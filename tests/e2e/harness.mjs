// Shared setup for the dispatch and scale end-to-end tests: rules-enforcing fake
// backend, Vite dev server with the fake Firebase SDK, and headless Chromium
// "phones" with fake camera, microphone and GPS.
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startFakeBackend } from './fake-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fake = (f) => path.join(here, 'fake-firebase', f);

export async function startEnv({ wsPort = 8787, gasPort = 8788, vitePort = 5174 } = {}) {
  Object.assign(process.env, {
    VITE_FIREBASE_API_KEY: 'test',
    VITE_FIREBASE_AUTH_DOMAIN: 'test.local',
    VITE_FIREBASE_DATABASE_URL: 'https://test-db.firebasedatabase.app',
    VITE_FIREBASE_PROJECT_ID: 'test',
    VITE_GAS_ENDPOINT: `http://127.0.0.1:${gasPort}/exec`,
    VITE_ICE_SERVERS: '[]',
    VITE_TILE_URL: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    VITE_USE_EMULATORS: '0',
    VITE_FAKE_WS: `ws://127.0.0.1:${wsPort}`,
    VITE_ROUTING_URL: `http://127.0.0.1:${gasPort}/routed-{profile}/route/v1/driving/{fromLng},{fromLat};{toLng},{toLat}?overview=false`
  });

  const backend = startFakeBackend({ wsPort, gasPort });
  const vite = await createServer({
    configFile: false,
    root,
    envDir: here,
    logLevel: 'error',
    server: { port: vitePort, host: '127.0.0.1', strictPort: true },
    resolve: {
      alias: {
        'firebase/app': fake('app.js'),
        'firebase/auth': fake('auth.js'),
        'firebase/database': fake('database.js')
      }
    }
  });
  await vite.listen();
  const appUrl = `http://127.0.0.1:${vitePort}/`;

  const executablePath = process.env.CHROME_PATH || ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'].find((p) => existsSync(p));
  const browser = await chromium.launch({
    executablePath,
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
      permissions: ['geolocation', 'camera', 'microphone', 'notifications'],
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: Number(process.env.E2E_DPR) || 1,
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
      // Record notifications instead of showing them.
      window.__notifications = [];
      class RecordingNotification {
        static permission = 'granted';
        static requestPermission() { return Promise.resolve('granted'); }
        constructor(title, options) { window.__notifications.push({ title, body: options && options.body }); }
        close() {}
      }
      window.Notification = RecordingNotification;
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => errors.push(`[${label}] ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/favicon|tile|404/i.test(msg.text())) errors.push(`[${label}] console: ${msg.text()}`);
    });
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined));
    await page.goto(appUrl);
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

  async function createGroup(page, name) {
    await page.fill('#create-name', name);
    await page.click('#create-submit');
    await page.waitForSelector('#screen-main:not([hidden])');
    await page.waitForFunction(() => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector('#invite-code').textContent));
    const code = await page.textContent('#invite-code');
    await page.waitForSelector('#members-sheet:not([hidden])');
    await closeSheet(page);
    return code;
  }

  /**
   * Join with an invite code, then pick a role (and optionally equipment / travel
   * mode) in the role prompt. role null = leave it open.
   */
  async function join(page, code, role = 'medical', opts = {}) {
    await page.fill('#join-code', code);
    await page.click('#join-submit');
    await page.waitForSelector('#screen-main:not([hidden])', { timeout: 15000 });
    await page.waitForSelector('#role-sheet:not([hidden])', { timeout: 10000 });
    if (role) await chooseUnit(page, role, opts);
  }

  /** In the open role sheet: choose a role, tick equipment, choose travel mode, save. */
  async function chooseUnit(page, role, { gear = [], mode = null } = {}) {
    await page.waitForSelector('#role-sheet:not([hidden])');
    await page.click(`#role-options button[data-unit="${role}"]`);
    for (const g of gear) await page.check(`#role-gear input[value="${g}"]`);
    if (mode) await page.click(`#role-mode button[data-mode="${mode}"]`);
    await page.click('#role-save');
    await page.waitForSelector('#role-sheet', { state: 'hidden' });
  }

  async function inboundPackets(page, kind) {
    return page.evaluate(async (k) => {
      let total = 0;
      for (const pc of window.__pcs) {
        if (pc.connectionState === 'closed') continue;
        const stats = await pc.getStats();
        stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === k) total += s.packetsReceived || 0; });
      }
      return total;
    }, kind);
  }

  /** A small real JPEG for photo uploads (drawn in the page). */
  async function jpegFile(page, label) {
    const base64 = await page.evaluate((text) => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const g = c.getContext('2d');
      g.fillStyle = '#2a6'; g.fillRect(0, 0, 640, 480);
      g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText(text, 40, 260);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    }, label);
    return { name: `${label}.jpg`, mimeType: 'image/jpeg', buffer: Buffer.from(base64, 'base64') };
  }

  async function closeSheet(page) {
    if (await page.isVisible('#sheet-backdrop')) await page.click('#sheet-backdrop', { position: { x: 10, y: 10 } });
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

  async function holdSos(page, ms = 1700) {
    const box = await page.locator('#btn-sos').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, ms));
    await page.mouse.up();
  }

  async function close() {
    await browser.close();
    await vite.close();
    await backend.close();
  }

  return { backend, browser, errors, newUser, register, createGroup, join, chooseUnit, closeSheet, inboundBytes, inboundPackets, holdPtt, holdSos, jpegFile, close, here };
}

export function stepper() {
  const results = [];
  return {
    results,
    async step(name, fn) {
      const t0 = Date.now();
      try {
        await fn();
        results.push(name);
        console.log(`  ok  ${name} (${Date.now() - t0} ms)`);
      } catch (err) {
        console.log(`FAIL  ${name}\n${err.stack}`);
        throw err;
      }
    }
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
