// Runtime site configuration (public/trailguard-config.js → src/runtime-config.js).
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}
let n = 0;
async function load(cfg) {
  if (cfg === undefined) delete globalThis.window; else globalThis.window = { TRAILGUARD_CONFIG: cfg };
  return import(`../src/runtime-config.js?case=${++n}`);
}

await test('no config file: every value falls back to the build-time value', async () => {
  const m = await load(undefined);
  assert.equal(m.hasRuntimeConfig, false);
  assert.equal(m.setting('firebase.apiKey', 'from-env'), 'from-env');
});

await test('values set in the file win; empty strings and null fall back', async () => {
  const m = await load({ firebase: { apiKey: ' AIza123 ', projectId: '' }, iceServers: null, gasEndpoint: 'https://script.google.com/macros/s/x/exec' });
  assert.equal(m.hasRuntimeConfig, true);
  assert.equal(m.setting('firebase.apiKey', 'env'), 'AIza123', 'trimmed');
  assert.equal(m.setting('firebase.projectId', 'env-project'), 'env-project');
  assert.equal(m.setting('iceServers', 'env-ice'), 'env-ice');
  assert.equal(m.setting('gasEndpoint', ''), 'https://script.google.com/macros/s/x/exec');
  assert.equal(m.setting('missing.deep.key', 'd'), 'd');
});

await test('lists are passed through (ICE servers)', async () => {
  const ice = [{ urls: ['turn:t.example.com:3478'], username: 'u', credential: 'p' }];
  const m = await load({ iceServers: ice });
  assert.deepEqual(m.setting('iceServers', null), ice);
});

await test('a malformed file (not an object) is ignored', async () => {
  const m = await load('oops');
  assert.equal(m.hasRuntimeConfig, false);
  assert.equal(m.setting('firebase.apiKey', 'env'), 'env');
});

await test('the example file is valid JavaScript and sets every documented key', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/trailguard-config.example.js', import.meta.url), 'utf8');
  const sandbox = {};
  new Function('window', src)(sandbox);
  const c = sandbox.TRAILGUARD_CONFIG;
  assert.deepEqual(Object.keys(c.firebase), ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId']);
  for (const k of ['gasEndpoint', 'publicUrl', 'emergencyNumber', 'iceServers', 'googleSignIn']) assert.ok(k in c, k);
  assert.equal(c.publicUrl, 'https://app.trailguardessentials.com/');
});

delete globalThis.window;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
