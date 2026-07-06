'use strict';
/*
  No Mercy Synchro - server-side game engine.

  Pure game rules. No DOM, no networking, no rendering. The room layer owns
  seats, sockets, and approval flow; this file owns only the card rules and the
  private game state those rules mutate.
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
  return { skips: [], exchanges: [], draw: null, synchroNotes: [] };
}
function queueSkip(state, seat, source) {
  if (!isSeatActive(state, seat)) return;
  state.pendingRecap[seat].skips.push({ source });
}
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
function queueSynchroDeclared(state, seat, by) {
  if (!isSeatActive(state, seat)) return;
  state.pendingRecap[seat].synchroNotes.push({ type: 'declared', by });
}

/* ---------- setup ---------- */
function createGame(names, opts) {
  opts = opts || {};
  names = Array.isArray(names) && names.length >= 2 ? names : ['Swimmer 1', 'Swimmer 2'];
  const rng = opts.rng || Math.random;
  const deck = shuffle(buildDeck(), rng);
  const playerCount = names.length;
  const state = {
    names: names.map((name, i) => name || `Swimmer ${i + 1}`),
    hands: Array.from({ length: playerCount }, () => []),
    active: Array.from({ length: playerCount }, () => true),
    deck,
    discard: [],
    theme: null,
    number: null,
    turn: 0,
    direction: 1,
    drawnThisTurn: false,
    pending: null,              // null | {type:'theme'|'kip', effect?, playerIdx, target}
    mustCallSynchro: Array.from({ length: playerCount }, () => false),
    synchroMisuseWarned: Array.from({ length: playerCount }, () => false),
    pendingRecap: Array.from({ length: playerCount }, () => emptyRecap()),
    gameOver: false,
    winner: null,
    rng
  };
  for (let i = 0; i < 7; i++) {
    for (let seat = 0; seat < playerCount; seat++) state.hands[seat].push(deck.pop());
  }
  const starterIdx = deck.findIndex(c => c.type === 'number');
  const starter = deck.splice(starterIdx, 1)[0];
  state.discard = [starter];
  state.theme = starter.theme;
  state.number = starter.value;
  return state;
}

/* ---------- helpers ---------- */
function mod(n, m) { return ((n % m) + m) % m; }
function topDiscard(state) { return state.discard[state.discard.length - 1]; }
function isSeatIndex(state, seat) {
  return Number.isInteger(seat) && seat >= 0 && seat < state.hands.length;
}
function isSeatActive(state, seat) {
  return isSeatIndex(state, seat) && state.active[seat] !== false;
}
function activeSeatCount(state) {
  let count = 0;
  for (let i = 0; i < state.hands.length; i++) if (isSeatActive(state, i)) count++;
  return count;
}
function nextPresentSeat(state, seat, direction) {
  if (!state || !state.hands.length) return null;
  const dir = (direction === undefined ? state.direction : direction) === -1 ? -1 : 1;
  let idx = mod(seat, state.hands.length);
  for (let i = 0; i < state.hands.length; i++) {
    idx = mod(idx + dir, state.hands.length);
    if (isSeatActive(state, idx)) return idx;
  }
  return null;
}
function opponentOf(state, seat) { return nextPresentSeat(state, seat); } // compatibility alias
function pendingTarget(state, pending) {
  const p = pending || state.pending;
  if (!p) return null;
  if (isSeatActive(state, p.target)) return p.target;
  return nextPresentSeat(state, p.playerIdx);
}
function forEachOtherActive(state, seat, fn) {
  for (let i = 0; i < state.hands.length; i++) {
    if (i !== seat && isSeatActive(state, i)) fn(i);
  }
}
function isPlayable(state, card) {
  if (card.theme === null) return true;
  const top = topDiscard(state);
  if (card.theme === state.theme) return true;
  if (card.type === 'number' && top.type === 'number' && card.value === state.number) return true;
  if (card.type !== 'number' && card.type === top.type) return true;
  return false;
}
function hasPlayable(state, seat) { return state.hands[seat].some(c => isPlayable(state, c)); }
function setTurn(state, seat) {
  if (seat === null || seat === undefined) return;
  let next = seat;
  if (!isSeatActive(state, next)) next = nextPresentSeat(state, next);
  if (next === null) return;
  state.turn = next;
  state.drawnThisTurn = false;
}
function reject(code) { return { ok: false, error: { code } }; }

function drawInternal(state, seat, n) {
  const drawn = [];
  if (!isSeatIndex(state, seat)) return drawn;
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

function resolveAbandonedPending(state, pending) {
  state.pending = null;
  const target = pendingTarget(state, pending);
  if (target === null) return;
  if (pending.type === 'theme') {
    state.number = null;
    if (pending.effect === 'drawFour') {
      const d = drawInternal(state, target, 4);
      queueDraw(state, target, 'Tower', d);
      setTurn(state, nextPresentSeat(state, target));
    } else {
      setTurn(state, target);
    }
    return;
  }
  if (pending.type === 'kip') setTurn(state, target);
}

function setSeatActive(state, seat, active) {
  if (!isSeatIndex(state, seat)) return { ok: false, activeCount: activeSeatCount(state) };
  const wasActive = isSeatActive(state, seat);
  state.active[seat] = !!active;
  if (active) return { ok: true, changed: !wasActive, activeCount: activeSeatCount(state) };

  state.mustCallSynchro[seat] = false;
  if (state.pending) {
    if (state.pending.playerIdx === seat) resolveAbandonedPending(state, state.pending);
    else if (state.pending.target === seat) state.pending.target = pendingTarget(state);
  }
  if (!state.gameOver && state.turn === seat) setTurn(state, nextPresentSeat(state, seat));
  return { ok: true, changed: wasActive, activeCount: activeSeatCount(state) };
}

// Guard shared by the plain turn actions (play / draw). Choice-resolving actions
// use their own guard since a pending choice is expected there.
function ensureActable(state, seat) {
  if (state.gameOver) return reject('game-over');
  if (!isSeatActive(state, seat)) return reject('seat-inactive');
  if (activeSeatCount(state) < 2) return reject('not-enough-active-players');
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
    state.mustCallSynchro[seat] = false;
    state.gameOver = true;
    state.winner = seat;
    return { ok: true, result: { type: 'win' } };
  }
  state.mustCallSynchro[seat] = hand.length === 1;

  const target = nextPresentSeat(state, seat);
  switch (card.type) {
    case 'number':
      setTurn(state, target);
      return { ok: true };
    case 'skip': {
      state.theme = card.theme; state.number = null;
      const activeBeforeReverse = activeSeatCount(state);
      state.direction = state.direction === 1 ? -1 : 1;
      if (activeBeforeReverse === 2) {
        const skipped = nextPresentSeat(state, seat);
        if (skipped !== null && skipped !== seat) queueSkip(state, skipped, 'Ballet Leg');
        setTurn(state, seat);
      } else {
        setTurn(state, nextPresentSeat(state, seat));
      }
      return { ok: true, result: { type: 'reverse', direction: state.direction } };
    }
    case 'drawTwo': {
      state.theme = card.theme; state.number = null;
      const d = drawInternal(state, target, 2);
      queueDraw(state, target, 'Tub', d);
      setTurn(state, nextPresentSeat(state, target));
      return { ok: true };
    }
    case 'drawFour':
      state.pending = { type: 'theme', effect: 'drawFour', playerIdx: seat, target };
      return { ok: true, pending: 'theme' };
    case 'wild':
      state.pending = { type: 'theme', effect: 'wild', playerIdx: seat, target };
      return { ok: true, pending: 'theme' };
    case 'swap':
      state.pending = { type: 'kip', playerIdx: seat, target };
      return { ok: true, pending: 'kip' };
    case 'steal':
      queueSkip(state, target, 'Barracuda');
      setTurn(state, nextPresentSeat(state, target));
      return { ok: true, result: { type: 'skip', source: 'Barracuda', skipped: target } };
    case 'twist': {
      let low = Infinity;
      for (let i = 0; i < state.hands.length; i++) {
        if (isSeatActive(state, i)) low = Math.min(low, state.hands[i].length);
      }
      let hits = [];
      for (let i = 0; i < state.hands.length; i++) {
        if (isSeatActive(state, i) && state.hands[i].length === low) hits.push(i);
      }
      if (hits.length > 1 && hits.indexOf(seat) !== -1) hits = hits.filter(i => i !== seat);

      const hitResults = [];
      for (const hit of hits) {
        const d = drawInternal(state, hit, 2);
        hitResults.push({ seat: hit, name: state.names[hit], drew: d.length });
        if (hit !== seat) queueDraw(state, hit, 'Oyster', d);
      }
      setTurn(state, target);
      const selfHit = hitResults.find(h => h.seat === seat);
      if (selfHit) return { ok: true, result: { type: 'oyster-self', drew: selfHit.drew } };
      return { ok: true, result: { type: 'oyster-hit', hits: hitResults } };
    }
  }
  return reject('unknown-card');
}

function applyDraw(state, seat) {
  const guard = ensureActable(state, seat);
  if (guard) return guard;
  if (state.drawnThisTurn) return reject('already-drew');
  if (hasPlayable(state, seat)) return reject('must-play');
  const drawn = drawInternal(state, seat, 1);
  state.drawnThisTurn = true;
  const stillStuck = !hasPlayable(state, seat);
  if (stillStuck) setTurn(state, nextPresentSeat(state, seat));
  return { ok: true, result: { type: 'draw', drew: drawn[0] || null, canPlay: !stillStuck } };
}

function applyChooseTheme(state, seat, theme) {
  if (state.gameOver) return reject('game-over');
  if (!isSeatActive(state, seat)) return reject('seat-inactive');
  const p = state.pending;
  if (!p || p.type !== 'theme') return reject('no-pending-theme');
  if (seat !== p.playerIdx) return reject('not-your-choice');
  if (THEMES.indexOf(theme) === -1) return reject('bad-theme');
  const target = pendingTarget(state, p);
  if (target === null) return reject('no-target');
  state.pending = null;
  state.theme = theme; state.number = null;
  if (p.effect === 'drawFour') {
    const d = drawInternal(state, target, 4);
    queueDraw(state, target, 'Tower', d);
    setTurn(state, nextPresentSeat(state, target));
  } else {
    setTurn(state, target);
  }
  return {
    ok: true,
    result: {
      type: 'theme-changed',
      public: true,
      bySeat: seat,
      byName: state.names[seat],
      theme,
      source: p.effect === 'drawFour' ? 'Tower' : 'Blossom'
    }
  };
}

function applyResolveKip(state, seat, ownCardId, targetIndex) {
  if (state.gameOver) return reject('game-over');
  if (!isSeatActive(state, seat)) return reject('seat-inactive');
  const p = state.pending;
  if (!p || p.type !== 'kip') return reject('no-pending-kip');
  if (seat !== p.playerIdx) return reject('not-your-choice');
  const target = pendingTarget(state, p);
  if (target === null || target === seat) return reject('no-target');
  const ownIdx = state.hands[seat].findIndex(c => c.id === ownCardId);
  if (ownIdx === -1) return reject('no-such-card');
  if (targetIndex < 0 || targetIndex >= state.hands[target].length) return reject('bad-target-index');

  const ownCard = state.hands[seat].splice(ownIdx, 1)[0];
  const targetCard = state.hands[target].splice(targetIndex, 1)[0];
  state.hands[seat].push(targetCard);
  state.hands[target].push(ownCard);
  state.pending = null;

  queueKip(state, target, targetCard, ownCard);
  setTurn(state, target);
  return { ok: true, result: { type: 'kip', gaveAway: ownCard, received: targetCard } };
}

function applyResolveSteal(state) {
  if (state.gameOver) return reject('game-over');
  return reject('no-pending-steal');
}

// Empty a seat's event buffer once those events have been delivered to that seat.
function clearRecap(state, seat) { state.pendingRecap[seat] = emptyRecap(); }

function applySynchro(state, seat) {
  if (state.gameOver) return reject('game-over');
  if (!isSeatActive(state, seat)) return reject('seat-inactive');
  if (state.pending) return reject('busy');

  if (state.mustCallSynchro[seat]) {
    state.mustCallSynchro[seat] = false;
    forEachOtherActive(state, seat, other => queueSynchroDeclared(state, other, state.names[seat]));
    return { ok: true, result: { type: 'synchro-declared' } };
  }

  const caught = [];
  forEachOtherActive(state, seat, other => {
    if (!state.mustCallSynchro[other]) return;
    const d = drawInternal(state, other, 2);
    state.mustCallSynchro[other] = false;
    queueDraw(state, other, 'SynchroCatch', d);
    caught.push({ seat: other, name: state.names[other], drew: d.length });
  });
  if (caught.length) {
    const drew = caught.reduce((sum, c) => sum + c.drew, 0);
    return { ok: true, result: { type: 'synchro-caught', caught, drew } };
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
  opponentOf, nextPresentSeat, pendingTarget, topDiscard,
  isSeatActive, activeSeatCount, setSeatActive,
  isPlayable, hasPlayable,
  applyPlay, applyDraw, applyChooseTheme, applyResolveKip, applyResolveSteal, applySynchro,
  clearRecap
};
