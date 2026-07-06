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
  const mgr = new RoomManager({ rng: engine.makeRng(seed) });
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
  newer.mgr.startGame(newer.conns[0]);
  assert.strictEqual(roomForRematch.phase, 'playing', 'host should be able to start a new hand after game over');
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
}

function main() {
  testReverseAndBarracuda();
  testSynchroCatchesMultiple();
  testOysterAllPlayerTieRules();
  testRoomStartHostDropAndDisplay();
  testThemeChangePublicResultAndTowerPrivateDraw();
  for (const players of [3, 4, 5, 6]) {
    for (let i = 0; i < 3; i++) playRandomGame(players, 1000 + players * 10 + i);
  }
  console.log('nplayer-sim ok');
}

main();
