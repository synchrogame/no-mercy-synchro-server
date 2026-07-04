'use strict';
/*
  No Mercy Synchro - v2 room manager (two-player milestone).

  Room / seat / presence logic PLUS the game session coordination that was seamed off in
  the previous step. Still transport-agnostic: it knows nothing about WebSockets. A
  "connection" is any object with a .send(obj) method (real sockets and test mocks both
  qualify), which is why this whole layer is testable headlessly.

  Game state lives here per room (room.game, an engine state). Clients never receive it
  directly: every outgoing game payload goes through filter.gameViewFor first, so each
  seat sees only its own hand plus opponent counts. That filtering is the security of the
  game and is tested in filtersim.js and gamesim.js.

  Event delivery follows the realtime-first model: after every action, each PRESENT seat
  is pushed its state (including any events aimed at it) and then its event buffer is
  cleared, since it saw them live. An ABSENT seat's buffer is left to accumulate and is
  delivered in full when it reconnects. One mechanism, two delivery modes.
*/

const crypto = require('crypto');
const engine = require('./engine.js');
const filter = require('./filter.js');

const MESSAGES = {
  'no-such-room': 'No room with that code.',
  'already-started': 'That game has already started.',
  'room-full': 'That room is full.',
  'bad-token': 'Could not resume that seat.',
  'no-space': 'Could not create a room right now.',
  'not-in-room': 'You are not in a room.',
  'not-in-game': 'The game is not in progress.'
};
function err(code) { return { type: 'error', error: { code, message: MESSAGES[code] || code } }; }

function cleanName(name, idx) {
  const trimmed = (name || '').trim().slice(0, 16);
  return trimmed || `Swimmer ${idx + 1}`;
}

class Room {
  constructor(code) {
    this.code = code;
    this.phase = 'lobby';   // 'lobby' | 'playing' | 'over'
    this.capacity = 2;      // two-player milestone; N-player raises this
    this.seats = [];        // { seat, name, token, conn, present }
    this.endedReason = null;
    this.game = null;       // engine state once started
  }
  isFull() { return this.seats.length >= this.capacity; }
}

class RoomManager {
  constructor(opts) {
    this.rooms = new Map();
    this._rng = (opts && opts.rng) || Math.random;
  }

  /* ---------- lobby ---------- */
  _newCode() {
    for (let i = 0; i < 10000; i++) {
      const code = String(Math.floor(this._rng() * 10000)).padStart(4, '0');
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }
  _token() { return crypto.randomBytes(9).toString('hex'); }

  createRoom(conn, name) {
    const code = this._newCode();
    if (code === null) { conn.send(err('no-space')); return null; }
    const room = new Room(code);
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
    if (room.isFull()) { conn.send(err('room-full')); return null; } // reachable only under explicit-start (N-player)
    const idx = room.seats.length;
    const seat = { seat: idx, name: cleanName(name, idx), token: this._token(), conn, present: true };
    room.seats.push(seat);
    conn.send({ type: 'joined', seat: idx, code, token: seat.token });
    if (room.isFull()) this._start(room); // two-player auto-start on full
    this._broadcast(room);
    return { code, seat: idx, token: seat.token };
  }

  rejoin(conn, code, token) {
    const room = this.rooms.get(code);
    if (!room) { conn.send(err('no-such-room')); return null; }
    const seat = room.seats.find(s => s.token === token);
    if (!seat) { conn.send(err('bad-token')); return null; }
    seat.conn = conn;
    seat.present = true;
    conn.send({ type: 'joined', seat: seat.seat, code, token: seat.token });
    this._sendState(room, seat); // deliver their buffered catch-up, then clear it
    this._broadcastExcept(room, seat); // let everyone else see them return
    return { code, seat: seat.seat };
  }

  handleDisconnect(conn) {
    for (const room of this.rooms.values()) {
      const seat = room.seats.find(s => s.conn === conn);
      if (!seat) continue;
      seat.conn = null;
      seat.present = false;

      if (room.phase === 'lobby') {
        room.seats = room.seats.filter(s => s !== seat);
        if (room.seats.length === 0) { this.rooms.delete(room.code); return { removed: true, code: room.code }; }
        this._broadcast(room);
        return { freed: true, code: room.code };
      }
      this._broadcast(room);
      return { graceNeeded: true, code: room.code, seat: seat.seat };
    }
    return { none: true };
  }

  expireGrace(code, seat) {
    const room = this.rooms.get(code);
    if (!room) return;
    const s = room.seats.find(x => x.seat === seat);
    if (!s || s.present || room.phase !== 'playing') return;
    // Two-player milestone: the only opponent is gone for good, so abandon the game.
    // SEAM_GAME (N-player): instead keep the seat 'absent' and continue play, auto-passing
    // that seat and sliding hits to the next present player, per the drop-out rule.
    room.phase = 'over';
    room.endedReason = 'opponent-left';
    this._broadcast(room);
  }

  _start(room) {
    room.phase = 'playing';
    room.game = engine.createGame(room.seats.map(s => s.name), { rng: this._rng });
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
  _viewFor(room, forSeat) {
    const msg = {
      type: 'state',
      phase: room.phase,
      code: room.code,
      endedReason: room.endedReason,
      you: { seat: forSeat.seat, name: forSeat.name },
      players: room.seats.map(s => ({ seat: s.seat, name: s.name, present: s.present }))
    };
    if (room.game) msg.game = filter.gameViewFor(room.game, forSeat.seat);
    return msg;
  }

  // Send one seat its state, then clear its (now-delivered) event buffer.
  _sendState(room, seat, extraGame) {
    if (!seat.conn) return;
    const msg = this._viewFor(room, seat);
    if (extraGame && msg.game) Object.assign(msg.game, extraGame);
    seat.conn.send(msg);
    if (room.game) engine.clearRecap(room.game, seat.seat);
  }

  _broadcast(room) {
    for (const s of room.seats) this._sendState(room, s);
  }
  _broadcastExcept(room, exceptSeat) {
    for (const s of room.seats) if (s !== exceptSeat) this._sendState(room, s);
  }

  // After a game action: push each present seat its view, attaching the actor's own
  // one-shot result (kip trade reveal, oyster self-hit, synchro outcome, draw) to the
  // actor's message only. Absent seats keep buffering for reconnect.
  _afterAction(room, actorSeatIdx, result) {
    for (const s of room.seats) {
      if (s.seat === actorSeatIdx && result) this._sendState(room, s, { yourResult: result });
      else this._sendState(room, s);
    }
  }
}

module.exports = { RoomManager, Room, cleanName };
