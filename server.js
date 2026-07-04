'use strict';
/*
  No Mercy Synchro - v2 WebSocket server shell (two-player milestone).

  The only file that depends on the `ws` package and the only one that opens a socket.
  Deliberately thin: it parses incoming JSON, hands it to the RoomManager, and pipes each
  seat's outgoing messages to its socket. All the actual logic lives in rooms.js (and,
  from step 4, engine.js), which is why this file has no tests of its own; the brains it
  drives are already proven headlessly.

  Run on deploy:  npm install  &&  node server.js
  (Render sets PORT in the environment; locally it defaults to 8080.)

  This one process serves BOTH the client page (any GET request returns the HTML) and the
  WebSocket, so a single Render service and a single URL cover the whole game. The client
  derives its own ws/wss address from wherever it was loaded, so nothing is hard-coded.
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { RoomManager } = require('./rooms.js');

const PORT = process.env.PORT || 8080;
const GRACE_MS = 45000; // grace period before a dropped in-game seat is given up (~45s)
const CLIENT_FILE = path.join(__dirname, 'no-mercy-synchro-client.html');

let CLIENT_HTML = '';
try { CLIENT_HTML = fs.readFileSync(CLIENT_FILE); }
catch (e) { console.error('WARNING: could not read client HTML at ' + CLIENT_FILE + ' (' + e.message + ')'); }

const mgr = new RoomManager();

// Any normal GET returns the client page. WebSocket upgrade requests are handled by the
// WebSocketServer attached below, not by this handler, so the two never collide.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(CLIENT_HTML);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', socket => {
  // Wrap the raw socket in the { id, send } shape the RoomManager expects.
  const conn = {
    id: crypto.randomUUID(),
    send(obj) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
    }
  };

  socket.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return conn.send({ type: 'error', error: { code: 'bad-json' } }); }

    switch (msg.type) {
      case 'create-room': mgr.createRoom(conn, msg.name); break;
      case 'join-room':   mgr.joinRoom(conn, msg.code, msg.name); break;
      case 'rejoin':      mgr.rejoin(conn, msg.code, msg.token); break;
      case 'play-card':    mgr.playCard(conn, msg.cardId); break;
      case 'draw-card':    mgr.drawCard(conn); break;
      case 'choose-theme': mgr.chooseTheme(conn, msg.theme); break;
      case 'resolve-kip':  mgr.resolveKip(conn, msg.ownCardId, msg.targetIndex); break;
      case 'resolve-steal':mgr.resolveSteal(conn, msg.targetIndex); break;
      case 'synchro':      mgr.synchro(conn); break;
      default: conn.send({ type: 'error', error: { code: 'unknown-message' } });
    }
  });

  socket.on('close', () => {
    const d = mgr.handleDisconnect(conn);
    if (d.graceNeeded) {
      // The room holds the seat; the manager's expireGrace is idempotent, so if this
      // player reconnects first the timer simply does nothing when it fires.
      setTimeout(() => mgr.expireGrace(d.code, d.seat), GRACE_MS);
    }
  });
});

httpServer.listen(PORT, () => console.log('No Mercy Synchro server listening on ' + PORT));
