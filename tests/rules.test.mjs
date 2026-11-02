// Security-rule tests for database.rules.json, evaluated offline with targaryen
// (a Firebase Realtime Database rules simulator). Run: npm run test:rules
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const targaryen = require('targaryen');
const rules = JSON.parse(readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8'));

const TS = { '.sv': 'timestamp' };
const GID = '-NgroupAAAAAAAAAAAAA';
const CODE = 'ABCD2345';
const OWNER = { uid: 'owner1', provider: 'password' };
const ALICE = { uid: 'alice1', provider: 'password' };
const BOB = { uid: 'bob1', provider: 'password' };
const MALLORY = { uid: 'mallory', provider: 'password' };

let failures = 0;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').slice(0, 6).join('\n      ')}`);
  }
}

let clock = 1_700_000_000_000;
const tick = (ms = 1000) => { clock += ms; return clock; };

// Note: targaryen's write(path, value, opts) takes { now } as an options object;
// update(path, patch, now) takes the timestamp directly.
function db(data) {
  return targaryen.database(rules, data).with({ debug: true });
}
function allowed(result) { assert.equal(result.allowed, true, result.info); return result.newDatabase; }
function denied(result, why = 'expected denial') { assert.equal(result.allowed, false, why); }

/** Group created by OWNER, with ALICE as member. */
function baseState() {
  let d = db(null);
  d = allowed(d.as(OWNER).update('/', {
    [`groups/${GID}/meta`]: { name: 'Alpha Team', owner: OWNER.uid, code: CODE, createdAt: TS },
    [`groups/${GID}/members/${OWNER.uid}`]: { name: 'Owner', role: 'owner', code: CODE, joinedAt: TS },
    [`groupCodes/${CODE}`]: GID,
    [`users/${OWNER.uid}/groups/${GID}`]: true
  }, tick()));
  d = allowed(d.as(ALICE).update('/', {
    [`groups/${GID}/members/${ALICE.uid}`]: { name: 'Alice', role: 'member', code: CODE, joinedAt: TS },
    [`users/${ALICE.uid}/groups/${GID}`]: true
  }, tick()));
  return d;
}

console.log('Group lifecycle');
test('owner can create a group atomically', () => { baseState(); });

test('create fails if the invite code is already taken', () => {
  const d = baseState();
  denied(d.as(BOB).update('/', {
    [`groups/-Nother/meta`]: { name: 'B', owner: BOB.uid, code: CODE, createdAt: TS },
    [`groups/-Nother/members/${BOB.uid}`]: { name: 'Bob', role: 'owner', code: CODE, joinedAt: TS },
    [`groupCodes/${CODE}`]: '-Nother'
  }, tick()));
});

test('cannot point an invite code at someone else\'s group', () => {
  const d = baseState();
  denied(d.as(MALLORY).write('groupCodes/ZZZZ9999', GID, { now: tick() }));
});

test('anyone signed in can resolve a code, but not list codes', () => {
  const d = baseState();
  allowed(d.as(BOB).read(`groupCodes/${CODE}`));
  denied(d.as(BOB).read('groupCodes'));
  denied(targaryen.database(rules, null).read(`groupCodes/${CODE}`)); // signed out
});

test('join with the right code', () => {
  const d = baseState();
  allowed(d.as(BOB).update('/', {
    [`groups/${GID}/members/${BOB.uid}`]: { name: 'Bob', role: 'member', code: CODE, joinedAt: TS },
    [`users/${BOB.uid}/groups/${GID}`]: true
  }, tick()));
});

test('join with a wrong code is denied', () => {
  const d = baseState();
  denied(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}`, { name: 'Bob', role: 'member', code: 'WRONG234', joinedAt: TS }, { now: tick() }));
});

test('joining as owner is denied', () => {
  const d = baseState();
  denied(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}`, { name: 'Bob', role: 'owner', code: CODE, joinedAt: TS }, { now: tick() }));
});

test('cannot add somebody else as a member', () => {
  const d = baseState();
  denied(d.as(ALICE).write(`groups/${GID}/members/${BOB.uid}`, { name: 'Bob', role: 'member', code: CODE, joinedAt: TS }, { now: tick() }));
});

test('member cannot change their own role', () => {
  const d = baseState();
  denied(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/role`, 'owner', { now: tick() }));
});

test('member cannot take over the group', () => {
  const d = baseState();
  denied(d.as(ALICE).write(`groups/${GID}/meta/owner`, ALICE.uid, { now: tick() }));
});

test('owner can rename; member cannot', () => {
  const d = baseState();
  allowed(d.as(OWNER).write(`groups/${GID}/meta/name`, 'Bravo', { now: tick() }));
  denied(d.as(ALICE).write(`groups/${GID}/meta/name`, 'Hacked', { now: tick() }));
});

test('non-members cannot read anything in the group', () => {
  const d = baseState();
  for (const p of [`groups/${GID}`, `groups/${GID}/members`, `presence/${GID}`, `locations/${GID}`, `ptt/${GID}`, `uploads/${GID}`]) {
    denied(d.as(BOB).read(p));
  }
  allowed(d.as(ALICE).read(`groups/${GID}`));
  allowed(d.as(ALICE).read(`locations/${GID}`));
});

test('member can leave atomically', () => {
  const d = baseState();
  allowed(d.as(ALICE).update('/', {
    [`groups/${GID}/members/${ALICE.uid}`]: null,
    [`presence/${GID}/${ALICE.uid}`]: null,
    [`locations/${GID}/${ALICE.uid}`]: null,
    [`signals/${GID}/${ALICE.uid}`]: null,
    [`users/${ALICE.uid}/groups/${GID}`]: null
  }, tick()));
});

test('owner removes and blocks a member; blocked member cannot rejoin; unblock restores', () => {
  let d = baseState();
  d = allowed(d.as(OWNER).update('/', {
    [`groups/${GID}/members/${ALICE.uid}`]: null,
    [`presence/${GID}/${ALICE.uid}`]: null,
    [`locations/${GID}/${ALICE.uid}`]: null,
    [`groups/${GID}/banned/${ALICE.uid}`]: 'Alice'
  }, tick()));
  denied(d.as(ALICE).read(`groups/${GID}`));
  denied(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}`, { name: 'Alice', role: 'member', code: CODE, joinedAt: TS }, { now: tick() }));
  d = allowed(d.as(OWNER).write(`groups/${GID}/banned/${ALICE.uid}`, null, { now: tick() }));
  allowed(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}`, { name: 'Alice', role: 'member', code: CODE, joinedAt: TS }, { now: tick() }));
});

test('member cannot remove another member', () => {
  let d = baseState();
  d = allowed(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}`, { name: 'Bob', role: 'member', code: CODE, joinedAt: TS }, { now: tick() }));
  denied(d.as(ALICE).write(`groups/${GID}/members/${BOB.uid}`, null, { now: tick() }));
});

test('owner rotates the invite code; old code stops working', () => {
  let d = baseState();
  d = allowed(d.as(OWNER).update('/', {
    [`groups/${GID}/meta/code`]: 'NEWC0DE2'.replace('0', 'Q'),
    [`groupCodes/NEWCQDE2`]: GID,
    [`groupCodes/${CODE}`]: null
  }, tick()));
  denied(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}`, { name: 'Bob', role: 'member', code: CODE, joinedAt: TS }, { now: tick() }));
  allowed(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}`, { name: 'Bob', role: 'member', code: 'NEWCQDE2', joinedAt: TS }, { now: tick() }));
});

test('member cannot rotate the code', () => {
  const d = baseState();
  denied(d.as(ALICE).update('/', {
    [`groups/${GID}/meta/code`]: 'MMMMMMMM',
    [`groupCodes/MMMMMMMM`]: GID,
    [`groupCodes/${CODE}`]: null
  }, tick()));
});

test('owner can disband everything in one update; member cannot', () => {
  const d = baseState();
  const patch = {
    [`groups/${GID}`]: null,
    [`presence/${GID}`]: null,
    [`locations/${GID}`]: null,
    [`ptt/${GID}`]: null,
    [`signals/${GID}`]: null,
    [`uploads/${GID}`]: null,
    [`groupCodes/${CODE}`]: null
  };
  denied(d.as(ALICE).update('/', patch, tick()));
  allowed(d.as(OWNER).update('/', { ...patch, [`users/${OWNER.uid}/groups/${GID}`]: null }, tick()));
});

console.log('Presence & location');
const presence = (name, sid) => ({ name, sid, live: false, tracking: true, lastSeen: TS });

test('member sets own presence; non-member cannot', () => {
  const d = baseState();
  allowed(d.as(ALICE).write(`presence/${GID}/${ALICE.uid}`, presence('Alice', 'sid-alice-0001'), { now: tick() }));
  denied(d.as(BOB).write(`presence/${GID}/${BOB.uid}`, presence('Bob', 'sid-bob-00001'), { now: tick() }));
  denied(d.as(ALICE).write(`presence/${GID}/${OWNER.uid}`, presence('Owner', 'sid-xxxxxxxxx'), { now: tick() }));
});

test('partial presence update (live flag) passes validation', () => {
  let d = baseState();
  d = allowed(d.as(ALICE).write(`presence/${GID}/${ALICE.uid}`, presence('Alice', 'sid-alice-0001'), { now: tick() }));
  allowed(d.as(ALICE).update(`presence/${GID}/${ALICE.uid}`, { live: true }, tick()));
});

const loc = (extra = {}) => ({ lat: 1.3, lng: 103.8, acc: 5, ts: TS, name: 'Alice', ...extra });

test('member writes own location', () => {
  const d = baseState();
  allowed(d.as(ALICE).write(`locations/${GID}/${ALICE.uid}`, loc({ heading: 90, speed: 1.2, gpsTs: 123 }), { now: tick() }));
});

test('location writes are rate limited to one per 500 ms', () => {
  let d = baseState();
  d = allowed(d.as(ALICE).write(`locations/${GID}/${ALICE.uid}`, loc(), { now: tick() }));
  denied(d.as(ALICE).write(`locations/${GID}/${ALICE.uid}`, loc({ lat: 1.31 }), { now: tick(100) }));
  allowed(d.as(ALICE).write(`locations/${GID}/${ALICE.uid}`, loc({ lat: 1.31 }), { now: tick(600) }));
});

test('location validation rejects bad data and client-forged timestamps', () => {
  const d = baseState();
  denied(d.as(ALICE).write(`locations/${GID}/${ALICE.uid}`, loc({ lat: 123 }), { now: tick() }));
  denied(d.as(ALICE).write(`locations/${GID}/${ALICE.uid}`, loc({ ts: 5 }), { now: tick() }));
  denied(d.as(ALICE).write(`locations/${GID}/${ALICE.uid}`, loc({ extra: 'x' }), { now: tick() }));
});

test('cannot write another member\'s location; non-member cannot write at all', () => {
  const d = baseState();
  denied(d.as(ALICE).write(`locations/${GID}/${OWNER.uid}`, loc(), { now: tick() }));
  denied(d.as(BOB).write(`locations/${GID}/${BOB.uid}`, loc({ name: 'Bob' }), { now: tick() }));
});

console.log('Push-to-talk floor');
const floor = (who, sid) => ({ uid: who.uid, name: who.uid, sid, since: TS });

test('free floor can be taken; held floor cannot', () => {
  let d = baseState();
  d = allowed(d.as(ALICE).write(`ptt/${GID}/main`, floor(ALICE, 'sid-a'), { now: tick() }));
  denied(d.as(OWNER).write(`ptt/${GID}/main`, floor(OWNER, 'sid-o'), { now: tick(5000) }));
});

test('stale floor (>65 s) can be taken over', () => {
  let d = baseState();
  d = allowed(d.as(ALICE).write(`ptt/${GID}/main`, floor(ALICE, 'sid-a'), { now: tick() }));
  allowed(d.as(OWNER).write(`ptt/${GID}/main`, floor(OWNER, 'sid-o'), { now: tick(66_000) }));
});

test('only the holder releases the floor (owner may force-clear)', () => {
  let d = baseState();
  d = allowed(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}`, { name: 'Bob', role: 'member', code: CODE, joinedAt: TS }, { now: tick() }));
  d = allowed(d.as(ALICE).write(`ptt/${GID}/main`, floor(ALICE, 'sid-a'), { now: tick() }));
  denied(d.as(BOB).write(`ptt/${GID}/main`, null, { now: tick() }));
  allowed(d.as(OWNER).write(`ptt/${GID}/main`, null, { now: tick() }));
  allowed(d.as(ALICE).write(`ptt/${GID}/main`, null, { now: tick() }));
});

test('cannot claim the floor in someone else\'s name; non-member cannot claim', () => {
  const d = baseState();
  denied(d.as(ALICE).write(`ptt/${GID}/main`, floor(OWNER, 'sid-o'), { now: tick() }));
  denied(d.as(BOB).write(`ptt/${GID}/main`, floor(BOB, 'sid-b'), { now: tick() }));
});

console.log('WebRTC signalling');
const signal = (from, to, extra = {}) => ({ from: from.uid, fromSid: 'sid-from', toSid: 'sid-to', gen: 1, type: 'offer', data: '{}', ts: TS, ...extra });

test('member can signal another member; recipient reads and deletes', () => {
  let d = baseState();
  d = allowed(d.as(OWNER).write(`signals/${GID}/${ALICE.uid}/m1`, signal(OWNER, ALICE), { now: tick() }));
  allowed(d.as(ALICE).read(`signals/${GID}/${ALICE.uid}`));
  denied(d.as(OWNER).read(`signals/${GID}/${ALICE.uid}`));
  allowed(d.as(ALICE).write(`signals/${GID}/${ALICE.uid}/m1`, null, { now: tick() }));
  allowed(d.as(ALICE).write(`signals/${GID}/${ALICE.uid}`, null, { now: tick() }));
});

test('cannot spoof the sender, signal non-members, or signal as a non-member', () => {
  const d = baseState();
  denied(d.as(ALICE).write(`signals/${GID}/${OWNER.uid}/m1`, signal(BOB, OWNER), { now: tick() }));
  denied(d.as(ALICE).write(`signals/${GID}/${BOB.uid}/m1`, signal(ALICE, BOB), { now: tick() }));
  denied(d.as(BOB).write(`signals/${GID}/${ALICE.uid}/m1`, signal(BOB, ALICE), { now: tick() }));
  denied(d.as(ALICE).write(`signals/${GID}/${OWNER.uid}/m1`, signal(ALICE, OWNER, { type: 'evil' }), { now: tick() }));
});

test('cannot overwrite an existing signal message', () => {
  let d = baseState();
  d = allowed(d.as(OWNER).write(`signals/${GID}/${ALICE.uid}/m1`, signal(OWNER, ALICE), { now: tick() }));
  denied(d.as(OWNER).write(`signals/${GID}/${ALICE.uid}/m1`, signal(OWNER, ALICE, { data: '{"x":1}' }), { now: tick() }));
});

console.log('Uploads log & profiles');
test('member logs an archived clip; spoofed uploader denied', () => {
  const d = baseState();
  const entry = { uid: ALICE.uid, name: 'Alice', fileId: 'f1', fileName: 'a.webm', size: 10, durationSec: 3, url: 'https://drive.google.com/x', ts: TS };
  allowed(d.as(ALICE).write(`uploads/${GID}/u1`, entry, { now: tick() }));
  denied(d.as(ALICE).write(`uploads/${GID}/u2`, { ...entry, uid: OWNER.uid }, { now: tick() }));
  denied(d.as(BOB).write(`uploads/${GID}/u3`, { ...entry, uid: BOB.uid }, { now: tick() }));
});

test('profiles are private to their owner', () => {
  let d = db(null);
  d = allowed(d.as(ALICE).write(`users/${ALICE.uid}/profile`, { displayName: 'Alice', email: 'a@x.io', createdAt: 1 }, { now: tick() }));
  allowed(d.as(ALICE).read(`users/${ALICE.uid}`));
  denied(d.as(BOB).read(`users/${ALICE.uid}`));
  denied(d.as(BOB).write(`users/${ALICE.uid}/groups/${GID}`, true, { now: tick() }));
});

test('root is closed', () => {
  const d = baseState();
  denied(d.as(OWNER).read('/'));
  denied(d.as(OWNER).write('/somethingElse', 1, { now: tick() }));
});

console.log('Dispatch: roles, SOS, incidents, assignments, status');
const DISPATCHER = { uid: 'disp1', provider: 'password' };

/** baseState + BOB as member + DISPATCHER promoted to dispatcher by the owner. */
const CASE_UNITS = {
  medical_minor: { medical: true },
  medical_major: { medical: true },
  cardiac: { medical: true },
  crowd: { security: true, usher: true },
  security: { security: true },
  lost: { usher: true, security: true },
  fire: { fire: true },
  transport: { medical: true },
  other: { medical: true, security: true, fire: true }
};
const SETTINGS = { v: 2, proximityM: 600, proximityOn: true, autoAssign: false, autoTimeoutS: 90, caseUnits: CASE_UNITS };

/** baseState + Bob, Dee (dispatcher); Alice = Medical on a bike with an aid bag, Bob = Security; group settings v2. */
function dispatchState(settings = SETTINGS) {
  let d = baseState();
  d = allowed(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}`, { name: 'Bob', role: 'member', code: CODE, joinedAt: TS }, { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`groups/${GID}/members/${DISPATCHER.uid}`, { name: 'Dee', role: 'member', code: CODE, joinedAt: TS }, { now: tick() }));
  d = allowed(d.as(OWNER).write(`groups/${GID}/members/${DISPATCHER.uid}/role`, 'dispatcher', { now: tick() }));
  d = allowed(d.as(ALICE).update('/', {
    [`groups/${GID}/members/${ALICE.uid}/unit`]: 'medical',
    [`groups/${GID}/members/${ALICE.uid}/gear`]: { aid_bag: true },
    [`groups/${GID}/members/${ALICE.uid}/mode`]: 'bike'
  }, tick()));
  d = allowed(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}/unit`, 'security', { now: tick() }));
  d = allowed(d.as(OWNER).write(`groups/${GID}/settings`, settings, { now: tick() }));
  return d;
}
const incident = (who, extra = {}) => ({
  type: 'medical_minor', title: 'Collapsed person', priority: 1, state: 'open', lat: 1.3, lng: 103.8,
  createdBy: who.uid, createdByName: who.uid, createdAt: TS, updatedAt: TS, ...extra
});
const sos = (who) => incident(who, { type: 'sos', title: `SOS ${who.uid}` });

test('only the owner changes roles; nobody can make an owner', () => {
  const d = dispatchState();
  denied(d.as(ALICE).write(`groups/${GID}/members/${BOB.uid}/role`, 'dispatcher', { now: tick() }));
  denied(d.as(DISPATCHER).write(`groups/${GID}/members/${BOB.uid}/role`, 'dispatcher', { now: tick() }));
  denied(d.as(OWNER).write(`groups/${GID}/members/${BOB.uid}/role`, 'owner', { now: tick() }));
  denied(d.as(OWNER).write(`groups/${GID}/members/${OWNER.uid}/role`, 'member', { now: tick() }));
  allowed(d.as(OWNER).write(`groups/${GID}/members/${DISPATCHER.uid}/role`, 'member', { now: tick() }));
});

test('member reports start Pending Review; dispatchers create verified cases directly', () => {
  let d = dispatchState();
  allowed(d.as(DISPATCHER).write(`incidents/${GID}/i1`, incident(DISPATCHER), { now: tick() }));
  allowed(d.as(OWNER).write(`incidents/${GID}/i2`, incident(OWNER, { state: 'monitoring' }), { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/i3`, incident(ALICE), { now: tick() }), 'member cannot skip review');
  d = allowed(d.as(ALICE).write(`incidents/${GID}/i3`, incident(ALICE, { state: 'pending', source: 'pin' }), { now: tick() }));
  denied(d.as(ALICE).update(`incidents/${GID}/i3`, { priority: 3 }, tick()));
  denied(d.as(ALICE).update(`incidents/${GID}/i3`, { state: 'open' }, tick()), 'reporter cannot verify own report');
  denied(d.as(ALICE).write(`incidents/${GID}/i4`, incident(ALICE, { state: 'closed' }), { now: tick() }));
  denied(d.as(MALLORY).write(`incidents/${GID}/i5`, incident(MALLORY, { state: 'pending' }), { now: tick() }));
  denied(d.as(BOB).write(`incidents/${GID}/i6`, incident(BOB, { state: 'pending', assigned: { [BOB.uid]: { name: 'Bob', state: 'accepted', ts: TS } } }), { now: tick() }),
    'a pending report cannot carry assignments');
});

test('dispatcher verifies or rejects a pending report; reporter can withdraw it while pending', () => {
  let d = dispatchState();
  d = allowed(d.as(ALICE).write(`incidents/${GID}/r1`, incident(ALICE, { state: 'pending' }), { now: tick() }));
  d = allowed(d.as(ALICE).write(`incidents/${GID}/r2`, incident(ALICE, { state: 'pending' }), { now: tick() }));
  d = allowed(d.as(ALICE).write(`incidents/${GID}/r3`, incident(ALICE, { state: 'pending' }), { now: tick() }));
  denied(d.as(BOB).update(`incidents/${GID}/r1`, { state: 'open', verifiedBy: BOB.uid, verifiedByName: 'Bob', verifiedAt: TS }, tick()));
  denied(d.as(DISPATCHER).update(`incidents/${GID}/r1`, { state: 'open', verifiedBy: ALICE.uid, verifiedByName: 'x', verifiedAt: TS }, tick()), 'cannot verify in someone else\'s name');
  d = allowed(d.as(DISPATCHER).update(`incidents/${GID}/r1`, { state: 'open', type: 'medical_major', verifiedBy: DISPATCHER.uid, verifiedByName: 'Dee', verifiedAt: TS, updatedAt: TS }, tick()));
  denied(d.as(ALICE).update(`incidents/${GID}/r1`, { state: 'closed', closedAt: TS, closedBy: ALICE.uid, closedByName: 'Alice' }, tick()), 'verified case: reporter can no longer withdraw');
  allowed(d.as(DISPATCHER).update(`incidents/${GID}/r2`, { state: 'rejected', rejectReason: 'Duplicate of r1', closedAt: TS, closedBy: DISPATCHER.uid, closedByName: 'Dee', updatedAt: TS }, tick()));
  allowed(d.as(ALICE).update(`incidents/${GID}/r3`, { state: 'closed', closedAt: TS, closedBy: ALICE.uid, closedByName: 'Alice' }, tick()));
  denied(d.as(BOB).update(`incidents/${GID}/r3`, { state: 'closed', closedAt: TS, closedBy: BOB.uid, closedByName: 'Bob' }, tick()));
});

test('an SOS must start open (not monitoring)', () => {
  const d = dispatchState();
  denied(d.as(ALICE).write(`incidents/${GID}/s9`, { ...sos(ALICE), state: 'monitoring' }, { now: tick() }));
});

test('live-view requests: dispatchers ask, the member or a dispatcher clears', () => {
  let d = dispatchState();
  const req = (who) => ({ by: who.uid, name: who.uid, ts: TS });
  denied(d.as(BOB).write(`liveRequests/${GID}/${ALICE.uid}`, req(BOB), { now: tick() }));
  denied(d.as(DISPATCHER).write(`liveRequests/${GID}/${ALICE.uid}`, req(OWNER), { now: tick() }));
  denied(d.as(DISPATCHER).write(`liveRequests/${GID}/${MALLORY.uid}`, req(DISPATCHER), { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`liveRequests/${GID}/${ALICE.uid}`, req(DISPATCHER), { now: tick() }));
  denied(d.as(BOB).write(`liveRequests/${GID}/${ALICE.uid}`, null, { now: tick() }));
  allowed(d.as(ALICE).read(`liveRequests/${GID}`));
  denied(d.as(MALLORY).read(`liveRequests/${GID}`));
  allowed(d.as(ALICE).write(`liveRequests/${GID}/${ALICE.uid}`, null, { now: tick() }));
});

test('any member can raise an SOS, without location if GPS has no fix', () => {
  const d = dispatchState();
  allowed(d.as(ALICE).write(`incidents/${GID}/s1`, sos(ALICE), { now: tick() }));
  const { lat, lng, ...noFix } = sos(ALICE);
  allowed(d.as(ALICE).write(`incidents/${GID}/s2`, noFix, { now: tick() }));
  denied(d.as(MALLORY).write(`incidents/${GID}/s3`, sos(MALLORY), { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/s4`, { ...sos(ALICE), createdBy: BOB.uid }, { now: tick() }));
});

test('SOS reporter can cancel their SOS but not edit or delete it; others cannot cancel', () => {
  let d = dispatchState();
  d = allowed(d.as(ALICE).write(`incidents/${GID}/s1`, sos(ALICE), { now: tick() }));
  const close = (who) => ({ state: 'closed', closedAt: TS, closedBy: who.uid, closedByName: who.uid });
  denied(d.as(BOB).update(`incidents/${GID}/s1`, close(BOB), tick()));
  denied(d.as(ALICE).update(`incidents/${GID}/s1`, { title: 'changed' }, tick()));
  denied(d.as(ALICE).write(`incidents/${GID}/s1`, null, { now: tick() }));
  allowed(d.as(ALICE).update(`incidents/${GID}/s1`, close(ALICE), tick()));
});

test('dispatcher edits, assigns, closes and deletes; immutable fields stay immutable', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/i1`, incident(DISPATCHER), { now: tick() }));
  d = allowed(d.as(DISPATCHER).update(`incidents/${GID}/i1`, { priority: 2, updatedAt: TS, [`assigned/${ALICE.uid}`]: { name: 'Alice', state: 'assigned', ts: TS } }, tick()));
  denied(d.as(DISPATCHER).update(`incidents/${GID}/i1`, { createdBy: ALICE.uid }, tick()));
  denied(d.as(DISPATCHER).update(`incidents/${GID}/i1`, { createdAt: 5 }, tick()));
  denied(d.as(DISPATCHER).write(`incidents/${GID}/i1/assigned/${MALLORY.uid}`, { name: 'M', state: 'assigned', ts: TS }, { now: tick() }));
  d = allowed(d.as(DISPATCHER).update(`incidents/${GID}/i1`, { state: 'closed', closedAt: TS, closedBy: DISPATCHER.uid, closedByName: 'Dee', updatedAt: TS }, tick()));
  allowed(d.as(DISPATCHER).write(`incidents/${GID}/i1`, null, { now: tick() }));
});

test('assigned responder updates only their own assignment state', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/i1`, incident(DISPATCHER, { assigned: { [ALICE.uid]: { name: 'Alice', state: 'assigned', ts: TS } } }), { now: tick() }));
  d = allowed(d.as(ALICE).write(`incidents/${GID}/i1/assigned/${ALICE.uid}`, { name: 'Alice', state: 'enroute', ts: TS }, { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/i1/assigned/${ALICE.uid}`, { name: 'Alice', state: 'hijacked', ts: TS }, { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/i1/assigned/${ALICE.uid}`, null, { now: tick() }));
  denied(d.as(BOB).write(`incidents/${GID}/i1/assigned/${ALICE.uid}`, { name: 'Alice', state: 'declined', ts: TS }, { now: tick() }));
  denied(d.as(BOB).write(`incidents/${GID}/i1/assigned/${BOB.uid}`, { name: 'Bob', state: 'enroute', ts: TS }, { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/i1/priority`, 3, { now: tick() }));
});

test('members can self-dispatch to an open SOS (en route only)', () => {
  let d = dispatchState();
  d = allowed(d.as(ALICE).write(`incidents/${GID}/s1`, sos(ALICE), { now: tick() }));
  allowed(d.as(BOB).write(`incidents/${GID}/s1/assigned/${BOB.uid}`, { name: 'Bob', state: 'enroute', ts: TS }, { now: tick() }));
  denied(d.as(BOB).write(`incidents/${GID}/s1/assigned/${BOB.uid}`, { name: 'Bob', state: 'onscene', ts: TS }, { now: tick() }));
  denied(d.as(MALLORY).write(`incidents/${GID}/s1/assigned/${MALLORY.uid}`, { name: 'M', state: 'enroute', ts: TS }, { now: tick() }));
});

test('members acknowledge alerts only for themselves', () => {
  let d = dispatchState();
  d = allowed(d.as(ALICE).write(`incidents/${GID}/s1`, sos(ALICE), { now: tick() }));
  allowed(d.as(BOB).write(`incidents/${GID}/s1/acks/${BOB.uid}`, TS, { now: tick() }));
  denied(d.as(BOB).write(`incidents/${GID}/s1/acks/${OWNER.uid}`, TS, { now: tick() }));
  denied(d.as(MALLORY).write(`incidents/${GID}/s1/acks/${MALLORY.uid}`, TS, { now: tick() }));
});

test('incidents and logs are invisible to non-members', () => {
  let d = dispatchState();
  d = allowed(d.as(ALICE).write(`incidents/${GID}/s1`, sos(ALICE), { now: tick() }));
  denied(d.as(MALLORY).read(`incidents/${GID}`));
  denied(d.as(MALLORY).read(`incidentLog/${GID}`));
  denied(d.as(MALLORY).read(`status/${GID}`));
  allowed(d.as(BOB).read(`incidents/${GID}`));
});

test('responder status: self only, valid states, dispatcher may clear', () => {
  let d = dispatchState();
  d = allowed(d.as(ALICE).write(`status/${GID}/${ALICE.uid}`, { state: 'available', name: 'Alice', ts: TS }, { now: tick() }));
  allowed(d.as(ALICE).write(`status/${GID}/${ALICE.uid}`, { state: 'enroute', incidentId: 'i1', name: 'Alice', ts: TS }, { now: tick() }));
  denied(d.as(ALICE).write(`status/${GID}/${ALICE.uid}`, { state: 'sleeping', name: 'Alice', ts: TS }, { now: tick() }));
  denied(d.as(BOB).write(`status/${GID}/${ALICE.uid}`, { state: 'offduty', name: 'Alice', ts: TS }, { now: tick() }));
  allowed(d.as(DISPATCHER).write(`status/${GID}/${ALICE.uid}`, null, { now: tick() }));
});

test('incident log: members append as themselves; entries are immutable', () => {
  let d = dispatchState();
  const entry = (who, text) => ({ uid: who.uid, name: who.uid, text, kind: 'note', ts: TS });
  d = allowed(d.as(ALICE).write(`incidentLog/${GID}/i1/e1`, entry(ALICE, 'On scene, patient conscious'), { now: tick() }));
  denied(d.as(ALICE).write(`incidentLog/${GID}/i1/e1`, entry(ALICE, 'edited'), { now: tick() }));
  denied(d.as(BOB).write(`incidentLog/${GID}/i1/e2`, entry(ALICE, 'spoof'), { now: tick() }));
  denied(d.as(MALLORY).write(`incidentLog/${GID}/i1/e3`, entry(MALLORY, 'x'), { now: tick() }));
});

test('disband also wipes dispatch data', () => {
  let d = dispatchState();
  d = allowed(d.as(ALICE).write(`incidents/${GID}/s1`, sos(ALICE), { now: tick() }));
  allowed(d.as(OWNER).update('/', {
    [`groups/${GID}`]: null, [`incidents/${GID}`]: null, [`incidentLog/${GID}`]: null, [`status/${GID}`]: null,
    [`presence/${GID}`]: null, [`locations/${GID}`]: null, [`ptt/${GID}`]: null, [`signals/${GID}`]: null,
    [`uploads/${GID}`]: null, [`liveRequests/${GID}`]: null, [`media/${GID}`]: null, [`groupCodes/${CODE}`]: null,
    [`epcr/${GID}`]: null, [`announcements/${GID}`]: null, [`overlays/${GID}`]: null
  }, tick()));
});

test('presence can carry the live-video "watching" target', () => {
  const d = dispatchState();
  allowed(d.as(BOB).write(`presence/${GID}/${BOB.uid}`, { ...presence('Bob', 'sid-bob-00001'), watching: ALICE.uid }, { now: tick() }));
});

console.log('Units, case privileges, proximity accept, task lock, ETA, photos');

test('members pick their own role; dispatchers can set anyone\'s; invalid and pre-1.4 roles refused', () => {
  const d = dispatchState();
  allowed(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/unit`, 'fire', { now: tick() }));
  denied(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/unit`, 'dispatcher', { now: tick() }), 'dispatcher is a permission, not a role');
  denied(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/unit`, 'ambulance', { now: tick() }), '1.3 unit names are gone');
  denied(d.as(ALICE).write(`groups/${GID}/members/${BOB.uid}/unit`, 'usher', { now: tick() }));
  allowed(d.as(DISPATCHER).write(`groups/${GID}/members/${BOB.uid}/unit`, 'usher', { now: tick() }));
  denied(d.as(MALLORY).write(`groups/${GID}/members/${MALLORY.uid}/unit`, 'medical', { now: tick() }), 'non-member cannot create a member via unit');
});

test('only dispatchers change group settings; settings are validated', () => {
  const d = dispatchState();
  denied(d.as(ALICE).write(`groups/${GID}/settings/proximityM`, 2000, { now: tick() }));
  allowed(d.as(DISPATCHER).write(`groups/${GID}/settings/proximityM`, 800, { now: tick() }));
  allowed(d.as(DISPATCHER).write(`groups/${GID}/settings/proximityM`, 100, { now: tick() }));
  allowed(d.as(DISPATCHER).write(`groups/${GID}/settings/proximityM`, 2000, { now: tick() }));
  denied(d.as(DISPATCHER).write(`groups/${GID}/settings/proximityM`, 50, { now: tick() }), 'below 100 m');
  denied(d.as(DISPATCHER).write(`groups/${GID}/settings/proximityM`, 2500, { now: tick() }), 'above 2000 m');
  allowed(d.as(DISPATCHER).write(`groups/${GID}/settings/proximityOn`, false, { now: tick() }));
  allowed(d.as(DISPATCHER).write(`groups/${GID}/settings/autoAssign`, true, { now: tick() }));
  denied(d.as(DISPATCHER).write(`groups/${GID}/settings/autoAssign`, 'yes', { now: tick() }));
  denied(d.as(DISPATCHER).write(`groups/${GID}/settings/autoTimeoutS`, 5, { now: tick() }));
  denied(d.as(ALICE).write(`groups/${GID}/settings/autoAssign`, true, { now: tick() }));
  denied(d.as(DISPATCHER).write(`groups/${GID}/settings/caseUnits/medical_minor/dispatcher`, true, { now: tick() }));
  denied(d.as(DISPATCHER).write(`groups/${GID}/settings/caseUnits/sos/medical`, true, { now: tick() }));
  denied(d.as(DISPATCHER).write(`groups/${GID}/settings/caseUnits/crowd/medic`, true, { now: tick() }), '1.3 unit names are gone');
  allowed(d.as(DISPATCHER).write(`groups/${GID}/settings/caseUnits/crowd/medical`, true, { now: tick() }));
});

const verified = (who, extra = {}) => incident(who, { state: 'open', ...extra });

test('a unit can accept a verified case only if its unit responds to that case type', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER, { type: 'medical_minor' }), { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/c1`, verified(DISPATCHER, { type: 'crowd' }), { now: tick() }));
  const accept = (who) => ({ name: who.uid, state: 'accepted', ts: TS, by: 'self' });
  denied(d.as(BOB).write(`incidents/${GID}/m1/assigned/${BOB.uid}`, accept(BOB), { now: tick() }), 'security cannot take minor medical');
  allowed(d.as(ALICE).write(`incidents/${GID}/m1/assigned/${ALICE.uid}`, accept(ALICE), { now: tick() }));
  allowed(d.as(BOB).write(`incidents/${GID}/c1/assigned/${BOB.uid}`, accept(BOB), { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/c1/assigned/${ALICE.uid}`, accept(ALICE), { now: tick() }), 'medical cannot take crowd control');
  denied(d.as(ALICE).write(`incidents/${GID}/m1/assigned/${ALICE.uid}`, { ...accept(ALICE), state: 'onscene' }, { now: tick() }), 'self-accept starts as accepted');
});

test('pending, monitoring and closed cases cannot be self-accepted', () => {
  let d = dispatchState();
  d = allowed(d.as(BOB).write(`incidents/${GID}/p1`, incident(BOB, { state: 'pending', type: 'medical_minor' }), { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/w1`, verified(DISPATCHER, { state: 'monitoring' }), { now: tick() }));
  const accept = { name: 'Alice', state: 'accepted', ts: TS };
  denied(d.as(ALICE).write(`incidents/${GID}/p1/assigned/${ALICE.uid}`, accept, { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/w1/assigned/${ALICE.uid}`, accept, { now: tick() }));
});

/** Alice accepts m1 and locks her status to it, in one update (as the app does). */
function lockedOn(d, iid) {
  return allowed(d.as(ALICE).update('/', {
    [`incidents/${GID}/${iid}/assigned/${ALICE.uid}`]: { name: 'Alice', state: 'accepted', ts: TS, by: 'self' },
    [`status/${GID}/${ALICE.uid}`]: { state: 'busy', incidentId: iid, name: 'Alice', ts: TS }
  }, tick()));
}

test('single-task lock: a busy unit cannot accept or be assigned a second case', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m2`, verified(DISPATCHER), { now: tick() }));
  d = lockedOn(d, 'm1');
  denied(d.as(ALICE).write(`incidents/${GID}/m2/assigned/${ALICE.uid}`, { name: 'Alice', state: 'accepted', ts: TS }, { now: tick() }), 'self-accept while locked');
  denied(d.as(DISPATCHER).update('/', {
    [`incidents/${GID}/m2/assigned/${ALICE.uid}`]: { name: 'Alice', state: 'assigned', ts: TS, by: 'dispatch' },
    [`status/${GID}/${ALICE.uid}`]: { state: 'busy', incidentId: 'm2', name: 'Alice', ts: TS }
  }, tick()), 'dispatcher assign while locked');
  // progressing on the locked case is fine
  allowed(d.as(ALICE).update('/', {
    [`incidents/${GID}/m1/assigned/${ALICE.uid}`]: { name: 'Alice', state: 'onscene', ts: TS },
    [`status/${GID}/${ALICE.uid}`]: { state: 'onscene', incidentId: 'm1', name: 'Alice', ts: TS }
  }, tick()));
});

test('single-task lock: a unit cannot leave the lock by editing its status', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  d = lockedOn(d, 'm1');
  denied(d.as(ALICE).write(`status/${GID}/${ALICE.uid}`, { state: 'available', name: 'Alice', ts: TS }, { now: tick() }));
  denied(d.as(ALICE).write(`status/${GID}/${ALICE.uid}`, { state: 'available', incidentId: 'm1', name: 'Alice', ts: TS }, { now: tick() }));
  denied(d.as(ALICE).write(`status/${GID}/${ALICE.uid}`, null, { now: tick() }));
  // the dispatcher can release a unit
  allowed(d.as(DISPATCHER).write(`status/${GID}/${ALICE.uid}`, { state: 'available', name: 'Alice', ts: TS }, { now: tick() }));
});

test('single-task lock releases when the case is resolved or closed', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m2`, verified(DISPATCHER), { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m3`, verified(DISPATCHER), { now: tick() }));
  d = lockedOn(d, 'm1');
  // Resolved: assignment cleared + status available in one update.
  d = allowed(d.as(ALICE).update('/', {
    [`incidents/${GID}/m1/assigned/${ALICE.uid}`]: { name: 'Alice', state: 'cleared', ts: TS },
    [`status/${GID}/${ALICE.uid}`]: { state: 'available', name: 'Alice', ts: TS }
  }, tick()));
  d = lockedOn(d, 'm2');
  // Case closed by dispatch while her status still points at it: lock no longer holds.
  d = allowed(d.as(DISPATCHER).update(`incidents/${GID}/m2`, { state: 'closed', closedAt: TS, closedBy: DISPATCHER.uid, closedByName: 'Dee', updatedAt: TS }, tick()));
  allowed(d.as(ALICE).write(`incidents/${GID}/m3/assigned/${ALICE.uid}`, { name: 'Alice', state: 'accepted', ts: TS }, { now: tick() }));
  allowed(d.as(ALICE).write(`status/${GID}/${ALICE.uid}`, { state: 'available', name: 'Alice', ts: TS }, { now: tick() }));
});

test('a teammate\'s SOS overrides the lock: a busy unit can still respond', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  d = lockedOn(d, 'm1');
  d = allowed(d.as(BOB).write(`incidents/${GID}/s1`, sos(BOB), { now: tick() }));
  allowed(d.as(ALICE).update('/', {
    [`incidents/${GID}/s1/assigned/${ALICE.uid}`]: { name: 'Alice', state: 'enroute', ts: TS, by: 'self' },
    [`status/${GID}/${ALICE.uid}`]: { state: 'enroute', incidentId: 's1', name: 'Alice', ts: TS }
  }, tick()));
});

test('dispatcher assignment sets the unit busy in the same update', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/c1`, verified(DISPATCHER, { type: 'crowd' }), { now: tick() }));
  allowed(d.as(DISPATCHER).update('/', {
    [`incidents/${GID}/c1/assigned/${BOB.uid}`]: { name: 'Bob', state: 'assigned', ts: TS, by: 'dispatch', unit: 'security' },
    [`incidents/${GID}/c1/updatedAt`]: TS,
    [`status/${GID}/${BOB.uid}`]: { state: 'busy', incidentId: 'c1', name: 'Bob', ts: TS }
  }, tick()));
  denied(d.as(ALICE).write(`status/${GID}/${BOB.uid}`, { state: 'busy', incidentId: 'c1', name: 'Bob', ts: TS }, { now: tick() }));
});

test('ETA: only the assigned unit writes its own ETA; values validated', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  const eta = { s: 240, m: 950, src: 'route', ts: TS };
  denied(d.as(ALICE).write(`incidents/${GID}/m1/eta/${ALICE.uid}`, eta, { now: tick() }), 'not assigned yet');
  d = lockedOn(d, 'm1');
  allowed(d.as(ALICE).write(`incidents/${GID}/m1/eta/${ALICE.uid}`, eta, { now: tick() }));
  denied(d.as(BOB).write(`incidents/${GID}/m1/eta/${ALICE.uid}`, eta, { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/m1/eta/${ALICE.uid}`, { ...eta, s: -5 }, { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/m1/eta/${ALICE.uid}`, { ...eta, src: 'guess' }, { now: tick() }));
});

test('proximity dismissals are per member', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  allowed(d.as(ALICE).write(`incidents/${GID}/m1/dismissed/${ALICE.uid}`, TS, { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/m1/dismissed/${BOB.uid}`, TS, { now: tick() }));
});

test('report photos: reporter, dispatchers and assigned units add JPEGs; others cannot', () => {
  let d = dispatchState();
  d = allowed(d.as(ALICE).write(`incidents/${GID}/r1`, incident(ALICE, { state: 'pending' }), { now: tick() }));
  const photo = (who) => ({ uid: who.uid, name: who.uid, data: 'data:image/jpeg;base64,/9j/4AAQ', w: 640, h: 480, ts: TS });
  d = allowed(d.as(ALICE).write(`media/${GID}/r1/p1`, photo(ALICE), { now: tick() }));
  allowed(d.as(DISPATCHER).write(`media/${GID}/r1/p2`, photo(DISPATCHER), { now: tick() }));
  denied(d.as(BOB).write(`media/${GID}/r1/p3`, photo(BOB), { now: tick() }), 'not reporter, dispatcher or assigned');
  denied(d.as(ALICE).write(`media/${GID}/r1/p4`, { ...photo(ALICE), data: 'data:text/html;base64,PHNjcmlwdD4=' }, { now: tick() }), 'only JPEG data URLs');
  denied(d.as(ALICE).write(`media/${GID}/r1/p1`, photo(ALICE), { now: tick() }), 'photos are immutable');
  allowed(d.as(ALICE).write(`media/${GID}/r1/p1/driveUrl`, 'https://drive.google.com/file/d/x/view', { now: tick() }));
  allowed(d.as(BOB).read(`media/${GID}/r1`));
  denied(d.as(MALLORY).read(`media/${GID}/r1`));
  allowed(d.as(DISPATCHER).write(`media/${GID}/r1`, null, { now: tick() }));
});

test('leaving the group removes a locked unit\'s status with it', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  d = lockedOn(d, 'm1');
  allowed(d.as(ALICE).update('/', {
    [`groups/${GID}/members/${ALICE.uid}`]: null,
    [`status/${GID}/${ALICE.uid}`]: null,
    [`users/${ALICE.uid}/groups/${GID}`]: null
  }, tick()));
});

console.log('1.4: equipment, travel mode, auto-assign, step times, field-opened cases');

test('equipment: only known gear ids, true only; self or dispatcher', () => {
  const d = dispatchState();
  allowed(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/gear/aed`, true, { now: tick() }));
  allowed(d.as(DISPATCHER).write(`groups/${GID}/members/${ALICE.uid}/gear/als`, true, { now: tick() }));
  denied(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/gear/jetpack`, true, { now: tick() }));
  denied(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/gear/aed`, false, { now: tick() }));
  denied(d.as(BOB).write(`groups/${GID}/members/${ALICE.uid}/gear/aed`, true, { now: tick() }));
  allowed(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/mode`, 'vehicle', { now: tick() }));
  denied(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/mode`, 'helicopter', { now: tick() }));
});

test('requested equipment and travel mode are informational: any unit of the role may accept', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/k1`, verified(DISPATCHER, { type: 'cardiac', requires: { aed: true } }), { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/t1`, verified(DISPATCHER, { type: 'transport' }), { now: tick() }));
  const accept = { name: 'Alice', state: 'accepted', ts: TS, by: 'self', t: { accepted: TS } };
  allowed(d.as(ALICE).write(`incidents/${GID}/k1/assigned/${ALICE.uid}`, accept, { now: tick() }), 'no AED, still allowed');
  allowed(d.as(ALICE).write(`incidents/${GID}/t1/assigned/${ALICE.uid}`, accept, { now: tick() }), 'on a bike, still allowed');
  denied(d.as(BOB).write(`incidents/${GID}/k1/assigned/${BOB.uid}`, { ...accept, name: 'Bob' }, { now: tick() }), 'the role still decides');
  denied(d.as(DISPATCHER).write(`incidents/${GID}/k2`, verified(DISPATCHER, { requires: { jetpack: true } }), { now: tick() }), 'unknown gear');
});

test('groups still on 1.3 settings fall back to the default role matrix', () => {
  const legacy = { proximityM: 500, caseUnits: {} };
  let d = baseState();
  d = allowed(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}`, { name: 'Bob', role: 'member', code: CODE, joinedAt: TS }, { now: tick() }));
  d = allowed(d.as(ALICE).write(`groups/${GID}/members/${ALICE.uid}/unit`, 'medical', { now: tick() }));
  d = allowed(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}/unit`, 'security', { now: tick() }));
  d = allowed(d.as(OWNER).write(`groups/${GID}/settings`, { ...legacy, proximityM: 600 }, { now: tick() }));
  d = allowed(d.as(OWNER).write(`incidents/${GID}/m1`, verified(OWNER), { now: tick() }));
  allowed(d.as(ALICE).write(`incidents/${GID}/m1/assigned/${ALICE.uid}`, { name: 'Alice', state: 'accepted', ts: TS }, { now: tick() }));
  denied(d.as(BOB).write(`incidents/${GID}/m1/assigned/${BOB.uid}`, { name: 'Bob', state: 'accepted', ts: TS }, { now: tick() }));
});

test('auto-assign: a fitting, free unit may lock itself as "assigned" only when the group enables it', () => {
  const auto = { name: 'Alice', state: 'assigned', ts: TS, by: 'auto', unit: 'medical', t: { assigned: TS } };
  let claimedAt = 0;
  const claim = (dd, iid) => {
    claimedAt = tick();
    return dd.as(ALICE).update('/', {
      [`incidents/${GID}/${iid}/assigned/${ALICE.uid}`]: auto,
      [`status/${GID}/${ALICE.uid}`]: { state: 'busy', incidentId: iid, name: 'Alice', ts: TS }
    }, claimedAt);
  };
  let off = dispatchState();
  off = allowed(off.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  denied(claim(off, 'm1'), 'auto-assign is off');

  let d = dispatchState({ ...SETTINGS, autoAssign: true });
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m2`, verified(DISPATCHER), { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/c1`, verified(DISPATCHER, { type: 'crowd' }), { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/m1/assigned/${ALICE.uid}`, { ...auto, by: 'self' }, { now: tick() }), '"assigned" by self is not a thing');
  denied(claim(d, 'c1'), 'role does not fit');
  d = allowed(claim(d, 'm1'));
  const assignedAt = claimedAt;
  denied(claim(d, 'm2'), 'single-task lock');
  // Unanswered: Alice declines with the timeout reason, keeping the original assigned time.
  const sameAssigned = d.as(ALICE).update('/', {
    [`incidents/${GID}/m1/assigned/${ALICE.uid}`]: { name: 'Alice', state: 'declined', ts: TS, by: 'auto', reason: 'timeout', t: { assigned: assignedAt - 1, declined: TS } },
    [`status/${GID}/${ALICE.uid}`]: { state: 'available', name: 'Alice', ts: TS }
  }, tick());
  denied(sameAssigned, 'cannot rewrite the assigned time');
  allowed(d.as(ALICE).update('/', {
    [`incidents/${GID}/m1/assigned/${ALICE.uid}`]: { name: 'Alice', state: 'declined', ts: TS, by: 'auto', reason: 'timeout', t: { assigned: assignedAt, declined: TS } },
    [`status/${GID}/${ALICE.uid}`]: { state: 'available', name: 'Alice', ts: TS }
  }, tick()));

  let quiet = dispatchState({ ...SETTINGS, autoAssign: true, proximityOn: false });
  quiet = allowed(quiet.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  denied(claim(quiet, 'm1'), 'proximity master switch off');
});

test('assignment step times must be the server time of the write', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/m1/assigned/${ALICE.uid}`, { name: 'Alice', state: 'accepted', ts: TS, t: { accepted: 12345 } }, { now: tick() }), 'forged time');
  denied(d.as(ALICE).write(`incidents/${GID}/m1/assigned/${ALICE.uid}`, { name: 'Alice', state: 'accepted', ts: TS, t: { teleported: TS } }, { now: tick() }), 'unknown step');
  allowed(d.as(ALICE).write(`incidents/${GID}/m1/assigned/${ALICE.uid}`, { name: 'Alice', state: 'accepted', ts: TS, t: { accepted: TS } }, { now: tick() }));
});

test('Fire & Safety may open a fire case at once (rapid alert); others go through review', () => {
  let d = dispatchState();
  d = allowed(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}/unit`, 'fire', { now: tick() }));
  allowed(d.as(BOB).write(`incidents/${GID}/f1`, verified(BOB, { type: 'fire', rapid: true, verifiedBy: BOB.uid, verifiedByName: 'Bob', verifiedAt: TS }), { now: tick() }));
  allowed(d.as(BOB).write(`incidents/${GID}/f2`, incident(BOB, { type: 'fire', state: 'pending' }), { now: tick() }));
  denied(d.as(BOB).write(`incidents/${GID}/f3`, verified(BOB, { type: 'crowd' }), { now: tick() }), 'only fire cases skip review');
  denied(d.as(ALICE).write(`incidents/${GID}/f4`, verified(ALICE, { type: 'fire' }), { now: tick() }), 'medical cannot open a fire case directly');
  denied(d.as(DISPATCHER).write(`incidents/${GID}/f5`, verified(DISPATCHER, { type: 'crowd', rapid: true }), { now: tick() }), 'rapid is for fire cases');
});

test('Medical may open a patient-transport request at once; nobody else may', () => {
  const d = dispatchState();
  allowed(d.as(ALICE).write(`incidents/${GID}/t1`, verified(ALICE, { type: 'transport', linkedCase: 'm1' }), { now: tick() }));
  denied(d.as(BOB).write(`incidents/${GID}/t2`, verified(BOB, { type: 'transport' }), { now: tick() }));
  denied(d.as(ALICE).write(`incidents/${GID}/t3`, verified(ALICE, { type: 'transport', linkedCase: '../x' }), { now: tick() }));
});

test('PTT channels: medical channel for medical units and dispatchers; ushers listen only', () => {
  let d = dispatchState();
  allowed(d.as(ALICE).write(`ptt/${GID}/medical`, floor(ALICE, 'sid-a'), { now: tick() }));
  allowed(d.as(DISPATCHER).write(`ptt/${GID}/medical`, floor(DISPATCHER, 'sid-d'), { now: tick() }));
  denied(d.as(BOB).write(`ptt/${GID}/medical`, floor(BOB, 'sid-b'), { now: tick() }), 'security is not on the medical channel');
  allowed(d.as(BOB).write(`ptt/${GID}/main`, floor(BOB, 'sid-b'), { now: tick() }));
  denied(d.as(BOB).write(`ptt/${GID}/secret`, floor(BOB, 'sid-b'), { now: tick() }), 'unknown channel');
  d = allowed(d.as(DISPATCHER).write(`groups/${GID}/members/${BOB.uid}/unit`, 'usher', { now: tick() }));
  denied(d.as(BOB).write(`ptt/${GID}/main`, floor(BOB, 'sid-b'), { now: tick() }), 'ushers do not transmit');
  allowed(d.as(BOB).read(`ptt/${GID}`));
  // Two channels have independent floors.
  let both = dispatchState();
  both = allowed(both.as(BOB).write(`ptt/${GID}/main`, floor(BOB, 'sid-b'), { now: tick() }));
  allowed(both.as(ALICE).write(`ptt/${GID}/medical`, floor(ALICE, 'sid-a'), { now: tick() }));
  // A dispatcher may clear a stuck floor.
  allowed(both.as(DISPATCHER).write(`ptt/${GID}/main`, null, { now: tick() }));
});

test('presence carries the per-device proximity switch', () => {
  const d = dispatchState();
  allowed(d.as(BOB).write(`presence/${GID}/${BOB.uid}`, { ...presence('Bob', 'sid-bob-00001'), prox: false }, { now: tick() }));
  denied(d.as(BOB).write(`presence/${GID}/${BOB.uid}`, { ...presence('Bob', 'sid-bob-00001'), prox: 'off' }, { now: tick() }));
});

console.log('1.4: ePCR, announcements, overlays');

const info = (who, extra = {}) => ({ by: who.uid, byName: who.uid, createdAt: TS, updatedAt: TS, status: 'open', complaint: 'Chest pain', patient: { age: 54, sex: 'M' }, ...extra });
const vitals = (who, extra = {}) => ({ hr: 120, sbp: 95, dbp: 60, spo2: 93, gcsE: 4, gcsV: 5, gcsM: 6, by: who.uid, name: who.uid, ts: TS, ...extra });

test('ePCR: medical units and dispatchers only; tied to an existing case', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  d = allowed(d.as(ALICE).write(`epcr/${GID}/m1/p1/info`, info(ALICE), { now: tick() }));
  allowed(d.as(ALICE).read(`epcr/${GID}`));
  allowed(d.as(DISPATCHER).read(`epcr/${GID}`));
  denied(d.as(BOB).read(`epcr/${GID}`), 'security cannot read patient records');
  denied(d.as(BOB).read(`epcr/${GID}/m1/p1/info`));
  denied(d.as(MALLORY).read(`epcr/${GID}`));
  denied(d.as(BOB).write(`epcr/${GID}/m1/p2/info`, info(BOB), { now: tick() }));
  denied(d.as(ALICE).write(`epcr/${GID}/nocase/p1/info`, info(ALICE), { now: tick() }), 'case must exist');
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p3/info`, info(ALICE, { by: DISPATCHER.uid }), { now: tick() }), 'author is the writer');
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p3/info`, info(ALICE, { nric: 'S1234567A' }), { now: tick() }), 'no unknown fields');
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p3/info`, info(ALICE, { patient: { age: 200 } }), { now: tick() }));
  // Another medic / a dispatcher edits; author and creation time stay.
  allowed(d.as(DISPATCHER).update(`epcr/${GID}/m1/p1/info`, { assessment: 'Likely ACS', updatedAt: TS, updatedBy: DISPATCHER.uid }, tick()));
  denied(d.as(DISPATCHER).update(`epcr/${GID}/m1/p1/info`, { by: DISPATCHER.uid, updatedAt: TS }, tick()));
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p1/info`, null, { now: tick() }), 'medics cannot delete a record');
  allowed(d.as(DISPATCHER).write(`epcr/${GID}/m1/p1`, null, { now: tick() }));
});

test('ePCR: vitals, treatments and medications are append-only and validated', () => {
  let d = dispatchState();
  d = allowed(d.as(DISPATCHER).write(`incidents/${GID}/m1`, verified(DISPATCHER), { now: tick() }));
  d = allowed(d.as(ALICE).write(`epcr/${GID}/m1/p1/info`, info(ALICE), { now: tick() }));
  d = allowed(d.as(ALICE).write(`epcr/${GID}/m1/p1/vitals/v1`, vitals(ALICE), { now: tick() }));
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p1/vitals/v1`, vitals(ALICE, { hr: 80 }), { now: tick() }), 'cannot change a recorded set');
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p1/vitals/v1`, null, { now: tick() }), 'cannot delete a recorded set');
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p1/vitals/v2`, vitals(ALICE, { spo2: 120 }), { now: tick() }));
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p1/vitals/v2`, vitals(ALICE, { gcsM: 7 }), { now: tick() }));
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p1/vitals/v2`, vitals(DISPATCHER), { now: tick() }), 'recorded as yourself');
  denied(d.as(ALICE).write(`epcr/${GID}/m1/p1/vitals/v2`, vitals(ALICE, { ts: 5 }), { now: tick() }), 'server time');
  allowed(d.as(ALICE).write(`epcr/${GID}/m1/p1/treatments/t1`, { text: 'Aspirin chewed, O2 via NRB', by: ALICE.uid, name: 'Alice', ts: TS }, { now: tick() }));
  allowed(d.as(ALICE).write(`epcr/${GID}/m1/p1/meds/d1`, { drug: 'Aspirin', dose: '300 mg', route: 'PO', by: ALICE.uid, name: 'Alice', ts: TS }, { now: tick() }));
  denied(d.as(BOB).write(`epcr/${GID}/m1/p1/treatments/t2`, { text: 'x', by: BOB.uid, name: 'Bob', ts: TS }, { now: tick() }));
  allowed(d.as(DISPATCHER).write(`epcr/${GID}/m1/p1/vitals/v1`, null, { now: tick() }), 'dispatch can remove an entry made in error');
});

test('announcements: dispatchers broadcast; fire units send fire alerts; acks are personal', () => {
  let d = dispatchState();
  const ann = (who, extra = {}) => ({ by: who.uid, name: who.uid, text: 'Heat advisory', level: 'info', audience: 'all', kind: 'general', ts: TS, ...extra });
  d = allowed(d.as(DISPATCHER).write(`announcements/${GID}/a1`, ann(DISPATCHER, { level: 'critical', audience: 'medical' }), { now: tick() }));
  denied(d.as(ALICE).write(`announcements/${GID}/a2`, ann(ALICE), { now: tick() }), 'members cannot broadcast');
  d = allowed(d.as(BOB).write(`groups/${GID}/members/${BOB.uid}/unit`, 'fire', { now: tick() }));
  allowed(d.as(BOB).write(`announcements/${GID}/a3`, ann(BOB, { kind: 'fire', level: 'critical', caseId: 'f1', lat: 1.3, lng: 103.8 }), { now: tick() }));
  denied(d.as(BOB).write(`announcements/${GID}/a4`, ann(BOB), { now: tick() }), 'fire units: fire alerts only');
  denied(d.as(DISPATCHER).write(`announcements/${GID}/a5`, ann(DISPATCHER, { level: 'apocalyptic' }), { now: tick() }));
  denied(d.as(DISPATCHER).write(`announcements/${GID}/a6`, ann(DISPATCHER, { audience: 'everyone' }), { now: tick() }));
  denied(d.as(DISPATCHER).write(`announcements/${GID}/a7`, ann(BOB), { now: tick() }), 'cannot announce as someone else');
  d = allowed(d.as(ALICE).write(`announcements/${GID}/a1/acks/${ALICE.uid}`, TS, { now: tick() }));
  denied(d.as(ALICE).write(`announcements/${GID}/a1/acks/${BOB.uid}`, TS, { now: tick() }));
  denied(d.as(ALICE).write(`announcements/${GID}/a1/text`, 'edited', { now: tick() }));
  allowed(d.as(ALICE).read(`announcements/${GID}`));
  denied(d.as(MALLORY).read(`announcements/${GID}`));
  denied(d.as(ALICE).write(`announcements/${GID}/a1`, null, { now: tick() }));
  allowed(d.as(DISPATCHER).write(`announcements/${GID}/a1`, null, { now: tick() }));
});

test('map overlays: dispatchers add, show / hide and remove; members read', () => {
  let d = dispatchState();
  const layer = { name: 'Marathon course', by: DISPATCHER.uid, ts: TS, data: '{"type":"FeatureCollection","features":[]}', count: 3, visible: true };
  denied(d.as(ALICE).write(`overlays/${GID}/o1`, { ...layer, by: ALICE.uid }, { now: tick() }));
  d = allowed(d.as(DISPATCHER).write(`overlays/${GID}/o1`, layer, { now: tick() }));
  allowed(d.as(DISPATCHER).write(`overlays/${GID}/o1/visible`, false, { now: tick() }));
  denied(d.as(DISPATCHER).write(`overlays/${GID}/o2`, { ...layer, data: '<script>' }, { now: tick() }));
  allowed(d.as(ALICE).read(`overlays/${GID}`));
  denied(d.as(MALLORY).read(`overlays/${GID}`));
  allowed(d.as(DISPATCHER).write(`overlays/${GID}/o1`, null, { now: tick() }));
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
