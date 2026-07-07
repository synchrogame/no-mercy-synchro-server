'use strict';
/*
  No Mercy Synchro personalized/public view filter.

  This module is the visibility boundary. Player views receive their own hand
  and public counts for everyone else. Shared-display views receive only public
  table state and hand counts. Post-game reveal remains the one deliberate
  exception where every hand can be shown.
*/

const { topDiscard, pendingTarget, isSeatActive } = require('./engine.js');

function publicCard(c) {
  const o = { id: c.id, theme: c.theme, type: c.type };
  if (c.type === 'number') o.value = c.value;
  return o;
}

function publicPlayer(state, seat) {
  return {
    seat,
    name: state.names[seat],
    cardCount: state.hands[seat].length,
    active: isSeatActive(state, seat)
  };
}

// Convert a seat's structured event buffer into a flat, client-friendly list.
// Every card referenced here is one the seat is entitled to see.
function clientEvents(recap) {
  const out = [];
  if (!recap) return out;
  if (recap.balletCount > 0) out.push({ kind: 'skip', source: 'Ballet Leg', count: recap.balletCount });
  if (Array.isArray(recap.skips)) {
    for (const s of recap.skips) out.push({ kind: 'skip', source: s.source || 'Skip', count: 1 });
  }
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

function choiceInfoFor(state, seat) {
  if (!state.pending) return { choice: null, choiceTarget: null, waitingOn: null };
  const target = pendingTarget(state);
  if (state.pending.playerIdx === seat) {
    return {
      choice: state.pending.type,
      choiceTarget: target === null ? null : publicPlayer(state, target),
      waitingOn: null
    };
  }
  return {
    choice: null,
    choiceTarget: null,
    waitingOn: {
      seat: state.pending.playerIdx,
      name: state.names[state.pending.playerIdx],
      kind: state.pending.type
    }
  };
}

function basePublicGameView(state) {
  const view = {
    turn: state.turn,
    direction: state.direction,
    theme: state.theme,
    number: state.number,
    discardTop: publicCard(topDiscard(state)),
    deckCount: state.deck.length,
    players: state.hands.map((_, seat) => publicPlayer(state, seat)),
    waitingOn: state.pending ? {
      seat: state.pending.playerIdx,
      name: state.names[state.pending.playerIdx],
      kind: state.pending.type
    } : null,
    gameOver: state.gameOver,
    winner: state.gameOver ? state.winner : null
  };

  if (state.gameOver) {
    view.finalHands = state.hands.map((h, i) => ({ seat: i, name: state.names[i], cards: h.map(publicCard) }));
  }
  return view;
}

function gameViewFor(state, seat) {
  const opponents = [];
  for (let i = 0; i < state.hands.length; i++) {
    if (i === seat) continue;
    opponents.push(publicPlayer(state, i));
  }

  const choice = choiceInfoFor(state, seat);
  const view = Object.assign(basePublicGameView(state), {
    yourTurn: state.turn === seat && !state.gameOver && !state.pending && isSeatActive(state, seat),
    youActive: isSeatActive(state, seat),
    hand: state.hands[seat].map(publicCard),
    opponents,
    choice: choice.choice,
    choiceTarget: choice.choiceTarget,
    waitingOn: choice.waitingOn,
    mustCallSynchro: state.mustCallSynchro[seat],
    events: clientEvents(state.pendingRecap[seat])
  });

  return view;
}

function spectatorGameView(state) {
  return basePublicGameView(state);
}

module.exports = { gameViewFor, spectatorGameView, publicCard, clientEvents };
