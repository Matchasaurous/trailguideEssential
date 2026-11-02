// End-to-end test: two browsers (fake camera, mic and GPS) run the real app
// against the rules-enforcing fake backend. Covers registration, group
// create/join, live map sync, WebRTC push-to-talk in both directions, bodycam
// record → chunked upload → Drive, live video viewing, incident logging,
// member removal/blocking and disbanding.
// Run: npm run test:e2e
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startFakeBackend } from './fake-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fake = (f) => path.join(here, 'fake-firebase', f);

const CHROME = process.env.CHROME_PATH || [
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'
].find((p) => existsSync(p));

Object.assign(process.env, {
  VITE_FIREBASE_API_KEY: 'test',
  VITE_FIREBASE_AUTH_DOMAIN: 'test.local',
  VITE_FIREBASE_DATABASE_URL: 'https://test-db.firebasedatabase.app',
  VITE_FIREBASE_PROJECT_ID: 'test',
  VITE_GAS_ENDPOINT: 'http://127.0.0.1:8788/exec',
  VITE_ICE_SERVERS: '[]',
  VITE_TILE_URL: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  VITE_USE_EMULATORS: '0'
});

const steps = [];
const stepStarts = [];
async function step(name, fn) {
  const t0 = Date.now();
  stepStarts.push([t0, name]);
  try {
    await fn();
    steps.push(`  ok  ${name} (${Date.now() - t0} ms)`);
    console.log(steps.at(-1));
  } catch (err) {
    console.log(`FAIL  ${name}\n${err.stack}`);
    throw err;
  }
}

const backend = startFakeBackend();
const vite = await createServer({
  configFile: false,
  root,
  envDir: here,
  logLevel: 'error',
  server: { port: 5174, host: '127.0.0.1', strictPort: true },
  resolve: {
    alias: {
      'firebase/app': fake('app.js'),
      'firebase/auth': fake('auth.js'),
      'firebase/database': fake('database.js')
    }
  }
});
await vite.listen();
const APP = 'http://127.0.0.1:5174/';

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns'
  ]
});

const errors = [];
async function newUser(label, lat, lng) {
  const context = await browser.newContext({
    geolocation: { latitude: lat, longitude: lng, accuracy: 8 },
    permissions: ['geolocation', 'camera', 'microphone'],
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  await context.addInitScript(() => {
    window.__pcs = [];
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...args) {
      const pc = new Native(...args);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Native.prototype;
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => errors.push(`[${label}] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/favicon|tile|404/i.test(msg.text())) errors.push(`[${label}] console: ${msg.text()}`);
  });
  page.on('dialog', (d) => d.accept());
  await page.goto(APP);
  return page;
}

async function register(page, name, email) {
  await page.click('#tab-register');
  await page.fill('#auth-name', name);
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', 'correct-horse-9');
  await page.click('#auth-submit');
  await page.waitForSelector('#screen-groups:not([hidden])');
}

async function inboundBytes(page, kind) {
  return page.evaluate(async (k) => {
    let total = 0;
    for (const pc of window.__pcs) {
      if (pc.connectionState === 'closed') continue;
      const stats = await pc.getStats();
      stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === k) total += s.bytesReceived || 0; });
    }
    return total;
  }, kind);
}

async function holdPtt(page) {
  const box = await page.locator('#btn-ptt').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

const SHOTS = process.env.E2E_SHOTS;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const toastText = (page) => page.locator('#toast').textContent();

let alpha;
let bravo;
let code;
let exitCode = 0;

/** Answer the role prompt: choose a role and save. */
async function pickRole(page, role) {
  await page.waitForSelector('#role-sheet:not([hidden])');
  await page.click(`#role-options button[data-unit="${role}"]`);
  await page.click('#role-save');
  await page.waitForSelector('#role-sheet', { state: 'hidden' });
}

try {
  alpha = await newUser('alpha', 1.2834, 103.8607);
  bravo = await newUser('bravo', 1.2840, 103.8590);

  await shot(alpha, '00-sign-in');
  await step('sign-in screen offers Google; a project without Google switched on explains it', async () => {
    await alpha.waitForSelector('#auth-google-row:not([hidden])');
    assert.match(await alpha.textContent('#auth-google'), /Continue with Google/);
    await alpha.click('#auth-google');
    await alpha.waitForSelector('#auth-error:not([hidden])');
    assert.match(await alpha.textContent('#auth-error'), /Google sign-in isn’t switched on/);
    assert.match(await alpha.textContent('#auth-google'), /Continue with Google/, 'button label restored');
    assert.equal(await alpha.isEnabled('#auth-google'), true);
  });

  await step('register two users', async () => {
    await register(alpha, 'Alpha One', 'alpha@test.io');
    await register(bravo, 'Bravo Two', 'bravo@test.io');
    assert.equal(await alpha.textContent('#groups-user'), 'Alpha One');
    const names = Object.values(backend.value('users')).map((u) => u.profile.displayName).sort();
    assert.deepEqual(names, ['Alpha One', 'Bravo Two']);
  });

  await step('Alpha creates a group and gets an invite code', async () => {
    await alpha.fill('#create-name', 'Marina Patrol');
    await alpha.click('#create-submit');
    await alpha.waitForSelector('#screen-main:not([hidden])');
    await alpha.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector('#invite-code').textContent));
    code = await alpha.textContent('#invite-code');
    await shot(alpha, '01-members-sheet');
    await alpha.click('#sheet-backdrop', { position: { x: 10, y: 10 } });
  });

  await step('Bravo joins with the code', async () => {
    await bravo.fill('#join-code', code.replace('-', '').toLowerCase());
    await bravo.click('#join-submit');
    await pickRole(bravo, 'security');
    await bravo.waitForSelector('#screen-main:not([hidden])');
    await bravo.waitForFunction(() => document.querySelector('#main-group-name').textContent === 'Marina Patrol');
  });

  await step('live map shows both members on both phones', async () => {
    for (const page of [alpha, bravo]) {
      await page.waitForFunction(() => document.querySelectorAll('.member-marker').length === 2, null, { timeout: 15000 });
    }
    const loc = backend.value('locations');
    const gid = Object.keys(loc)[0];
    const positions = Object.values(loc[gid]);
    assert.equal(positions.length, 2);
    assert.ok(positions.some((p) => Math.abs(p.lat - 1.2834) < 1e-6));
  });

  await step('WebRTC mesh connects (voice 1/1 on both)', async () => {
    for (const page of [alpha, bravo]) {
      await page.waitForFunction(() => /voice 1\/1/.test(document.querySelector('#main-status').textContent), null, { timeout: 20000 });
    }
  });

  await step('position update moves the marker for the other member', async () => {
    await bravo.context().setGeolocation({ latitude: 1.2900, longitude: 103.8500, accuracy: 5 });
    const gid = Object.keys(backend.value('locations'))[0];
    const deadline = Date.now() + 15000;
    let synced = false;
    while (Date.now() < deadline) {
      const all = backend.value(`locations/${gid}`);
      if (Object.values(all).some((p) => Math.abs(p.lat - 1.29) < 1e-6)) { synced = true; break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(synced, 'Bravo\'s new position reached the database');
  });

  await step('Alpha holds PTT: floor granted, Bravo sees speaker overlay and receives audio', async () => {
    const before = await inboundBytes(bravo, 'audio');
    await holdPtt(alpha);
    await alpha.waitForSelector('#btn-ptt[data-state="talking"]', { timeout: 10000 });
    await bravo.waitForSelector('#speaker-overlay:not([hidden])');
    assert.equal(await bravo.textContent('#speaker-name'), 'Alpha One');
    assert.equal(await bravo.getAttribute('#btn-ptt', 'data-state'), 'busy');
    await new Promise((r) => setTimeout(r, 2000));
    const after = await inboundBytes(bravo, 'audio');
    assert.ok(after - before > 4000, `Bravo received ${after - before} audio bytes`);
    await shot(bravo, '02-receiving-ptt');
    await shot(alpha, '03-talking');
    const gid = Object.keys(backend.value('ptt'))[0];
    assert.equal(backend.value(`ptt/${gid}/main/name`), 'Alpha One');
    const audible = await bravo.evaluate(() => [...document.querySelectorAll('#rtc-audio-sink audio')].map((a) => a.muted));
    assert.deepEqual(audible, [false], 'only the speaker is unmuted');
  });

  await step('Bravo pressing while Alpha talks gets "busy" and no floor', async () => {
    const box = await bravo.locator('#btn-ptt').boundingBox();
    await bravo.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await bravo.mouse.down();
    await bravo.waitForFunction(() => /talking/i.test(document.querySelector('#toast').textContent));
    await bravo.mouse.up();
    const gid = Object.keys(backend.value('ptt'))[0];
    assert.equal(backend.value(`ptt/${gid}/main/name`), 'Alpha One');
  });

  await step('Alpha releases: floor freed and overlay disappears', async () => {
    await alpha.mouse.up();
    await bravo.waitForSelector('#speaker-overlay', { state: 'hidden' });
    await alpha.waitForSelector('#btn-ptt[data-state="idle"]');
    assert.equal(backend.value('ptt'), null);
  });

  await step('Bravo talks back: Alpha receives audio (reverse direction)', async () => {
    const before = await inboundBytes(alpha, 'audio');
    await holdPtt(bravo);
    await bravo.waitForSelector('#btn-ptt[data-state="talking"]', { timeout: 10000 });
    await alpha.waitForSelector('#speaker-overlay:not([hidden])');
    await new Promise((r) => setTimeout(r, 2000));
    await bravo.mouse.up();
    const after = await inboundBytes(alpha, 'audio');
    assert.ok(after - before > 4000, `Alpha received ${after - before} audio bytes`);
    await alpha.waitForSelector('#speaker-overlay', { state: 'hidden' });
  });

  await step('one-touch bodycam: a single tap starts the camera, recording and the live broadcast', async () => {
    await alpha.click('#btn-cam');
    await alpha.waitForFunction(() => document.querySelector('#bodycam-video').videoWidth > 0, null, { timeout: 10000 });
    await alpha.waitForSelector('#rec-indicator:not([hidden])');
    await alpha.waitForSelector('#live-indicator:not([hidden])');
    assert.equal(await alpha.getAttribute('#btn-live', 'aria-pressed'), 'true', 'broadcasting without a second tap');
    await new Promise((r) => setTimeout(r, 3500));
    assert.match(await alpha.textContent('#rec-time'), /^00:0[2-4]$/);
    await shot(alpha, '04-recording');
    await alpha.click('#btn-record');
    await alpha.waitForSelector('#rec-indicator', { state: 'hidden' });
    await alpha.waitForFunction(() => document.querySelectorAll('#clip-list li').length === 1);
    await alpha.waitForSelector('#btn-save-clip:not([disabled])');
    // Every floating control is on screen and is the topmost element at its centre.
    const blocked = await alpha.evaluate(() => ['#btn-cam-close', '#btn-flip', '#btn-live', '#btn-record', '#btn-save-clip', '#btn-clips', '#btn-cam-ptt']
      .filter((sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        const inView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.width > 0;
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !inView || !(top === el || el.contains(top));
      }));
    assert.deepEqual(blocked, [], `controls hidden or covered: ${blocked.join(', ')}`);
  });

  await step('upload clip: chunked to Apps Script → Drive, bytes identical, logged for group', async () => {
    const clipSize = await alpha.evaluate(() => new Promise((resolve) => {
      const req = indexedDB.open('trailguard', 1);
      req.onsuccess = () => {
        const tx = req.result.transaction('clips', 'readonly').objectStore('clips').getAll();
        tx.onsuccess = () => resolve(tx.result[0].size);
      };
    }));
    await alpha.click('#btn-save-clip');
    await alpha.waitForFunction(() => document.querySelectorAll('#clip-list li').length === 0, null, { timeout: 30000 });
    assert.match(await toastText(alpha), /saved to Google Drive/i);
    assert.equal(backend.gas.files.size, 1);
    const [file] = backend.gas.files.values();
    assert.equal(file.bytes.length, clipSize);
    assert.equal(file.bytes.subarray(0, 4).toString('hex'), '1a45dfa3', 'stored file is a WebM/Matroska container');
    assert.equal(backend.log.badContentType || 0, 0, 'all requests were CORS-simple text/plain');
    const rows = backend.gas.sheetRows('Uploads');
    assert.equal(rows.length, 2);
    await bravo.click('#btn-members');
    await bravo.waitForFunction(() => document.querySelectorAll('#archive-list li').length === 1);
    await bravo.click('#sheet-backdrop', { position: { x: 10, y: 10 } });
  });

  await step('Alpha is still broadcasting; Bravo watches beside the map from the marker popup', async () => {
    await alpha.waitForSelector('#live-indicator:not([hidden])');
    await bravo.waitForSelector('.member-marker .live-badge', { timeout: 10000 });
    await bravo.click('.member-marker:has(.live-badge)');
    await bravo.click('.leaflet-popup .popup-actions button:has-text("View live")');
    await bravo.waitForFunction(() => document.querySelector('#viewer-video').videoWidth > 0, null, { timeout: 15000 });
    assert.equal(await bravo.isVisible('#map'), true, 'map stays visible');
    assert.equal(await bravo.locator('.member-marker.watched').count(), 1, 'watched member is highlighted');
    await alpha.waitForFunction(() => /1 watching/.test(document.querySelector('#live-indicator').textContent));
    await shot(bravo, '05-viewing-live');
    await bravo.click('#viewer-close');
    await alpha.click('#btn-live');
    await alpha.waitForSelector('#live-indicator', { state: 'hidden' });
  });

  await step('field note is logged with position', async () => {
    await alpha.click('#btn-clips');
    await alpha.fill('#incident-text', 'Suspicious package near gate 3');
    await alpha.click('#incident-submit');
    await alpha.waitForFunction(() => /logged/i.test(document.querySelector('#toast').textContent));
    const rows = backend.gas.sheetRows('Incidents');
    assert.equal(rows.length, 2);
    assert.equal(rows[1][7], 'Suspicious package near gate 3');
    assert.ok(rows[1][8] > 1.28 && rows[1][8] < 1.29);
    await alpha.click('#btn-cam-close');
  });

  await step('owner removes Bravo: Bravo is ejected and cannot rejoin', async () => {
    await alpha.click('#btn-members');
    await alpha.click('#member-list button:has-text("Remove")');
    await bravo.waitForSelector('#screen-groups:not([hidden])', { timeout: 10000 });
    await alpha.waitForFunction(() => document.querySelectorAll('#member-list li').length === 1);
    await alpha.waitForFunction(() => document.querySelectorAll('.member-marker').length === 1);
    await bravo.fill('#join-code', code);
    await bravo.click('#join-submit');
    await bravo.waitForFunction(() => /cannot join/i.test(document.querySelector('#toast').textContent));
  });

  await step('owner unblocks; Bravo can rejoin; reload resumes the session', async () => {
    await alpha.click('#banned-list button:has-text("Unblock")');
    await alpha.waitForSelector('#banned-block', { state: 'hidden' });
    await bravo.fill('#join-code', code);
    await bravo.click('#join-submit');
    await bravo.waitForSelector('#screen-main:not([hidden])');
    // Removal deleted his member record, unit included: he picks it again.
    await pickRole(bravo, 'security');
    await bravo.reload();
    await bravo.waitForSelector('#screen-main:not([hidden])', { timeout: 10000 });
    await bravo.waitForTimeout(1500);
    assert.equal(await bravo.isVisible('#role-sheet'), false, 'unit remembered: no prompt after reload');
    await bravo.waitForFunction(() => /voice 1\/1/.test(document.querySelector('#main-status').textContent), null, { timeout: 20000 });
    await alpha.waitForFunction(() => /voice 1\/1/.test(document.querySelector('#main-status').textContent), null, { timeout: 20000 });
    // The previous page's onDisconnect fires after the new session started; presence must survive it.
    await new Promise((r) => setTimeout(r, 2500));
    const gid = Object.keys(backend.value('presence'))[0];
    assert.equal(Object.keys(backend.value(`presence/${gid}`)).length, 2, 'both members still present');
    assert.match(await alpha.textContent('#main-status'), /2 online · voice 1\/1/);
    // And voice still works after the reload.
    const before = await inboundBytes(alpha, 'audio');
    await holdPtt(bravo);
    await bravo.waitForSelector('#btn-ptt[data-state="talking"]', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 1500));
    await bravo.mouse.up();
    assert.ok((await inboundBytes(alpha, 'audio')) - before > 3000, 'audio flows after reload');
  });

  await step('owner disbands: everyone returns to the group list, data removed', async () => {
    await alpha.click('#sheet-backdrop', { position: { x: 10, y: 10 } }).catch(() => {});
    await alpha.click('#btn-members');
    await alpha.click('#btn-leave');
    await alpha.waitForSelector('#screen-groups:not([hidden])');
    await bravo.waitForSelector('#screen-groups:not([hidden])', { timeout: 10000 });
    assert.equal(backend.value('groups'), null);
    assert.equal(backend.value('locations'), null);
    assert.equal(backend.value('presence'), null);
    assert.equal(backend.value('groupCodes'), null);
  });

  assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`);
  const denials = {};
  for (const d of backend.log.denied) {
    const key = `${d.op} ${d.path.replace(/-[A-Za-z0-9_-]{19}/g, '<id>').replace(/u[0-9a-f]{12}/g, '<uid>')}`;
    denials[key] = (denials[key] || 0) + 1;
  }
  console.log(`\nE2E passed: ${steps.length} steps.`);
  console.log('Writes denied by database rules during the run:', denials);
  if (process.env.E2E_DEBUG) {
    for (const d of backend.log.denied) {
      const during = stepStarts.filter(([t]) => t <= d.at).at(-1);
      const why = d.info.split('\n').filter((l) => /=> (true|false)$/.test(l.trim()) && /exists\(\)|now -|members/.test(l)).slice(0, 6).join('\n');
      console.log(`- ${d.op} ${d.path} during "${during && during[1]}"\n${why}`);
    }
  }
} catch (err) {
  exitCode = 1;
  if (errors.length) console.log(`Page errors:\n${errors.join('\n')}`);
  console.log('Rule denials:', JSON.stringify(backend.log.denied.slice(-10), null, 1));
  for (const [name, page] of [['alpha', alpha], ['bravo', bravo]]) {
    if (page) await page.screenshot({ path: path.join(here, `fail-${name}.png`) }).catch(() => {});
  }
} finally {
  await browser.close();
  await vite.close();
  await backend.close();
  process.exit(exitCode);
}
