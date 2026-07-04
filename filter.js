'use strict';
/*
  No Mercy Synchro - v2 personalized-view filter (the heart of the phase).

  gameViewFor(state, seat) turns the full server-side game state into the slice a single
  seat is allowed to see:
    - your own hand, in full
    - every opponent as a name and card count only, never card identities
    - shared public table state (discard top, theme, number, whose turn, deck COUNT)
    - your own live event buffer (things done to you), which only ever references cards
      you are entitled to see (your own that moved, or ones that arrived in your hand)

  It deliberately does NOT expose: any opponent's card identities, the deck contents,
  session tokens, or the opponent's Synchro flag (knowing whether they forgot to call
  would make catching risk-free and kill the mechanic; you only see your own flag).

  This is the one module whose correctness IS the security of the game, so it is tested
  hard in filtersim.js (leak + correctness over randomized games) and end to end in
  gamesim.js (two mock clients play a whole game from these views alone).
*/

const { topDiscard } = require('./engine.js');

function publicCard(c) {
  const o = { id: c.id, theme: c.theme, type: c.type };
  if (c.type === 'number') o.value = c.value;
  return o;
}

// Convert a seat's structured event buffer into a flat, client-friendly list.
// Every card referenced here is one the seat is entitled to see.
function clientEvents(recap) {
  const out = [];
  if (!recap) return out;
  if (recap.balletCount > 0) out.push({ kind: 'ballet', count: recap.balletCount });
  for (const ex of recap.exchanges) {
    if (ex.kind === 'kip') {
      out.push({ kind: 'kip', gaveAway: publicCard(ex.gaveAway), received: publicCard(ex.received) });
    } else if (ex.kind === 'barracuda') {
      out.push({ kind: 'barracuda', takenFromYou: publicCard(ex.takenFromYou) });
    }
  }
  if (recap.draw) out.push({ kind: 'draw', count: recap.draw.count, sources: recap.draw.sources.map(s => ({ source: s.source, count: s.count })) });
  for (const n of recap.synchroNotes) out.push({ kind: 'synchro-declared', by: n.by });
  return out;
}

function gameViewFor(state, seat) {
  const opponents = [];
  for (let i = 0; i < state.hands.length; i++) {
    if (i === seat) continue;
    opponents.push({ seat: i, name: state.names[i], cardCount: state.hands[i].length });
  }

  // A pending choice: if it's yours, the client needs to know which picker to show.
  // If it's the opponent's, the client only learns that someone is choosing and what
  // kind (the played action card is already face-up on the discard, so its type is public).
  let choice = null;
  let waitingOn = null;
  if (state.pending) {
    if (state.pending.playerIdx === seat) choice = state.pending.type;
    else waitingOn = { seat: state.pending.playerIdx, kind: state.pending.type };
  }

  const view = {
    turn: state.turn,
    yourTurn: state.turn === seat && !state.gameOver && !state.pending,
    theme: state.theme,
    number: state.number,
    discardTop: publicCard(topDiscard(state)),
    deckCount: state.deck.length,
    hand: state.hands[seat].map(publicCard),
    opponents,
    choice,
    waitingOn,
    mustCallSynchro: state.mustCallSynchro[seat], // your own flag only; derivable from your own hand
    events: clientEvents(state.pendingRecap[seat]),
    gameOver: state.gameOver,
    winner: state.gameOver ? state.winner : null
  };

  // Post-game reveal: once (and ONLY once) the game is truly over, every hand is opened,
  // same as v1.5's end screen. Hiding no longer matters, and it's a deliberate reveal, so
  // this is the one place opponent cards are allowed to leave the server.
  if (state.gameOver) {
    view.finalHands = state.hands.map((h, i) => ({ seat: i, name: state.names[i], cards: h.map(publicCard) }));
  }

  return view;
}

module.exports = { gameViewFor, publicCard, clientEvents };
