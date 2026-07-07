'use strict';

const assert = require('assert');
const engine = require('./engine.js');
const { RoomManager } = require('./rooms.js');

function makeCard(id, type, theme, value) {
  const c = { id, type, theme: theme === undefined ? null : theme };
  if (type === 'number') c.value = value === undefined ? 1 : value;
  return c;
}

function clientPlayable(g, card) {
  if (card.theme === null) return true;
  if (card.theme === g.theme) return true;
  if (card.type === 'number' && g.discardTop.type === 'number' && card.value === g.number) return true;
  if (card.type !== 'number' && card.type === g.discardTop.type) return true;
  return false;
}

function assertNoSpectatorLeak(msg) {
  if (!msg || msg.type !== 'state' || msg.role !== 'display' || !msg.game) return;
  assert.strictEqual(Object.prototype.hasOwnProperty.call(msg.game, 'hand'), false, 'display received a hand');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(msg.game, 'events'), false, 'display received private events');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(msg.game, 'mustCallSynchro'), false, 'display received synchro flag');
  if (!msg.game.gameOver) assert.strictEqual(Object.prototype.hasOwnProperty.call(msg.game, 'finalHands'), false, 'display received finalHands early');
}

function assertNoPlayerLeak(msg) {
  if (!msg || msg.type !== 'state' || msg.role !== 'player' || !msg.game) return;
  assert(Array.isArray(msg.game.hand), 'player view missing own hand');
  assert(Array.isArray(msg.game.opponents), 'player view missing opponents');
  for (const opp of msg.game.opponents) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(opp, 'cards'), false, 'opponent cards leaked');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(opp, 'hand'), false, 'opponent hand leaked');
  }
  if (!msg.game.gameOver) assert.strictEqual(Object.prototype.hasOwnProperty.call(msg.game, 'finalHands'), false, 'player received finalHands early');
}

function conn(label) {
  return {
    label,
    messages: [],
    lastState: null,
    send(obj) {
      this.messages.push(obj);
      assertNoPlayerLeak(obj);
      assertNoSpectatorLeak(obj);
      if (obj.type === 'state') this.lastState = obj;
    }
  };
}

function testReverseAndBarracuda() {
  const g3 = engine.createGame(['A', 'B', 'C'], { rng: engine.makeRng(1) });
  g3.turn = 0;
  g3.direction = 1;
  g3.theme = 'tiedye';
  g3.number = 5;
  g3.discard = [makeCard(900, 'number', 'tiedye', 5)];
  g3.hands[0] = [makeCard(1, 'skip', 'tiedye'), makeCard(2, 'number', 'tiedye', 7)];
  const reverse = engine.applyPlay(g3, 0, 1);
  assert(reverse.ok, '3-player reverse should play');
  assert.strictEqual(g3.direction, -1, 'Ballet Leg should reverse direction');
  assert.strictEqual(g3.turn, 2, '3-player reverse should pass to previous player');

  const g2 = engine.createGame(['A', 'B'], { rng: engine.makeRng(2) });
  g2.turn = 0;
  g2.direction = 1;
  g2.theme = 'tiedye';
  g2.number = 5;
  g2.discard = [makeCard(901, 'number', 'tiedye', 5)];
  g2.hands[0] = [makeCard(3, 'skip', 'tiedye'), makeCard(4, 'number', 'tiedye', 7)];
  const reverse2 = engine.applyPlay(g2, 0, 3);
  assert(reverse2.ok, '2-player reverse should play');
  assert.strictEqual(g2.turn, 0, '2-player reverse should behave like skip');

  const g4 = engine.createGame(['A', 'B', 'C', 'D'], { rng: engine.makeRng(3) });
  g4.turn = 0;
  g4.direction = 1;
  g4.theme = 'tiedye';
  g4.number = 5;
  g4.discard = [makeCard(902, 'number', 'tiedye', 5)];
  g4.hands[0] = [makeCard(5, 'steal', null), makeCard(6, 'number', 'tiedye', 7)];
  const barracuda = engine.applyPlay(g4, 0, 5);
  assert(barracuda.ok, 'Barracuda should play');
  assert.strictEqual(g4.turn, 2, 'Barracuda should skip the next player');
  assert.strictEqual(g4.hands[1].length, 7, 'Barracuda should not steal a card anymore');
}

function testSynchroCatchesMultiple() {
  const g = engine.createGame(['A', 'B', 'C', 'D'], { rng: engine.makeRng(4) });
  g.mustCallSynchro = [false, true, false, true];
  g.hands[1] = [makeCard(10, 'number', 'tiedye', 1)];
  g.hands[2] = [makeCard(11, 'number', 'felt', 1)];
  g.hands[3] = [makeCard(12, 'number', 'greek', 1)];
  const res = engine.applySynchro(g, 0);
  assert(res.ok, 'Synchro catch should apply');
  assert.strictEqual(res.result.caught.length, 2, 'Synchro should catch every flagged one-card player');
  assert.strictEqual(g.hands[1].length, 3, 'First caught player draws 2');
  assert.strictEqual(g.hands[2].length, 1, 'Declared/safe one-card player is not caught');
  assert.strictEqual(g.hands[3].length, 3, 'Second caught player draws 2');
}

function testOysterAllPlayerTieRules() {
  const tiedWithActor = engine.createGame(['A', 'B', 'C'], { rng: engine.makeRng(5) });
  tiedWithActor.turn = 1;
  tiedWithActor.direction = 1;
  tiedWithActor.theme = 'tiedye';
  tiedWithActor.number = 5;
  tiedWithActor.discard = [makeCard(910, 'number', 'tiedye', 5)];
  tiedWithActor.hands[0] = Array.from({ length: 6 }, (_, i) => makeCard(100 + i, 'number', 'felt', 1));
  tiedWithActor.hands[1] = [makeCard(200, 'twist', null)].concat(Array.from({ length: 6 }, (_, i) => makeCard(201 + i, 'number', 'greek', 1)));
  tiedWithActor.hands[2] = Array.from({ length: 7 }, (_, i) => makeCard(300 + i, 'number', 'dream', 1));
  const tiedRes = engine.applyPlay(tiedWithActor, 1, 200);
  assert(tiedRes.ok, 'Oyster tie with actor should play');
  assert.strictEqual(tiedWithActor.hands[0].length, 8, 'Other tied-low swimmer should draw 2');
  assert.strictEqual(tiedWithActor.hands[1].length, 6, 'Actor should not draw when merely tied for low');
  assert.strictEqual(tiedWithActor.hands[2].length, 7, 'Non-low swimmer should not draw');

  const otherTie = engine.createGame(['A', 'B', 'C'], { rng: engine.makeRng(6) });
  otherTie.turn = 0;
  otherTie.theme = 'tiedye';
  otherTie.number = 5;
  otherTie.discard = [makeCard(911, 'number', 'tiedye', 5)];
  otherTie.hands[0] = [makeCard(400, 'twist', null)].concat(Array.from({ length: 7 }, (_, i) => makeCard(401 + i, 'number', 'greek', 1)));
  otherTie.hands[1] = Array.from({ length: 5 }, (_, i) => makeCard(500 + i, 'number', 'felt', 1));
  otherTie.hands[2] = Array.from({ length: 5 }, (_, i) => makeCard(600 + i, 'number', 'dream', 1));
  const otherTieRes = engine.applyPlay(otherTie, 0, 400);
  assert(otherTieRes.ok, 'Oyster other-player tie should play');
  assert.strictEqual(otherTie.hands[1].length, 7, 'First tied-low non-actor should draw 2');
  assert.strictEqual(otherTie.hands[2].length, 7, 'Second tied-low non-actor should draw 2');

  const actorOnlyLow = engine.createGame(['A', 'B', 'C'], { rng: engine.makeRng(7) });
  actorOnlyLow.turn = 0;
  actorOnlyLow.theme = 'tiedye';
  actorOnlyLow.number = 5;
  actorOnlyLow.discard = [makeCard(912, 'number', 'tiedye', 5)];
  actorOnlyLow.hands[0] = [makeCard(700, 'twist', null)].concat(Array.from({ length: 3 }, (_, i) => makeCard(701 + i, 'number', 'greek', 1)));
  actorOnlyLow.hands[1] = Array.from({ length: 6 }, (_, i) => makeCard(800 + i, 'number', 'felt', 1));
  actorOnlyLow.hands[2] = Array.from({ length: 6 }, (_, i) => makeCard(900 + i, 'number', 'dream', 1));
  const selfRes = engine.applyPlay(actorOnlyLow, 0, 700);
  assert(selfRes.ok, 'Oyster actor-only low should play');
  assert.strictEqual(actorOnlyLow.hands[0].length, 5, 'Actor should draw when uniquely lowest');
}

function setupRoom(playerCount, seed) {
  const mgr = new RoomManager({ rng: engine.makeRng(seed), setTimeout: () => null, clearTimeout: () => {} });
  const conns = Array.from({ length: playerCount }, (_, i) => conn('P' + i));
  const first = mgr.createRoom(conns[0], 'P0');
  for (let i = 1; i < playerCount; i++) mgr.joinRoom(conns[i], first.code, 'P' + i);
  return { mgr, conns, code: first.code };
}

function testRoomStartHostDropAndDisplay() {
  const newer = setupRoom(2, 10);
  const older = setupRoom(3, 9);
  assert(newer.code !== older.code || true);

  const display = conn('TV');
  newer.mgr.requestDisplayLatest(display);
  assert(display.messages.some(m => m.type === 'display-pending'), 'display should wait for approval');
  const hostState = newer.conns[0].lastState;
  assert.strictEqual(hostState.displayRequests.length, 1, 'host should see display request');
  newer.mgr.approveDisplay(newer.conns[0], hostState.displayRequests[0].id);
  assert(display.lastState && display.lastState.role === 'display', 'approved display should receive display state');

  newer.mgr.startGame(newer.conns[0]);
  assert(display.lastState.game, 'display should receive public game once started');
  assertNoSpectatorLeak(display.lastState);

  const roomForRematch = newer.mgr.rooms.get(newer.code);
  roomForRematch.phase = 'over';
  roomForRematch.game.gameOver = true;
  roomForRematch.game.winner = 0;
  newer.mgr._enterRematch(roomForRematch);
  // Both present players readying up starts the next hand (unanimous, no host action).
  newer.mgr.rematchReady(newer.conns[0]);
  newer.mgr.rematchReady(newer.conns[1]);
  assert.strictEqual(roomForRematch.phase, 'playing', 'unanimous ready should start a new hand after game over');
  assert.strictEqual(roomForRematch.game.gameOver, false, 'new hand should reset game-over state');

  const drop = setupRoom(3, 11);
  mgrStart(drop);
  const room = drop.mgr.rooms.get(drop.code);
  room.game.turn = 1;
  const token = room.seats[1].token;
  drop.mgr.handleDisconnect(drop.conns[1]);
  drop.mgr.expireGrace(drop.code, 1);
  assert.strictEqual(engine.isSeatActive(room.game, 1), false, 'expired seat should become inactive');
  assert.notStrictEqual(room.game.turn, 1, 'turn should move off expired seat');
  const replacement = conn('P1b');
  drop.mgr.rejoin(replacement, drop.code, token);
  assert.strictEqual(engine.isSeatActive(room.game, 1), true, 'rejoined seat should become active again');
}

function testThemeChangePublicResultAndTowerPrivateDraw() {
  const setup = setupRoom(3, 12);
  const display = conn('TV-theme');
  setup.mgr.requestDisplayLatest(display);
  setup.mgr.approveDisplay(setup.conns[0], setup.conns[0].lastState.displayRequests[0].id);
  mgrStart(setup);
  const room = setup.mgr.rooms.get(setup.code);
  const g = room.game;
  g.turn = 0;
  g.direction = 1;
  g.theme = 'tiedye';
  g.number = 5;
  g.discard = [makeCard(920, 'number', 'tiedye', 5)];
  g.hands[0] = [makeCard(921, 'drawFour', 'tiedye'), makeCard(922, 'number', 'felt', 3)];
  const played = setup.mgr.playCard(setup.conns[0], 921);
  assert(played.ok, 'Tower should play');
  const chosen = setup.mgr.chooseTheme(setup.conns[0], 'dream');
  assert(chosen.ok, 'Tower theme choice should resolve');

  for (const c of setup.conns) {
    assert(c.lastState.game.publicResult, 'player should receive public theme result');
    assert.strictEqual(c.lastState.game.publicResult.type, 'theme-changed');
    assert.strictEqual(c.lastState.game.publicResult.theme, 'dream');
    assert.strictEqual(c.lastState.game.publicResult.source, 'Tower');
  }
  assert(display.lastState.game.publicResult, 'display should receive public theme result');
  assert.strictEqual(display.lastState.game.publicResult.type, 'theme-changed');
  const targetEvents = setup.conns[1].lastState.game.events || [];
  assert(targetEvents.some(e => e.kind === 'draw' && e.count === 4), 'Tower target should still receive private draw event');
}

function mgrStart(setup) {
  const res = setup.mgr.startGame(setup.conns[0]);
  assert(res, 'host should be able to start game');
}

function playRandomGame(playerCount, seed) {
  const setup = setupRoom(playerCount, seed);
  const display = conn('TV-' + seed);
  setup.mgr.requestDisplayLatest(display);
  const request = setup.conns[0].lastState.displayRequests[0];
  setup.mgr.approveDisplay(setup.conns[0], request.id);
  mgrStart(setup);
  const room = setup.mgr.rooms.get(setup.code);

  for (let step = 0; step < 1500 && room.phase === 'playing'; step++) {
    const g = room.game;
    if (g.pending) {
      const actor = g.pending.playerIdx;
      const view = setup.conns[actor].lastState.game;
      if (view.choice === 'theme') setup.mgr.chooseTheme(setup.conns[actor], engine.THEMES[step % engine.THEMES.length]);
      else if (view.choice === 'kip') {
        assert(view.hand.length > 0, 'Kip actor should have a hand');
        const targetCount = view.choiceTarget ? view.choiceTarget.cardCount : 0;
        assert(targetCount > 0, 'Kip target should have cards');
        setup.mgr.resolveKip(setup.conns[actor], view.hand[0].id, step % targetCount);
      } else {
        throw new Error('unknown pending choice ' + view.choice);
      }
      continue;
    }

    const actor = g.turn;
    const view = setup.conns[actor].lastState.game;
    const playable = view.hand.filter(c => clientPlayable(view, c));
    if (playable.length) setup.mgr.playCard(setup.conns[actor], playable[step % playable.length].id);
    else setup.mgr.drawCard(setup.conns[actor]);
  }

  assert.strictEqual(room.phase, 'over', `random ${playerCount}p seed ${seed} did not finish`);
  assert(room.rematch, `random ${playerCount}p seed ${seed} should open a rematch on a clean finish`);
}

function testDrawAndPassPublicNotice() {
  const setup = setupRoom(3, 77);
  const display = conn('TV-draw');
  setup.mgr.requestDisplayLatest(display);
  setup.mgr.approveDisplay(setup.conns[0], setup.conns[0].lastState.displayRequests[0].id);
  mgrStart(setup);
  const room = setup.mgr.rooms.get(setup.code);
  const g = room.game;

  // Rig seat 0 to hold one unplayable card and draw another unplayable card, forcing
  // a draw-and-pass.
  g.turn = 0; g.direction = 1; g.theme = 'tiedye'; g.number = 5;
  g.discard = [makeCard(940, 'number', 'tiedye', 5)];
  g.hands[0] = [makeCard(941, 'number', 'felt', 3)];
  g.deck = [makeCard(942, 'number', 'greek', 8)];

  [0, 1, 2].forEach(i => { setup.conns[i].messages = []; });
  display.messages = [];

  const res = setup.mgr.drawCard(setup.conns[0]);
  assert(res && res.ok, 'draw-and-pass should succeed');

  const drawNotices = c => c.messages.filter(m => m.type === 'state' && m.game && m.game.publicResult && m.game.publicResult.type === 'draw');
  const yourDraws = c => c.messages.filter(m => m.type === 'state' && m.game && m.game.yourResult && m.game.yourResult.type === 'draw');

  // Actor: private draw, no public notice.
  assert(yourDraws(setup.conns[0]).length >= 1, 'drawer should get a private draw result');
  assert.strictEqual(drawNotices(setup.conns[0]).length, 0, 'drawer should not get a public draw notice');

  // Others and the shared display: public notice, named, no card data.
  for (const c of [setup.conns[1], setup.conns[2], display]) {
    const n = drawNotices(c);
    assert(n.length >= 1, c.label + ' should hear the public draw notice');
    const pr = n[n.length - 1].game.publicResult;
    assert.strictEqual(pr.byName, 'P0', 'notice names the drawer');
    assert.strictEqual('drew' in pr, false, 'draw notice must not carry the card');
    assert.strictEqual('id' in pr, false, 'draw notice must not carry a card id');
  }

  assert.notStrictEqual(room.game.turn, 0, 'draw-and-pass should move the turn off the drawer');
}

function endGameInto(setup, winnerSeat) {
  const room = setup.mgr.rooms.get(setup.code);
  room.phase = 'over';
  room.game.gameOver = true;
  room.game.winner = winnerSeat === undefined ? 0 : winnerSeat;
  setup.mgr._enterRematch(room);
  setup.mgr._broadcast(room); // real flow broadcasts via _afterAction right after entry
  return room;
}
function rematchView(c) { return c.lastState.rematch; }

function testRematchUnanimousInProposeWindow() {
  const setup = setupRoom(3, 201);
  mgrStart(setup);
  const room = endGameInto(setup, 0);
  assert(room.rematch, 'rematch should open on a clean finish');
  assert.strictEqual(rematchView(setup.conns[0]).stage, 'proposing', 'starts in the propose window');
  setup.mgr.rematchReady(setup.conns[0]);
  setup.mgr.rematchReady(setup.conns[1]);
  assert.strictEqual(room.phase, 'over', 'not everyone present is ready yet');
  setup.mgr.rematchReady(setup.conns[2]);
  assert.strictEqual(room.phase, 'playing', 'unanimous present ready starts the hand with no host action');
  for (let i = 0; i < 3; i++) assert.strictEqual(engine.isSeatActive(room.game, i), true, 'every ready player is active');
  assert.strictEqual(room.rematch, null, 'rematch state cleared once the hand starts');
}

function testRematchProposeThenAllReady() {
  const setup = setupRoom(3, 202);
  mgrStart(setup);
  const room = endGameInto(setup, 0);
  setup.mgr.rematchPropose(setup.conns[0]);
  assert.strictEqual(room.rematch.proposed, false, 'host cannot propose before the propose window elapses');
  setup.mgr.rematchExpirePropose(setup.code);
  assert.strictEqual(rematchView(setup.conns[0]).canPropose, true, 'host may propose after the window elapses');
  setup.mgr.rematchPropose(setup.conns[0]);
  assert.strictEqual(room.rematch.proposed, true, 'host proposed');
  assert.strictEqual(rematchView(setup.conns[1]).stage, 'deciding', 'others move to the decide stage');
  setup.mgr.rematchReady(setup.conns[0]);
  setup.mgr.rematchReady(setup.conns[1]);
  assert.strictEqual(room.phase, 'over', 'still one holdout');
  setup.mgr.rematchReady(setup.conns[2]);
  assert.strictEqual(room.phase, 'playing', 'clearing the last holdout starts the hand');
}

function testRematchWaitCommitBenchAndReturn() {
  const setup = setupRoom(3, 203);
  mgrStart(setup);
  const room = endGameInto(setup, 0);
  setup.mgr.rematchExpirePropose(setup.code);
  setup.mgr.rematchPropose(setup.conns[0]);
  setup.mgr.rematchReady(setup.conns[0]);
  setup.mgr.rematchReady(setup.conns[1]);
  setup.mgr.rematchWait(setup.conns[2]);
  assert.strictEqual(room.rematch.canCommit, false, 'a Wait tap re-locks commit and restarts the window');
  assert(rematchView(setup.conns[2]).youWaiting, 'P2 shows as waiting');
  setup.mgr.rematchExpireDecide(setup.code);
  assert.strictEqual(rematchView(setup.conns[0]).canCommit, true, 'host may commit once the window elapses with enough ready');
  setup.mgr.rematchCommit(setup.conns[0]);
  assert.strictEqual(room.phase, 'playing', 'commit starts the hand');
  assert.strictEqual(engine.isSeatActive(room.game, 0), true, 'ready host is active');
  assert.strictEqual(engine.isSeatActive(room.game, 1), true, 'ready P1 is active');
  assert.strictEqual(engine.isSeatActive(room.game, 2), false, 'holdout P2 starts benched');
  setup.mgr.imBack(setup.conns[2]);
  assert.strictEqual(engine.isSeatActive(room.game, 2), true, 'I\'m back returns the holdout to active play');
}

function testRematchCommitNeedsEnoughReady() {
  const setup = setupRoom(3, 204);
  mgrStart(setup);
  const room = endGameInto(setup, 0);
  setup.mgr.rematchExpirePropose(setup.code);
  setup.mgr.rematchPropose(setup.conns[0]);
  setup.mgr.rematchReady(setup.conns[0]); // only the host is ready
  setup.mgr.rematchExpireDecide(setup.code);
  assert.strictEqual(rematchView(setup.conns[0]).canCommit, false, 'no commit with fewer than the minimum ready');
  const res = setup.mgr.rematchCommit(setup.conns[0]);
  assert.strictEqual(res, null, 'commit is rejected with too few ready');
  assert.strictEqual(room.phase, 'over', 'table keeps waiting');
}

function testRematchBenchedSeatZeroOpensOnActive() {
  const setup = setupRoom(3, 205);
  mgrStart(setup);
  const room = endGameInto(setup, 1);
  // The original host (seat 0) leaves during the over phase; the host role passes to a
  // present seat, and seat 0 will start the next hand benched.
  setup.mgr.handleDisconnect(setup.conns[0]);
  assert.notStrictEqual(room.hostSeat, 0, 'host passes off the absent seat 0');
  setup.mgr.rematchReady(setup.conns[1]);
  setup.mgr.rematchReady(setup.conns[2]);
  assert.strictEqual(room.phase, 'playing', 'the present players start the hand');
  assert.strictEqual(engine.isSeatActive(room.game, 0), false, 'absent seat 0 starts benched');
  assert(engine.isSeatActive(room.game, room.game.turn), 'opening turn lands on an active seat');
  assert.notStrictEqual(room.game.turn, 0, 'opening turn is not the benched seat 0');
}

function testRematchReadyPublicNotice() {
  const setup = setupRoom(3, 206);
  const display = conn('TV-rm');
  setup.mgr.requestDisplayLatest(display);
  setup.mgr.approveDisplay(setup.conns[0], setup.conns[0].lastState.displayRequests[0].id);
  mgrStart(setup);
  const room = endGameInto(setup, 0);
  [0, 1, 2].forEach(i => { setup.conns[i].messages = []; });
  display.messages = [];
  setup.mgr.rematchReady(setup.conns[1]); // P1 taps in, not unanimous
  const notices = c => c.messages.filter(m => m.type === 'state' && m.game && m.game.publicResult && m.game.publicResult.type === 'rematch-ready');
  assert.strictEqual(notices(setup.conns[1]).length, 0, 'the player who tapped in gets no self toast');
  assert(notices(setup.conns[0]).length >= 1, 'others hear the "in" notice');
  assert(notices(setup.conns[2]).length >= 1, 'others hear the "in" notice');
  assert(notices(display).length >= 1, 'the shared display hears the "in" notice');
  assert.strictEqual(notices(setup.conns[0])[0].game.publicResult.byName, 'P1', 'notice names the ready player');
  assert.notStrictEqual(rematchView(setup.conns[0]).readySeats.indexOf(1), -1, 'roster reflects P1 as ready');
}

function testRematchAbsentBenched() {
  const setup = setupRoom(3, 207);
  mgrStart(setup);
  const room = endGameInto(setup, 0);
  setup.mgr.handleDisconnect(setup.conns[2]); // P2 leaves during the over phase
  setup.mgr.rematchReady(setup.conns[0]);
  setup.mgr.rematchReady(setup.conns[1]);
  assert.strictEqual(room.phase, 'playing', 'unanimous among present players starts the hand');
  assert.strictEqual(engine.isSeatActive(room.game, 2), false, 'absent P2 starts benched');
  assert(engine.isSeatActive(room.game, 0) && engine.isSeatActive(room.game, 1), 'present ready players are active');
}

function testGraceAbandonNoRematch() {
  const setup = setupRoom(2, 208);
  mgrStart(setup);
  const room = setup.mgr.rooms.get(setup.code);
  setup.mgr.handleDisconnect(setup.conns[1]);
  setup.mgr.expireGrace(setup.code, 1);
  assert.strictEqual(room.phase, 'over', 'a two-player drop abandons the hand');
  assert.strictEqual(room.endedReason, 'opponent-left', 'ended as opponent-left');
  assert.strictEqual(room.rematch, null, 'a grace-abandoned hand offers no rematch');
}

function testNudgeBasics() {
  const setup = setupRoom(3, 301);
  mgrStart(setup);
  const room = setup.mgr.rooms.get(setup.code);
  const g = room.game;
  const turn = g.turn;
  const other = (turn + 1) % 3;
  const another = (turn + 2) % 3;

  assert.strictEqual(setup.conns[other].lastState.pacing.canNudge, false, 'no nudge before the window');
  assert.strictEqual(setup.mgr.nudge(setup.conns[other]), null, 'nudge rejected before the window');

  setup.mgr.nudgeWindowExpired(setup.code);
  assert.strictEqual(setup.conns[other].lastState.pacing.canNudge, true, 'others may nudge after the window');
  assert.strictEqual(setup.conns[turn].lastState.pacing.canNudge, false, 'the turn holder cannot nudge itself');

  [0, 1, 2].forEach(i => { setup.conns[i].messages = []; });
  setup.mgr.nudge(setup.conns[other]);
  const nudged = c => c.messages.filter(m => m.type === 'state' && m.game && m.game.publicResult && m.game.publicResult.type === 'nudged');
  const youNudged = c => c.messages.filter(m => m.type === 'state' && m.game && m.game.publicResult && m.game.publicResult.type === 'you-nudged');
  assert(nudged(setup.conns[turn]).length >= 1, 'the target hears the nudge');
  assert.strictEqual(nudged(setup.conns[another]).length, 0, 'bystanders do not hear the nudge');
  assert(youNudged(setup.conns[other]).length >= 1, 'the nudger gets a confirmation');

  assert.strictEqual(setup.conns[other].lastState.pacing.canNudge, false, 'cannot nudge twice in one turn');
  assert.strictEqual(setup.mgr.nudge(setup.conns[other]), null, 'second nudge rejected');
}

function testHostSkip() {
  const setup = setupRoom(3, 302);
  mgrStart(setup);
  const room = setup.mgr.rooms.get(setup.code);
  const g = room.game;
  g.turn = 1; // put the turn on a non-host seat
  setup.mgr._resetTurnPacing(room);
  setup.mgr._broadcast(room);

  setup.mgr.nudgeWindowExpired(setup.code);
  setup.mgr.skipWindowExpired(setup.code);
  assert.strictEqual(setup.conns[2].lastState.pacing.canSkip, false, 'non-host cannot skip');
  assert.strictEqual(setup.conns[0].lastState.pacing.canSkip, true, 'host may skip after the window with three active');
  assert.strictEqual(setup.mgr.skip(setup.conns[2]), null, 'non-host skip rejected');

  [0, 1, 2].forEach(i => { setup.conns[i].messages = []; });
  const res = setup.mgr.skip(setup.conns[0]);
  assert(res && res.ok, 'host skip succeeds');
  assert.strictEqual(engine.isSeatActive(g, 1), false, 'the skipped seat is benched');
  assert.notStrictEqual(g.turn, 1, 'the turn moves off the skipped seat');
  const skippedYou = setup.conns[1].messages.filter(m => m.type === 'state' && m.game && m.game.publicResult && m.game.publicResult.type === 'skipped-you');
  const skippedOthers = setup.conns[0].messages.filter(m => m.type === 'state' && m.game && m.game.publicResult && m.game.publicResult.type === 'skipped');
  assert(skippedYou.length >= 1, 'the skipped player is told directly');
  assert(skippedOthers.length >= 1, 'others are told who was skipped');

  setup.mgr.imBack(setup.conns[1]);
  assert.strictEqual(engine.isSeatActive(g, 1), true, 'the skipped player returns with I\'m back');
}

function testSkipNeedsThreeActive() {
  const setup = setupRoom(2, 303);
  mgrStart(setup);
  const room = setup.mgr.rooms.get(setup.code);
  const g = room.game;
  g.turn = 1;
  setup.mgr._resetTurnPacing(room);
  setup.mgr.nudgeWindowExpired(setup.code);
  setup.mgr.skipWindowExpired(setup.code);
  setup.mgr._broadcast(room);
  assert.strictEqual(setup.conns[0].lastState.pacing.canSkip, false, 'no skip offered at two players');
  assert.strictEqual(setup.mgr.skip(setup.conns[0]), null, 'skip rejected at two players');
  assert.strictEqual(room.phase, 'playing', 'the hand keeps going');
}

function testPacingResetsOnAction() {
  const setup = setupRoom(3, 304);
  mgrStart(setup);
  const room = setup.mgr.rooms.get(setup.code);
  const g = room.game;
  const turn = g.turn;
  setup.mgr.nudgeWindowExpired(setup.code);
  assert.strictEqual(setup.conns[(turn + 1) % 3].lastState.pacing.canNudge, true, 'nudge available while idle');
  // Force the turn holder into a draw-and-pass so we have a guaranteed action.
  g.theme = 'tiedye'; g.number = 5;
  g.discard = [makeCard(950, 'number', 'tiedye', 5)];
  g.hands[turn] = [makeCard(951, 'number', 'felt', 3)];
  g.deck = [makeCard(952, 'number', 'greek', 8)];
  g.drawnThisTurn = false;
  setup.mgr.drawCard(setup.conns[turn]);
  assert.strictEqual(room.turnNudge.nudgeReady, false, 'the idle clock resets after an action');
  assert.strictEqual(setup.conns[(turn + 2) % 3].lastState.pacing.canNudge, false, 'nudge clears after the action');
}

function testPacingClearsOnGameOver() {
  const setup = setupRoom(3, 305);
  mgrStart(setup);
  const room = setup.mgr.rooms.get(setup.code);
  const g = room.game;
  const turn = g.turn;
  setup.mgr.nudgeWindowExpired(setup.code);
  assert(room.turnNudge, 'pacing active mid-hand');
  g.theme = 'tiedye'; g.number = 5;
  g.discard = [makeCard(960, 'number', 'tiedye', 5)];
  g.hands[turn] = [makeCard(961, 'number', 'tiedye', 4)]; // playable last card -> win
  setup.mgr.playCard(setup.conns[turn], 961);
  assert.strictEqual(room.phase, 'over', 'the hand ended');
  assert.strictEqual(room.turnNudge, null, 'pacing is cleared at game over');
}

function testRematchHostProposeAutoReady() {
  const setup = setupRoom(3, 209);
  mgrStart(setup);
  const room = endGameInto(setup, 0);
  setup.mgr.rematchExpirePropose(setup.code);
  setup.mgr.rematchPropose(setup.conns[0]);
  assert(rematchView(setup.conns[0]).youReady, 'the host is counted in just by proposing');
  setup.mgr.rematchReady(setup.conns[1]);
  setup.mgr.rematchReady(setup.conns[2]);
  assert.strictEqual(room.phase, 'playing', 'starts once everyone present is in');
  assert.strictEqual(engine.isSeatActive(room.game, 0), true, 'a host who only proposed is still active');
}

function main() {
  testReverseAndBarracuda();
  testSynchroCatchesMultiple();
  testOysterAllPlayerTieRules();
  testRoomStartHostDropAndDisplay();
  testThemeChangePublicResultAndTowerPrivateDraw();
  testDrawAndPassPublicNotice();
  testRematchUnanimousInProposeWindow();
  testRematchProposeThenAllReady();
  testRematchWaitCommitBenchAndReturn();
  testRematchCommitNeedsEnoughReady();
  testRematchBenchedSeatZeroOpensOnActive();
  testRematchHostProposeAutoReady();
  testRematchReadyPublicNotice();
  testRematchAbsentBenched();
  testGraceAbandonNoRematch();
  testNudgeBasics();
  testHostSkip();
  testSkipNeedsThreeActive();
  testPacingResetsOnAction();
  testPacingClearsOnGameOver();
  for (const players of [3, 4, 5, 6]) {
    for (let i = 0; i < 3; i++) playRandomGame(players, 1000 + players * 10 + i);
  }
  console.log('nplayer-sim ok');
}

main();
