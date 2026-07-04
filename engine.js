'use strict';
/*
  No Mercy Synchro - v2 server-side game engine (two-player milestone).

  Pure game rules. No DOM, no networking, no rendering. Drivable headlessly by the
  test harness (sim.js), same discipline the project has used since v1.

  This is the port of v1.5's inline game logic, with three deliberate changes that the
  server context forces:
    1. Single-device UI flow removed (pass-the-device gate, reveal gate, modal
       show/hide flags). Only the pure rules and the recap DATA survive.
    2. Invalid moves return an explicit { ok:false, error } instead of a silent no-op,
       so the server can turn a rejection into an `error` message to the client.
    3. Synchro acts for the CALLER's seat (whoever's device sent it), not for the
       current turn-holder, so a player can catch their opponent during the
       opponent's turn.

  Two-player only for now, by decision (two-player online first, then N-player).
  The single spot that will need real generalizing is marked SEAM_2P.

  Two latent v1.5 bugs were found and corrected during the port; see BUGFIX notes.
*/

const THEMES = ['tiedye', 'felt', 'greek', 'dream'];
const DECK_SIZE = 112; // sanity constant; buildDeck must produce exactly this many

/* ---------- deck ---------- */
function buildDeck() {
  const deck = [];
  let id = 0;
  THEMES.forEach(theme => {
    deck.push({ id: id++, theme, type: 'number', value: 0 });
    for (let n = 1; n <= 9; n++) {
      deck.push({ id: id++, theme, type: 'number', value: n });
      deck.push({ id: id++, theme, type: 'number', value: n });
    }
    deck.push({ id: id++, theme, type: 'skip' });
    deck.push({ id: id++, theme, type: 'skip' });
    deck.push({ id: id++, theme, type: 'drawTwo' });
    deck.push({ id: id++, theme, type: 'drawTwo' });
    deck.push({ id: id++, theme, type: 'drawFour' });
  });
  ['wild', 'swap', 'steal', 'twist'].forEach(type => {
    for (let i = 0; i < 4; i++) deck.push({ id: id++, theme: null, type });
  });
  return deck;
}

// Seedable PRNG (mulberry32) so the harness can reproduce any game from its seed.
// Defaults to Math.random in real use.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  rng = rng || Math.random;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ---------- recap (structured, perspective-correct, no pre-rendered text) ---------- */
function emptyRecap() {
  return { balletCount: 0, exchanges: [], draw: null, synchroNotes: [] };
}
function queueBallet(state, seat) { state.pendingRecap[seat].balletCount++; }
function queueDraw(state, seat, source, drawn) {
  if (!drawn.length) return;
  const r = state.pendingRecap[seat];
  if (!r.draw) r.draw = { count: 0, sources: [] };
  r.draw.count += drawn.length;
  r.draw.sources.push({ source, count: drawn.length });
}
function queueKip(state, seat, gaveAway, received) {
  state.pendingRecap[seat].exchanges.push({ kind: 'kip', gaveAway, received });
}
function queueBarracuda(state, seat, takenFromYou) {
  state.pendingRecap[seat].exchanges.push({ kind: 'barracuda', takenFromYou });
}
function queueSynchroDeclared(state, seat, by) {
  state.pendingRecap[seat].synchroNotes.push({ type: 'declared', by });
}

/* ---------- setup ---------- */
function createGame(names, opts) {
  opts = opts || {};
  const rng = opts.rng || Math.random;
  const deck = shuffle(buildDeck(), rng);
  const state = {
    names: [(names && names[0]) || 'Swimmer 1', (names && names[1]) || 'Swimmer 2'],
    hands: [[], []],
    deck,
    discard: [],
    theme: null,
    number: null,
    turn: 0,
    drawnThisTurn: false,
    pending: null,              // null | {type:'theme'|'kip'|'steal', effect?, playerIdx, opp}
    mustCallSynchro: [false, false],
    synchroMisuseWarned: [false, false],
    pendingRecap: [emptyRecap(), emptyRecap()],
    gameOver: false,
    winner: null,
    rng
  };
  for (let i = 0; i < 7; i++) { state.hands[0].push(deck.pop()); state.hands[1].push(deck.pop()); }
  const starterIdx = deck.findIndex(c => c.type === 'number');
  const starter = deck.splice(starterIdx, 1)[0];
  state.discard = [starter];
  state.theme = starter.theme;
  state.number = starter.value;
  return state;
}

/* ---------- helpers ---------- */
function opponentOf(state, seat) { return 1 - seat; } // SEAM_2P: N-player -> next present seat
function topDiscard(state) { return state.discard[state.discard.length - 1]; }
function isPlayable(state, card) {
  if (card.theme === null) return true;
  const top = topDiscard(state);
  if (card.theme === state.theme) return true;
  if (card.type === 'number' && top.type === 'number' && card.value === state.number) return true;
  if (card.type !== 'number' && card.type === top.type) return true;
  return false;
}
function hasPlayable(state, seat) { return state.hands[seat].some(c => isPlayable(state, c)); }
function setTurn(state, seat) { state.turn = seat; state.drawnThisTurn = false; }
function reject(code) { return { ok: false, error: { code } }; }

function drawInternal(state, seat, n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0) {
      const top = state.discard.pop();
      state.deck = shuffle(state.discard, state.rng);
      state.discard = [top];
    }
    if (state.deck.length === 0) break;
    const c = state.deck.pop();
    state.hands[seat].push(c);
    drawn.push(c);
  }
  if (state.hands[seat].length !== 1) state.mustCallSynchro[seat] = false;
  return drawn;
}

// Guard shared by the plain turn actions (play / draw). Choice-resolving actions
// (theme/kip/steal) use their own guard since a pending choice is expected there.
function ensureActable(state, seat) {
  if (state.gameOver) return reject('game-over');
  if (state.pending) return reject('choice-in-progress');
  if (seat !== state.turn) return reject('not-your-turn');
  return null;
}

/* ---------- actions ---------- */
function applyPlay(state, seat, cardId) {
  const guard = ensureActable(state, seat);
  if (guard) return guard;
  const hand = state.hands[seat];
  const idx = hand.findIndex(c => c.id === cardId);
  if (idx === -1) return reject('no-such-card');
  const card = hand[idx];
  if (!isPlayable(state, card)) return reject('illegal-play');

  hand.splice(idx, 1);
  state.discard.push(card);
  if (card.type === 'number') { state.theme = card.theme; state.number = card.value; }

  if (hand.length === 0) {
    state.mustCallSynchro[seat] = false; // no dangling flag on a finished game
    state.gameOver = true;
    state.winner = seat;
    return { ok: true, result: { type: 'win' } };
  }
  state.mustCallSynchro[seat] = hand.length === 1;

  const opp = opponentOf(state, seat);
  switch (card.type) {
    case 'number':
      setTurn(state, opp);
      return { ok: true };
    case 'skip':
      state.theme = card.theme; state.number = null;
      queueBallet(state, opp);
      setTurn(state, seat);
      return { ok: true };
    case 'drawTwo': {
      state.theme = card.theme; state.number = null;
      const d = drawInternal(state, opp, 2);
      queueDraw(state, opp, 'Tub', d);
      setTurn(state, seat);
      return { ok: true };
    }
    case 'drawFour':
      state.pending = { type: 'theme', effect: 'drawFour', playerIdx: seat, opp };
      return { ok: true, pending: 'theme' };
    case 'wild':
      state.pending = { type: 'theme', effect: 'wild', playerIdx: seat, opp };
      return { ok: true, pending: 'theme' };
    case 'swap':
      state.pending = { type: 'kip', playerIdx: seat, opp };
      return { ok: true, pending: 'kip' };
    case 'steal':
      state.pending = { type: 'steal', playerIdx: seat, opp };
      return { ok: true, pending: 'steal' };
    case 'twist': {
      const lenSelf = state.hands[seat].length;
      const lenOpp = state.hands[opp].length;
      const target = (lenSelf < lenOpp) ? seat : opp; // tie -> opp (Oyster default, unchanged)
      const d = drawInternal(state, target, 2);
      if (target === opp) {
        queueDraw(state, opp, 'Oyster', d);
        setTurn(state, opp);
        return { ok: true };
      }
      setTurn(state, opp);
      return { ok: true, result: { type: 'oyster-self', drew: d.length } };
    }
  }
  return reject('unknown-card');
}

function applyDraw(state, seat) {
  const guard = ensureActable(state, seat);
  if (guard) return guard;
  if (state.drawnThisTurn) return reject('already-drew');
  if (hasPlayable(state, seat)) return reject('must-play'); // can only draw when stuck
  const drawn = drawInternal(state, seat, 1);
  state.drawnThisTurn = true;
  const stillStuck = !hasPlayable(state, seat);
  if (stillStuck) setTurn(state, opponentOf(state, seat));
  return { ok: true, result: { type: 'draw', drew: drawn[0] || null, canPlay: !stillStuck } };
}

function applyChooseTheme(state, seat, theme) {
  if (state.gameOver) return reject('game-over');
  const p = state.pending;
  if (!p || p.type !== 'theme') return reject('no-pending-theme');
  if (seat !== p.playerIdx) return reject('not-your-choice');
  if (THEMES.indexOf(theme) === -1) return reject('bad-theme');
  state.pending = null;
  state.theme = theme; state.number = null;
  if (p.effect === 'drawFour') {
    const d = drawInternal(state, p.opp, 4);
    queueDraw(state, p.opp, 'Tower', d);
    setTurn(state, p.playerIdx);
  } else {
    setTurn(state, p.opp);
  }
  return { ok: true };
}

function applyResolveKip(state, seat, ownCardId, targetIndex) {
  if (state.gameOver) return reject('game-over');
  const p = state.pending;
  if (!p || p.type !== 'kip') return reject('no-pending-kip');
  if (seat !== p.playerIdx) return reject('not-your-choice');
  const opp = p.opp;
  const ownIdx = state.hands[seat].findIndex(c => c.id === ownCardId);
  if (ownIdx === -1) return reject('no-such-card');
  if (targetIndex < 0 || targetIndex >= state.hands[opp].length) return reject('bad-target-index');

  const ownCard = state.hands[seat].splice(ownIdx, 1)[0];
  const oppCard = state.hands[opp].splice(targetIndex, 1)[0];
  state.hands[seat].push(oppCard);
  state.hands[opp].push(ownCard);
  state.pending = null;

  // BUGFIX vs v1.5: the off-turn player's recap had gave/received swapped. From opp's
  // perspective they gave away oppCard and received ownCard.
  queueKip(state, opp, oppCard, ownCard);
  // Sizes unchanged by a trade, so synchro flags are unaffected.
  setTurn(state, opp);
  return { ok: true, result: { type: 'kip', gaveAway: ownCard, received: oppCard } };
}

function applyResolveSteal(state, seat, targetIndex) {
  if (state.gameOver) return reject('game-over');
  const p = state.pending;
  if (!p || p.type !== 'steal') return reject('no-pending-steal');
  if (seat !== p.playerIdx) return reject('not-your-choice');
  const opp = p.opp;
  if (targetIndex < 0 || targetIndex >= state.hands[opp].length) return reject('bad-target-index');

  const stolen = state.hands[opp].splice(targetIndex, 1)[0];
  state.hands[seat].push(stolen);
  state.pending = null;

  // BUGFIX vs v1.5: stealing grows the thief's hand, so recompute their flag too;
  // v1.5 only updated the victim's, which could leave the thief wrongly flagged.
  state.mustCallSynchro[seat] = state.hands[seat].length === 1;
  state.mustCallSynchro[opp] = state.hands[opp].length === 1;

  queueBarracuda(state, opp, stolen);
  setTurn(state, opp);
  return { ok: true, result: { type: 'barracuda', got: stolen } };
}

// Empty a seat's event buffer once those events have been delivered to that seat.
function clearRecap(state, seat) { state.pendingRecap[seat] = emptyRecap(); }

function applySynchro(state, seat) {
  if (state.gameOver) return reject('game-over');
  if (state.pending) return reject('busy'); // matches v1.5: no synchro mid-choice
  const opp = opponentOf(state, seat);

  if (state.mustCallSynchro[seat]) {
    state.mustCallSynchro[seat] = false;
    queueSynchroDeclared(state, opp, state.names[seat]);
    return { ok: true, result: { type: 'synchro-declared' } };
  }
  if (state.mustCallSynchro[opp]) {
    const d = drawInternal(state, opp, 2);
    state.mustCallSynchro[opp] = false;
    queueDraw(state, opp, 'SynchroCatch', d);
    return { ok: true, result: { type: 'synchro-caught', drew: d.length } };
  }
  if (!state.synchroMisuseWarned[seat]) {
    state.synchroMisuseWarned[seat] = true;
    return { ok: true, result: { type: 'synchro-warned' } };
  }
  const d = drawInternal(state, seat, 1);
  return { ok: true, result: { type: 'synchro-penalty', drew: d.length } };
}

module.exports = {
  THEMES, DECK_SIZE,
  buildDeck, makeRng, shuffle, createGame,
  opponentOf, topDiscard, isPlayable, hasPlayable,
  applyPlay, applyDraw, applyChooseTheme, applyResolveKip, applyResolveSteal, applySynchro,
  clearRecap
};
