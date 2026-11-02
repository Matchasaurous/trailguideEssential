// End-to-end dispatch scenario with three phones:
//   Alpha   — group owner (dispatch rights), no field role
//   Bravo   — Medical on a bicycle with an aid bag, ~190 m from Alpha
//   Charlie — Security, ~1.4 km away; promoted to dispatcher, later Usher and
//             Fire & Safety
// Covers role / equipment selection, SOS (hold, alarm, respond with lock,
// cancel), member report with a dropped pin and a photo → Pending Review →
// dispatcher verifies → proximity alarm to the matching unit only → accept →
// single-task lock → routed ETA → resolve → second case alarm → dismiss → direct
// assignment → close; rejecting a report; proximity radius setting; required
// equipment (AED) matching and map badges; auto-assign of the closest unit;
// ePCR with SOAP handover archived to Drive; announcements; map layers
// (GeoJSON + KML); after-action report (CSV download, PDF to Drive); Sheet case
// log; background notification; keyboard PTT and rebinding; medical PTT
// channel; request-live; one-touch bodycam with dispatcher auto-open; usher
// simplified screen; fire rapid alert; offline outbox.
// Run: npm run test:dispatch
import assert from 'node:assert/strict';
import path from 'node:path';
import { startEnv, stepper, sleep } from './harness.mjs';

const env = await startEnv();
const { backend } = env;
const { step } = stepper();
let alpha;
let bravo;
let charlie;
let exitCode = 0;
let gid;

const SHOTS = process.env.E2E_SHOTS;
const shot = async (page, name) => {
  if (!SHOTS) return null;
  // Marketing screenshots: hide transient toasts so they don't cover the header.
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.style.setProperty('display', 'none', 'important'); });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.style.removeProperty('display'); });
  return null;
};
const SAMPLE_GEOJSON = JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { name: 'Full marathon course' }, geometry: { type: 'LineString', coordinates: [[103.858, 1.281], [103.861, 1.284], [103.865, 1.286]] } },
  { type: 'Feature', properties: { name: 'Water point 3' }, geometry: { type: 'Point', coordinates: [103.861, 1.2845] } },
  { type: 'Feature', properties: { name: 'KM 21' }, geometry: { type: 'Point', coordinates: [103.863, 1.285] } }
] });
const SAMPLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Folder><name>Road closures</name>
<Placemark><name>Nicoll Highway closed</name><LineString><coordinates>103.862,1.296,0 103.866,1.299,0</coordinates></LineString></Placemark>
<Placemark><name>Medical tent 2</name><Point><coordinates>103.8605,1.2836,0</coordinates></Point></Placemark>
</Folder></Document></kml>`;
const incidents = () => Object.entries(backend.value(`incidents/${gid}`) || {}).map(([id, v]) => ({ id, ...v }));
const byTitle = (title) => incidents().find((i) => i.title === title);
const uidOf = (name) => Object.entries(backend.value(`groups/${gid}/members`)).find(([, m]) => m.name === name)[0];
const pillState = (page) => page.getAttribute('#status-pill', 'data-state');
const pillLocked = (page) => page.evaluate(() => document.querySelector('#status-pill').classList.contains('locked'));
async function until(fn, ms = 10000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

try {
  alpha = await env.newUser('alpha', 1.2834, 103.8607);
  bravo = await env.newUser('bravo', 1.2851, 103.8610);
  charlie = await env.newUser('charlie', 1.2900, 103.8500);

  await step('three members join; responders pick their unit in the role prompt', async () => {
    await env.register(alpha, 'Alpha One', 'alpha@test.io');
    await env.register(bravo, 'Bravo Two', 'bravo@test.io');
    await env.register(charlie, 'Charlie Three', 'charlie@test.io');
    const code = await env.createGroup(alpha, 'Bukit Watch');
    await env.join(bravo, code, 'medical', { gear: ['aid_bag'], mode: 'bike' });
    await env.join(charlie, code, 'security');
    gid = Object.keys(backend.value('groups'))[0];
    for (const page of [alpha, bravo, charlie]) {
      await page.waitForFunction(() => /voice 2\/2/.test(document.querySelector('#main-status').textContent), null, { timeout: 20000 });
    }
    assert.equal(await bravo.textContent('#btn-role'), 'Medical · BAG BIKE');
    assert.equal(await charlie.textContent('#btn-role'), 'Security');
    assert.equal(await alpha.isVisible('#role-sheet'), false, 'the owner dispatches and is not forced to pick a role');
    assert.deepEqual(backend.value(`groups/${gid}/members/${uidOf('Bravo Two')}/gear`), { aid_bag: true });
    assert.equal(backend.value(`groups/${gid}/members/${uidOf('Bravo Two')}/mode`), 'bike');
    assert.equal(backend.value(`groups/${gid}/settings/proximityM`), 600, 'new groups default to a 600 m radius');
    assert.equal(backend.value(`groups/${gid}/settings/v`), 2);
    // Role-based screens: the medic has ePCR instead of the bodycam, plus the medical channel switch.
    assert.equal(await bravo.isVisible('#btn-cam'), false, 'no bodycam for medical');
    assert.equal(await bravo.isVisible('#btn-epcr-dock'), true);
    assert.equal(await bravo.isVisible('#ptt-channel'), true);
    assert.equal(await charlie.isVisible('#btn-cam'), true, 'security has the bodycam');
    assert.equal(await charlie.isVisible('#ptt-channel'), false, 'security is not on the medical channel');
    await alpha.waitForFunction(() => [...document.querySelectorAll('.member-marker .gear-badge')].some((b) => b.textContent === 'BAG'), null, { timeout: 10000 });
  });

  await step('owner promotes Charlie to dispatcher (keeps his Security unit)', async () => {
    await alpha.click('#btn-members');
    await alpha.click('#member-list li:has-text("Charlie Three") button:has-text("Make dispatcher")');
    await charlie.waitForSelector('#role-tag:not([hidden])');
    await alpha.waitForFunction(() => /Dispatcher · Security/.test(document.querySelector('#member-list').textContent));
    await env.closeSheet(alpha);
  });

  await step('a short tap on SOS does not send it', async () => {
    await env.holdSos(bravo, 300);
    await sleep(500);
    assert.equal(incidents().length, 0);
  });

  await step('SOS: alarm on the others; Charlie responds and is locked; Bravo cancels and Charlie is released', async () => {
    await env.holdSos(bravo);
    await bravo.waitForSelector('#sos-banner:not([hidden])');
    for (const page of [alpha, charlie]) {
      await page.waitForSelector('#alert-overlay:not([hidden])', { timeout: 10000 });
      assert.equal(await page.textContent('#alert-title'), 'Bravo Two needs help');
    }
    await shot(alpha, 'd1-sos-alarm');
    await charlie.click('#alert-actions button:has-text("I\'m responding")');
    await charlie.waitForFunction(() => document.querySelector('#status-pill').classList.contains('locked'));
    assert.match(await charlie.textContent('#status-lock'), /EN ROUTE/);
    await alpha.click('#alert-actions button:has-text("Acknowledge")');
    await bravo.waitForFunction(() => /Charlie Three.*responding · 2 acknowledged/.test(document.querySelector('#sos-banner-detail').textContent));
    await bravo.click('#btn-sos-cancel');
    await bravo.waitForSelector('#sos-banner', { state: 'hidden' });
    await charlie.waitForFunction(() => !document.querySelector('#status-pill').classList.contains('locked'));
    assert.equal(await pillState(charlie), 'available');
  });

  await step('Bravo reports a case: drops a pin, adds a photo → Pending Review; dispatchers get a review banner', async () => {
    await bravo.click('#btn-pin');
    await bravo.waitForSelector('#pin-hint:not([hidden])');
    const box = await bravo.locator('#map').boundingBox();
    await bravo.mouse.click(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40);
    await bravo.waitForSelector('#incident-form-sheet:not([hidden])');
    assert.match(await bravo.textContent('#new-location'), /pin you dropped/);
    assert.equal(await bravo.textContent('#new-submit'), 'Send for review');
    await bravo.selectOption('#new-type', 'medical_minor');
    assert.match(await bravo.textContent('#new-type-hint'), /Responds: Medical\./);
    await bravo.selectOption('#new-priority', '2');
    await bravo.fill('#new-title', 'Runner collapsed at water point 3');
    await bravo.fill('#new-notes', 'Conscious, dizzy, possible heat exhaustion.');
    await bravo.setInputFiles('#new-photos', await env.jpegFile(bravo, 'scene'));
    await bravo.waitForSelector('#new-photo-preview img');
    await bravo.click('#new-submit');
    await bravo.waitForSelector('#incident-sheet:not([hidden])');
    const report = byTitle('Runner collapsed at water point 3');
    assert.equal(report.state, 'pending');
    assert.equal(report.source, 'pin');
    assert.match(await bravo.textContent('#inc-state'), /Pending review/);
    await bravo.waitForSelector('#inc-photos img');
    await until(() => Object.keys(backend.value(`media/${gid}/${report.id}`) || {}).length === 1, 10000, 'photo in database');
    await until(() => backend.gas.sheetRows('Photos').length === 2, 15000, 'photo archived to Drive');
    await until(() => Object.values(backend.value(`media/${gid}/${report.id}`))[0].driveUrl, 10000, 'Drive link on the photo');
    for (const page of [alpha, charlie]) {
      await page.waitForSelector('#alert-banner[data-kind="review"]:not([hidden])', { timeout: 10000 });
      assert.match(await page.textContent('#banner-kind'), /Pending review · from Bravo Two/);
    }
    await shot(charlie, 'd2-review-banner');
    assert.equal(await bravo.isVisible('#alert-banner'), false, 'no proximity alarm while the report is pending');
    await env.closeSheet(bravo);
  });

  await step('dispatcher verifies: only the matching, nearby unit (Bravo, Medical) gets the proximity alarm', async () => {
    await charlie.click('#banner-actions button:has-text("Review")');
    await charlie.waitForSelector('#inc-review:not([hidden])');
    assert.match(await charlie.textContent('#review-units'), /free Medical units within 600 m are alerted/);
    await charlie.waitForSelector('#inc-photos img');
    await shot(charlie, 'd3-review-case');
    await charlie.click('#review-approve');
    await until(() => byTitle('Runner collapsed at water point 3').state === 'open', 5000, 'verified');
    assert.equal(byTitle('Runner collapsed at water point 3').verifiedBy, uidOf('Charlie Three'));
    await bravo.waitForSelector('#alert-banner[data-kind="proximity"]:not([hidden])', { timeout: 10000 });
    assert.match(await bravo.textContent('#banner-kind'), /Nearby case · P2 · Minor medical/);
    assert.match(await bravo.textContent('#banner-meta'), /\d+ m away · ETA ~(\d+|<1) min/);
    await shot(bravo, 'd4-proximity-banner');
    await sleep(800);
    assert.equal(await alpha.isVisible('#alert-banner[data-kind="proximity"]'), false, 'owner without a role: no proximity alarm');
    assert.equal(await charlie.isVisible('#alert-banner[data-kind="proximity"]'), false, 'security does not respond to minor medical');
    await env.closeSheet(charlie);
  });

  await step('Bravo accepts from the banner: locked BUSY, routed ETA reaches dispatch', async () => {
    await bravo.click('#banner-actions button:has-text("Accept case")');
    await bravo.waitForSelector('#alert-banner', { state: 'hidden' });
    await bravo.waitForFunction(() => document.querySelector('#status-pill').classList.contains('locked'));
    assert.match(await bravo.textContent('#status-lock'), /BUSY · Runner collapsed/);
    const iid = byTitle('Runner collapsed at water point 3').id;
    const bravoUid = uidOf('Bravo Two');
    assert.equal(backend.value(`status/${gid}/${bravoUid}/incidentId`), iid);
    await until(() => backend.value(`incidents/${gid}/${iid}/eta/${bravoUid}/src`) === 'route', 15000, 'routed ETA');
    assert.ok(backend.log.routeRequests >= 1, 'routing service called');
    await charlie.click('#btn-dispatch');
    await charlie.click('#incident-list li:has-text("Runner collapsed") button.row');
    await charlie.waitForFunction(() => /ETA \d+ min|ETA <1 min/.test(document.querySelector('#inc-assigned').textContent));
    assert.doesNotMatch(await charlie.textContent('#inc-assigned .eta'), /~/, 'routed ETA is shown without the estimate mark');
    await shot(charlie, 'd5-eta');
    await env.closeSheet(charlie);
  });

  await step('single-task lock: a second nearby case does not alarm the busy unit and cannot be given to him', async () => {
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-new-incident');
    await alpha.waitForSelector('#incident-form-sheet:not([hidden])');
    assert.equal(await alpha.textContent('#new-submit'), 'Create verified case');
    assert.match(await alpha.textContent('#new-location'), /Your GPS position/);
    await alpha.selectOption('#new-type', 'medical_minor');
    await alpha.selectOption('#new-priority', '1');
    await alpha.fill('#new-title', 'Child with bleeding knee at stage');
    await alpha.click('#new-submit');
    await alpha.waitForSelector('#incident-sheet:not([hidden])');
    assert.equal(byTitle('Child with bleeding knee at stage').state, 'open');
    await sleep(1500);
    assert.equal(await bravo.isVisible('#alert-banner'), false, 'locked unit gets no proximity alarm');
    const row = alpha.locator('#inc-assign-list li:has-text("Bravo Two")');
    assert.equal(await row.locator('.tag.locked').count(), 1, 'shown as busy');
    assert.equal(await row.locator('button:has-text("Assign")').count(), 0, 'no assign button while locked');
    await env.closeSheet(alpha);
  });

  await step('Bravo goes en route → on scene → resolved; the lock releases and the second case alarms him; he dismisses it', async () => {
    await bravo.click('#btn-dispatch');
    await bravo.click('#incident-list li:has-text("Runner collapsed") button.row');
    await bravo.click('#inc-my-actions button:has-text("En route")');
    await bravo.waitForFunction(() => /EN ROUTE/.test(document.querySelector('#status-lock').textContent));
    await bravo.click('#inc-my-actions button:has-text("On scene")');
    await bravo.waitForFunction(() => /ON SCENE/.test(document.querySelector('#status-lock').textContent));
    await bravo.fill('#inc-note', 'Patient cooled, drinking. Released to family.');
    await bravo.click('#inc-note-form button');
    await bravo.click('#inc-my-actions button:has-text("Resolved")');
    await bravo.waitForFunction(() => !document.querySelector('#status-pill').classList.contains('locked'));
    assert.equal(await pillState(bravo), 'available');
    await env.closeSheet(bravo);
    await bravo.waitForSelector('#alert-banner[data-kind="proximity"]:not([hidden])', { timeout: 10000 });
    assert.match(await bravo.textContent('#banner-title'), /Child with bleeding knee/);
    await bravo.click('#banner-actions button:has-text("Dismiss")');
    await bravo.waitForSelector('#alert-banner', { state: 'hidden' });
    const iid = byTitle('Child with bleeding knee at stage').id;
    await until(() => backend.value(`incidents/${gid}/${iid}/dismissed/${uidOf('Bravo Two')}`), 5000, 'dismissal recorded');
  });

  await step('dispatcher assigns Bravo directly: assignment banner → accept → locked; closing the case releases him', async () => {
    await alpha.click('#btn-dispatch');
    await alpha.click('#incident-list li:has-text("Child with bleeding knee") button.row');
    await alpha.click('#inc-assign-list li:has-text("Bravo Two") button:has-text("Assign")');
    await bravo.waitForSelector('#alert-banner[data-kind="assignment"]:not([hidden])', { timeout: 10000 });
    assert.match(await bravo.textContent('#banner-kind'), /Assigned to you · P1/);
    await bravo.waitForFunction(() => document.querySelector('#status-pill').classList.contains('locked'), null, { timeout: 5000 });
    await bravo.click('#banner-actions button:has-text("Accept case")');
    await bravo.waitForSelector('#alert-banner', { state: 'hidden' });
    await alpha.click('#inc-close');
    await bravo.waitForFunction(() => !document.querySelector('#status-pill').classList.contains('locked'));
    assert.equal(backend.value(`status/${gid}/${uidOf('Bravo Two')}/incidentId`), null);
    await env.closeSheet(alpha);
  });

  await step('a report with GPS location is rejected with a reason; the reporter sees it', async () => {
    await bravo.click('#btn-dispatch');
    await bravo.click('#btn-new-incident');
    await bravo.waitForSelector('#incident-form-sheet:not([hidden])');
    await bravo.click('#new-use-gps');
    assert.match(await bravo.textContent('#new-location'), /Your GPS position/);
    await bravo.selectOption('#new-type', 'lost');
    await bravo.fill('#new-title', 'Kid looking for mum near toilets');
    await bravo.click('#new-submit');
    await bravo.waitForSelector('#incident-sheet:not([hidden])');
    assert.equal(byTitle('Kid looking for mum near toilets').source, 'gps');
    await alpha.waitForSelector('#alert-banner[data-kind="review"]:not([hidden])', { timeout: 10000 });
    await alpha.click('#banner-actions button:has-text("Review")');
    await alpha.waitForSelector('#inc-review:not([hidden])');
    await alpha.click('#review-reject');
    await until(() => byTitle('Kid looking for mum near toilets').state === 'rejected', 5000, 'rejected');
    assert.equal(byTitle('Kid looking for mum near toilets').rejectReason, 'Duplicate / not actionable');
    await bravo.waitForFunction(() => /Rejected/.test(document.querySelector('#inc-state').textContent));
    await charlie.waitForSelector('#alert-banner', { state: 'hidden' });
    await env.closeSheet(alpha);
    await env.closeSheet(bravo);
  });

  await step('dispatch settings: widen the radius to 2 km → Security 1.4 km away gets a crowd-control alarm and accepts', async () => {
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-dispatch-settings');
    assert.equal(await alpha.inputValue('#set-radius'), '600');
    await alpha.$eval('#set-radius', (el) => { el.value = '2000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await alpha.textContent('#set-radius-label'), '2000 m');
    await shot(alpha, 'd6-settings');
    await alpha.click('#set-save');
    await until(() => backend.value(`groups/${gid}/settings/proximityM`) === 2000, 5000, 'radius saved');
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-new-incident');
    await alpha.selectOption('#new-type', 'crowd');
    await alpha.fill('#new-title', 'Crush risk at gate B');
    await alpha.click('#new-submit');
    await alpha.waitForSelector('#incident-sheet:not([hidden])');
    await charlie.waitForSelector('#alert-banner[data-kind="proximity"]:not([hidden])', { timeout: 10000 });
    assert.match(await charlie.textContent('#banner-meta'), /1\.\d km away/);
    await sleep(800);
    assert.equal(await bravo.isVisible('#alert-banner[data-kind="proximity"]'), false, 'medical does not respond to crowd control');
    await charlie.click('#banner-actions button:has-text("Accept case")');
    await charlie.waitForFunction(() => document.querySelector('#status-pill').classList.contains('locked'));
    await alpha.click('#inc-close');
    await charlie.waitForFunction(() => !document.querySelector('#status-pill').classList.contains('locked'));
    await env.closeSheet(alpha);
  });


  await step('requested equipment is informational: a medic without an AED is still alerted to a cardiac arrest; badges on the map', async () => {
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-new-incident');
    await alpha.selectOption('#new-type', 'cardiac');
    assert.equal(await alpha.isChecked('#new-gear input[value="aed"]'), true, 'cardiac pre-selects the AED');
    await alpha.fill('#new-title', 'Runner collapsed, not breathing');
    await alpha.click('#new-submit');
    await alpha.waitForSelector('#incident-sheet:not([hidden])');
    const k = byTitle('Runner collapsed, not breathing');
    assert.deepEqual(k.requires, { aed: true });
    assert.match(await alpha.textContent('#inc-requires'), /Equipment requested: Medical - AED/);
    assert.match(await alpha.textContent('#inc-assign-list'), /Match · no AED/);
    await bravo.waitForSelector('#alert-banner[data-kind="proximity"]:not([hidden])', { timeout: 10000 });
    assert.match(await bravo.textContent('#banner-kind'), /P1 · Cardiac arrest \/ collapse · AED requested/);
    await bravo.click('#banner-actions button:has-text("Accept case")');
    await bravo.waitForFunction(() => document.querySelector('#status-pill').classList.contains('locked'));
    // He ticks the AED he carries: the badge shows on the dispatcher's map.
    await bravo.click('#btn-role');
    await env.chooseUnit(bravo, 'medical', { gear: ['aed'] });
    assert.deepEqual(backend.value(`groups/${gid}/members/${uidOf('Bravo Two')}/gear`), { aid_bag: true, aed: true });
    await alpha.waitForFunction(() => [...document.querySelectorAll('.member-marker .gear-badge.aed')].length > 0, null, { timeout: 10000 });
    await shot(alpha, 'd9-aed-badge');
    const a = backend.value(`incidents/${gid}/${k.id}/assigned/${uidOf('Bravo Two')}`);
    assert.equal(a.unit, 'medical');
    assert.ok(Number.isFinite(a.t.accepted), 'acceptance time recorded');
    await env.closeSheet(alpha);
    await bravo.click('#btn-dispatch');
    await bravo.click('#incident-list li:has-text("not breathing") button.row');
    await bravo.click('#inc-my-actions button:has-text("On scene")');
    await until(() => Number.isFinite((backend.value(`incidents/${gid}/${k.id}/assigned/${uidOf('Bravo Two')}/t`) || {}).onscene), 5000, 'on-scene time');
    await env.closeSheet(bravo);
  });

  await step('simplified case creation: only a location and details — no title — still creates the case', async () => {
    await charlie.click('#btn-dispatch');
    await charlie.click('#btn-new-incident');
    await charlie.waitForSelector('#incident-form-sheet:not([hidden])');
    await charlie.fill('#new-title', '');
    await charlie.fill('#new-notes', 'Bag left unattended near gate C. No owner around');
    await charlie.click('#new-submit');
    await until(() => byTitle('Bag left unattended near gate C'), 8000, 'case with a title taken from the details');
    const c = byTitle('Bag left unattended near gate C');
    assert.equal(c.state, 'open', 'a dispatcher (Charlie) opens it at once');
    assert.equal(c.priority, 2, 'default severity');
    await charlie.waitForSelector('#incident-sheet:not([hidden])', { timeout: 8000 });
    await charlie.click('#inc-close');
    await env.closeSheet(charlie);
  });

  await step('ePCR: the medic records a patient, vitals, treatment and medication; SOAP handover; saved to the restricted Drive folder', async () => {
    const k = byTitle('Runner collapsed, not breathing');
    await bravo.click('#btn-epcr-dock');
    await bravo.waitForSelector('#epcr-sheet:not([hidden])');
    assert.match(await bravo.textContent('#epcr-case'), /Runner collapsed, not breathing/);
    await bravo.click('#epcr-new');
    await bravo.waitForSelector('#epcr-form:not([hidden])');
    await bravo.fill('#epcr-age', '54');
    await bravo.selectOption('#epcr-sex', 'M');
    await bravo.selectOption('#epcr-triage', 'red');
    await bravo.fill('#epcr-complaint', 'Collapsed at km 18, no pulse on arrival');
    await bravo.fill('#epcr-allergies', 'NKDA');
    await bravo.click('#epcr-history');
    for (const [id, v] of [['#v-hr', '136'], ['#v-sbp', '86'], ['#v-dbp', '50'], ['#v-spo2', '90'], ['#v-rr', '28']]) await bravo.fill(id, v);
    for (const [id, v] of [['#v-gcsE', '2'], ['#v-gcsV', '2'], ['#v-gcsM', '5']]) await bravo.selectOption(id, v);
    assert.match(await bravo.textContent('#v-gcs-total'), /GCS 9/);
    await bravo.click('#epcr-add-vitals');
    await bravo.waitForFunction(() => document.querySelectorAll('#epcr-vitals td.abn').length >= 4, null, { timeout: 5000 });
    await bravo.fill('#epcr-treatment', 'CPR, AED 1 shock, ROSC after 4 min');
    await bravo.click('#epcr-add-treatment');
    await bravo.fill('#epcr-drug', 'Oxygen');
    await bravo.fill('#epcr-dose', '15 L/min');
    await bravo.fill('#epcr-route', 'NRB');
    await bravo.click('#epcr-add-med');
    await bravo.fill('#epcr-assessment', 'Cardiac arrest, ROSC');
    await bravo.selectOption('#epcr-disposition', 'transported');
    await bravo.fill('#epcr-destination', 'SGH A&E');
    await bravo.click('#epcr-plan');
    await bravo.waitForSelector('#epcr-meds li');
    await until(() => {
      const recs = backend.value(`epcr/${gid}/${k.id}`) || {};
      const rec = Object.values(recs)[0];
      return rec && rec.info.destination === 'SGH A&E' && rec.info.patient && rec.info.patient.age === 54 && rec.vitals;
    }, 8000, 'patient record saved');
    await bravo.click('#epcr-handover');
    const soap = await bravo.inputValue('#epcr-soap');
    for (const part of ['S — SUBJECTIVE', 'Collapsed at km 18', 'HR 136', 'BP 86/50', 'GCS 9 (E2V2M5)', '[ABNORMAL]', 'CPR, AED 1 shock', 'Oxygen 15 L/min NRB', 'Disposition: Transported → SGH A&E']) {
      assert.ok(soap.includes(part), `handover is missing "${part}"`);
    }
    await shot(bravo, 'd10-epcr');
    await bravo.click('#epcr-archive');
    await until(() => backend.gas.sheetRows('Patients').length === 2, 15000, 'patient record archived');
    const row = backend.gas.sheetRows('Patients')[1];
    assert.equal(row[8], 'transported');
    assert.ok(!row.some((c) => String(c).includes('SGH') || String(c).includes('km 18')), 'no clinical detail in the Sheet');
    await until(() => Object.values(backend.value(`epcr/${gid}/${k.id}`))[0].info.driveUrl, 5000, 'Drive link on the record');
    await env.closeSheet(bravo);
    // The dispatcher sees it too; the case resolves.
    await alpha.click('#btn-dispatch');
    await alpha.click('#incident-list li:has-text("not breathing") button.row');
    assert.match(await alpha.textContent('#inc-epcr'), /Patient care \(ePCR\) \(1\)/);
    await alpha.click('#inc-close');
    await bravo.waitForFunction(() => !document.querySelector('#status-pill').classList.contains('locked'));
    await env.closeSheet(alpha);
  });

  await step('auto-assign: with it on, the closest free fitting unit is locked to a new case and confirms it', async () => {
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-dispatch-settings');
    await alpha.check('#set-auto');
    await alpha.$eval('#set-radius', (el) => { el.value = '600'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await alpha.click('#set-save');
    await until(() => backend.value(`groups/${gid}/settings/autoAssign`) === true, 5000, 'auto-assign saved');
    assert.equal(backend.value(`groups/${gid}/settings/proximityM`), 600);
    await alpha.click('#btn-dispatch');
    assert.match(await alpha.textContent('#auto-mode-label'), /auto-assign ON · 600 m/);
    await alpha.click('#btn-new-incident');
    await alpha.selectOption('#new-type', 'medical_major');
    await alpha.fill('#new-title', 'Cyclist down at the bridge');
    await alpha.click('#new-submit');
    await alpha.waitForSelector('#incident-sheet:not([hidden])');
    const iid = byTitle('Cyclist down at the bridge').id;
    await until(() => (backend.value(`incidents/${gid}/${iid}/assigned/${uidOf('Bravo Two')}`) || {}).by === 'auto', 15000, 'Bravo auto-assigned');
    await bravo.waitForSelector('#alert-banner[data-kind="assignment"]:not([hidden])', { timeout: 10000 });
    assert.match(await bravo.textContent('#banner-kind'), /Auto-assigned — closest unit/);
    assert.match(await bravo.textContent('#banner-meta'), /confirm within \d+ s/);
    await bravo.waitForFunction(() => document.querySelector('#status-pill').classList.contains('locked'));
    assert.equal(backend.value(`status/${gid}/${uidOf('Bravo Two')}/incidentId`), iid);
    await alpha.waitForFunction(() => /auto-assigned/.test(document.querySelector('#inc-assigned').textContent));
    await shot(bravo, 'd11-auto-assigned');
    await bravo.click('#banner-actions button:has-text("Accept case")');
    await until(() => backend.value(`incidents/${gid}/${iid}/assigned/${uidOf('Bravo Two')}/state`) === 'accepted', 5000, 'accepted');
    const t = backend.value(`incidents/${gid}/${iid}/assigned/${uidOf('Bravo Two')}/t`);
    assert.ok(t.assigned <= t.accepted, 'assigned, then accepted');
    assert.equal(Object.keys(backend.value(`incidents/${gid}/${iid}/assigned`)).length, 1, 'only the closest unit was assigned');
    await alpha.click('#inc-close');
    await bravo.waitForFunction(() => !document.querySelector('#status-pill').classList.contains('locked'));
    await env.closeSheet(alpha);
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-dispatch-settings');
    await alpha.uncheck('#set-auto');
    await alpha.click('#set-save');
    await until(() => backend.value(`groups/${gid}/settings/autoAssign`) === false, 5000, 'auto-assign off');
  });

  await step('device proximity switch: Bravo turns his alerts off — no alarm, and he is out of auto-assign', async () => {
    await bravo.click('#btn-members');
    await bravo.uncheck('#device-prox');
    await until(() => backend.value(`presence/${gid}/${uidOf('Bravo Two')}/prox`) === false, 5000, 'presence says opted out');
    await env.closeSheet(bravo);
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-new-incident');
    await alpha.selectOption('#new-type', 'medical_minor');
    await alpha.fill('#new-title', 'Blister at km 5');
    await alpha.click('#new-submit');
    await alpha.waitForSelector('#incident-sheet:not([hidden])');
    await sleep(2000);
    assert.equal(await bravo.isVisible('#alert-banner[data-kind="proximity"]'), false, 'device switch off');
    await bravo.click('#btn-members');
    await bravo.check('#device-prox');
    await env.closeSheet(bravo);
    await bravo.waitForSelector('#alert-banner[data-kind="proximity"]:not([hidden])', { timeout: 10000 });
    await bravo.click('#banner-actions button:has-text("Dismiss")');
    await alpha.click('#inc-close');
    await env.closeSheet(alpha);
  });

  await step('map layers: the dispatcher uploads a GeoJSON course and a KML file; every phone draws them', async () => {
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-layers');
    await alpha.setInputFiles('#layer-file', { name: 'marathon.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(SAMPLE_GEOJSON) });
    await alpha.waitForSelector('#layer-list li:has-text("marathon")');
    await alpha.setInputFiles('#layer-file', { name: 'closures.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from(SAMPLE_KML) });
    await alpha.waitForSelector('#layer-list li:has-text("closures")');
    const layers = Object.values(backend.value(`overlays/${gid}`));
    assert.equal(layers.length, 2);
    const kml = JSON.parse(layers.find((l) => l.name === 'closures').data);
    assert.deepEqual(kml.features.map((f) => f.properties.category).sort(), ['aid', 'closure']);
    // Bravo is next to the course: the line is drawn at full size. Charlie is 1.4 km away
    // (Leaflet clips vectors outside the view), so for him the point markers prove the layer arrived.
    await bravo.waitForFunction(() => {
      const paths = [...document.querySelectorAll('.leaflet-overlays-pane path')];
      const drawn = paths.filter((p) => { const r = p.getBoundingClientRect(); return r.width > 30 || r.height > 30; });
      const svg = document.querySelector('.leaflet-overlays-pane svg');
      return drawn.length >= 1 && svg && svg.getBoundingClientRect().width > 100;
    }, null, { timeout: 10000 });
    for (const page of [bravo, charlie]) {
      await page.waitForFunction(() => document.querySelectorAll('.overlay-point').length >= 3, null, { timeout: 10000 });
    }
    assert.ok(await bravo.$('.overlay-point.cat-water'), 'water point drawn');
    assert.ok(await bravo.$('.overlay-point.cat-km'), 'km marker drawn');
    await shot(bravo, 'd12-layers');
    await alpha.uncheck('#layer-list li:has-text("closures") input[type="checkbox"]');
    await bravo.waitForFunction(() => document.querySelectorAll('.overlay-point.cat-aid').length === 0, null, { timeout: 10000 });
    await env.closeSheet(alpha);
  });

  await step('every case event lands in the Sheet case log', async () => {
    await until(() => backend.gas.sheetRows('Cases').length >= 12, 10000, 'case rows');
    const events = backend.gas.sheetRows('Cases').slice(1).map((r) => `${r[1]}:${r[8]}`);
    for (const expected of [
      'sos:SOS — Bravo Two', 'sos_cancelled:SOS — Bravo Two',
      'reported:Runner collapsed at water point 3', 'verified:Runner collapsed at water point 3', 'accepted:Runner collapsed at water point 3',
      'created:Child with bleeding knee at stage', 'assigned:Child with bleeding knee at stage', 'closed:Child with bleeding knee at stage',
      'reported:Kid looking for mum near toilets', 'rejected:Kid looking for mum near toilets',
      'created:Crush risk at gate B', 'accepted:Crush risk at gate B', 'closed:Crush risk at gate B'
    ]) assert.ok(events.includes(expected), `missing ${expected}`);
  });

  await step('backgrounded responder gets a notification for a new SOS', async () => {
    await bravo.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await env.holdSos(alpha);
    await bravo.waitForFunction(() => window.__notifications.some((n) => /SOS — Alpha One/.test(n.title)), null, { timeout: 10000 });
    await bravo.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await bravo.waitForSelector('#alert-overlay:not([hidden])');
    await bravo.click('#alert-actions button:has-text("Acknowledge")');
    await charlie.click('#alert-actions button:has-text("Acknowledge")');
    await charlie.click('#btn-dispatch');
    await charlie.click('#incident-list li:has-text("SOS — Alpha One") button.row');
    await charlie.click('#inc-close');
    await alpha.waitForSelector('#sos-banner', { state: 'hidden' });
    await env.closeSheet(charlie);
  });

  await step('laptop push-to-talk: holding the Space bar transmits; typing a space in a field does not', async () => {
    const before = await env.inboundBytes(bravo, 'audio');
    await alpha.keyboard.down('Space');
    await alpha.waitForSelector('#btn-ptt[data-state="talking"]', { timeout: 10000 });
    await bravo.waitForSelector('#speaker-overlay:not([hidden])');
    await sleep(1500);
    await alpha.keyboard.up('Space');
    await alpha.waitForSelector('#btn-ptt[data-state="idle"]');
    assert.ok((await env.inboundBytes(bravo, 'audio')) - before > 3000, 'audio sent');
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-new-incident');
    await alpha.click('#new-title');
    await alpha.keyboard.type('a b');
    assert.equal(await alpha.getAttribute('#btn-ptt', 'data-state'), 'idle', 'space in a text field is just a space');
    assert.equal(await alpha.inputValue('#new-title'), 'a b');
    await env.closeSheet(alpha);
  });

  await step('rebinding the PTT key (e.g. a Bluetooth PTT button) works', async () => {
    await alpha.click('#btn-members');
    await alpha.click('#btn-ptt-key');
    await alpha.keyboard.press('F9');
    await alpha.waitForFunction(() => document.querySelector('#ptt-key-label').textContent === 'F9');
    await env.closeSheet(alpha);
    await alpha.keyboard.down('F9');
    await alpha.waitForSelector('#btn-ptt[data-state="talking"]', { timeout: 10000 });
    await alpha.keyboard.up('F9');
    await alpha.waitForSelector('#btn-ptt[data-state="idle"]');
  });

  await step('dispatcher requests the security unit\'s bodycam; he allows; video plays beside the map', async () => {
    await alpha.click('#btn-members');
    assert.equal(await alpha.locator('#member-list li:has-text("Bravo Two") button:has-text("Request live")').count(), 0, 'medical has no bodycam');
    await alpha.click('#member-list li:has-text("Charlie Three") button:has-text("Request live")');
    await alpha.waitForSelector('#viewer:not([hidden])');
    assert.match(await alpha.textContent('#viewer-wait'), /Waiting for the camera/);
    await charlie.waitForSelector('#live-request:not([hidden])', { timeout: 10000 });
    await charlie.click('#live-request-allow');
    await charlie.waitForSelector('#live-indicator:not([hidden])', { timeout: 15000 });
    await alpha.waitForFunction(() => document.querySelector('#viewer-video').videoWidth > 0, null, { timeout: 20000 });
    assert.equal(backend.value(`liveRequests/${gid}`), null, 'request cleared once answered');
    await alpha.click('#viewer-close');
    await charlie.click('#btn-cam-close');
    await charlie.waitForSelector('#bodycam-panel', { state: 'hidden' });
  });

  await step('one-touch bodycam: one tap records and goes live; the dispatcher\'s viewer opens by itself', async () => {
    await charlie.click('#btn-cam');
    await charlie.waitForSelector('#rec-indicator:not([hidden])', { timeout: 10000 });
    await charlie.waitForSelector('#live-indicator:not([hidden])');
    await alpha.waitForSelector('#viewer:not([hidden])', { timeout: 15000 });
    await alpha.waitForFunction(() => document.querySelector('#viewer-video').videoWidth > 0, null, { timeout: 20000 });
    assert.equal(await alpha.textContent('#viewer-name'), 'Charlie Three');
    await alpha.waitForSelector('#live-strip:not([hidden]) button:has-text("Charlie Three")');
    await shot(alpha, 'd7-auto-open-live');
    await shot(charlie, 'd8-one-touch');
    await charlie.click('#btn-cam-min');
    await charlie.waitForSelector('#bodycam-panel', { state: 'hidden' });
    await sleep(800);
    assert.equal(await charlie.isVisible('#live-indicator'), false);
    assert.ok(await charlie.evaluate(() => document.querySelector('#btn-cam').classList.contains('running')), 'dock shows bodycam running');
    await alpha.waitForFunction(() => document.querySelector('#viewer-video').videoWidth > 0);
    await charlie.click('#btn-cam');
    await charlie.click('#btn-cam-close');
    await charlie.waitForFunction(() => document.querySelectorAll('#clip-list li').length >= 1, null, { timeout: 10000 });
    await alpha.waitForFunction(() => /Camera is off/.test(document.querySelector('#viewer-wait').textContent), null, { timeout: 10000 });
    await alpha.click('#viewer-close');
  });

  await step('a responder cannot request someone else\'s camera', async () => {
    await bravo.click('#btn-members');
    assert.equal(await bravo.locator('#member-list button:has-text("Request live")').count(), 0);
    await env.closeSheet(bravo);
  });

  await step('offline: positions wait in the outbox and are sent when the connection returns', async () => {
    const bravoUid = uidOf('Bravo Two');
    await bravo.context().setOffline(true);
    await bravo.context().setGeolocation({ latitude: 1.2777, longitude: 103.8455, accuracy: 6 });
    await bravo.waitForFunction(() => new Promise((resolve) => {
      const req = indexedDB.open('trailguard-bg', 1);
      req.onsuccess = () => {
        const get = req.result.transaction('outbox', 'readonly').objectStore('outbox').getAll();
        get.onsuccess = () => resolve(get.result.some((r) => Math.abs(r.payload.lat - 1.2777) < 1e-6));
        get.onerror = () => resolve(false);
      };
      req.onerror = () => resolve(false);
    }), null, { timeout: 15000, polling: 500 });
    assert.notEqual(backend.value(`locations/${gid}/${bravoUid}/lat`), 1.2777, 'not written while offline');
    await bravo.context().setOffline(false);
    await until(() => backend.value(`locations/${gid}/${bravoUid}/lat`) === 1.2777, 15000, 'position after reconnecting');
  });

  await step('owner demotes Charlie; Charlie loses dispatch tools', async () => {
    await alpha.click('#btn-members');
    await alpha.click('#member-list li:has-text("Charlie Three") button:has-text("Make responder")');
    await charlie.waitForSelector('#role-tag', { state: 'hidden' });
    await env.closeSheet(alpha);
    await charlie.click('#btn-dispatch');
    assert.equal(await charlie.isVisible('#btn-dispatch-settings'), false);
    assert.equal(await charlie.textContent('#btn-new-incident'), 'Report case');
    await env.closeSheet(charlie);
  });


  await step('Charlie (Security, no longer dispatching) cannot see patient records', async () => {
    await charlie.click('#btn-dispatch');
    await charlie.click('#closed-block summary');
    await charlie.click('#closed-list li:has-text("not breathing") button.row');
    assert.equal(await charlie.isVisible('#inc-epcr'), false);
    await env.closeSheet(charlie);
  });

  await step('medical PTT channel: Bravo talks on MED — the dispatcher hears it, Security does not', async () => {
    await bravo.click('#ptt-channel');
    await bravo.waitForFunction(() => document.querySelector('#ptt-channel-label').textContent === 'MED');
    const alphaBefore = await env.inboundBytes(alpha, 'audio');
    const charlieBefore = await env.inboundBytes(charlie, 'audio');
    await bravo.locator('#btn-ptt').hover();
    await bravo.mouse.down();
    await bravo.waitForSelector('#btn-ptt[data-state="talking"]', { timeout: 10000 });
    await until(() => backend.value(`ptt/${gid}/medical/name`) === 'Bravo Two', 5000, 'medical floor');
    await alpha.waitForSelector('#speaker-overlay:not([hidden])');
    assert.equal(await alpha.textContent('#speaker-channel'), 'MED');
    await sleep(1800);
    await bravo.mouse.up();
    await bravo.waitForSelector('#btn-ptt[data-state="idle"]');
    assert.ok((await env.inboundBytes(alpha, 'audio')) - alphaBefore > 3000, 'dispatcher received medical audio');
    assert.ok((await env.inboundBytes(charlie, 'audio')) - charlieBefore < 1000, 'security received no medical audio');
    assert.equal(await charlie.isVisible('#speaker-overlay'), false);
    await bravo.click('#ptt-channel');
    await bravo.waitForFunction(() => document.querySelector('#ptt-channel-label').textContent === 'MAIN');
  });

  await step('announcements: a critical message to Medical reaches Bravo only; he acknowledges; logged to the Sheet', async () => {
    await alpha.click('#btn-announcements');
    await alpha.fill('#announce-text', 'Mass casualty at km 30 — all medical to the north aid station');
    await alpha.selectOption('#announce-audience', 'medical');
    await alpha.selectOption('#announce-level', 'critical');
    await alpha.click('#announce-send');
    await bravo.waitForSelector('#alert-banner[data-kind="announcement"].critical:not([hidden])', { timeout: 10000 });
    assert.match(await bravo.textContent('#banner-title'), /Mass casualty at km 30/);
    await sleep(800);
    assert.equal(await charlie.isVisible('#alert-banner[data-kind="announcement"]'), false, 'not for security');
    await shot(bravo, 'd13-announcement');
    await bravo.click('#banner-actions button:has-text("Acknowledge")');
    await bravo.waitForSelector('#alert-banner', { state: 'hidden' });
    const [a] = Object.values(backend.value(`announcements/${gid}`));
    assert.ok(a.acks && a.acks[uidOf('Bravo Two')], 'acknowledged');
    await alpha.waitForFunction(() => /Acknowledged by 1 of 1/.test(document.querySelector('#announce-list').textContent));
    await until(() => backend.gas.sheetRows('Announcements').length === 2, 10000, 'announcement logged');
    await env.closeSheet(alpha);
  });

  await step('usher: simplified screen — no push-to-talk or bodycam, a big Report button', async () => {
    await alpha.click('#btn-members');
    await alpha.click('#member-list li:has-text("Charlie Three") button:has-text("Role")');
    await env.chooseUnit(alpha, 'usher');
    await env.closeSheet(alpha);
    await charlie.waitForSelector('#btn-report-big:visible', { timeout: 10000 });
    assert.equal(await charlie.isVisible('#btn-ptt'), false);
    assert.equal(await charlie.isVisible('#btn-cam'), false);
    assert.equal(await charlie.textContent('#btn-role'), 'Usher / Marshal');
    await shot(charlie, 'd14-usher');
    await charlie.click('#btn-report-big');
    await charlie.waitForSelector('#incident-form-sheet:not([hidden])');
    assert.equal(await charlie.textContent('#new-submit'), 'Send for review');
    await env.closeSheet(charlie);
  });

  await step('Fire & Safety: holding FIRE opens a P1 fire case without review and alerts everyone (critical)', async () => {
    await alpha.click('#btn-members');
    await alpha.click('#member-list li:has-text("Charlie Three") button:has-text("Role")');
    await env.chooseUnit(alpha, 'fire', { gear: ['extinguisher'] });
    await env.closeSheet(alpha);
    await charlie.waitForSelector('#btn-fire:visible', { timeout: 10000 });
    const box = await charlie.locator('#btn-fire').boundingBox();
    await charlie.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await charlie.mouse.down();
    await sleep(1800);
    await charlie.mouse.up();
    await until(() => incidents().some((i) => i.type === 'fire' && i.rapid), 8000, 'fire case');
    const f = incidents().find((i) => i.type === 'fire' && i.rapid);
    assert.equal(f.state, 'open', 'no review for a fire unit\'s alert');
    assert.equal(f.priority, 1);
    for (const page of [alpha, bravo]) {
      await page.waitForSelector('#alert-banner[data-kind="announcement"].critical:not([hidden])', { timeout: 10000 });
      assert.match(await page.textContent('#banner-kind'), /Fire alert/);
    }
    await shot(bravo, 'd15-fire-alert');
    await bravo.click('#banner-actions button:has-text("Acknowledge")');
    await alpha.click('#banner-actions button:has-text("Acknowledge")');
    await alpha.click('#btn-dispatch');
    await alpha.click(`#incident-list li:has-text("${f.title}") button.row`);
    await alpha.click('#inc-close');
    await env.closeSheet(alpha);
  });

  await step('after-action report: totals and response times on screen; CSV download; PDF saved to Drive', async () => {
    await alpha.click('#btn-dispatch');
    await alpha.click('#btn-reports');
    await alpha.waitForSelector('#reports-sheet:not([hidden]) .kpi');
    const kpis = await alpha.textContent('#report-kpis');
    assert.match(kpis, new RegExp(`Cases${incidents().length}`));
    assert.match(await alpha.textContent('#report-body'), /Reported → Accepted/);
    assert.match(await alpha.textContent('#report-body'), /Bravo Two/);
    await shot(alpha, 'd16-report');
    const [download] = await Promise.all([alpha.waitForEvent('download'), alpha.click('#report-csv')]);
    const csvPath = await download.path();
    const csv = (await import('node:fs')).readFileSync(csvPath, 'utf8');
    assert.match(csv, /Trailguard Essentials after-action report/);
    assert.match(csv, /Runner collapsed, not breathing/);
    assert.match(csv, /Patients \(ePCR\),1/);
    await alpha.click('#report-drive');
    await until(() => backend.gas.sheetRows('Reports').length === 2, 20000, 'report saved to Drive');
    const reportFile = [...backend.gas.files.values()].find((f) => /^after-action_bukit-watch_.*\.pdf$/.test(f.name));
    assert.ok(reportFile && reportFile.bytes.subarray(0, 4).toString() === '%PDF', 'PDF in Drive');
    await env.closeSheet(alpha);
  });

  assert.deepEqual(env.errors, [], `page errors:\n${env.errors.join('\n')}`);
  console.log('\nDispatch E2E passed: all steps.');
  console.log('Writes denied by database rules:', backend.log.denied.map((d) => `${d.op} ${d.path.replace(/-[A-Za-z0-9_-]{19}/g, '<id>').replace(/u[0-9a-f]{12}/g, '<uid>')}`));
  if (process.env.E2E_DEBUG) for (const d of backend.log.denied) console.log(d.info);
} catch (err) {
  exitCode = 1;
  if (env.errors.length) console.log(`Page errors:\n${env.errors.join('\n')}`);
  console.log('Rule denials:', backend.log.denied.map((d) => `${d.op} ${d.path}`).slice(-10));
  if (process.env.E2E_DEBUG) for (const d of backend.log.denied.slice(-3)) console.log(d.info);
  for (const [name, page] of [['alpha', alpha], ['bravo', bravo], ['charlie', charlie]]) {
    if (page) await page.screenshot({ path: path.join(env.here, `fail-dispatch-${name}.png`) }).catch(() => {});
  }
} finally {
  await env.close();
  process.exit(exitCode);
}
