// Scale test: N phones (default 15) in one group, all in one headless Chromium.
// Checks the full WebRTC mesh forms (voice (N-1)/(N-1) on every phone), every
// marker shows on the map, push-to-talk audio reaches every other member,
// and an SOS alarms all of them.
// Run: npm run test:scale   (SCALE_N=10 npm run test:scale for a smaller run)
import assert from 'node:assert/strict';
import { startEnv, stepper, sleep } from './harness.mjs';

const N = Number(process.env.SCALE_N || 15);
const env = await startEnv({ wsPort: 8797, gasPort: 8798, vitePort: 5184 });
const { step } = stepper();
const pages = [];
let exitCode = 0;

async function waitAll(fn, arg, timeout) {
  await Promise.all(pages.map((p) => p.waitForFunction(fn, arg, { timeout })));
}

try {
  await step(`${N} members register and join`, async () => {
    for (let i = 0; i < N; i++) {
      // Spread members ~100 m apart around Toa Payoh.
      pages.push(await env.newUser(`m${i}`, 1.3343 + (i % 5) * 0.0009, 103.8563 + Math.floor(i / 5) * 0.0009));
    }
    for (let i = 0; i < N; i++) await env.register(pages[i], `Member ${String(i + 1).padStart(2, '0')}`, `m${i}@test.io`);
    const code = await env.createGroup(pages[0], 'Scale Test');
    for (let i = 1; i < N; i++) await env.join(pages[i], code);
  });

  await step(`full mesh: every phone shows ${N} online and voice ${N - 1}/${N - 1}`, async () => {
    const t0 = Date.now();
    await waitAll((n) => {
      const t = document.querySelector('#main-status').textContent;
      return t.includes(`${n} online`) && t.includes(`voice ${n - 1}/${n - 1}`);
    }, N, 120000);
    console.log(`      mesh complete ${Date.now() - t0} ms after the last join`);
  });

  await step(`every phone shows ${N} markers`, async () => {
    await waitAll((n) => document.querySelectorAll('.member-marker').length === n, N, 30000);
  });

  for (const talker of [0, N - 1]) {
    await step(`member ${talker + 1} talks: audio reaches all ${N - 1} others`, async () => {
      const listeners = pages.filter((_, i) => i !== talker);
      const before = await Promise.all(listeners.map((p) => env.inboundPackets(p, 'audio')));
      await env.holdPtt(pages[talker]);
      await pages[talker].waitForSelector('#btn-ptt[data-state="talking"]', { timeout: 15000 });
      await sleep(4000);
      const after = await Promise.all(listeners.map((p) => env.inboundPackets(p, 'audio')));
      await pages[talker].mouse.up();
      // Opus sends ~50 packets/s. On a CPU-starved test machine fewer get through,
      // so the check is that every listener receives a steady stream.
      const deltas = after.map((a, i) => a - before[i]);
      const silent = deltas.filter((d) => d < 25).length;
      console.log(`      audio packets per listener in 4 s: min ${Math.min(...deltas)}, max ${Math.max(...deltas)}`);
      assert.equal(silent, 0, `${silent} listeners received no audio stream`);
      await waitAll(() => document.querySelector('#speaker-overlay').hidden, null, 10000);
    });
  }

  await step('live video is sent only to the member watching it', async () => {
    const [broadcaster, viewer, bystander] = [pages[0], pages[1], pages[2]];
    await broadcaster.click('#btn-cam');   // one touch: camera + recording + live
    await broadcaster.waitForFunction(() => document.querySelector('#bodycam-video').videoWidth > 0, null, { timeout: 15000 });
    await broadcaster.waitForSelector('#live-indicator:not([hidden])');
    await viewer.click('#btn-members');
    await viewer.click('#member-list li:has-text("Member 01") button:has-text("View live")', { timeout: 15000 });
    await viewer.waitForFunction(() => document.querySelector('#viewer-video').videoWidth > 0, null, { timeout: 20000 });
    const v0 = await env.inboundBytes(viewer, 'video');
    const b0 = await env.inboundBytes(bystander, 'video');
    await sleep(2500);
    const viewerGot = (await env.inboundBytes(viewer, 'video')) - v0;
    const bystanderGot = (await env.inboundBytes(bystander, 'video')) - b0;
    console.log(`      video bytes in 2.5 s: viewer ${viewerGot}, bystander ${bystanderGot}`);
    assert.ok(viewerGot > 20000, 'viewer receives video');
    assert.ok(bystanderGot < 2000, 'non-viewers receive no video');
    await viewer.click('#viewer-close');
    await broadcaster.click('#btn-cam-close');
  });

  await step(`SOS from member ${Math.ceil(N / 2)} alarms all ${N - 1} others`, async () => {
    const sender = Math.floor(N / 2);
    await env.holdSos(pages[sender]);
    await Promise.all(pages.map((p, i) => (i === sender
      ? p.waitForSelector('#sos-banner:not([hidden])')
      : p.waitForSelector('#alert-overlay:not([hidden])', { timeout: 20000 }))));
  });

  const heap = await Promise.all(pages.map((p) => p.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0))));
  console.log(`      JS heap per phone: ~${Math.round(Math.max(...heap) / 1048576)} MB max`);
  assert.deepEqual(env.errors, [], `page errors:\n${env.errors.join('\n')}`);
  console.log(`\nScale E2E passed with ${N} phones.`);
} catch (err) {
  exitCode = 1;
  if (env.errors.length) console.log(`Page errors:\n${env.errors.slice(0, 10).join('\n')}`);
  if (pages.length) {
    const statuses = await Promise.all(pages.map((p) => p.textContent('#main-status').catch(() => '?')));
    console.log('Status lines:', statuses);
  }
} finally {
  await env.close();
  process.exit(exitCode);
}
