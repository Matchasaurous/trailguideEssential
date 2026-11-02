// Packs dist/ into trailguard-site.zip for upload to a web host (Hostinger:
// File Manager → public_html → Upload → Extract). Files sit at the zip's root.
// Source maps are left out; trailguard-config.js is never included, so an
// update can't overwrite the settings on the server.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve('dist');
const out = resolve('trailguard-site.zip');
if (!existsSync(resolve(dist, 'index.html'))) {
  console.error('dist/ is empty — run "npm run build" first.');
  process.exit(1);
}
rmSync(out, { force: true });
const r = spawnSync('zip', ['-qr', '-X', out, '.', '-x', '*.map', 'trailguard-config.js'], { cwd: dist, stdio: 'inherit' });
if (r.error || r.status !== 0) {
  console.error('Could not run "zip". Zip the contents of dist/ yourself (not the folder), leaving out *.map files.');
  process.exit(1);
}
console.log(`Wrote ${out} — upload it to public_html and extract it there.`);
