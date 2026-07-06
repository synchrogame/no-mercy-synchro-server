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
  'bad-display-request': 'That shared display request is no longer available.'
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
  }
  isFull() { return this.seats.length >= this.capacity; }
}

class RoomManager {
  constructor(opts) {
    this.rooms = new Map();
    this._rng = (opts && opts.rng) || Math.random;
    this._seq = 0;
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
    if (room.phase !== 'lobby') { conn.send(err('already-started')); return null; }
    if (seat.seat !== room.hostSeat) { conn.send(err('not-host')); return null; }
    if (room.seats.length < room.minPlayers) { conn.send(err('not-enough-players')); return null; }
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
      this._broadcast(room);
      return;
    }

    engine.setSeatActive(room.game, seat, false);
    if (engine.activeSeatCount(room.game) < 2) {
      room.phase = 'over';
      room.endedReason = 'opponent-left';
    }
    this._broadcast(room);
  }

  _start(room) {
    room.phase = 'playing';
    room.endedReason = null;
    room.displayRequests = room.displayRequests.filter(r => r.conn);
    room.seats.sort((a, b) => a.seat - b.seat);
    room.game = engine.createGame(room.seats.map(s => s.name), { rng: this._rng });
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
    if (room.game.gameOver) room.phase = 'over';
    this._afterAction(room, seat.seat, res.result || null);
    return res;
  }

  playCard(conn, cardId) { return this._gameAction(conn, (g, s) => engine.applyPlay(g, s, cardId)); }
  drawCard(conn) { return this._gameAction(conn, (g, s) => engine.applyDraw(g, s)); }
  chooseTheme(conn, theme) { return this._gameAction(conn, (g, s) => engine.applyChooseTheme(g, s, theme)); }
  resolveKip(conn, ownCardId, targetIndex) { return this._gameAction(conn, (g, s) => engine.applyResolveKip(g, s, ownCardId, targetIndex)); }
  resolveSteal(conn, targetIndex) { return this._gameAction(conn, (g, s) => engine.applyResolveSteal(g, s, targetIndex)); }
  synchro(conn) { return this._gameAction(conn, (g, s) => engine.applySynchro(g, s)); }

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
      canStart: room.phase === 'lobby' && forSeat.seat === room.hostSeat && room.seats.length >= room.minPlayers,
      endedReason: room.endedReason,
      you: { seat: forSeat.seat, name: forSeat.name },
      players: this._playersFor(room),
      displayRequests: forSeat.seat === room.hostSeat ? this._displayRequestsFor(room) : []
    };
    if (room.game) msg.game = filter.gameViewFor(room.game, forSeat.seat);
    return msg;
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
    return msg;
  }

  _sendState(room, seat, extraGame) {
    if (!seat.conn) return;
    const msg = this._viewFor(room, seat);
    if (extraGame && msg.game) Object.assign(msg.game, extraGame);
    seat.conn.send(msg);
    if (room.game) engine.clearRecap(room.game, seat.seat);
  }

  _sendDisplayState(room, spectator) {
    if (!spectator.conn) return;
    spectator.conn.send(this._viewForDisplay(room));
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
  _afterAction(room, actorSeatIdx, result) {
    for (const s of room.seats) {
      if (s.seat === actorSeatIdx && result) this._sendState(room, s, { yourResult: result });
      else this._sendState(room, s);
    }
    for (const sp of room.spectators) this._sendDisplayState(room, sp);
  }
}

module.exports = { RoomManager, Room, cleanName, MIN_PLAYERS, MAX_PLAYERS };
