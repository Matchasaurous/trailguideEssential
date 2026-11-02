// Test backend for the end-to-end run (Firebase emulators cannot be downloaded
// in this sandbox). It provides:
//   * a WebSocket "Realtime Database + Auth" that enforces database.rules.json
//     through the targaryen rules simulator on every read, listen and write;
//   * an HTTP endpoint that runs the real Apps Script file against fake Drive.
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { createGasRuntime } from '../gas-harness.mjs';

const require = createRequire(import.meta.url);
const targaryen = require('targaryen');
const rules = JSON.parse(readFileSync(new URL('../../database.rules.json', import.meta.url), 'utf8'));

// disconnectDelayMs: how long the server takes to notice a dropped client before
// running its onDisconnect operations. Real servers can take far longer after a
// network drop; a delay makes the "stale onDisconnect" race happen on every reload.
export function startFakeBackend({ wsPort = 8787, gasPort = 8788, disconnectDelayMs = 1500 } = {}) {
  let database = targaryen.database(rules, null);
  const users = new Map();          // email -> {uid, email, password, displayName}
  const tokens = new Map();         // token -> uid
  const listeners = new Map();      // conn -> Map(lid -> {path, last})
  const disconnectOps = new Map();  // conn -> Map(path -> {token})
  const log = { denied: [] };

  const valueAt = (path) => {
    const v = database.snapshot(path).val();
    return v === undefined ? null : v;
  };
  const authFor = (token) => (token && tokens.has(token) ? { uid: tokens.get(token), provider: 'password' } : null);
  const asUser = (auth) => (auth ? database.as(auth) : targaryen.database(rules, null));

  function canRead(auth, path) {
    if (!auth) return false;
    return database.as(auth).read(path, { now: Date.now() }).allowed;
  }

  function notify() {
    for (const [conn, subs] of listeners) {
      for (const [lid, sub] of subs) {
        if (!canRead(sub.auth, sub.path)) {
          subs.delete(lid);
          conn.send(JSON.stringify({ lid, cancel: 'PERMISSION_DENIED' }));
          continue;
        }
        const value = valueAt(sub.path);
        const json = JSON.stringify(value);
        if (json !== sub.last) {
          sub.last = json;
          conn.send(JSON.stringify({ lid, value }));
        }
      }
    }
  }

  function write(auth, op, path, value) {
    if (!auth) return 'PERMISSION_DENIED';
    const now = Date.now();
    const res = op === 'update'
      ? database.as(auth).update(path, value, now)
      : database.as(auth).write(path, value, { now });
    if (!res.allowed) {
      log.denied.push({ uid: auth.uid, op, path, at: Date.now(), info: res.info });
      return 'PERMISSION_DENIED';
    }
    database = res.newDatabase;
    notify();
    return null;
  }

  function issueToken(uid) {
    const token = `fake.${uid}.${crypto.randomBytes(64).toString('hex')}`;
    tokens.set(token, uid);
    return token;
  }

  const wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1' });
  wss.on('connection', (conn) => {
    listeners.set(conn, new Map());
    disconnectOps.set(conn, new Map());

    conn.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const reply = (body) => conn.send(JSON.stringify({ id: msg.id, ...body }));
      const auth = authFor(msg.token);
      try {
        switch (msg.op) {
          case 'signup': {
            if (users.has(msg.email)) return reply({ error: 'auth/email-already-in-use' });
            if (!msg.password || msg.password.length < 6) return reply({ error: 'auth/weak-password' });
            const uid = `u${crypto.randomBytes(6).toString('hex')}`;
            users.set(msg.email, { uid, email: msg.email, password: msg.password, displayName: null });
            return reply({ user: { uid, email: msg.email, displayName: null }, token: issueToken(uid) });
          }
          case 'signin': {
            const u = users.get(msg.email);
            if (!u || u.password !== msg.password) return reply({ error: 'auth/invalid-credential' });
            return reply({ user: { uid: u.uid, email: u.email, displayName: u.displayName }, token: issueToken(u.uid) });
          }
          case 'resume': {
            if (!auth) return reply({ user: null });
            const u = [...users.values()].find((x) => x.uid === auth.uid);
            return reply({ user: u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null });
          }
          case 'profile': {
            const u = auth && [...users.values()].find((x) => x.uid === auth.uid);
            if (u) u.displayName = msg.displayName;
            return reply({ ok: true });
          }
          case 'set':
          case 'update': {
            const err = write(auth, msg.op, msg.path, msg.value);
            return reply(err ? { error: err } : { ok: true });
          }
          case 'get': {
            if (!canRead(auth, msg.path)) return reply({ error: 'PERMISSION_DENIED' });
            return reply({ value: valueAt(msg.path) });
          }
          case 'listen': {
            if (!canRead(auth, msg.path)) {
              conn.send(JSON.stringify({ lid: msg.lid, cancel: 'PERMISSION_DENIED' }));
              return;
            }
            const value = valueAt(msg.path);
            listeners.get(conn).set(msg.lid, { path: msg.path, auth, last: JSON.stringify(value) });
            conn.send(JSON.stringify({ lid: msg.lid, value }));
            return;
          }
          case 'unlisten':
            listeners.get(conn).delete(msg.lid);
            return;
          case 'onDisconnect': {
            const ops = disconnectOps.get(conn);
            if (msg.action === 'cancel') ops.delete(msg.path);
            else ops.set(msg.path, { token: msg.token });
            return reply({ ok: true });
          }
          default:
            return reply({ error: `unknown op ${msg.op}` });
        }
      } catch (err) {
        reply({ error: err.message });
      }
    });

    conn.on('close', () => {
      const ops = disconnectOps.get(conn);
      listeners.delete(conn);
      disconnectOps.delete(conn);
      setTimeout(() => {
        for (const [path, { token }] of ops) write(authFor(token), 'set', path, null);
      }, disconnectDelayMs);
    });
  });

  // Apps Script endpoint backed by the same membership data.
  const members = new Proxy({}, { get: (_, gid) => valueAt(`groups/${String(gid)}/members`) || {} });
  const gas = createGasRuntime({ members });
  const httpServer = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    // OSRM-compatible routing mock: /routed-{profile}/route/v1/driving/lng,lat;lng,lat
    const route = /^\/routed-(car|bike|foot)\/route\/v1\/driving\/([-\d.]+),([-\d.]+);([-\d.]+),([-\d.]+)/.exec(req.url || '');
    if (route) {
      log.routeRequests = (log.routeRequests || 0) + 1;
      const [, profile, lng1, lat1, lng2, lat2] = route;
      const toRad = (d) => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      const meters = 2 * 6371000 * Math.asin(Math.sqrt(a)) * 1.25;
      const speed = { car: 8, bike: 4, foot: 1.3 }[profile];
      res.writeHead(200, cors);
      return res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: meters, duration: meters / speed }] }));
    }
    if (req.method !== 'POST') {
      res.writeHead(req.method === 'OPTIONS' ? 405 : 200, cors);
      return res.end(JSON.stringify(gas.doGet()));
    }
    // Apps Script cannot answer CORS preflights; a preflight here means the client
    // sent a non-simple request, so record it as a failure.
    if (!/^text\/plain/.test(req.headers['content-type'] || '')) {
      log.badContentType = (log.badContentType || 0) + 1;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, cors);
      res.end(JSON.stringify(gas.doPost(body)));
    });
  });
  httpServer.listen(gasPort, '127.0.0.1');

  return {
    gas,
    log,
    value: valueAt,
    close: () => new Promise((resolve) => { wss.close(); httpServer.close(() => resolve()); })
  };
}
