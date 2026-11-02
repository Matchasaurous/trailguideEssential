// Test-only stand-in for firebase/database (the subset Trailguard Essentials uses).
import { call, listen, unlisten } from './conn.js';

const norm = (p) => String(p || '').replace(/^\/+|\/+$/g, '');

class Ref {
  constructor(path, q = null) {
    this.path = norm(path);
    this.key = this.path ? this.path.split('/').pop() : null;
    this._query = q;
  }
  toString() { return this.path; }
}

class Snapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.key = ref.key;
    this._v = value === undefined ? null : value;
  }
  val() { return this._v === null ? null : structuredClone(this._v); }
  exists() { return this._v !== null; }
  forEach(cb) {
    if (this._v && typeof this._v === 'object') {
      for (const k of Object.keys(this._v).sort()) {
        if (cb(new Snapshot(child(this.ref, k), this._v[k])) === true) return true;
      }
    }
    return false;
  }
}

export function getDatabase() { return {}; }
export function connectDatabaseEmulator() {}
export function ref(_db, path = '') { return new Ref(path); }
export function child(r, p) { return new Ref(r.path ? `${r.path}/${norm(p)}` : norm(p)); }
export function serverTimestamp() { return { '.sv': 'timestamp' }; }

const permissionError = (msg) => Object.assign(new Error(`PERMISSION_DENIED: ${msg}`), { code: 'PERMISSION_DENIED' });

export async function set(r, value) {
  try { await call('set', { path: r.path, value: value === undefined ? null : value }); }
  catch (err) { throw err.code === 'PERMISSION_DENIED' ? permissionError(r.path) : err; }
}
export async function update(r, value) {
  try { await call('update', { path: r.path || '/', value }); }
  catch (err) { throw err.code === 'PERMISSION_DENIED' ? permissionError(r.path) : err; }
}
export const remove = (r) => set(r, null);

export async function get(r) {
  try {
    const m = await call('get', { path: r.path });
    return new Snapshot(r, applyQuery(r, m.value));
  } catch (err) {
    throw err.code === 'PERMISSION_DENIED' ? permissionError(r.path) : err;
  }
}

const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
const lastRand = [];
function pushId() {
  let now = Date.now();
  const duplicate = now === lastPushTime;
  lastPushTime = now;
  const ts = new Array(8);
  for (let i = 7; i >= 0; i--) { ts[i] = PUSH_CHARS.charAt(now % 64); now = Math.floor(now / 64); }
  let id = ts.join('');
  if (!duplicate) {
    for (let i = 0; i < 12; i++) lastRand[i] = Math.floor(Math.random() * 64);
  } else {
    let i;
    for (i = 11; i >= 0 && lastRand[i] === 63; i--) lastRand[i] = 0;
    lastRand[i] += 1;
  }
  for (let i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRand[i]);
  return id;
}

export function push(r, value) {
  const c = child(r, pushId());
  if (value === undefined) return c;
  const p = set(c, value).then(() => c);
  return Object.assign(p, { key: c.key, path: c.path });
}

export const limitToLast = (n) => ({ limitToLast: n });
export function query(r, ...constraints) {
  return new Ref(r.path, Object.assign({}, ...constraints));
}
function applyQuery(r, v) {
  if (!r._query || !v || typeof v !== 'object') return v;
  const keys = Object.keys(v).sort().slice(-r._query.limitToLast);
  return Object.fromEntries(keys.map((k) => [k, v[k]]));
}

function subscribe(r, onData, onCancel) {
  if (r.path === '.info/connected') { setTimeout(() => onData(true), 0); return () => {}; }
  if (r.path === '.info/serverTimeOffset') { setTimeout(() => onData(0), 0); return () => {}; }
  let lid = null;
  let closed = false;
  listen(r.path, (m) => {
    if (closed) return;
    if (m.cancel) { if (onCancel) onCancel(permissionError(r.path)); return; }
    onData(applyQuery(r, m.value));
  }).then((id) => { lid = id; if (closed) unlisten(id); });
  return () => { closed = true; if (lid) unlisten(lid); };
}

export function onValue(r, cb, cancel) {
  return subscribe(r, (v) => cb(new Snapshot(r, v)), cancel);
}

function childListener(kind) {
  return (r, cb, cancel) => {
    let prev = {};
    return subscribe(r, (v) => {
      const cur = v && typeof v === 'object' ? v : {};
      for (const k of Object.keys(cur).sort()) {
        const snap = new Snapshot(child(r, k), cur[k]);
        if (!(k in prev)) { if (kind === 'added') cb(snap); }
        else if (JSON.stringify(prev[k]) !== JSON.stringify(cur[k]) && kind === 'changed') cb(snap);
      }
      if (kind === 'removed') {
        for (const k of Object.keys(prev)) if (!(k in cur)) cb(new Snapshot(child(r, k), prev[k]));
      }
      prev = cur;
    }, cancel);
  };
}
export const onChildAdded = childListener('added');
export const onChildChanged = childListener('changed');
export const onChildRemoved = childListener('removed');

export function onDisconnect(r) {
  return {
    remove: () => call('onDisconnect', { path: r.path, action: 'remove' }),
    cancel: () => call('onDisconnect', { path: r.path, action: 'cancel' })
  };
}
