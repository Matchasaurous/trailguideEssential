// Background operation for Trailguard Essentials.
//
// What keeps the app working when it is minimised or the screen is locked:
//
//  * Android (Capacitor): a foreground service started by
//    @capacitor-community/background-geolocation (see native.js watchLocation)
//    keeps the whole app process — GPS, the Firebase connection, incoming
//    push-to-talk audio and the alert listener — running, with a persistent
//    "Trailguard — on duty" notification. While backgrounded, database writes go
//    through native HTTP (native.js restPut) because Android throttles WebView
//    network requests.
//
//  * Web / PWA: browsers do not give service workers or web workers access to
//    GPS, and they suspend pages that are hidden. What the web version CAN do is
//    make sure the last known position still reaches the team: positions taken
//    while offline are kept in an IndexedDB outbox, and the service worker
//    (public/sw-background.js) sends the newest one through Background Sync as
//    soon as connectivity returns — even if the page has been closed by then.
//
// This module owns the outbox and the online/offline state (LocationTracker
// calls saveForLater() when it cannot write, and listens for 'online'), and the
// emergency alarm sound used by SOS, assignment, proximity, review and
// announcement alerts — which keeps sounding on Android with the screen off
// because the foreground service keeps the app running. Alert notifications are
// raised by alerts.js through native.js notify().
//
// Critical alerts (SOS, P1 cases, fire alerts, critical announcements) on
// Android play the system alarm sound on the ALARM stream through the native
// CriticalAlert plugin: the ringer switch (silent / vibrate) does not mute it,
// DND lets alarms through by default, and with "Raise alarm volume" on it is
// raised to at least 80 % while it sounds. On the web, browsers give no way past
// silent mode or DND, so the in-page siren plays and notifications stay on
// screen until handled.
import { vibrate } from './ui.js';
import { ref, onValue } from 'firebase/database';
import { db, config } from './firebase.js';
import { isNative, onAppStateChange, startNativeAlarm, stopNativeAlarm, hasCriticalAlerts } from './native.js';

const DB_NAME = 'trailguard-bg';
const STORE = 'outbox';
export const SYNC_TAG = 'tg-location-sync';

function openOutbox() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'path' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const database = await openOutbox();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    database.close();
  }
}

/** Expiry (ms since epoch) of a Firebase ID token, read from its JWT payload. */
export function tokenExpiry(idToken) {
  try {
    const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Number(payload.exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

export class BackgroundService extends EventTarget {
  /**
   * Events: 'online', 'offline'.
   * @param {{gid: string, uid: string, name: string, getIdToken: () => Promise<string>}} opts
   */
  constructor({ gid, uid, name, getIdToken }) {
    super();
    this.gid = gid;
    this.uid = uid;
    this.name = name;
    this.getIdToken = getIdToken;
    this.connected = true;
    this.unsubs = [];
    this.registration = null;
    this.onOnline = () => this.updateOnline();
    this.onOffline = () => this.updateOnline();
  }

  /** 'native' when an Android foreground service keeps the app alive, else 'web'. */
  get mode() {
    return isNative ? 'native' : 'web';
  }

  get supportsBackgroundSync() {
    return !!(this.registration && 'sync' in this.registration);
  }

  isOnline() {
    return this.connected && (typeof navigator === 'undefined' || navigator.onLine !== false);
  }

  async start() {
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    this.unsubs.push(() => {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    });
    // The Realtime Database connection is the truth for "can we write now".
    this.unsubs.push(onValue(ref(db, '.info/connected'), (snap) => {
      this.connected = snap.val() === true;
      this.updateOnline();
    }));
    // Coming back to the foreground is a good moment to retry.
    this.unsubs.push(onAppStateChange((foreground) => { if (foreground) this.updateOnline(true); }));

    if (!isNative && 'serviceWorker' in navigator) {
      // getRegistration() resolves at once, also when no service worker is
      // installed (dev server); the PWA build registers one on first load.
      this.registration = (await navigator.serviceWorker.getRegistration().catch(() => null)) || null;
      if (!this.registration) {
        navigator.serviceWorker.ready.then((reg) => { this.registration = reg; }).catch(() => {});
      }
    }
  }

  updateOnline(force = false) {
    const online = this.isOnline();
    if (online !== this.wasOnline || force) {
      this.wasOnline = online;
      this.dispatchEvent(new Event(online ? 'online' : 'offline'));
    }
  }

  /**
   * Keep the newest value for a database path until it can be written.
   * payload uses REST server values ({".sv":"timestamp"}).
   */
  async saveForLater(path, payload) {
    let idToken = '';
    try { idToken = await this.getIdToken(); } catch { /* offline token refresh can fail */ }
    const record = {
      path,
      payload,
      idToken,
      exp: idToken ? tokenExpiry(idToken) : 0,
      dbUrl: config.firebase.databaseURL.replace(/\/+$/, ''),
      savedAt: Date.now()
    };
    await withStore('readwrite', (store) => store.put(record)).catch((err) => console.warn('Outbox write failed', err));
    if (this.supportsBackgroundSync) {
      try { await this.registration.sync.register(SYNC_TAG); } catch { /* permission or support */ }
    }
  }

  /** The page wrote a fresher value itself; drop the queued one. */
  async clear(path) {
    await withStore('readwrite', (store) => store.delete(path)).catch(() => {});
  }

  async clearAll() {
    await withStore('readwrite', (store) => store.clear()).catch(() => {});
  }

  async stop({ clearOutbox = false } = {}) {
    for (const unsub of this.unsubs) { try { unsub(); } catch { /* ignore */ } }
    this.unsubs = [];
    if (clearOutbox) await this.clearAll();
  }
}

/* ============================== Alarm sound ============================== */

const LS_ALARM_MUTED = 'trailguard.alarmMuted';
const LS_ALARM_FORCE_VOLUME = 'trailguard.alarmForceVolume';

/**
 * Emergency alarm: a two-tone siren (Web Audio) plus vibration. The sound can be
 * muted per device (vibration and the visual alert always stay on), e.g. for a
 * dispatcher at a desk. Browsers only allow sound after a first tap: call
 * unlock() from a user gesture.
 */
export class Alarm extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.timer = null;
    this.level = null;   // 'urgent' (SOS, P1) | 'normal'
    this.critical = false;
    this.nativeOn = false;
    try { this.muted = localStorage.getItem(LS_ALARM_MUTED) === '1'; } catch { this.muted = false; }
    try { this.forceVolume = localStorage.getItem(LS_ALARM_FORCE_VOLUME) !== '0'; } catch { this.forceVolume = true; }
  }

  /** Android: raise the alarm volume to at least 80 % while a critical alarm sounds. */
  setForceVolume(on) {
    this.forceVolume = !!on;
    try { localStorage.setItem(LS_ALARM_FORCE_VOLUME, this.forceVolume ? '1' : '0'); } catch { /* ignore */ }
  }

  unlock() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!this.ctx) this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  setMuted(muted) {
    this.muted = !!muted;
    try { localStorage.setItem(LS_ALARM_MUTED, this.muted ? '1' : '0'); } catch { /* ignore */ }
    if (this.muted) this.stopNative();
    else if (this.timer && this.critical) this.startNative();
    this.dispatchEvent(new CustomEvent('muted', { detail: { muted: this.muted } }));
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  get playing() {
    return !!this.timer;
  }

  cycle() {
    if (this.nativeOn) return; // the native alarm sounds and vibrates by itself
    vibrate(this.level === 'urgent' ? [500, 250, 500] : [300, 200, 300]);
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = 'sawtooth';
    if (this.level === 'urgent') {
      // Rising/falling wail.
      osc.frequency.setValueAtTime(650, t0);
      osc.frequency.linearRampToValueAtTime(1350, t0 + 0.45);
      osc.frequency.linearRampToValueAtTime(650, t0 + 0.9);
    } else {
      // Hi-lo two-tone.
      osc.frequency.setValueAtTime(960, t0);
      osc.frequency.setValueAtTime(770, t0 + 0.45);
    }
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(0.18, t0 + 0.03);
    amp.gain.setValueAtTime(0.18, t0 + 0.85);
    amp.gain.linearRampToValueAtTime(0, t0 + 0.9);
    osc.connect(amp).connect(this.ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.95);
  }

  /**
   * level: 'urgent' (SOS, P1) | 'normal'. critical: use the native alarm on
   * Android (sounds through silent mode); the in-page siren elsewhere.
   */
  start(level = 'normal', { critical = false } = {}) {
    if (this.timer && this.level === level && this.critical === critical) return;
    this.level = level;
    this.critical = critical;
    clearInterval(this.timer);
    if (critical && !this.muted) this.startNative();
    else this.stopNative();
    this.cycle();
    this.timer = setInterval(() => this.cycle(), level === 'urgent' ? 1600 : 2400);
  }

  startNative() {
    if (!isNative || !hasCriticalAlerts || this.nativeOn) return;
    this.nativeOn = true;
    startNativeAlarm({ forceVolume: this.forceVolume }).then((ok) => { if (!ok) this.nativeOn = false; });
  }

  stopNative() {
    if (!this.nativeOn) return;
    this.nativeOn = false;
    stopNativeAlarm();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.level = null;
    this.critical = false;
    this.stopNative();
    vibrate(0);
  }

  close() {
    this.stop();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}
