// Trailguard Essentials — app bootstrap, authentication, group session orchestration
// and UI wiring: role-based features (Security, Medical, Fire & Safety, Usher /
// Marshal, Dispatcher) with equipment sub-roles, map with equipment badges and
// course overlays, push-to-talk channels (button, keyboard, XCover key, Knox
// intents), bodycam and dispatcher live view, cases and SOS, proximity alerts and
// auto-dispatch, ePCR, announcements, after-action reports, background operation.
import './styles.css';
import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult
} from 'firebase/auth';
import {
  ref, onValue, update, remove, onDisconnect, serverTimestamp, query, limitToLast
} from 'firebase/database';
import { auth, db, configError, googleSignInAvailable } from './firebase.js';
import { startClock, serverNow } from './clock.js';
import {
  $, h, toast, showScreen, setBusy, initials, colorFor, formatAgo, formatDuration,
  formatBytes, friendlyError, vibrate, openSheet, closeSheets
} from './ui.js';
import {
  listMyGroups, createGroup, joinGroup, leaveGroup, disbandGroup, removeMember,
  unblockMember, rotateCode, saveProfile, loadProfileName, normalizeCode, formatCode, inviteLink,
  setMemberRole, setMemberProfile
} from './groups.js';
import { Dispatch, STATUSES, isDispatcherRole } from './dispatch.js';
import { memberRoleLabel, ROLES, featuresFor, profileOf, markerBadges, isDispatchRole } from './roles.js';
import { EtaRouter, EtaReporter, OverlayStore, clampRadius } from './location.js';
import { AlertCenter } from './alerts.js';
import { DispatchUI } from './dispatch-ui.js';
import { AutoDispatcher } from './auto-dispatch.js';
import { AnnouncementCenter } from './announcements.js';
import { EpcrStore } from './epcr.js';
import { EpcrUI } from './epcr-ui.js';
import { AnnouncementsUI, LayersUI, ReportsUI } from './ops-ui.js';
import {
  onAppStateChange, openAppSettings, onNotificationTap, ensureNotificationPermission, isNative,
  criticalAlertStatus, openDndAccessSettings, openFullScreenAlertSettings, hasNativeKeys
} from './native.js';
import { BackgroundService } from './background-service.js';
import { set as dbSet } from 'firebase/database';
import { MapView } from './map.js';
import { LocationTracker } from './location.js';
import { RtcMesh } from './rtc-mesh.js';
import { PushToTalk, PttKeys, MAX_TALK_MS, CHANNELS, describeKey } from './voice-ptt.js';
import { Bodycam } from './bodycam.js';

const LS_LAST_GROUP = 'trailguard.lastGroup';
const LS_TRACKING = 'trailguard.tracking';
const LS_AUTO_LIVE = 'trailguard.autoLive';
const LS_AUTO_OPEN_LIVE = 'trailguard.autoOpenLive';
const LS_PROX_ON = 'trailguard.proxOn';
const LS_PROX_RADIUS = 'trailguard.proxRadius';

/** This device's proximity switch and optional own radius (null = the group's). */
function deviceProximity() {
  let on = true;
  let radiusM = null;
  try {
    on = localStorage.getItem(LS_PROX_ON) !== '0';
    radiusM = clampRadius(localStorage.getItem(LS_PROX_RADIUS));
    if (localStorage.getItem(LS_PROX_RADIUS) === null) radiusM = null;
  } catch { /* storage unavailable: defaults */ }
  return { on, radiusM };
}

/** Features for my role, plus layout flags derived from them. */
function myFeatures(session) {
  const me = session && state.user ? session.members[state.user.uid] : null;
  const set = featuresFor(me ? { ...me, role: session.role } : { role: session ? session.role : 'member' });
  // Push-to-talk is for everyone except Ushers / Marshals — including members who
  // haven't picked a role yet (or whose role didn't save), so nobody loses the radio.
  if (profileOf(me).unit !== 'usher') set.add('ptt');
  if (!set.has('ptt')) set.add('reportOnly');
  if (set.has('epcr') && !set.has('bodycam')) set.add('epcrDock');
  return set;
}

function autoOpenLiveEnabled() {
  try { return localStorage.getItem(LS_AUTO_OPEN_LIVE) !== '0'; } catch { return true; }
}

function autoLiveEnabled() {
  try { return localStorage.getItem(LS_AUTO_LIVE) === '1'; } catch { return false; }
}

const state = {
  user: null,
  displayName: '',
  authMode: 'signin',
  pendingJoin: null,
  map: null,
  session: null,
  enteringGroup: false
};

/* ============================== Boot ============================== */

function readDeepLink() {
  const params = new URLSearchParams(location.search);
  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));
  const code = normalizeCode(params.get('join') || hashParams.get('join') || '');
  if (code) {
    state.pendingJoin = code;
    params.delete('join');
    const rest = params.toString();
    history.replaceState(null, '', `${location.pathname}${rest ? `?${rest}` : ''}`);
  }
}

function boot() {
  if (configError) {
    $('#boot-message').textContent = configError;
    return;
  }
  if (!window.isSecureContext) {
    $('#boot-message').textContent = 'Trailguard Essentials must be opened over HTTPS (camera, microphone and GPS require a secure connection).';
    return;
  }
  startClock();
  readDeepLink();
  wireAuthForm();
  wireGroupScreen();
  wireMainScreen();
  onAuthStateChanged(auth, (user) => {
    handleAuthChange(user).catch((err) => {
      console.error(err);
      toast(friendlyError(err), 'error');
    });
  });
}

/* ============================== Auth ============================== */

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === 'register';
  $('#tab-signin').classList.toggle('active', !register);
  $('#tab-register').classList.toggle('active', register);
  $('#tab-signin').setAttribute('aria-selected', String(!register));
  $('#tab-register').setAttribute('aria-selected', String(register));
  $('#field-name').hidden = !register;
  $('#auth-submit').textContent = register ? 'Create account' : 'Sign in';
  $('#auth-password').setAttribute('autocomplete', register ? 'new-password' : 'current-password');
  $('#auth-reset').hidden = register;
  showAuthError(null);
}

function showAuthError(message) {
  const el = $('#auth-error');
  el.hidden = !message;
  el.textContent = message || '';
}

function wireAuthForm() {
  $('#tab-signin').addEventListener('click', () => setAuthMode('signin'));
  $('#tab-register').addEventListener('click', () => setAuthMode('register'));

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const name = $('#auth-name').value.trim().replace(/\s+/g, ' ');
    const button = $('#auth-submit');
    showAuthError(null);

    if (!email) return showAuthError('Enter your email.');
    if (state.authMode === 'register') {
      if (name.length < 1 || name.length > 40) return showAuthError('Enter a display name (up to 40 characters).');
      if (password.length < 8) return showAuthError('Use a password of at least 8 characters.');
    } else if (!password) {
      return showAuthError('Enter your password.');
    }

    setBusy(button, true, 'Please wait…');
    try {
      if (state.authMode === 'register') {
        // Set before creating the account: the auth observer fires as soon as the
        // account exists, before updateProfile() has finished.
        state.displayName = name;
        try {
          const cred = await createUserWithEmailAndPassword(auth, email, password);
          await saveProfile(cred.user, name);
          await updateProfile(cred.user, { displayName: name });
        } catch (err) {
          if (!auth.currentUser) state.displayName = '';
          throw err;
        }
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      $('#auth-password').value = '';
    } catch (err) {
      showAuthError(friendlyError(err));
    } finally {
      setBusy(button, false);
    }
  });

  // Google sign-in (web): a pop-up first; if the browser blocks pop-ups, a full-page
  // redirect instead. Works for new and existing accounts alike.
  const google = $('#auth-google');
  $('#auth-google-row').hidden = !googleSignInAvailable;
  if (googleSignInAvailable) {
    getRedirectResult(auth).catch((err) => showAuthError(friendlyError(err)));
    google.addEventListener('click', async () => {
      showAuthError(null);
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const label = google.querySelector('span');
      google.disabled = true;
      label.textContent = 'Opening Google…';
      try {
        await signInWithPopup(auth, provider);
      } catch (err) {
        const code = err && err.code;
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
          try { await signInWithRedirect(auth, provider); return; } catch (err2) { showAuthError(friendlyError(err2)); }
        } else if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request' && code !== 'auth/user-cancelled') {
          showAuthError(friendlyError(err));
        }
      } finally {
        google.disabled = false;
        label.textContent = 'Continue with Google';
      }
    });
  }

  $('#auth-reset').addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    if (!email) return showAuthError('Enter your email first, then tap “Forgot password?”.');
    try {
      await sendPasswordResetEmail(auth, email);
      toast('If that account exists, a reset email is on its way.', 'ok');
    } catch (err) {
      showAuthError(friendlyError(err));
    }
  });
}

async function handleAuthChange(user) {
  if (!user) {
    await endSession({ silent: true });
    state.user = null;
    state.displayName = '';
    setAuthMode('signin');
    showScreen('screen-auth');
    return;
  }

  state.user = user;
  let name = state.displayName || user.displayName || (await loadProfileName(user));
  if (!name) name = (user.email || 'Member').split('@')[0].slice(0, 40);
  state.displayName = name.slice(0, 40);
  // Make sure the profile node exists (accounts created before profiles, or elsewhere).
  if (!(await loadProfileName(user))) await saveProfile(user, state.displayName).catch(() => {});

  $('#groups-user').textContent = state.displayName;
  showScreen('screen-groups');

  if (state.pendingJoin) {
    const code = state.pendingJoin;
    state.pendingJoin = null;
    try {
      const gid = await joinGroup(user, code, state.displayName);
      await enterGroup(gid);
      return;
    } catch (err) {
      $('#join-code').value = formatCode(code);
      toast(friendlyError(err), 'error', 5000);
    }
  }

  const groups = await renderGroupList();
  const last = localStorage.getItem(LS_LAST_GROUP);
  if (last && groups.some((g) => g.gid === last)) await enterGroup(last);
}

/* ============================== Group picker ============================== */

async function renderGroupList() {
  const list = $('#group-list');
  list.replaceChildren(h('li', { class: 'muted small' }, 'Loading…'));
  let groups = [];
  try {
    groups = await listMyGroups(state.user.uid);
  } catch (err) {
    list.replaceChildren();
    toast(friendlyError(err), 'error');
    return [];
  }
  list.replaceChildren(...groups.map((g) => h('li', {},
    h('button', { class: 'row', type: 'button', onClick: () => enterGroup(g.gid) },
      h('div', { class: 'avatar', style: `background:${colorFor(g.gid)}` }, initials(g.name)),
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, g.name),
        h('div', { class: 'small muted' }, g.role === 'owner' ? 'Owner' : 'Member'))
    ),
    h('span', { class: 'tag' }, 'Open')
  )));
  $('#group-list-empty').hidden = groups.length > 0;
  return groups;
}

function wireGroupScreen() {
  $('#btn-signout').addEventListener('click', async () => {
    await endSession({ silent: true });
    localStorage.removeItem(LS_LAST_GROUP);
    await signOut(auth);
  });

  $('#join-code').addEventListener('input', (e) => {
    const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    e.target.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
  });

  $('#join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#join-submit');
    setBusy(button, true, 'Joining…');
    try {
      const gid = await joinGroup(state.user, $('#join-code').value, state.displayName);
      $('#join-code').value = '';
      await enterGroup(gid);
    } catch (err) {
      toast(friendlyError(err), 'error', 5000);
    } finally {
      setBusy(button, false);
    }
  });

  $('#create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#create-submit');
    setBusy(button, true, 'Creating…');
    try {
      const { gid } = await createGroup(state.user, $('#create-name').value, state.displayName);
      $('#create-name').value = '';
      await enterGroup(gid);
      openMembersSheet();
    } catch (err) {
      toast(friendlyError(err), 'error');
    } finally {
      setBusy(button, false);
    }
  });
}

/* ============================== Group session ============================== */

function newSessionId() {
  return crypto.randomUUID().replace(/-/g, '');
}

async function enterGroup(gid) {
  if (state.enteringGroup) return;
  state.enteringGroup = true;
  try {
    await endSession({ silent: true });
    const user = state.user;
    const sid = newSessionId();

    const session = {
      gid,
      sid,
      meta: null,
      role: 'member',
      members: {},
      banned: {},
      uploads: [],
      roster: new Map(),
      speaker: null,
      lastFix: null,
      connected: false,
      presenceRef: ref(db, `presence/${gid}/${user.uid}`),
      unsubs: [],
      cleanups: [],
      viewerUid: null,
      progress: new Map(),
      positions: new Map(),
      ending: false
    };
    state.session = session;
    localStorage.setItem(LS_LAST_GROUP, gid);

    showScreen('screen-main');
    $('#main-group-name').textContent = 'Loading…';
    if (!state.map) {
      state.map = new MapView('map', {
        selfUid: user.uid,
        onUserPan: () => setFollowUi(false),
        onIncidentClick: (iid) => { if (state.session && state.session.dispatchUI) state.session.dispatchUI.openIncident(iid); },
        onLongPress: (latlng) => {
          const s = state.session;
          if (s && s.dispatchUI) s.dispatchUI.openForm({ lat: latlng.lat, lng: latlng.lng });
        },
        popupActions: (uid) => markerActions(uid)
      });
    }
    state.map.selfUid = user.uid;
    state.map.clear();
    state.map.invalidate();
    setFollowUi(true);
    state.map.setFollow(true);

    // --- Membership / metadata watchers: removal or disband ends the session.
    session.unsubs.push(onValue(ref(db, `groups/${gid}/members/${user.uid}`), (snap) => {
      if (!snap.exists() && state.session === session) {
        endSession({ message: 'You are no longer a member of this group.' });
      }
    }, () => { if (state.session === session) endSession({ message: 'Access to this group was removed.' }); }));

    session.unsubs.push(onValue(ref(db, `groups/${gid}/meta`), (snap) => {
      if (!snap.exists()) {
        if (state.session === session) endSession({ message: 'This group was disbanded.' });
        return;
      }
      session.meta = snap.val();
      if (session.meta.owner === user.uid) session.role = 'owner';
      $('#main-group-name').textContent = session.meta.name;
      $('#invite-code').textContent = formatCode(session.meta.code);
      $('#btn-rotate').hidden = session.role !== 'owner';
      $('#btn-leave').textContent = session.role === 'owner' ? 'Disband group' : 'Leave group';
      renderMembers();
    }, () => {}));

    session.unsubs.push(onValue(ref(db, `groups/${gid}/members`), (snap) => {
      session.members = snap.val() || {};
      const me = session.members[user.uid];
      if (me) session.role = me.role;
      applyFeatures(session);
      renderProfiles(session);
      renderMembers();
      if (session.ptt) session.ptt.refreshAudience();
      // My role or equipment may have changed what I'm alerted to.
      if (session.alerts) session.alerts.evaluate();
      if (session.dispatchUI) session.dispatchUI.renderAll();
    }, () => {}));

    session.unsubs.push(onValue(ref(db, `groups/${gid}/banned`), (snap) => {
      session.banned = snap.val() || {};
      renderMembers();
    }, () => {}));

    session.unsubs.push(onValue(query(ref(db, `uploads/${gid}`), limitToLast(30)), (snap) => {
      const items = [];
      snap.forEach((child) => { items.push({ id: child.key, ...child.val() }); });
      session.uploads = items.reverse();
      renderArchive();
    }, () => {}));

    // --- WebRTC mesh (must start before presence so stale signals are cleared first).
    session.mesh = new RtcMesh({ gid, uid: user.uid, sid });
    session.mesh.addEventListener('roster', (e) => {
      session.roster = new Map(e.detail.roster);
      state.map.setLive([...session.roster].filter(([uid, p]) => uid !== user.uid && p.live).map(([uid]) => uid));
      renderMembers();
      renderStatus();
      renderViewer();
      renderLiveViewers();
      renderLiveStrip();
    });
    session.mesh.addEventListener('peer-state', () => renderStatus());
    session.mesh.addEventListener('autoplay-blocked', () => { $('#audio-unlock').hidden = false; });
    session.mesh.addEventListener('remote-video', (e) => {
      if (session.viewerUid === e.detail.uid) attachViewer(e.detail.stream);
    });
    await session.mesh.start();

    // --- Presence with automatic removal on disconnect.
    const publishPresence = async () => {
      if (!session.connected || state.session !== session) return;
      try {
        await onDisconnect(session.presenceRef).remove();
        await update(session.presenceRef, {
          name: state.displayName,
          sid,
          live: !!(session.bodycam && session.bodycam.live),
          tracking: !!(session.tracker && session.tracker.tracking),
          prox: deviceProximity().on,
          watching: session.viewerUid || null,
          lastSeen: serverTimestamp()
        });
      } catch (err) {
        console.warn('Presence write failed', err);
      }
    };
    session.unsubs.push(onValue(ref(db, '.info/connected'), (snap) => {
      session.connected = snap.val() === true;
      renderStatus();
      publishPresence();
    }));
    // Self-heal: an onDisconnect left by an earlier connection of this same user
    // (app reload, network drop detected late by the server) can delete the
    // presence this session just wrote. Put it back.
    session.unsubs.push(onValue(session.presenceRef, (snap) => {
      if (session.ending) return;
      const value = snap.val();
      if (value && value.sid === sid) {
        session.presenceOwned = true;
        return;
      }
      if (value && session.presenceOwned) {
        // Our presence was replaced by another live session of the same account:
        // it was opened on another device. The newest device wins so the two don't
        // fight over presence, voice and location. (A different sid seen *before*
        // we wrote ours is just the previous app load's record, about to expire.)
        endSession({ message: 'This account is now active on another device.', keepPresence: true });
        return;
      }
      if (value) return;
      clearTimeout(session.presenceHeal);
      session.presenceHeal = setTimeout(publishPresence, 500);
    }, () => {}));

    // --- Location.
    session.background = new BackgroundService({ gid, uid: user.uid, name: state.displayName, getIdToken: () => user.getIdToken() });
    await session.background.start();
    session.tracker = new LocationTracker({
      gid, uid: user.uid, name: state.displayName, getIdToken: () => user.getIdToken(), background: session.background
    });
    session.tracker.addEventListener('member', (e) => {
      session.positions.set(e.detail.uid, e.detail.data);
      if (session.viewerUid === e.detail.uid) renderViewer();
      if (e.detail.uid === user.uid && session.lastFix) return; // own marker is driven by live fixes
      state.map.upsert(e.detail.uid, e.detail.data);
    });
    session.tracker.addEventListener('member-removed', (e) => {
      session.positions.delete(e.detail.uid);
      state.map.remove(e.detail.uid);
    });
    session.tracker.addEventListener('fix', (e) => {
      session.lastFix = e.detail;
      state.map.upsert(user.uid, e.detail);
      renderStatus();
    });
    session.tracker.addEventListener('error', (e) => {
      if (e.detail.code === 3 && session.lastFix) return;
      if (e.detail.code === 'write') return console.debug('Location write skipped:', e.detail.message);
      if (e.detail.openSettings && confirm(`${e.detail.message}\n\nOpen settings now?`)) openAppSettings();
      else toast(e.detail.message, 'error');
    });
    session.tracker.addEventListener('state', (e) => {
      if (state.session !== session) return;
      setTrackingUi(e.detail.tracking);
      if (!e.detail.tracking) {
        session.lastFix = null;
      }
      patchPresence(session, { tracking: e.detail.tracking });
    });
    session.tracker.subscribe();
    if (localStorage.getItem(LS_TRACKING) !== '0') session.tracker.start();
    else setTrackingUi(false);

    // --- Push-to-talk.
    session.ptt = new PushToTalk({
      gid,
      uid: user.uid,
      sid,
      name: state.displayName,
      mesh: session.mesh,
      channels: () => {
        const f = myFeatures(session);
        const listen = ['main'];
        const talk = [];
        if (f.has('ptt')) talk.push('main');
        if (f.has('medicalChannel')) { listen.push('medical'); talk.push('medical'); }
        return { listen, talk };
      },
      canHear: (peerUid, channel) => {
        if (channel === 'main') return true;
        const m = session.members[peerUid];
        return !!m && (isDispatchRole(m.role) || profileOf(m).unit === 'medical');
      }
    });
    session.ptt.addEventListener('state', (e) => renderPtt(e.detail.state));
    session.ptt.addEventListener('channel', () => renderPtt(session.ptt.state));
    session.ptt.addEventListener('speaker', (e) => renderSpeaker(e.detail.speaker, e.detail.self));
    session.ptt.addEventListener('error', (e) => toast(e.detail.message, 'error', 2200));
    session.ptt.start();
    session.cleanups.push(session.ptt.bindButton($('#btn-ptt')));
    session.cleanups.push(session.ptt.bindButton($('#btn-cam-ptt')));
    session.pttKeys = new PttKeys(session.ptt, {
      onTopKey: (down) => { if (session.dispatchUI) session.dispatchUI.topKey(down); }
    });
    session.pttKeys.start();
    session.cleanups.push(() => session.pttKeys.stop());
    renderDeviceSettings();

    // --- Bodycam.
    session.bodycam = new Bodycam({
      gid,
      groupName: '',
      uid: user.uid,
      name: state.displayName,
      mesh: session.mesh,
      getIdToken: () => user.getIdToken(),
      getPosition: () => session.lastFix,
      setLivePresence: async (live) => { patchPresence(session, { live }); }
    });
    wireBodycamEvents(session);
    session.bodycam.refreshClips();

    // --- Dispatch: incidents, SOS, assignments, responder status, alerts.
    session.dispatch = new Dispatch({
      gid,
      uid: user.uid,
      name: state.displayName,
      onCaseEvent: (event, incident) => {
        session.bodycam.groupName = session.meta ? session.meta.name : '';
        session.bodycam.sendCase(event, incident).catch((err) => console.warn('Case log not written to the Sheet:', err.message));
      }
    });
    const myMember = () => session.members[user.uid] || null;
    session.announcements = new AnnouncementCenter({ gid, uid: user.uid, name: state.displayName, getMe: () => ({ ...(myMember() || {}), role: session.role }) });
    session.alerts = new AlertCenter({
      gid,
      uid: user.uid,
      dispatch: session.dispatch,
      announcements: session.announcements,
      getIdToken: () => user.getIdToken(),
      isDispatcher: () => isDispatcherRole(session.role),
      getMember: () => (myFeatures(session).has('proximity') ? myMember() : null),
      getMyFix: () => session.lastFix,
      isOffDuty: () => session.dispatch.effectiveStatus(user.uid).state === 'offduty' || !session.tracker.tracking,
      getDeviceProximity: deviceProximity
    });
    session.etaReporter = new EtaReporter({ dispatch: session.dispatch, router: new EtaRouter(), getMode: () => profileOf(myMember()).mode });
    session.autoDispatch = new AutoDispatcher({
      uid: user.uid,
      dispatch: session.dispatch,
      getMembers: () => session.members,
      getPositions: () => session.positions,
      getRoster: () => session.roster,
      isDeviceProximityOn: () => deviceProximity().on && myFeatures(session).has('proximity') && session.tracker.tracking
    });
    session.epcrStore = new EpcrStore({ gid, uid: user.uid, name: state.displayName });
    session.epcrAll = {};
    session.overlays = new OverlayStore({ gid, uid: user.uid });
    session.overlays.addEventListener('change', (e) => state.map.setOverlays(e.detail.overlays));
    const logAnnouncement = (a) => {
      session.bodycam.groupName = session.meta ? session.meta.name : '';
      session.bodycam.sendAnnouncement(a).catch((err) => console.warn('Announcement not logged to the Sheet:', err.message));
    };
    session.dispatchUI = new DispatchUI({
      uid: user.uid,
      name: state.displayName,
      map: state.map,
      dispatch: session.dispatch,
      alerts: session.alerts,
      bodycam: session.bodycam,
      getRole: () => session.role,
      getMembers: () => session.members,
      getPositions: () => session.positions,
      getMyFix: () => session.lastFix,
      getRoster: () => session.roster,
      getGroupName: () => (session.meta ? session.meta.name : ''),
      features: () => myFeatures(session),
      setProfile: (targetUid, profile) => setMemberProfile(gid, targetUid, profile),
      announcements: session.announcements,
      onAnnouncementSent: logAnnouncement,
      patientCount: (iid) => Object.keys(session.epcrAll[iid] || {}).length,
      openEpcr: (iid) => session.epcrUI.open(iid),
      openLayers: () => session.layersUI.open(),
      openReports: () => session.reportsUI.open(),
      onFollowOff: () => setFollowUi(false),
      unlockAudio: () => { session.alerts.unlock(); session.ptt.unlockAudio(); },
      onDutyChange: (onDuty) => {
        if (onDuty && !session.tracker.tracking) {
          localStorage.setItem(LS_TRACKING, '1');
          session.tracker.start();
        } else if (!onDuty && session.tracker.tracking) {
          localStorage.setItem(LS_TRACKING, '0');
          session.tracker.stop();
        }
      }
    });
    session.epcrUI = new EpcrUI({
      store: session.epcrStore,
      dispatch: session.dispatch,
      bodycam: session.bodycam,
      getGroupName: () => (session.meta ? session.meta.name : ''),
      requestTransport: (iid) => session.dispatchUI.requestTransport(iid),
      canTransport: () => myFeatures(session).has('transport')
    });
    session.announcementsUI = new AnnouncementsUI({
      center: session.announcements,
      uid: user.uid,
      isDispatcher: () => isDispatcherRole(session.role),
      getMembers: () => session.members,
      onSent: logAnnouncement,
      openIncident: (iid) => session.dispatchUI.openIncident(iid)
    });
    session.layersUI = new LayersUI({ store: session.overlays, isDispatcher: () => isDispatcherRole(session.role) });
    session.reportsUI = new ReportsUI({
      dispatch: session.dispatch,
      getMembers: () => session.members,
      getEpcr: () => session.epcrAll,
      getGroupName: () => (session.meta ? session.meta.name : ''),
      bodycam: session.bodycam
    });
    let statusInitialised = false;
    session.dispatch.addEventListener('status', () => {
      if (statusInitialised || state.session !== session) return;
      statusInitialised = true;
      if (!session.dispatch.status.has(user.uid) && !session.dispatch.myLock()) {
        session.dispatch.setStatus(session.tracker.tracking ? 'available' : 'offduty').catch(() => {});
      }
    });
    // Groups from before 1.4 have no (or 1.3) dispatch settings: the first dispatcher in writes 1.4 defaults.
    session.dispatch.addEventListener('settings', () => {
      if (isDispatcherRole(session.role)) session.dispatch.ensureSettings().catch(() => {});
      renderDeviceSettings();
    });
    // My ETA to my case, and proximity checks, follow my position — and my case:
    // a new lock (accepted / assigned) reports an ETA at once, even if I am standing still.
    session.tracker.addEventListener('fix', (e) => {
      session.alerts.onFix();
      session.etaReporter.update(e.detail);
    });
    session.dispatch.addEventListener('incidents', () => {
      if (session.lastFix) session.etaReporter.update(session.lastFix);
    });
    session.etaTimer = setInterval(() => {
      if (session.lastFix) session.etaReporter.update(session.lastFix);
    }, 30_000);
    session.dispatch.addEventListener('error', (e) => console.warn('Dispatch sync', e.detail.message));
    session.dispatch.start();
    session.announcements.start();
    session.overlays.start();
    session.alerts.start();
    session.dispatchUI.start();
    session.epcrUI.start();
    session.announcementsUI.start();
    session.layersUI.start();
    session.reportsUI.start();
    session.autoDispatch.start();
    applyFeatures(session);
    session.cleanups.push(onNotificationTap((data) => {
      if (state.session !== session) return;
      if (data.incidentId && session.dispatch.incidents.has(data.incidentId)) session.dispatchUI.openIncident(data.incidentId);
      else if (String(data.key || '').startsWith('ann:')) session.announcementsUI.open();
    }));
    session.cleanups.push(onAppStateChange((foreground) => {
      if (!foreground && session.ptt) session.ptt.releaseAll();
    }));

    // --- Dispatcher asks to see my bodycam.
    session.unsubs.push(onValue(ref(db, `liveRequests/${gid}/${user.uid}`), (snap) => {
      if (state.session === session) handleLiveRequest(snap.val());
    }, () => {}));

    // Any first touch on the map screen unlocks audio playback for the channel.
    const unlock = () => {
      session.ptt.unlockAudio();
      session.alerts.unlock();
      $('#audio-unlock').hidden = true;
      ensureNotificationPermission();
      // Ask for the microphone now, so the first press of the talk button talks
      // instead of being used up by the permission prompt.
      if (session.ptt.canTalk) session.ptt.primeMicrophone();
    };
    document.addEventListener('pointerdown', unlock, { once: true, capture: true });
    session.cleanups.push(() => document.removeEventListener('pointerdown', unlock, { capture: true }));

    session.statusTimer = setInterval(renderStatus, 5000);
    renderPtt('idle');
    renderStatus();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err), 'error', 5000);
    await endSession({ silent: true });
    showScreen('screen-groups');
    renderGroupList();
  } finally {
    state.enteringGroup = false;
  }
}

/**
 * Tear down the current group session.
 * @param {{message?: string, silent?: boolean, leave?: boolean, disband?: boolean, keepPresence?: boolean}} opts
 */
async function endSession(opts = {}) {
  const session = state.session;
  if (!session || session.ending) return;
  session.ending = true;
  state.session = null;

  if (session.autoDispatch) session.autoDispatch.stop();
  if (session.dispatchUI) session.dispatchUI.stop();
  if (session.epcrUI) session.epcrUI.stop();
  if (session.announcementsUI) session.announcementsUI.stop();
  if (session.layersUI) session.layersUI.stop();
  if (session.reportsUI) session.reportsUI.stop();
  if (session.alerts) session.alerts.stop();
  if (session.announcements) session.announcements.stop();
  if (session.overlays) session.overlays.stop();
  if (session.epcrUnsub) session.epcrUnsub();
  session.epcrUnsub = null;
  if (session.dispatch) session.dispatch.stop();
  document.body.removeAttribute('data-role');
  closeSheets();
  closeViewer(session);
  $('#live-request').hidden = true;
  $('#clip-drawer').hidden = true;
  $('#bodycam-panel').hidden = true;
  $('#btn-cam').setAttribute('aria-pressed', 'false');
  $('#speaker-overlay').hidden = true;
  $('#audio-unlock').hidden = true;
  clearInterval(session.statusTimer);
  clearInterval(session.speakerTimer);
  clearTimeout(session.presenceHeal);
  clearInterval(session.etaTimer);

  for (const fn of session.cleanups) { try { fn(); } catch { /* ignore */ } }
  for (const unsub of session.unsubs) { try { unsub(); } catch { /* ignore */ } }

  if (session.ptt) await session.ptt.stop().catch(() => {});
  if (session.bodycam) await session.bodycam.close().catch(() => {});
  if (session.tracker) await session.tracker.destroy({ clearRemote: opts.leave || opts.disband }).catch(() => {});
  if (session.background) await session.background.stop({ clearOutbox: !!(opts.leave || opts.disband || opts.message) }).catch(() => {});
  if (session.mesh) await session.mesh.stop().catch(() => {});
  if (!opts.keepPresence) {
    await onDisconnect(session.presenceRef).cancel().catch(() => {});
    await remove(session.presenceRef).catch(() => {});
  }
  if (state.map) state.map.clear();

  if (opts.message || opts.leave || opts.disband) localStorage.removeItem(LS_LAST_GROUP);
  if (opts.message) toast(opts.message, 'error', 5000);
  if (!opts.silent && state.user) {
    showScreen('screen-groups');
    renderGroupList();
  }
}

/**
 * Update fields of my presence record. Before the full record exists (first
 * connection still in progress) a partial write would fail validation; the
 * full write that follows reads the same session state, so nothing is lost.
 */
function patchPresence(session, fields) {
  if (!session || session.ending || !session.connected || !session.presenceOwned) return;
  update(session.presenceRef, fields).catch(() => {});
}

/* ============================== Main screen UI ============================== */

function setFollowUi(on) {
  $('#btn-follow').setAttribute('aria-pressed', String(on));
}

function setTrackingUi(on) {
  const button = $('#btn-track');
  button.setAttribute('aria-pressed', String(on));
  button.querySelector('span').textContent = on ? 'GPS on' : 'GPS off';
}

function renderStatus() {
  const session = state.session;
  if (!session) return;
  const dot = $('#conn-dot');
  dot.className = `dot ${session.connected ? 'online' : 'offline'}`;
  if (!session.connected) {
    $('#main-status').textContent = 'Offline — reconnecting…';
    return;
  }
  const online = [...session.roster.keys()].length;
  const { connected, total } = session.mesh ? session.mesh.connectionSummary() : { connected: 0, total: 0 };
  const parts = [`${online} online`];
  if (total > 0) parts.push(`voice ${connected}/${total}`);
  if (session.lastFix) parts.push(`GPS ±${Math.round(session.lastFix.acc)} m`);
  else if (session.tracker && session.tracker.tracking) parts.push('GPS searching…');
  $('#main-status').textContent = parts.join(' · ');
  $('#members-count').textContent = String(Object.keys(session.members).length);
}

function renderPtt(pttState) {
  const button = $('#btn-ptt');
  const labels = { idle: 'HOLD TO TALK', requesting: 'WAIT…', talking: 'TALKING', busy: 'CHANNEL BUSY', denied: 'LISTEN ONLY' };
  const session = state.session;
  const effective = session && !session.connected && pttState === 'idle' ? 'offline' : pttState;
  button.dataset.state = effective;
  $('#btn-cam-ptt').dataset.state = effective;
  const channel = session && session.ptt ? session.ptt.txChannel : 'main';
  button.dataset.channel = channel;
  $('#ptt-channel').dataset.channel = channel;
  $('#ptt-channel-label').textContent = CHANNELS[channel].short;
  $('#ptt-channel').setAttribute('aria-label', `Talk channel: ${CHANNELS[channel].label}. Tap to switch.`);
  $('#ptt-label').textContent = effective === 'offline' ? 'OFFLINE' : labels[pttState] || labels.idle;
}

function renderSpeaker(speaker, self) {
  const session = state.session;
  if (!session) return;
  session.speaker = speaker;
  const overlay = $('#speaker-overlay');
  clearInterval(session.speakerTimer);
  state.map.setSpeaker(speaker ? speaker.uid : null);
  renderMembers();

  if (!speaker) {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  overlay.classList.toggle('self', !!self);
  const channel = speaker.channel || 'main';
  overlay.dataset.channel = channel;
  $('#speaker-channel').textContent = CHANNELS[channel] ? CHANNELS[channel].short : 'MAIN';
  $('#speaker-label').textContent = self ? 'You are transmitting' : 'Transmitting';
  $('#speaker-name').textContent = self ? state.displayName : speaker.name;
  const avatar = $('#speaker-avatar');
  avatar.textContent = initials(speaker.name);
  avatar.style.background = colorFor(speaker.uid);
  const tick = () => {
    const elapsed = Math.min(MAX_TALK_MS, Math.max(0, serverNow() - speaker.since));
    $('#speaker-timer').textContent = formatDuration(elapsed / 1000);
  };
  tick();
  session.speakerTimer = setInterval(tick, 250);
}

function renderMembers() {
  const session = state.session;
  if (!session) return;
  const uid = state.user.uid;
  const isOwner = session.role === 'owner';
  const list = $('#member-list');
  const entries = Object.entries(session.members)
    .sort(([a, ma], [b, mb]) => {
      const oa = session.roster.has(a) ? 0 : 1;
      const ob = session.roster.has(b) ? 0 : 1;
      return oa - ob || String(ma.name).localeCompare(String(mb.name));
    });

  list.classList.add('member-rows');
  list.replaceChildren(...entries.map(([memberUid, member]) => {
    const presence = session.roster.get(memberUid);
    const online = !!presence;
    const talking = session.speaker && session.speaker.uid === memberUid;
    const live = online && presence.live && memberUid !== uid;
    const duty = session.dispatch ? session.dispatch.effectiveStatus(memberUid) : null;
    const sub = [
      memberUid === uid ? 'You' : online ? 'Online' : 'Offline',
      memberRoleLabel(member),
      duty ? (duty.locked ? `On a case · ${STATUSES[duty.state]}` : STATUSES[duty.state]) : null,
      online && presence.tracking === false ? 'GPS off' : null
    ].filter(Boolean).join(' · ');
    const canSetUnit = isDispatcherRole(session.role) || memberUid === uid;
    const unitSelect = canSetUnit
      ? h('button', {
        class: 'btn small ghost',
        type: 'button',
        'aria-label': `Role and equipment for ${member.name}`,
        onClick: () => { if (session.dispatchUI) session.dispatchUI.openRolePicker(memberUid); }
      }, profileOf(member).unit ? 'Role' : 'Set role…')
      : null;
    const roleButton = isOwner && memberUid !== uid
      ? h('button', {
        class: 'btn small ghost',
        type: 'button',
        onClick: () => changeRole(memberUid, member.name, member.role === 'dispatcher' ? 'member' : 'dispatcher')
      }, member.role === 'dispatcher' ? 'Make responder' : 'Make dispatcher')
      : null;

    return h('li', {},
      h('button', { class: 'row', type: 'button', onClick: () => focusMember(memberUid) },
        h('div', { class: 'avatar', style: `background:${colorFor(memberUid)}` },
          initials(member.name), h('span', { class: `presence ${online ? 'on' : ''}` })),
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, member.name),
          h('div', { class: 'small muted' }, sub))
      ),
      talking ? h('span', { class: 'tag talk' }, 'TALKING') : null,
      live ? h('button', { class: 'btn small', type: 'button', onClick: () => openViewer(memberUid, member.name) }, 'View live') : null,
      !live && online && memberUid !== uid && isDispatcherRole(session.role) && hasBodycam(member)
        ? h('button', { class: 'btn small', type: 'button', onClick: () => requestLive(memberUid, member.name) }, 'Request live')
        : null,
      unitSelect,
      roleButton,
      isOwner && memberUid !== uid
        ? h('button', { class: 'btn small ghost', type: 'button', 'aria-label': `Remove ${member.name}`, onClick: () => confirmRemove(memberUid, member.name) }, 'Remove')
        : null
    );
  }));

  const banned = Object.entries(session.banned || {});
  $('#banned-block').hidden = !isOwner || banned.length === 0;
  $('#banned-list').replaceChildren(...banned.map(([bannedUid, name]) => h('li', {},
    h('div', { class: 'grow' }, h('div', { class: 'title' }, name)),
    h('button', { class: 'btn small', type: 'button', onClick: () => unblock(bannedUid, name) }, 'Unblock')
  )));
  renderStatus();
}

function renderArchive() {
  const session = state.session;
  if (!session) return;
  const list = $('#archive-list');
  list.replaceChildren(...session.uploads.map((u) => h('li', {},
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, u.fileName),
      h('div', { class: 'small muted' },
        `${u.name} · ${formatBytes(u.size)}${u.durationSec ? ` · ${formatDuration(u.durationSec)}` : ''} · ${formatAgo(serverNow() - u.ts)}`)),
    u.url && /^https:\/\//.test(u.url)
      ? h('a', { class: 'btn small', href: u.url, target: '_blank', rel: 'noopener noreferrer' }, 'Drive')
      : null
  )));
  $('#archive-empty').hidden = session.uploads.length > 0;
}

function focusMember(memberUid) {
  const entry = state.map.markers.get(memberUid);
  closeSheets();
  if (!entry) {
    toast('No position from this member yet.');
    return;
  }
  setFollowUi(false);
  state.map.setFollow(false);
  state.map.map.setView(entry.marker.getLatLng(), Math.max(state.map.map.getZoom(), 17), { animate: true });
  entry.marker.openPopup();
}

async function confirmRemove(memberUid, name) {
  const session = state.session;
  if (!session) return;
  if (!confirm(`Remove ${name} from the group? They will be blocked from rejoining until you unblock them.`)) return;
  try {
    await removeMember(session.gid, memberUid, name, true);
    toast(`${name} removed`, 'ok');
  } catch (err) {
    toast(friendlyError(err), 'error');
  }
}

async function changeRole(memberUid, name, role) {
  const session = state.session;
  if (!session) return;
  try {
    await setMemberRole(session.gid, memberUid, role);
    toast(role === 'dispatcher' ? `${name} can now dispatch` : `${name} is a responder`, 'ok');
  } catch (err) {
    toast(friendlyError(err), 'error');
  }
}

async function unblock(bannedUid, name) {
  const session = state.session;
  if (!session) return;
  try {
    await unblockMember(session.gid, bannedUid);
    toast(`${name} can rejoin with the invite code`, 'ok');
  } catch (err) {
    toast(friendlyError(err), 'error');
  }
}

function openMembersSheet() {
  openSheet('members-sheet');
  renderDeviceSettings();
  renderMembers();
  renderArchive();
}

/* ---------------- Live viewer (dispatcher view of a member's bodycam) ---------------- */

function memberName(uid) {
  const session = state.session;
  const m = session && session.members[uid];
  return m ? m.name : 'Member';
}

/** Actions in a member's map popup. */
function markerActions(uid) {
  const session = state.session;
  if (!session || uid === state.user.uid) return [];
  const presence = session.roster.get(uid);
  const name = memberName(uid);
  if (presence && presence.live) return [{ label: 'View live', primary: true, onClick: () => openViewer(uid, name) }];
  if (presence && isDispatcherRole(session.role) && hasBodycam(session.members[uid])) return [{ label: 'Request live', onClick: () => requestLive(uid, name) }];
  return [];
}

/** Bodycam streaming is a Security (and dispatcher) feature. */
function hasBodycam(member) {
  return !!member && featuresFor(member).has('bodycam');
}

/** Dispatcher: ask a member to start their bodycam, and open the viewer waiting for it. */
async function requestLive(memberUid, name) {
  const session = state.session;
  if (!session) return;
  try {
    await dbSet(ref(db, `liveRequests/${session.gid}/${memberUid}`), {
      by: state.user.uid, name: state.displayName, ts: serverTimestamp()
    });
    session.requestedLive = memberUid;
    openViewer(memberUid, name);
    toast(`Asked ${name} to start their camera`, 'ok');
  } catch (err) {
    toast(friendlyError(err), 'error');
  }
}

function attachViewer(stream) {
  const video = $('#viewer-video');
  if (video.srcObject !== stream) video.srcObject = stream;
  video.play().catch(() => {});
}

function openViewer(memberUid, name) {
  const session = state.session;
  if (!session) return;
  if (session.viewerUid && session.viewerUid !== memberUid) closeViewer(session);
  session.viewerUid = memberUid;
  session.viewerFollow = true;
  $('#viewer-name').textContent = name;
  $('#viewer-follow').setAttribute('aria-pressed', 'true');
  closeSheets();
  $('#viewer').hidden = false;
  // Video is only sent to members who say they are watching (saves uplink in big groups).
  patchPresence(session, { watching: memberUid });
  state.map.setWatched(memberUid, true);
  setFollowUi(true);
  markLiveStrip();
  const stream = session.mesh.getRemoteVideo(memberUid);
  if (stream) attachViewer(stream);
  renderViewer();
}

function renderViewer() {
  const session = state.session;
  if (!session || !session.viewerUid || $('#viewer').hidden) return;
  const uid = session.viewerUid;
  const presence = session.roster.get(uid);
  const video = $('#viewer-video');
  const playing = video.videoWidth > 0 && presence && presence.live;
  let wait = '';
  if (!presence) wait = 'Member is offline.';
  else if (!presence.live) wait = session.requestedLive === uid ? 'Waiting for the camera to start…' : 'Camera is off.';
  else if (!playing) wait = 'Connecting video…';
  $('#viewer-wait').hidden = !wait;
  $('#viewer-wait').textContent = wait;
  video.style.visibility = presence && presence.live ? 'visible' : 'hidden';
  const pos = session.positions.get(uid);
  const parts = [presence && presence.live ? 'Live' : 'Not live'];
  const duty = session.dispatch ? session.dispatch.status.get(uid) : null;
  if (duty) parts.push(STATUSES[duty.state]);
  if (pos && session.lastFix) {
    const meters = state.map.map.distance([pos.lat, pos.lng], [session.lastFix.lat, session.lastFix.lng]);
    parts.push(meters < 1000 ? `${Math.round(meters)} m from you` : `${(meters / 1000).toFixed(1)} km from you`);
  }
  $('#viewer-meta').textContent = parts.join(' · ');
  if (presence && presence.live && session.requestedLive === uid) session.requestedLive = null;
  const stream = session.mesh.getRemoteVideo(uid);
  if (stream) attachViewer(stream);
}

function closeViewer(session = state.session) {
  const video = $('#viewer-video');
  video.pause();
  video.srcObject = null;
  $('#viewer').hidden = true;
  if (!session) return;
  if (session.requestedLive) {
    // Withdraw an unanswered request.
    if (!session.ending) remove(ref(db, `liveRequests/${session.gid}/${session.requestedLive}`)).catch(() => {});
    session.requestedLive = null;
  }
  if (session.viewerUid) {
    session.viewerUid = null;
    markLiveStrip();
    if (state.map) state.map.setWatched(null, false);
    if (!session.ending) patchPresence(session, { watching: null });
  }
}

/* ---------------- Incoming live-view request (I am the field member) ---------------- */

async function startLiveForRequest(session) {
  $('#live-request').hidden = true;
  closeSheets();
  try {
    session.bodycam.groupName = session.meta ? session.meta.name : '';
    $('#bodycam-panel').hidden = false;
    $('#btn-cam').setAttribute('aria-pressed', 'true');
    await session.bodycam.open();
    await session.bodycam.setLive(true);
    toast('Your camera is live to dispatch', 'ok');
  } catch (err) {
    toast(err && err.name === 'NotAllowedError' ? 'Camera permission denied.' : `Camera unavailable: ${err.message}`, 'error', 5000);
  }
  remove(ref(db, `liveRequests/${session.gid}/${state.user.uid}`)).catch(() => {});
}

function handleLiveRequest(request) {
  const session = state.session;
  if (!session) return;
  const card = $('#live-request');
  if (!request) {
    card.hidden = true;
    return;
  }
  if (session.bodycam.live || !myFeatures(session).has('bodycam')) {
    // Already live, or my role has no bodycam: nothing to start.
    remove(ref(db, `liveRequests/${session.gid}/${state.user.uid}`)).catch(() => {});
    return;
  }
  vibrate([200, 100, 200]);
  if (autoLiveEnabled()) {
    startLiveForRequest(session);
    return;
  }
  $('#live-request-name').textContent = request.name;
  $('#live-request-always').checked = false;
  card.hidden = false;
}

/** Dispatchers: chips for every member broadcasting, and auto-open a new feed. */
function renderLiveStrip() {
  const session = state.session;
  if (!session) return;
  const strip = $('#live-strip');
  const dispatcher = isDispatcherRole(session.role);
  const live = [...session.roster].filter(([uid, p]) => uid !== state.user.uid && p.live).map(([uid]) => uid);
  const previous = session.liveSeen || new Set();
  session.liveSeen = new Set(live);
  strip.hidden = !dispatcher || live.length === 0;
  strip.replaceChildren(...live.map((uid) => h('button', {
    type: 'button',
    'aria-pressed': String(session.viewerUid === uid),
    onClick: () => openViewer(uid, memberName(uid))
  }, memberName(uid))));
  if (!dispatcher || !autoOpenLiveEnabled()) return;
  const started = live.filter((uid) => !previous.has(uid));
  if (started.length && (!session.viewerUid || !session.roster.get(session.viewerUid) || !session.roster.get(session.viewerUid).live)) {
    openViewer(started[0], memberName(started[0]));
    toast(`${memberName(started[0])} started their bodycam`, 'info');
  }
}

function markLiveStrip() {
  const session = state.session;
  for (const button of document.querySelectorAll('#live-strip button')) {
    button.setAttribute('aria-pressed', String(!!session && button.textContent === memberName(session.viewerUid)));
  }
}

function renderLiveViewers() {
  const session = state.session;
  if (!session || !session.bodycam) return;
  const n = session.mesh.viewerCount();
  $('#live-viewers').textContent = session.bodycam.live && n ? `· ${n} watching` : '';
}

/* ---------------- Device settings (members sheet) ---------------- */

async function saveKnox() {
  const session = state.session;
  if (!session || !session.pttKeys) return;
  try {
    await session.pttKeys.setKnox({ enabled: $('#knox-enabled').checked, press: $('#knox-press').value, release: $('#knox-release').value });
    toast('Knox PTT settings saved', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
  renderDeviceSettings();
}

function renderDeviceSettings() {
  const session = state.session;
  $('#ptt-key-label').textContent = session && session.pttKeys ? describeKey(session.pttKeys.binding) : 'Space bar';
  $('#xcover-row').hidden = !isNative;
  $('#knox-row').hidden = !hasNativeKeys;
  $('#auto-open-live').checked = autoOpenLiveEnabled();
  if (session && session.alerts) {
    $('#alarm-sound').checked = !session.alerts.alarm.muted;
    $('#force-volume').checked = session.alerts.alarm.forceVolume;
  }
  $('#force-volume-row').hidden = !isNative;
  if (session && session.pttKeys) {
    $('#native-ptt-keys').textContent = session.pttKeys.describeNativeKeys();
    const knox = session.pttKeys.knox;
    $('#knox-enabled').checked = knox.enabled;
    if (document.activeElement !== $('#knox-press')) $('#knox-press').value = knox.press;
    if (document.activeElement !== $('#knox-release')) $('#knox-release').value = knox.release;
  }
  $('#auto-live').checked = autoLiveEnabled();
  const prox = deviceProximity();
  const groupRadius = session && session.dispatch ? session.dispatch.settings.proximityM : 600;
  const groupOn = !session || !session.dispatch || session.dispatch.settings.proximityOn;
  $('#device-prox').checked = prox.on;
  $('#device-prox-hint').textContent = groupOn
    ? 'Nearby cases that fit your role and equipment. Off also takes you out of auto-assign.'
    : 'Dispatch has switched proximity alerts off for the whole group.';
  const radius = prox.radiusM || groupRadius;
  if (document.activeElement !== $('#device-radius')) $('#device-radius').value = String(radius);
  $('#device-radius-label').textContent = prox.radiusM ? `${prox.radiusM} m (mine)` : `${groupRadius} m (group)`;
  $('#device-radius-reset').hidden = !prox.radiusM;
  renderCriticalStatus();
}

async function renderCriticalStatus() {
  const st = await criticalAlertStatus();
  const parts = [];
  if (!st.notificationsEnabled) parts.push('Notifications are off — alerts can only show while the app is open.');
  if (st.available) {
    parts.push(st.dndAccess ? 'Critical alerts sound through Do Not Disturb.' : 'Allow Do Not Disturb access so critical alerts get through DND.');
    if (!st.fullScreen) parts.push('Allow full-screen alerts so they light up the lock screen.');
    parts.push('The alarm plays on the alarm channel, so the silent switch does not mute it.');
  } else {
    parts.push('Browsers cannot override silent mode or Do Not Disturb — install the Android app for critical alerts.');
  }
  $('#critical-status').textContent = parts.join(' ');
  $('#critical-actions').hidden = !st.available;
  $('#btn-dnd-access').hidden = !st.available || st.dndAccess;
  $('#btn-fullscreen-access').hidden = !st.available || st.fullScreen;
}

/** Show the controls my role allows: [data-feature] elements, body role class and theme colour. */
function applyFeatures(session) {
  if (!session || state.session !== session) return;
  const features = myFeatures(session);
  for (const el of document.querySelectorAll('[data-feature]')) {
    if (features.has(el.dataset.feature)) {
      el.removeAttribute('data-feature-off');
      if (el.id === 'btn-fire' || el.id === 'ptt-channel' || el.id === 'btn-report-big' || el.id === 'btn-epcr-dock') el.hidden = false;
    } else {
      el.setAttribute('data-feature-off', '');
    }
  }
  const me = session.members[state.user.uid];
  const { unit } = profileOf(me);
  if (unit) document.body.dataset.role = unit;
  else document.body.removeAttribute('data-role');
  document.documentElement.style.setProperty('--role-color', unit ? ROLES[unit].color : 'var(--accent)');
  document.body.classList.toggle('is-dispatcher', isDispatcherRole(session.role));
  if (session.ptt) session.ptt.refreshChannels();
  syncEpcrSubscription(session, features.has('epcr'));
}

/** Medical responders and dispatchers keep every patient record of the group in view (counts, analytics). */
function syncEpcrSubscription(session, wanted) {
  if (wanted && !session.epcrUnsub && session.epcrStore) {
    session.epcrUnsub = session.epcrStore.listenAll((tree) => {
      session.epcrAll = tree || {};
      if (session.dispatchUI) session.dispatchUI.renderAll();
    });
  } else if (!wanted && session.epcrUnsub) {
    session.epcrUnsub();
    session.epcrUnsub = null;
    session.epcrAll = {};
  }
}

/** Role colour and equipment badges on every member's map marker. */
function renderProfiles(session) {
  if (!state.map) return;
  const profiles = new Map();
  for (const [uid, m] of Object.entries(session.members)) {
    const { unit } = profileOf(m);
    profiles.set(uid, {
      role: unit || '',
      color: unit ? ROLES[unit].color : '',
      roleShort: isDispatchRole(m.role) && !unit ? 'DSP' : unit ? ROLES[unit].short : '',
      badges: markerBadges(m),
      description: memberRoleLabel(m)
    });
  }
  state.map.setProfiles(profiles);
}

/** Medical field units: open the ePCR for my current case (or my most recent one). */
function openMyEpcr() {
  const session = state.session;
  if (!session) return;
  const lock = session.dispatch.myLock();
  if (lock) {
    session.epcrUI.open(lock.incident.id);
    return;
  }
  const mine = [...session.dispatch.incidents.values()]
    .filter((inc) => inc.assigned && inc.assigned[state.user.uid] && inc.state !== 'rejected')
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (mine.length) session.epcrUI.open(mine[0].id);
  else toast('Accept or open a case first, then record patients from its case screen.');
}

function wireMainScreen() {
  $('#btn-back').addEventListener('click', () => endSession({}));
  $('#btn-members').addEventListener('click', openMembersSheet);
  $('#sheet-backdrop').addEventListener('click', () => closeSheets());
  $('#viewer-close').addEventListener('click', () => closeViewer());
  $('#viewer-follow').addEventListener('click', () => {
    const session = state.session;
    if (!session || !session.viewerUid) return;
    session.viewerFollow = !session.viewerFollow;
    $('#viewer-follow').setAttribute('aria-pressed', String(session.viewerFollow));
    state.map.setWatched(session.viewerUid, session.viewerFollow);
    setFollowUi(session.viewerFollow);
  });
  $('#viewer-video').addEventListener('resize', () => renderViewer());
  $('#viewer-video').addEventListener('loadeddata', () => renderViewer());

  $('#live-request-allow').addEventListener('click', () => {
    const session = state.session;
    if (!session) return;
    if ($('#live-request-always').checked) {
      try { localStorage.setItem(LS_AUTO_LIVE, '1'); } catch { /* ignore */ }
    }
    startLiveForRequest(session);
  });
  $('#live-request-decline').addEventListener('click', () => {
    const session = state.session;
    $('#live-request').hidden = true;
    if (session) remove(ref(db, `liveRequests/${session.gid}/${state.user.uid}`)).catch(() => {});
  });

  $('#btn-ptt-key').addEventListener('click', async () => {
    const session = state.session;
    if (!session || !session.pttKeys) return;
    const button = $('#btn-ptt-key');
    button.textContent = 'Press a key…';
    toast('Press the key to use for push-to-talk (Esc to cancel)', 'info', 6000);
    try {
      const binding = await session.pttKeys.learn();
      toast(`Push-to-talk key: ${describeKey(binding)}`, 'ok');
    } catch { /* cancelled */ }
    button.textContent = 'Change';
    renderDeviceSettings();
  });
  $('#auto-open-live').addEventListener('change', (e) => {
    try { localStorage.setItem(LS_AUTO_OPEN_LIVE, e.target.checked ? '1' : '0'); } catch { /* ignore */ }
  });
  $('#alarm-sound').addEventListener('change', (e) => {
    const session = state.session;
    if (session && session.alerts) session.alerts.alarm.setMuted(!e.target.checked);
  });
  $('#btn-native-key').addEventListener('click', async () => {
    const session = state.session;
    if (!session || !session.pttKeys) return;
    const button = $('#btn-native-key');
    button.textContent = 'Press the button…';
    toast('Press the hardware button to use for push-to-talk', 'info', 8000);
    try {
      const code = await session.pttKeys.learnNative();
      toast(`Hardware key ${code} now talks`, 'ok');
    } catch (err) {
      if (err && err.message !== 'cancelled') toast(err.message, 'error');
    }
    button.textContent = 'Add key';
    renderDeviceSettings();
  });
  $('#auto-live').addEventListener('change', (e) => {
    try { localStorage.setItem(LS_AUTO_LIVE, e.target.checked ? '1' : '0'); } catch { /* ignore */ }
  });
  $('#device-prox').addEventListener('change', (e) => {
    try { localStorage.setItem(LS_PROX_ON, e.target.checked ? '1' : '0'); } catch { /* ignore */ }
    const session = state.session;
    if (session) {
      patchPresence(session, { prox: e.target.checked });
      session.alerts.evaluate();
    }
    renderDeviceSettings();
  });
  $('#device-radius').addEventListener('input', (e) => {
    $('#device-radius-label').textContent = `${e.target.value} m (mine)`;
  });
  $('#device-radius').addEventListener('change', (e) => {
    const radius = clampRadius(e.target.value);
    try { if (radius) localStorage.setItem(LS_PROX_RADIUS, String(radius)); } catch { /* ignore */ }
    if (state.session) state.session.alerts.evaluate();
    renderDeviceSettings();
  });
  $('#device-radius-reset').addEventListener('click', () => {
    try { localStorage.removeItem(LS_PROX_RADIUS); } catch { /* ignore */ }
    if (state.session) state.session.alerts.evaluate();
    renderDeviceSettings();
  });
  $('#force-volume').addEventListener('change', (e) => {
    if (state.session) state.session.alerts.alarm.setForceVolume(e.target.checked);
  });
  $('#btn-dnd-access').addEventListener('click', () => {
    openDndAccessSettings().catch((err) => toast(err.message, 'error'));
    toast('Find Trailguard Essentials in the list and allow access, then come back.', 'info', 6000);
  });
  $('#btn-fullscreen-access').addEventListener('click', () => {
    openFullScreenAlertSettings().catch((err) => toast(err.message, 'error'));
  });
  $('#knox-enabled').addEventListener('change', () => saveKnox());
  $('#knox-save').addEventListener('click', () => saveKnox());
  $('#ptt-channel').addEventListener('click', () => {
    const session = state.session;
    if (!session || !session.ptt) return;
    const { talk } = session.ptt.channels();
    const next = talk[(talk.indexOf(session.ptt.txChannel) + 1) % talk.length];
    if (next) session.ptt.setChannel(next);
    toast(`Talking on the ${CHANNELS[session.ptt.txChannel].label} channel`, 'info', 1500);
  });
  $('#btn-announcements').addEventListener('click', () => { if (state.session) state.session.announcementsUI.open(); });
  $('#btn-epcr-dock').addEventListener('click', () => openMyEpcr());
  // Coming back from the DND / full-screen settings screens: show the new state.
  onAppStateChange((foreground) => { if (foreground && state.session) renderCriticalStatus(); });

  $('#audio-unlock').addEventListener('click', () => {
    if (state.session) state.session.ptt.unlockAudio();
    $('#audio-unlock').hidden = true;
  });

  $('#btn-follow').addEventListener('click', () => {
    if (!state.map) return;
    const on = $('#btn-follow').getAttribute('aria-pressed') !== 'true';
    setFollowUi(on);
    state.map.setFollow(on);
    if (on && !state.map.centerOnSelf(true)) toast('Waiting for your GPS position…');
  });

  $('#btn-fit').addEventListener('click', () => {
    if (!state.map) return;
    setFollowUi(false);
    state.map.setFollow(false);
    if (!state.map.fitGroup()) toast('No member positions yet.');
  });

  $('#btn-track').addEventListener('click', () => {
    const session = state.session;
    if (!session) return;
    if (session.tracker.tracking) {
      session.tracker.stop({ clearRemote: false });
      localStorage.setItem(LS_TRACKING, '0');
      toast('Location sharing paused. Your last position stays visible to the group.');
    } else {
      session.tracker.start();
      localStorage.setItem(LS_TRACKING, '1');
    }
  });

  $('#btn-share').addEventListener('click', async () => {
    const session = state.session;
    if (!session || !session.meta) return;
    const url = inviteLink(session.meta.code);
    const text = `Join "${session.meta.name}" on Trailguard Essentials with code ${formatCode(session.meta.code)}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Trailguard Essentials invite', text, url });
      } else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        toast('Invite link copied', 'ok');
      }
    } catch (err) {
      if (err && err.name !== 'AbortError') toast('Could not share. Read the code out instead.', 'error');
    }
  });

  $('#btn-rotate').addEventListener('click', async () => {
    const session = state.session;
    if (!session || !session.meta) return;
    if (!confirm('Create a new invite code? The old code and links stop working. Current members stay in the group.')) return;
    try {
      const code = await rotateCode(session.gid, session.meta.code);
      toast(`New code ${formatCode(code)}`, 'ok');
    } catch (err) {
      toast(friendlyError(err), 'error');
    }
  });

  $('#btn-leave').addEventListener('click', async () => {
    const session = state.session;
    if (!session || !session.meta) return;
    const owner = session.role === 'owner';
    const prompt = owner
      ? `Disband "${session.meta.name}"? Everyone is removed and all positions are deleted. Clips already in Drive are kept.`
      : `Leave "${session.meta.name}"? You can rejoin with the invite code.`;
    if (!confirm(prompt)) return;
    const { gid, meta } = session;
    const uid = state.user.uid;
    try {
      // Stop media and listeners first so nothing writes after we lose access.
      await endSession({ silent: true, leave: !owner, disband: owner });
      if (owner) await disbandGroup(uid, gid, meta.code);
      else await leaveGroup(uid, gid);
      toast(owner ? 'Group disbanded' : 'You left the group', 'ok');
    } catch (err) {
      toast(friendlyError(err), 'error');
    }
    showScreen('screen-groups');
    renderGroupList();
  });

  // ---------------- Bodycam controls ----------------
  // One touch: camera on (front), recording, and broadcasting to dispatch.
  // Tapping again while it runs in the background just shows the camera.
  $('#btn-cam').addEventListener('click', async () => {
    const session = state.session;
    if (!session) return;
    const panel = $('#bodycam-panel');
    closeSheets();
    panel.hidden = false;
    if (session.bodycam.running && session.bodycam.live && session.bodycam.isRecording) return;
    session.bodycam.groupName = session.meta ? session.meta.name : '';
    try {
      const { recording, live } = await session.bodycam.oneTouch();
      $('#btn-cam').setAttribute('aria-pressed', 'true');
      $('#btn-cam').classList.add('running');
      toast(live && recording ? 'Bodycam on — recording and live to dispatch' : live ? 'Bodycam live to dispatch (this browser cannot record)' : 'Bodycam on', 'ok');
    } catch (err) {
      panel.hidden = true;
      $('#btn-cam').classList.remove('running');
      toast(err && err.name === 'NotAllowedError'
        ? 'Camera permission denied. Enable it in settings.'
        : `Camera unavailable: ${err.message}`, 'error', 5000);
    }
  });

  $('#btn-cam-min').addEventListener('click', () => {
    $('#clip-drawer').hidden = true;
    $('#bodycam-panel').hidden = true;
    toast('Bodycam still recording and live — tap Bodycam to see it');
  });

  $('#btn-cam-close').addEventListener('click', async () => {
    const session = state.session;
    if (!session) return;
    const saved = await session.bodycam.close();
    if (saved) toast('Bodycam stopped. Clip kept on this phone — open Bodycam → Clips to save it to Drive', 'ok');
    $('#clip-drawer').hidden = true;
    $('#bodycam-panel').hidden = true;
    $('#btn-cam').setAttribute('aria-pressed', 'false');
    $('#btn-cam').classList.remove('running');
  });

  $('#btn-flip').addEventListener('click', async () => {
    const session = state.session;
    if (!session) return;
    try { await session.bodycam.flip(); } catch (err) { toast(err.message, 'error'); }
  });

  $('#btn-record').addEventListener('click', async () => {
    const session = state.session;
    if (!session) return;
    const cam = session.bodycam;
    try {
      if (cam.isRecording) {
        const clip = await cam.stopRecording();
        if (clip) toast(`Clip recorded (${formatDuration(clip.durationSec)}). Tap Save to archive it to Drive.`, 'ok');
      } else {
        await cam.open();
        cam.startRecording();
        vibrate(60);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-live').addEventListener('click', async () => {
    const session = state.session;
    if (!session) return;
    const cam = session.bodycam;
    try {
      await cam.setLive(!cam.live);
      toast(cam.live ? 'Broadcasting — dispatchers can now watch' : 'Broadcast stopped', cam.live ? 'ok' : 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-save-clip').addEventListener('click', async () => {
    const session = state.session;
    if (!session) return;
    const clips = await session.bodycam.listClips();
    const next = clips.find((c) => !session.bodycam.uploading.has(c.id));
    if (!next) return;
    uploadClip(session, next.id);
  });

  const setDrawer = (open) => {
    $('#clip-drawer').hidden = !open;
    $('#btn-clips').setAttribute('aria-expanded', String(open));
  };
  $('#btn-clips').addEventListener('click', () => setDrawer($('#clip-drawer').hidden));
  $('#btn-clips-close').addEventListener('click', () => setDrawer(false));

  $('#incident-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = state.session;
    if (!session) return;
    const button = $('#incident-submit');
    setBusy(button, true, 'Sending…');
    try {
      session.bodycam.groupName = session.meta ? session.meta.name : '';
      await session.bodycam.sendIncident($('#incident-text').value);
      $('#incident-text').value = '';
      toast('Field note logged', 'ok');
    } catch (err) {
      toast(err.message, 'error', 5000);
    } finally {
      setBusy(button, false);
    }
  });
}

function wireBodycamEvents(session) {
  const cam = session.bodycam;
  const video = $('#bodycam-video');

  cam.addEventListener('preview', (e) => {
    if (state.session !== session) return;
    video.srcObject = e.detail.stream;
    video.classList.toggle('mirror', !!e.detail.mirrored);
    $('#bodycam-placeholder').hidden = !!e.detail.stream;
    $('#bodycam-placeholder').textContent = 'Starting camera…';
    if (e.detail.stream) video.play().catch(() => {});
  });

  cam.addEventListener('recording', (e) => {
    if (state.session !== session) return;
    $('#rec-indicator').hidden = !e.detail.active;
    $('#rec-time').textContent = '00:00';
    const button = $('#btn-record');
    button.classList.toggle('recording', e.detail.active);
    button.setAttribute('aria-label', e.detail.active ? 'Stop recording' : 'Start recording');
    $('#btn-flip').disabled = e.detail.active;
  });

  cam.addEventListener('tick', (e) => {
    if (state.session === session) $('#rec-time').textContent = formatDuration(e.detail.seconds);
  });

  cam.addEventListener('live', (e) => {
    if (state.session !== session) return;
    $('#live-indicator').hidden = !e.detail.live;
    const button = $('#btn-live');
    button.setAttribute('aria-pressed', String(e.detail.live));
    button.querySelector('span').textContent = e.detail.live ? 'Stop' : 'Broadcast';
    renderLiveViewers();
  });

  cam.addEventListener('clips', (e) => {
    if (state.session === session) renderClips(session, e.detail.clips);
  });

  cam.addEventListener('progress', (e) => {
    session.progress.set(e.detail.id, e.detail);
    const bar = document.querySelector(`[data-progress="${CSS.escape(e.detail.id)}"] > i`);
    if (bar) bar.style.width = `${Math.round((e.detail.sent / e.detail.total) * 100)}%`;
  });

  cam.addEventListener('error', (e) => toast(e.detail.message, 'error'));
}

/** Upload one clip to Drive (from the Save button or the clip list). */
async function uploadClip(session, clipId) {
  const cam = session.bodycam;
  session.bodycam.groupName = session.meta ? session.meta.name : '';
  $('#btn-save-clip').disabled = true;
  cam.refreshClips();
  try {
    await cam.uploadClip(clipId);
    toast('Clip saved to Google Drive', 'ok');
  } catch (err) {
    toast(`Save failed: ${err.message}`, 'error', 6000);
  } finally {
    if (state.session === session) cam.refreshClips();
  }
}

function renderClips(session, clips) {
  const cam = session.bodycam;
  $('#clip-empty').hidden = clips.length > 0;
  $('#outbox-count').textContent = clips.length ? `(${clips.length})` : '';
  $('#btn-save-clip').disabled = !clips.some((c) => !cam.uploading.has(c.id));

  $('#clip-list').replaceChildren(...clips.map((clip) => {
    const busy = cam.uploading.has(clip.id);
    const p = session.progress.get(clip.id);
    const pct = p ? Math.round((p.sent / p.total) * 100) : 0;
    const objectUrl = URL.createObjectURL(clip.blob);
    const uploadBtn = h('button', { class: 'btn small primary', type: 'button', disabled: busy }, busy ? 'Saving…' : 'Save to Drive');
    const deleteBtn = h('button', { class: 'btn small ghost', type: 'button', disabled: busy, 'aria-label': 'Delete clip' }, 'Delete');
    const saveLink = h('a', { class: 'btn small ghost', href: objectUrl, download: clip.fileName }, 'Download');

    uploadBtn.addEventListener('click', () => uploadClip(session, clip.id));
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this clip from the device? It has not been archived.')) return;
      try { await cam.deleteClip(clip.id); } catch (err) { toast(err.message, 'error'); }
    });

    return h('li', {},
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, clip.fileName),
        h('div', { class: 'small muted' }, `${formatDuration(clip.durationSec)} · ${formatBytes(clip.size)}`),
        h('div', { class: 'progress', dataset: { progress: clip.id } }, h('i', { style: `width:${pct}%` }))
      ),
      saveLink, deleteBtn, uploadBtn
    );
  }));
  revokeStaleObjectUrls();
}

// Object URLs for the "Save" links are revoked once their row is re-rendered away.
let liveObjectUrls = new Set();
function revokeStaleObjectUrls() {
  const current = new Set([...document.querySelectorAll('#clip-list a[download]')].map((a) => a.href));
  for (const url of liveObjectUrls) if (!current.has(url)) URL.revokeObjectURL(url);
  liveObjectUrls = current;
}

boot();
