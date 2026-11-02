// Unit tests for the pure dispatch logic, loaded through Vite (SSR) with the fake
// Firebase SDK and Capacitor stubs: role / equipment matching, proximity, the
// auto-dispatch ranking, overlays, ePCR and after-action analytics.
// Run: npm run test:unit
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// The fake Auth module keeps its session in localStorage: give Node a small one.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
Object.assign(process.env, {
  VITE_FIREBASE_API_KEY: 'test', VITE_FIREBASE_AUTH_DOMAIN: 'test.local',
  VITE_FIREBASE_DATABASE_URL: 'https://test-db.firebasedatabase.app', VITE_FIREBASE_PROJECT_ID: 'test'
});
const stub = path.join(here, 'unit-stubs', 'capacitor.js');
const vite = await createServer({
  configFile: false,
  root,
  envDir: path.join(here, 'e2e'),
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false },
  resolve: {
    alias: {
      'firebase/app': path.join(here, 'e2e/fake-firebase/app.js'),
      'firebase/auth': path.join(here, 'e2e/fake-firebase/auth.js'),
      'firebase/database': path.join(here, 'e2e/fake-firebase/database.js'),
      '@capacitor/core': stub,
      '@capacitor/app': stub,
      '@capacitor/local-notifications': stub
    }
  }
});

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${String(err.stack).split('\n').slice(0, 5).join('\n      ')}`);
  }
}

try {
  const roles = await vite.ssrLoadModule('/src/roles.js');
  const location = await vite.ssrLoadModule('/src/location.js');
  const auto = await vite.ssrLoadModule('/src/auto-dispatch.js');
  const dispatch = await vite.ssrLoadModule('/src/dispatch.js');
  const epcr = await vite.ssrLoadModule('/src/epcr-format.js');
  const analytics = await vite.ssrLoadModule('/src/analytics.js');
  const ann = await vite.ssrLoadModule('/src/announcements.js');

  const settings = roles.defaultSettings();
  const medic = { name: 'Med', role: 'member', unit: 'medical', gear: { aid_bag: true }, mode: 'bike' };
  const aedMedic = { name: 'AED', role: 'member', unit: 'medical', gear: { aed: true }, mode: 'foot' };
  const ambulance = { name: 'Amb', role: 'member', unit: 'medical', gear: { trauma_kit: true }, mode: 'vehicle' };
  const guard = { name: 'Sec', role: 'member', unit: 'security', gear: { crowd_control: true } };
  const usher = { name: 'Ush', role: 'member', unit: 'usher' };
  const fire = { name: 'Fire', role: 'member', unit: 'fire', gear: { extinguisher: true } };
  const site = { lat: 1.3000, lng: 103.8000 };
  const at = (dLatM, dLngM = 0) => ({ lat: site.lat + dLatM / 111320, lng: site.lng + dLngM / 111320 });

  console.log('Roles and equipment');
  await test('defaults: 600 m, master switch on, auto-assign off, v2', () => {
    assert.equal(settings.proximityM, 600);
    assert.equal(settings.proximityOn, true);
    assert.equal(settings.autoAssign, false);
    assert.equal(settings.v, 2);
  });
  await test('settings are clamped to 100–2000 m and 1.3 unit matrices are replaced', () => {
    assert.equal(roles.normalizeSettings({ proximityM: 20 }).proximityM, 100);
    assert.equal(roles.normalizeSettings({ proximityM: 9000 }).proximityM, 2000);
    const legacy = roles.normalizeSettings({ proximityM: 500, caseUnits: { medical_minor: { bike_medic: true } } });
    assert.deepEqual(legacy.caseUnits.medical_minor, { medical: true });
  });
  await test('responderFit: the primary role decides; equipment and vehicle are informational', () => {
    const cardiac = { type: 'cardiac', requires: { aed: true } };
    const noAed = roles.responderFit(cardiac, medic, settings);
    assert.equal(noAed.ok, true, 'a medic without an AED may still respond');
    assert.deepEqual(noAed.missing, ['aed']);
    assert.deepEqual(roles.responderFit(cardiac, aedMedic, settings).missing, []);
    assert.equal(roles.responderFit(cardiac, guard, settings).reason, 'Other role');
    assert.equal(roles.responderFit({ type: 'transport' }, medic, settings).ok, true, 'transport is not limited to vehicles');
    assert.equal(roles.bestEquipped({ type: 'transport' }, ambulance), true);
    assert.equal(roles.bestEquipped({ type: 'transport' }, medic), false);
    assert.equal(roles.bestEquipped(cardiac, aedMedic), true);
    assert.equal(roles.bestEquipped(cardiac, medic), false);
    assert.equal(roles.responderFit({ type: 'fire' }, fire, settings).ok, true);
    assert.equal(roles.responderFit({ type: 'crowd' }, usher, settings).reason, 'Other role', 'ushers report, they are not dispatched by default');
    assert.equal(roles.responderFit({ type: 'medical_minor' }, { unit: 'bike_medic' }, settings).ok, false, '1.3 roles must re-pick');
  });
  await test('gear of another role does not count; badges show gear and travel mode', () => {
    const odd = { unit: 'security', gear: { aed: true, escort: true }, mode: 'vehicle' };
    assert.deepEqual(roles.profileOf(odd).gear, ['escort']);
    assert.deepEqual(roles.markerBadges(odd), ['ESC', 'VEH']);
    assert.deepEqual(roles.markerBadges(medic), ['BAG', 'BIKE']);
    assert.equal(roles.memberRoleLabel({ ...aedMedic, role: 'dispatcher' }), 'Dispatcher · Medical · AED');
  });
  await test('feature toggles per role', () => {
    const f = (m) => [...roles.featuresFor(m)].sort();
    assert.ok(roles.featuresFor(guard).has('bodycam') && !roles.featuresFor(guard).has('epcr'));
    assert.ok(roles.featuresFor(medic).has('epcr') && roles.featuresFor(medic).has('medicalChannel') && !roles.featuresFor(medic).has('bodycam'));
    assert.ok(roles.featuresFor(fire).has('rapidAlert') && !roles.featuresFor(fire).has('bodycam'));
    assert.deepEqual(f(usher), ['map', 'report']);
    const disp = roles.featuresFor({ role: 'dispatcher' });
    for (const k of ['review', 'assign', 'feeds', 'analytics', 'announce', 'epcr', 'bodycam', 'ptt']) assert.ok(disp.has(k), k);
  });

  console.log('Proximity and ETA');
  const inc = (id, extra = {}) => ({ id, type: 'medical_minor', title: id, priority: 2, state: 'open', ...site, createdAt: 1, ...extra });
  const prox = (member, fix, extra = {}) => location.findProximityCases({
    incidents: new Map([['a', inc('a')], ['k', inc('k', { type: 'cardiac', requires: { aed: true }, priority: 1 })]]),
    uid: 'me', member, fix, settings, radiusM: settings.proximityM, locked: false, offDuty: false, ...extra
  }).map((p) => p.incident.id);
  await test('alerts only cases that fit, inside the radius', () => {
    assert.deepEqual(prox(aedMedic, { ...at(500), acc: 5 }), ['k', 'a'], 'P1 first');
    assert.deepEqual(prox(medic, { ...at(400), acc: 5 }), ['k', 'a'], 'no AED: still alerted to the cardiac case');
    assert.deepEqual(prox(medic, { ...at(700), acc: 5 }), []);
    assert.deepEqual(prox(medic, { ...at(700), acc: 5 }, { radiusM: 1000 }), ['k', 'a'], 'device radius');
    assert.deepEqual(prox(guard, { ...at(100), acc: 5 }), []);
  });
  await test('master switch, device switch, lock and off duty silence proximity alerts', () => {
    const fix = { ...at(100), acc: 5 };
    assert.deepEqual(prox(medic, fix, { settings: { ...settings, proximityOn: false } }), []);
    assert.deepEqual(prox(medic, fix, { deviceOn: false }), []);
    assert.deepEqual(prox(medic, fix, { locked: true }), []);
    assert.deepEqual(prox(medic, fix, { offDuty: true }), []);
  });
  await test('radius is clamped to 100–2000 m', () => {
    assert.equal(location.clampRadius(30), 100);
    assert.equal(location.clampRadius(5000), 2000);
    assert.equal(location.clampRadius('abc'), null);
  });
  await test('ETA uses the travel mode', () => {
    const foot = location.estimateEta(1000, 'foot').seconds;
    const bike = location.estimateEta(1000, 'bike').seconds;
    const car = location.estimateEta(1000, 'vehicle').seconds;
    assert.ok(foot > bike && bike > car);
  });

  console.log('Auto-dispatch');
  const now = 1_800_000_000_000;
  const members = { m1: medic, m2: aedMedic, a1: ambulance, s1: guard };
  const roster = new Map(Object.keys(members).map((u) => [u, { tracking: true }]));
  const positions = new Map([
    ['m1', { ...at(150), acc: 5, ts: now - 5000 }],
    ['m2', { ...at(400), acc: 5, ts: now - 5000 }],
    ['a1', { ...at(250), acc: 5, ts: now - 5000 }],
    ['s1', { ...at(50), acc: 5, ts: now - 5000 }]
  ]);
  const free = () => ({ state: 'available', locked: false });
  const rank = (incident, extra = {}) => auto.rankCandidates({ incident, members, positions, roster, effectiveStatus: free, settings, now, ...extra }).map((c) => c.uid);
  await test('closest free, online, fresh units of the role; best-equipped first, nobody excluded', () => {
    assert.deepEqual(rank(inc('x')), ['m1', 'a1', 'm2']);
    assert.deepEqual(rank(inc('k', { type: 'cardiac', requires: { aed: true } })), ['m2', 'm1', 'a1'], 'AED carrier first, then the rest by distance');
    assert.deepEqual(rank(inc('t', { type: 'transport' })), ['a1', 'm1', 'm2'], 'vehicle first');
    assert.deepEqual(rank(inc('c', { type: 'crowd' })), ['s1']);
  });
  await test('excludes locked, busy, opted-out, offline, stale, declined and out-of-range units', () => {
    assert.deepEqual(rank(inc('x'), { effectiveStatus: (u) => (u === 'm1' ? { state: 'busy', locked: true } : free()) }), ['a1', 'm2']);
    assert.deepEqual(rank(inc('x'), { roster: new Map([...roster].map(([u, p]) => [u, u === 'm1' ? { ...p, prox: false } : p])) }), ['a1', 'm2']);
    assert.deepEqual(rank(inc('x'), { roster: new Map([...roster].filter(([u]) => u !== 'a1')) }), ['m1', 'm2']);
    assert.deepEqual(rank(inc('x'), { positions: new Map([...positions].map(([u, p]) => [u, u === 'm1' ? { ...p, ts: now - 600_000 } : p])) }), ['a1', 'm2']);
    assert.deepEqual(rank(inc('x', { assigned: { m1: { state: 'declined' } } })), ['a1', 'm2']);
    assert.deepEqual(rank(inc('x'), { settings: { ...settings, proximityM: 200 } }), ['m1']);
  });
  await test('leader is the lowest-uid online dispatcher', () => {
    const ms = { b: { role: 'dispatcher' }, a: { role: 'owner' }, c: { role: 'member' } };
    assert.equal(auto.leaderUid(ms, new Map([['b', {}], ['a', {}], ['c', {}]])), 'a');
    assert.equal(auto.leaderUid(ms, new Map([['b', {}], ['c', {}]])), 'b');
    assert.equal(auto.leaderUid(ms, new Map([['c', {}]])), null);
  });
  await test('an unanswered auto-assignment goes stale after the answer time', () => {
    const a = { state: 'assigned', by: 'auto', t: { assigned: now - 91_000 } };
    assert.equal(dispatch.isStaleAuto(a, settings, now), true);
    assert.equal(dispatch.isStaleAuto({ ...a, t: { assigned: now - 30_000 } }, settings, now), false);
    assert.equal(dispatch.isStaleAuto({ ...a, by: 'dispatch' }, settings, now), false);
    assert.equal(dispatch.isStaleAuto({ ...a, state: 'accepted' }, settings, now), false);
  });
  await test('field units may open fire / transport cases directly', () => {
    assert.equal(dispatch.canOpenDirect('fire', fire), true);
    assert.equal(dispatch.canOpenDirect('fire', medic), false);
    assert.equal(dispatch.canOpenDirect('transport', medic), true);
    assert.equal(dispatch.canOpenDirect('crowd', guard), false);
    assert.equal(dispatch.canOpenDirect('crowd', { role: 'dispatcher' }), true);
  });

  console.log('Overlays');
  await test('features are classified by name, category and geometry', () => {
    const f = (props, type = 'Point') => location.classifyFeature({ properties: props, geometry: { type } });
    assert.equal(f({ name: 'KM 21' }), 'km');
    assert.equal(f({ name: 'Water station 3' }), 'water');
    assert.equal(f({ name: 'First Aid Tent B' }), 'aid');
    assert.equal(f({ name: 'Road closure Nicoll Hwy' }, 'LineString'), 'closure');
    assert.equal(f({ name: 'Emergency access lane' }, 'LineString'), 'access');
    assert.equal(f({ name: 'Full marathon' }, 'LineString'), 'course');
    assert.equal(f({ category: 'water', name: 'Marker' }), 'water');
    assert.equal(f({ name: 'Zone' }, 'Polygon'), 'area');
  });
  await test('overlays are cleaned, rounded and size-limited', () => {
    const big = { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { name: 'Course', '<bad>': 'x', n: 5 }, geometry: { type: 'LineString', coordinates: Array.from({ length: 40000 }, (_, i) => [103.8 + i * 1e-5, 1.3 + Math.sin(i / 50) * 1e-3]) } },
      { type: 'Feature', properties: { name: 'Broken' }, geometry: { type: 'Point', coordinates: [500, 1] } },
      { type: 'Feature', properties: {}, geometry: null }
    ] };
    const { text, count } = location.prepareOverlay(big);
    assert.equal(count, 1, 'invalid features dropped');
    assert.ok(text.length <= 880_000, `fits (${text.length})`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.features[0].properties.category, 'course');
    assert.equal(parsed.features[0].properties['<bad>'], undefined);
    assert.throws(() => location.prepareOverlay({ hello: 'world' }), /Not a GeoJSON/);
  });

  console.log('ePCR');
  await test('vitals: ranges, GCS completeness, abnormal flags', () => {
    assert.throws(() => epcr.cleanVitals({ spo2: 120 }), /SpO/);
    assert.throws(() => epcr.cleanVitals({ gcsE: 4 }), /all three GCS/);
    assert.throws(() => epcr.cleanVitals({}), /at least one/);
    const v = epcr.cleanVitals({ hr: '130', sbp: '85', spo2: '91', gcsE: '3', gcsV: '4', gcsM: '6', temp: '38.94' });
    assert.equal(v.temp, 38.9);
    assert.equal(epcr.gcsTotal(v), 13);
    assert.deepEqual(epcr.abnormal(v).sort(), ['gcs', 'hr', 'sbp', 'spo2', 'temp']);
  });
  await test('SOAP handover lists S, O, A and P with timed entries', () => {
    const rec = {
      info: { complaint: 'Chest pain', allergies: 'NKDA', assessment: 'Possible ACS', disposition: 'transported', destination: 'SGH', triage: 'red', patient: { age: 54, sex: 'M' }, byName: 'Mia', createdAt: now },
      vitals: { v1: { hr: 128, sbp: 92, dbp: 60, spo2: 91, ts: now, name: 'Mia' } },
      treatments: { t1: { text: 'Oxygen 15 L NRB', ts: now + 60000, name: 'Mia' } },
      meds: { d1: { drug: 'Aspirin', dose: '300 mg', route: 'PO', ts: now + 90000, name: 'Mia' } }
    };
    const text = epcr.generateSoap(rec, { incident: { title: 'Collapse km 12', type: 'cardiac', priority: 1, lat: 1.3, lng: 103.8 }, groupName: 'Marathon' });
    for (const part of ['S — SUBJECTIVE', 'O — OBJECTIVE', 'A — ASSESSMENT', 'P — PLAN', 'Chief complaint: Chest pain', 'HR 128', 'BP 92/60', '[ABNORMAL]', 'Aspirin 300 mg PO', 'Disposition: Transported → SGH', '54 y, Male', 'Triage Red']) {
      assert.ok(text.includes(part), `missing "${part}"`);
    }
  });

  console.log('Announcements');
  await test('audience: everyone, one role, or dispatchers; dispatchers see all', () => {
    const a = (audience) => ({ audience });
    assert.equal(ann.isForMember(a('all'), usher), true);
    assert.equal(ann.isForMember(a('medical'), medic), true);
    assert.equal(ann.isForMember(a('medical'), guard), false);
    assert.equal(ann.isForMember(a('dispatch'), guard), false);
    assert.equal(ann.isForMember(a('fire'), { role: 'dispatcher' }), true);
  });

  console.log('Analytics');
  await test('response intervals, severity / role breakdown and utilisation', () => {
    const T = (s) => now + s * 1000;
    const report = analytics.computeAnalytics({
      incidents: {
        a: { type: 'cardiac', title: 'A', priority: 1, state: 'closed', createdBy: 'u', createdAt: T(0), verifiedBy: 'd', verifiedAt: T(20), closedAt: T(600),
          assigned: { m2: { name: 'AED', unit: 'medical', state: 'cleared', ts: T(590), t: { assigned: T(25), accepted: T(40), onscene: T(160), cleared: T(590) } } } },
        b: { type: 'crowd', title: 'B', priority: 3, state: 'closed', createdBy: 'd', createdAt: T(1000), verifiedBy: 'd', verifiedAt: T(1000), closedAt: T(1400),
          assigned: { s1: { name: 'Sec', unit: 'security', state: 'cleared', ts: T(1390), t: { assigned: T(1010), accepted: T(1100), onscene: T(1300), cleared: T(1390) } } } }
      },
      members, from: T(0), to: T(3600), now: T(3600)
    });
    assert.equal(report.totals.cases, 2);
    assert.equal(report.totals.reports, 1);
    assert.equal(report.times.reportToAccept.avg, 70);
    assert.equal(report.times.acceptToOnScene.avg, 160);
    assert.equal(report.times.reportToResolved.avg, 500);
    assert.equal(report.times.reportToVerify.n, 1);
    assert.equal(report.bySeverity[1], 1);
    assert.equal(report.byRole.medical, 1);
    assert.equal(report.byRole.security, 1);
    const unit = report.units.find((u) => u.uid === 'm2');
    assert.equal(unit.busyS, 550);
    assert.ok(Math.abs(unit.utilisation - 550 / 3600) < 1e-9);
    assert.equal(report.utilisation.activeUnits, 2);
    const csv = analytics.toCsv(report, { groupName: 'Test' });
    assert.ok(csv.includes('Reported → Accepted,2,70,70,94'), 'avg, median and 90th percentile');
    const pdf = analytics.toPdf(report, { groupName: 'Test' });
    assert.ok(pdf.output('arraybuffer').byteLength > 3000);
  });
  await test('CSV cells are protected against formula injection', () => {
    assert.equal(analytics.csvCell('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(analytics.csvCell('a,b'), '"a,b"');
    assert.equal(analytics.csvCell('say "hi"'), '"say ""hi"""');
  });
} finally {
  await vite.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
