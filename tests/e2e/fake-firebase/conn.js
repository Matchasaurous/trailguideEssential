// WebSocket transport to tests/e2e/fake-server.mjs (test-only).
const WS_URL = import.meta.env.VITE_FAKE_WS || 'ws://127.0.0.1:8787';
let ws = null;
let ready = null;
let seq = 0;
let token = null;
const pending = new Map();
const subs = new Map();

export const setToken = (t) => { token = t; };
export const getToken = () => token;

function open() {
  if (ready) return ready;
  ws = new WebSocket(WS_URL);
  ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(msg.error), { code: msg.error }));
      else resolve(msg);
    } else if (msg.lid != null) {
      const cb = subs.get(msg.lid);
      if (cb) cb(msg);
    }
  };
  return ready;
}

export async function call(op, body = {}) {
  await open();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, op, token, ...body }));
  });
}

export async function listen(path, cb) {
  await open();
  const lid = `l${++seq}`;
  subs.set(lid, cb);
  ws.send(JSON.stringify({ op: 'listen', lid, path, token }));
  return lid;
}

export function unlisten(lid) {
  subs.delete(lid);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op: 'unlisten', lid }));
}
