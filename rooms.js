'use strict';
/*
  No Mercy Synchro room manager.

  Owns rooms, seats, host powers, presence, shared-display approval, and game
  session coordination. The game state still never leaves this layer directly:
  every outgoing game payload goes through filter.js first.
*/

const crypto = require('crypto');
const engine = require('./engine.js');
const filter = require('./filter.js');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const MESSAGES = {
  'no-such-room': 'No room with that code.',
  'no-active-room': 'No active room is waiting for a shared display.',
  'already-started': 'That game has already started.',
  'room-full': 'That room is full.',
  'bad-token': 'Could not resume that seat.',
  'no-space': 'Could not create a room right now.',
  'not-in-room': 'You are not in a room.',
  'not-in-game': 'The game is not in progress.',
  'not-host': 'Only the room host can do that.',
  'not-enough-players': 'At least two swimmers need to join first.',
  'bad-display-request': 'That shared display request is no longer available.',
  'no-rematch': 'There is no rematch to answer right now.',
  'too-early': 'Not yet - give it a moment.',
  'cannot-skip': 'You can only skip when at least three swimmers are in.'
};
function err(code) { return { type: 'error', error: { code, message: MESSAGES[code] || code } }; }

function cleanName(name, idx) {
  const trimmed = (name || '').trim().slice(0, 16);
  return trimmed || `Swimmer ${idx + 1}`;
}

class Room {
  constructor(code, createdSeq) {
    this.code = code;
    this.createdSeq = createdSeq;
    this.phase = 'lobby';   // 'lobby' | 'playing' | 'over'
    this.capacity = MAX_PLAYERS;
    this.minPlayers = MIN_PLAYERS;
    this.hostSeat = 0;
    this.seats = [];        // { seat, name, token, conn, present }
    this.spectators = [];   // approved shared-display connections
    this.displayRequests = []; // pending shared-display approval requests
    this.endedReason = null;
    this.game = null;
    // Rematch (post-game ready-check) lives here while phase === 'over'.
    this.rematch = null;    // { proposed, canPropose, canCommit, ready:[], waiting:[] }
    this._proposeTimer = null;
    this._decideTimer = null;
    // Turn pacing (nudge/skip) lives here while phase === 'playing'.
    this.turnNudge = null;  // { nudgeReady, skipReady, nudgers:[] }
    this._nudgeTimer = null;
    this._skipTimer = null;
  }
  isFull() { return this.seats.length >= this.capacity; }
}

class RoomManager {
  constructor(opts) {
    opts = opts || {};
    this.rooms = new Map();
    this._rng = opts.rng || Math.random;
    this._seq = 0;
    // Timers are injectable so the headless harness can disable real ones and drive
    // expiry directly (same approach the disconnect grace uses from server.js).
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((h) => clearTimeout(h));
    // Rematch pacing. Values come from server.js so all tunable timers live in one
    // place; these defaults are only used when server.js doesn't pass them (e.g. tests).
    this._rematchProposeMs = opts.rematchProposeMs || 60000;
    this._rematchDecideMs = opts.rematchDecideMs || 60000;
    // Turn pacing: how long a turn sits idle before others may nudge, and how much
    // longer before the host may skip (so skip unlocks at nudge + skip after turn start).
    this._nudgeDelayMs = opts.nudgeDelayMs || 60000;
    this._skipDelayMs = opts.skipDelayMs || 60000;
  }

  /* ---------- lobby / room lifecycle ---------- */
  _newCode() {
    for (let i = 0; i < 10000; i++) {
      const code = String(Math.floor(this._rng() * 10000)).padStart(4, '0');
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }
  _token() { return crypto.randomBytes(9).toString('hex'); }
  _requestId() { return crypto.randomBytes(5).toString('hex'); }

  _renumberLobbySeats(room) {
    if (room.phase !== 'lobby') return;
    room.seats.forEach((s, i) => {
      s.seat = i;
      s.name = cleanName(s.name, i);
    });
    room.hostSeat = room.seats.length ? 0 : null;
  }

  _ensureHost(room) {
    if (!room.seats.length) { room.hostSeat = null; return null; }
    const current = room.seats.find(s => s.seat === room.hostSeat);
    if (current && current.present) return current;
    const next = room.seats.find(s => s.present) || room.seats[0];
    room.hostSeat = next ? next.seat : null;
    return next || null;
  }

  _latestApprovableRoom() {
    let best = null;
    for (const room of this.rooms.values()) {
      if (room.phase === 'over') continue;
      if (!room.seats.some(s => s.present)) continue;
      this._ensureHost(room);
      if (room.hostSeat === null) continue;
      if (!best || room.createdSeq > best.createdSeq) best = room;
    }
    return best;
  }

  _presentPlayerCount(room) {
    return room.seats.filter(s => s.present).length;
  }

  createRoom(conn, name) {
    const code = this._newCode();
    if (code === null) { conn.send(err('no-space')); return null; }
    const room = new Room(code, ++this._seq);
    this.rooms.set(code, room);
    const seat = { seat: 0, name: cleanName(name, 0), token: this._token(), conn, present: true };
    room.seats.push(seat);
    conn.send({ type: 'joined', seat: 0, code, token: seat.token });
    this._broadcast(room);
    return { code, seat: 0, token: seat.token };
  }

  joinRoom(conn, code, name) {
    const room = this.rooms.get(code);
    if (!room) { conn.send(err('no-such-room')); return null; }
    if (room.phase !== 'lobby') { conn.send(err('already-started')); return null; }
    if (room.isFull()) { conn.send(err('room-full')); return null; }
    const idx = room.seats.length;
    const seat = { seat: idx, name: cleanName(name, idx), token: this._token(), conn, present: true };
    room.seats.push(seat);
    conn.send({ type: 'joined', seat: idx, code, token: seat.token });
    this._broadcast(room);
    return { code, seat: idx, token: seat.token };
  }

  startGame(conn) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    // Only the initial start from the lobby comes through here now. Restarting after a
    // finished hand goes through the rematch ready-check (rematchReady / propose / commit).
    if (room.phase !== 'lobby') { conn.send(err('already-started')); return null; }
    if (seat.seat !== room.hostSeat) { conn.send(err('not-host')); return null; }
    if (this._presentPlayerCount(room) < room.minPlayers) { conn.send(err('not-enough-players')); return null; }
    this._start(room);
    this._broadcast(room);
    return { code: room.code };
  }

  rejoin(conn, code, token) {
    const room = this.rooms.get(code);
    if (!room) { conn.send(err('no-such-room')); return null; }
    const seat = room.seats.find(s => s.token === token);
    if (!seat) { conn.send(err('bad-token')); return null; }
    seat.conn = conn;
    seat.present = true;
    if (room.game && room.phase === 'playing') engine.setSeatActive(room.game, seat.seat, true);
    this._ensureHost(room);
    conn.send({ type: 'joined', seat: seat.seat, code, token: seat.token });
    this._sendState(room, seat);
    this._broadcastExcept(room, seat);
    return { code, seat: seat.seat };
  }

  handleDisconnect(conn) {
    for (const room of this.rooms.values()) {
      const seat = room.seats.find(s => s.conn === conn);
      if (seat) {
        seat.conn = null;
        seat.present = false;

        if (room.phase === 'lobby') {
          room.seats = room.seats.filter(s => s !== seat);
          this._renumberLobbySeats(room);
          if (room.seats.length === 0) { this.rooms.delete(room.code); return { removed: true, code: room.code }; }
          this._broadcast(room);
          return { freed: true, code: room.code };
        }

        this._ensureHost(room);
        this._broadcast(room);
        return room.phase === 'playing'
          ? { graceNeeded: true, code: room.code, seat: seat.seat }
          : { closed: true, code: room.code };
      }

      const spectatorIdx = room.spectators.findIndex(s => s.conn === conn);
      if (spectatorIdx !== -1) {
        room.spectators.splice(spectatorIdx, 1);
        return { display: true, code: room.code };
      }

      const requestIdx = room.displayRequests.findIndex(r => r.conn === conn);
      if (requestIdx !== -1) {
        room.displayRequests.splice(requestIdx, 1);
        this._broadcast(room);
        return { displayRequest: true, code: room.code };
      }
    }
    return { none: true };
  }

  expireGrace(code, seat) {
    const room = this.rooms.get(code);
    if (!room || !room.game) return;
    const s = room.seats.find(x => x.seat === seat);
    if (!s || s.present || room.phase !== 'playing') return;

    const activeBefore = engine.activeSeatCount(room.game);
    if (activeBefore <= 2) {
      room.phase = 'over';
      room.endedReason = 'opponent-left';
      this._resetTurnPacing(room);
      this._broadcast(room);
      return;
    }

    engine.setSeatActive(room.game, seat, false);
    if (engine.activeSeatCount(room.game) < 2) {
      room.phase = 'over';
      room.endedReason = 'opponent-left';
    }
    this._resetTurnPacing(room);
    this._broadcast(room);
  }

  // activeSeats (optional Set of seat indices): when provided, any PRESENT seat not in
  // the set also starts benched (inactive). Used by the rematch commit to sit out
  // holdouts. Without it (the initial lobby start), only absent seats are benched.
  _start(room, activeSeats) {
    room.phase = 'playing';
    room.endedReason = null;
    room.rematch = null;
    this._clearRematchTimers(room);
    room.displayRequests = room.displayRequests.filter(r => r.conn);
    room.seats.sort((a, b) => a.seat - b.seat);
    room.game = engine.createGame(room.seats.map(s => s.name), { rng: this._rng });
    for (const s of room.seats) {
      const benchAbsent = !s.present;
      const benchNotReady = activeSeats ? !activeSeats.has(s.seat) : false;
      if (benchAbsent || benchNotReady) engine.setSeatActive(room.game, s.seat, false);
    }
    // createGame opens on seat 0; if that seat is benched, slide the opening turn to
    // the first active seat so play doesn't stall on an empty chair.
    if (!engine.isSeatActive(room.game, room.game.turn)) {
      const first = engine.nextPresentSeat(room.game, room.game.turn);
      if (first !== null) room.game.turn = first;
    }
    this._resetTurnPacing(room);
  }

  _clearRematchTimers(room) {
    if (room._proposeTimer) { this._clearTimeout(room._proposeTimer); room._proposeTimer = null; }
    if (room._decideTimer) { this._clearTimeout(room._decideTimer); room._decideTimer = null; }
  }

  _clearTurnPacingTimers(room) {
    if (room._nudgeTimer) { this._clearTimeout(room._nudgeTimer); room._nudgeTimer = null; }
    if (room._skipTimer) { this._clearTimeout(room._skipTimer); room._skipTimer = null; }
  }

  // Restart the idle clock for the current turn. Called whenever the turn (re)starts or
  // the current player acts, so nudge/skip only fire on a genuinely idle turn. Clears
  // pacing entirely once the hand is no longer in progress.
  _resetTurnPacing(room) {
    this._clearTurnPacingTimers(room);
    if (!room.game || room.phase !== 'playing' || room.game.gameOver) { room.turnNudge = null; return; }
    room.turnNudge = { nudgeReady: false, skipReady: false, nudgers: [] };
    room._nudgeTimer = this._setTimeout(() => this.nudgeWindowExpired(room.code), this._nudgeDelayMs);
    room._skipTimer = this._setTimeout(() => this.skipWindowExpired(room.code), this._nudgeDelayMs + this._skipDelayMs);
  }

  nudgeWindowExpired(code) {
    const room = this.rooms.get(code);
    if (!room || room.phase !== 'playing' || !room.turnNudge) return;
    room.turnNudge.nudgeReady = true;
    this._broadcast(room);
  }
  skipWindowExpired(code) {
    const room = this.rooms.get(code);
    if (!room || room.phase !== 'playing' || !room.turnNudge) return;
    room.turnNudge.skipReady = true;
    this._broadcast(room);
  }

  /* ---------- shared display ---------- */
  requestDisplayLatest(conn) {
    const room = this._latestApprovableRoom();
    if (!room) { conn.send(err('no-active-room')); return null; }
    const request = { id: this._requestId(), conn, createdAt: Date.now() };
    room.displayRequests.push(request);
    conn.send({ type: 'display-pending', code: room.code, requestId: request.id });
    this._broadcast(room);
    return { code: room.code, requestId: request.id };
  }

  approveDisplay(conn, requestId) {
    return this._resolveDisplayRequest(conn, requestId, true);
  }

  rejectDisplay(conn, requestId) {
    return this._resolveDisplayRequest(conn, requestId, false);
  }

  _resolveDisplayRequest(conn, requestId, approved) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    if (seat.seat !== room.hostSeat) { conn.send(err('not-host')); return null; }
    const idx = room.displayRequests.findIndex(r => r.id === requestId);
    if (idx === -1) { conn.send(err('bad-display-request')); return null; }
    const request = room.displayRequests.splice(idx, 1)[0];

    if (!approved) {
      request.conn.send({ type: 'display-denied', code: room.code });
      this._broadcast(room);
      return { code: room.code, approved: false };
    }

    const spectator = { id: request.id, conn: request.conn };
    room.spectators.push(spectator);
    request.conn.send({ type: 'display-joined', code: room.code });
    this._sendDisplayState(room, spectator);
    this._broadcast(room);
    return { code: room.code, approved: true };
  }

  /* ---------- game actions ---------- */
  _findSeat(conn) {
    for (const room of this.rooms.values()) {
      const seat = room.seats.find(s => s.conn === conn);
      if (seat) return { room, seat };
    }
    return null;
  }

  _gameAction(conn, apply) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    if (!room.game || room.phase !== 'playing') { conn.send(err('not-in-game')); return null; }
    const res = apply(room.game, seat.seat);
    if (!res.ok) { conn.send({ type: 'error', error: res.error }); return null; }
    if (room.game.gameOver) { room.phase = 'over'; this._enterRematch(room); }
    this._resetTurnPacing(room);
    this._afterAction(room, seat.seat, res.result || null);
    return res;
  }

  playCard(conn, cardId) { return this._gameAction(conn, (g, s) => engine.applyPlay(g, s, cardId)); }
  drawCard(conn) { return this._gameAction(conn, (g, s) => engine.applyDraw(g, s)); }
  chooseTheme(conn, theme) { return this._gameAction(conn, (g, s) => engine.applyChooseTheme(g, s, theme)); }
  resolveKip(conn, ownCardId, targetIndex) { return this._gameAction(conn, (g, s) => engine.applyResolveKip(g, s, ownCardId, targetIndex)); }
  resolveSteal(conn, targetIndex) { return this._gameAction(conn, (g, s) => engine.applyResolveSteal(g, s, targetIndex)); }
  synchro(conn) { return this._gameAction(conn, (g, s) => engine.applySynchro(g, s)); }

  /* ---------- rematch (post-game ready-check) ---------- */
  // A won hand opens a ready-check. Nothing here ever auto-starts on a timer; a timer
  // only unlocks a host option. The hand starts when everyone present is ready, or when
  // the host commits (sitting out any holdouts). A grace-abandoned hand (endedReason set)
  // does not offer a rematch - there aren't enough players to restart against.
  _enterRematch(room) {
    if (room.endedReason) return;
    room.rematch = { proposed: false, canPropose: false, canCommit: false, ready: [], waiting: [] };
    this._clearRematchTimers(room);
    room._proposeTimer = this._setTimeout(() => this.rematchExpirePropose(room.code), this._rematchProposeMs);
  }

  _readyPresentCount(room) {
    if (!room.rematch) return 0;
    return room.seats.filter(s => s.present && room.rematch.ready.includes(s.seat)).length;
  }
  _allPresentReady(room) {
    if (!room.rematch) return false;
    const present = room.seats.filter(s => s.present);
    if (present.length < room.minPlayers) return false;
    return present.every(s => room.rematch.ready.includes(s.seat));
  }
  _startRematch(room) {
    // Active next hand = present players who are ready. Everyone else (absent, on Wait,
    // or untouched) sits out but keeps their seat/token and can tap "I'm back" to join.
    const active = new Set(
      room.rematch.ready.filter(seatIdx => {
        const s = room.seats.find(x => x.seat === seatIdx);
        return s && s.present;
      })
    );
    this._start(room, active);
  }

  // A player commits to the next hand (the "Play Again" tap in the propose window, or
  // the "I'm in!" tap in the decide window). Unifies both because they mean the same thing.
  rematchReady(conn) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    if (room.phase !== 'over' || !room.rematch) { conn.send(err('no-rematch')); return null; }
    const r = room.rematch;
    if (!r.ready.includes(seat.seat)) r.ready.push(seat.seat);
    r.waiting = r.waiting.filter(x => x !== seat.seat);
    if (this._allPresentReady(room)) {
      this._startRematch(room);
      this._broadcast(room);
      return { ok: true, started: true };
    }
    // Public "X's in" toast to everyone else + the shared display, plus a roster refresh.
    this._broadcastPublicNotice(room, seat.seat, { type: 'rematch-ready', byName: seat.name });
    return { ok: true };
  }

  // A player asks for more time (the "Hang on" tap). Only meaningful once the host has
  // proposed. Restarts the shared decide window (latest Wait wins) and re-locks commit.
  rematchWait(conn) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    if (room.phase !== 'over' || !room.rematch) { conn.send(err('no-rematch')); return null; }
    const r = room.rematch;
    if (!r.proposed) return null;
    if (r.ready.includes(seat.seat)) return null;
    if (!r.waiting.includes(seat.seat)) r.waiting.push(seat.seat);
    r.canCommit = false;
    this._clearRematchTimers(room);
    room._decideTimer = this._setTimeout(() => this.rematchExpireDecide(room.code), this._rematchDecideMs);
    this._broadcast(room);
    return { ok: true };
  }

  // Host taps "Ready to start?" once the propose window has elapsed. Moves to the decide
  // stage and hands every uncommitted player Ready/Wait buttons.
  rematchPropose(conn) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    if (room.phase !== 'over' || !room.rematch) { conn.send(err('no-rematch')); return null; }
    if (seat.seat !== room.hostSeat) { conn.send(err('not-host')); return null; }
    const r = room.rematch;
    if (!r.canPropose || r.proposed) { conn.send(err('too-early')); return null; }
    r.proposed = true;
    r.canCommit = false;
    this._clearRematchTimers(room);
    room._decideTimer = this._setTimeout(() => this.rematchExpireDecide(room.code), this._rematchDecideMs);
    if (this._allPresentReady(room)) { this._startRematch(room); }
    this._broadcast(room);
    return { ok: true };
  }

  // Host taps "Start now" once the decide window has elapsed with holdouts still out.
  rematchCommit(conn) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    if (room.phase !== 'over' || !room.rematch) { conn.send(err('no-rematch')); return null; }
    if (seat.seat !== room.hostSeat) { conn.send(err('not-host')); return null; }
    const r = room.rematch;
    if (!r.proposed || !r.canCommit) { conn.send(err('too-early')); return null; }
    if (this._readyPresentCount(room) < room.minPlayers) { conn.send(err('not-enough-players')); return null; }
    this._startRematch(room);
    this._broadcast(room);
    return { ok: true };
  }

  rematchExpirePropose(code) {
    const room = this.rooms.get(code);
    if (!room || !room.rematch || room.phase !== 'over') return;
    if (room.rematch.proposed) return;
    room.rematch.canPropose = true;
    this._broadcast(room);
  }
  rematchExpireDecide(code) {
    const room = this.rooms.get(code);
    if (!room || !room.rematch || room.phase !== 'over') return;
    if (!room.rematch.proposed) return;
    room.rematch.canCommit = true;
    this._broadcast(room);
  }

  // A present-but-benched player taps "I'm back" to rejoin active play mid-hand. This is
  // the same signal a skipped player uses to return, and what a rematch holdout uses once
  // the hand has started without them.
  imBack(conn) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    if (!room.game || room.phase !== 'playing') { conn.send(err('not-in-game')); return null; }
    if (engine.isSeatActive(room.game, seat.seat)) return null;
    engine.setSeatActive(room.game, seat.seat, true);
    this._broadcast(room);
    return { ok: true };
  }

  /* ---------- turn pacing (nudge / host skip) ---------- */
  // A present, active player pokes whoever is sitting on their turn. One poke per player
  // per idle turn; no group consent needed. The poke is private to the target.
  nudge(conn) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    if (!room.game || room.phase !== 'playing') { conn.send(err('not-in-game')); return null; }
    const tn = room.turnNudge;
    if (!tn || !tn.nudgeReady) { conn.send(err('too-early')); return null; }
    const g = room.game;
    if (g.turn === seat.seat) return null;                 // don't nudge yourself
    if (!engine.isSeatActive(g, seat.seat)) return null;   // benched players don't nudge
    if (tn.nudgers.includes(seat.seat)) return null;       // already nudged this turn
    tn.nudgers.push(seat.seat);
    this._broadcastNudge(room, g.turn, seat.seat, seat.name, this._seatName(room, g.turn));
    return { ok: true };
  }

  // The host skips whoever is stalling, once the skip window has elapsed. Only offered
  // when at least three players are active, so a skip never drops the table below two.
  // The skipped player is benched (kept by token) and returns with "I'm back".
  skip(conn) {
    const found = this._findSeat(conn);
    if (!found) { conn.send(err('not-in-room')); return null; }
    const { room, seat } = found;
    if (!room.game || room.phase !== 'playing') { conn.send(err('not-in-game')); return null; }
    if (seat.seat !== room.hostSeat) { conn.send(err('not-host')); return null; }
    const tn = room.turnNudge;
    if (!tn || !tn.skipReady) { conn.send(err('too-early')); return null; }
    const g = room.game;
    const target = g.turn;
    if (target === seat.seat) return null;                 // host won't skip their own turn
    if (engine.activeSeatCount(g) < 3) { conn.send(err('cannot-skip')); return null; }
    const targetName = this._seatName(room, target);
    engine.setSeatActive(g, target, false);                // benches target, moves turn, abandons any pending
    this._resetTurnPacing(room);
    this._broadcastSkip(room, target, targetName);
    return { ok: true, result: { type: 'skipped', target } };
  }

  _seatName(room, seatIdx) {
    const s = room.seats.find(x => x.seat === seatIdx);
    return s ? s.name : (room.game ? room.game.names[seatIdx] : 'that swimmer');
  }

  // Fresh state to everyone (so nudge buttons update), a "you were nudged" toast to the
  // target, and a small "you nudged X" confirmation to the nudger.
  _broadcastNudge(room, targetSeatIdx, nudgerSeatIdx, nudgerName, targetName) {
    this._ensureHost(room);
    for (const s of room.seats) {
      let extra = null;
      if (s.seat === targetSeatIdx) extra = { publicResult: { type: 'nudged', byName: nudgerName } };
      else if (s.seat === nudgerSeatIdx) extra = { publicResult: { type: 'you-nudged', targetName } };
      this._sendState(room, s, extra);
    }
    for (const sp of room.spectators) this._sendDisplayState(room, sp);
  }

  // Fresh state to everyone, "you were skipped" to the target, "X was skipped" to the rest
  // and the shared display.
  _broadcastSkip(room, targetSeatIdx, targetName) {
    this._ensureHost(room);
    for (const s of room.seats) {
      const notice = (s.seat === targetSeatIdx) ? { type: 'skipped-you' } : { type: 'skipped', byName: targetName };
      this._sendState(room, s, { publicResult: notice });
    }
    for (const sp of room.spectators) this._sendDisplayState(room, sp, { publicResult: { type: 'skipped', byName: targetName } });
  }

  /* ---------- delivery ---------- */
  _playersFor(room) {
    return room.seats.map(s => ({
      seat: s.seat,
      name: s.name,
      present: s.present,
      active: room.game ? engine.isSeatActive(room.game, s.seat) : true,
      host: s.seat === room.hostSeat
    }));
  }

  _displayRequestsFor(room) {
    return room.displayRequests.map(r => ({ id: r.id, createdAt: r.createdAt }));
  }

  _viewFor(room, forSeat) {
    this._ensureHost(room);
    const msg = {
      type: 'state',
      role: 'player',
      phase: room.phase,
      code: room.code,
      capacity: room.capacity,
      minPlayers: room.minPlayers,
      hostSeat: room.hostSeat,
      isHost: forSeat.seat === room.hostSeat,
      canStart: room.phase === 'lobby' && forSeat.seat === room.hostSeat && this._presentPlayerCount(room) >= room.minPlayers,
      endedReason: room.endedReason,
      you: { seat: forSeat.seat, name: forSeat.name },
      players: this._playersFor(room),
      displayRequests: forSeat.seat === room.hostSeat ? this._displayRequestsFor(room) : []
    };
    if (room.game) msg.game = filter.gameViewFor(room.game, forSeat.seat);
    if (room.rematch) msg.rematch = this._rematchViewFor(room, forSeat.seat);
    if (room.game && room.phase === 'playing' && room.turnNudge) msg.pacing = this._pacingViewFor(room, forSeat.seat);
    return msg;
  }

  _pacingViewFor(room, seatIdx) {
    const tn = room.turnNudge;
    const g = room.game;
    const isTurnHolder = g.turn === seatIdx;
    return {
      turnSeat: g.turn,
      canNudge: tn.nudgeReady && engine.isSeatActive(g, seatIdx) && !isTurnHolder && !tn.nudgers.includes(seatIdx),
      canSkip: tn.skipReady && seatIdx === room.hostSeat && !isTurnHolder && engine.activeSeatCount(g) >= 3
    };
  }

  _rematchViewFor(room, seatIdx) {
    const r = room.rematch;
    const isHost = seatIdx === room.hostSeat;
    const presentCount = this._presentPlayerCount(room);
    const readyEnough = this._readyPresentCount(room) >= room.minPlayers;
    return {
      stage: r.proposed ? 'deciding' : 'proposing',
      youReady: r.ready.includes(seatIdx),
      youWaiting: r.waiting.includes(seatIdx),
      canPropose: isHost && r.canPropose && !r.proposed && presentCount >= room.minPlayers,
      canCommit: isHost && r.proposed && r.canCommit && readyEnough,
      readySeats: r.ready.slice(),
      waitingSeats: r.waiting.slice()
    };
  }

  _rematchPublicView(room) {
    const r = room.rematch;
    return {
      stage: r.proposed ? 'deciding' : 'proposing',
      readySeats: r.ready.slice(),
      waitingSeats: r.waiting.slice()
    };
  }

  _viewForDisplay(room) {
    this._ensureHost(room);
    const msg = {
      type: 'state',
      role: 'display',
      phase: room.phase,
      code: room.code,
      endedReason: room.endedReason,
      players: this._playersFor(room)
    };
    if (room.game) msg.game = filter.spectatorGameView(room.game);
    if (room.rematch) msg.rematch = this._rematchPublicView(room);
    return msg;
  }

  // Broadcast state to everyone, attaching a public toast to every connection EXCEPT the
  // actor (who prompted it), plus every shared display. Used for "X's in" style notices.
  _broadcastPublicNotice(room, exceptSeatIdx, notice) {
    this._ensureHost(room);
    for (const s of room.seats) {
      const extra = (s.seat !== exceptSeatIdx) ? { publicResult: notice } : null;
      this._sendState(room, s, extra);
    }
    for (const sp of room.spectators) this._sendDisplayState(room, sp, { publicResult: notice });
  }

  _sendState(room, seat, extraGame) {
    if (!seat.conn) return;
    const msg = this._viewFor(room, seat);
    if (extraGame && msg.game) Object.assign(msg.game, extraGame);
    seat.conn.send(msg);
    if (room.game) engine.clearRecap(room.game, seat.seat);
  }

  _sendDisplayState(room, spectator, extraGame) {
    if (!spectator.conn) return;
    const msg = this._viewForDisplay(room);
    if (extraGame && msg.game) Object.assign(msg.game, extraGame);
    spectator.conn.send(msg);
  }

  _broadcast(room) {
    this._ensureHost(room);
    for (const s of room.seats) this._sendState(room, s);
    for (const sp of room.spectators) this._sendDisplayState(room, sp);
  }

  _broadcastExcept(room, exceptSeat) {
    this._ensureHost(room);
    for (const s of room.seats) if (s !== exceptSeat) this._sendState(room, s);
    for (const sp of room.spectators) this._sendDisplayState(room, sp);
  }

  // After a game action: push each seat its view, attaching the actor's own
  // one-shot result to the actor's message only. Disconnected seats keep their
  // recap buffers for reconnect; shared displays only see public state.
  //
  // Two kinds of public feedback ride along here:
  //   result.public        -> a public result shown to EVERYONE including the actor
  //                           (e.g. a theme change).
  //   result.publicNotice  -> a public toast for everyone EXCEPT the actor, plus every
  //                           shared display (e.g. "X drew a card"). The actor is left
  //                           out because they already get their own private feedback.
  _afterAction(room, actorSeatIdx, result) {
    const publicExtra = result && result.public ? { publicResult: result } : null;
    const noticeExtra = result && result.publicNotice ? { publicResult: result.publicNotice } : null;
    for (const s of room.seats) {
      const isActor = s.seat === actorSeatIdx;
      const extra = Object.assign({},
        publicExtra || {},
        (!isActor && noticeExtra) ? noticeExtra : {},
        (isActor && result && !result.public) ? { yourResult: result } : {}
      );
      this._sendState(room, s, Object.keys(extra).length ? extra : null);
    }
    for (const sp of room.spectators) this._sendDisplayState(room, sp, publicExtra || noticeExtra);
  }
}

module.exports = { RoomManager, Room, cleanName, MIN_PLAYERS, MAX_PLAYERS };
