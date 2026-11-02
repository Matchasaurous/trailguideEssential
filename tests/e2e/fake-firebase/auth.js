// Test-only stand-in for firebase/auth (email/password subset used by the app).
import { call, setToken } from './conn.js';

export const indexedDBLocalPersistence = { type: 'LOCAL' };
export const browserLocalPersistence = { type: 'LOCAL' };
export function connectAuthEmulator() {}

const TOKEN_KEY = 'fake.token';

function makeUser(info, token) {
  return { uid: info.uid, email: info.email, displayName: info.displayName, getIdToken: async () => token };
}

export function initializeAuth() {
  const auth = { currentUser: null, callbacks: new Set(), ready: null };
  auth.ready = (async () => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) return;
    setToken(saved);
    const r = await call('resume');
    if (r.user) auth.currentUser = makeUser(r.user, saved);
    else setToken(null);
  })();
  return auth;
}

function setUser(auth, user, token) {
  setToken(token);
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  auth.currentUser = user;
  // Like the real SDK, observers fire asynchronously after the credential resolves.
  setTimeout(() => { for (const cb of auth.callbacks) cb(user); }, 0);
}

export function onAuthStateChanged(auth, cb) {
  auth.callbacks.add(cb);
  auth.ready.then(() => cb(auth.currentUser));
  return () => auth.callbacks.delete(cb);
}

export async function createUserWithEmailAndPassword(auth, email, password) {
  const r = await call('signup', { email, password });
  const user = makeUser(r.user, r.token);
  setUser(auth, user, r.token);
  return { user };
}

export async function signInWithEmailAndPassword(auth, email, password) {
  const r = await call('signin', { email, password });
  const user = makeUser(r.user, r.token);
  setUser(auth, user, r.token);
  return { user };
}

export async function updateProfile(user, { displayName }) {
  await call('profile', { displayName });
  user.displayName = displayName;
}

export async function signOut(auth) {
  setUser(auth, null, null);
}

export async function sendPasswordResetEmail() {}

// Google sign-in: the fake backend has no OAuth provider, so these behave like a
// project where Google sign-in hasn't been switched on yet.
export const browserPopupRedirectResolver = { type: 'popup-redirect' };
export class GoogleAuthProvider {
  setCustomParameters(params) { this.params = params; return this; }
}
function notEnabled() {
  return Object.assign(new Error('Firebase: Error (auth/operation-not-allowed).'), { code: 'auth/operation-not-allowed' });
}
export async function signInWithPopup() { throw notEnabled(); }
export async function signInWithRedirect() { throw notEnabled(); }
export async function getRedirectResult() { return null; }
