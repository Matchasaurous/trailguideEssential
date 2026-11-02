// Tests for the Apps Script archive endpoint, run in Node against in-memory
// fakes of Drive, Sheets and Firebase. Run: npm run test:gas
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGasRuntime, fakeToken } from './gas-harness.mjs';

const GID = '-NgroupAAAAAAAAAAAAA';
const CHUNK = 4 * 1024 * 1024;
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      ${err.stack.split('\n').slice(0, 4).join('\n      ')}`);
  }
}

function runtime() {
  return createGasRuntime({
    members: {
      [GID]: {
        alice: { name: 'Alice', role: 'member', unit: 'usher' },
        owner: { name: 'Owner', role: 'owner' },
        medic: { name: 'Mia', role: 'member', unit: 'medical' },
        dee: { name: 'Dee', role: 'dispatcher' },
        fiona: { name: 'Fiona', role: 'member', unit: 'fire' }
      }
    }
  });
}

function init(gas, size, extra = {}) {
  return gas.doPost({
    action: 'init', idToken: fakeToken('alice'), groupId: GID, groupName: 'Alpha / Team',
    fileName: 'bodycam_20261030-120000_Alice.webm', mimeType: 'video/webm;codecs=vp8,opus',
    size, durationSec: 12, recordedAt: '2026-10-30T04:00:00.000Z', lat: 1.3, lng: 103.8, ...extra
  });
}

function sendAll(gas, uploadId, data, { from = 0 } = {}) {
  let offset = from;
  let result;
  while (offset < data.length) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    result = gas.doPost({ action: 'chunk', idToken: fakeToken('alice'), groupId: GID, uploadId, offset, data: chunk.toString('base64') });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.done) return result;
    offset = result.nextOffset;
  }
  return result;
}

test('health check', () => {
  assert.equal(runtime().doGet().ok, true);
});

test('setup creates archive folder and log sheet', () => {
  const gas = runtime();
  gas.setup();
  assert.ok(gas.props.get('ROOT_FOLDER_ID'));
  assert.ok(gas.props.get('LOG_SHEET_ID'));
});

test('full chunked upload reassembles the exact bytes in Drive', () => {
  const gas = runtime();
  const data = crypto.randomBytes(Math.floor(10.5 * 1024 * 1024));
  const start = init(gas, data.length);
  assert.equal(start.ok, true, JSON.stringify(start));
  const done = sendAll(gas, start.uploadId, data);
  assert.equal(done.done, true);
  assert.ok(done.file.id && done.file.url.startsWith('https://drive.google.com/'));
  assert.ok(gas.fileBytes(done.file.id).equals(data));
  const rows = gas.sheetRows('Uploads');
  assert.equal(rows.length, 2); // header + one upload
  assert.equal(rows[1][6], 'bodycam_20261030-120000_Alice.webm');
  assert.ok(!gas.props.has(`up_${start.uploadId}`), 'upload record cleaned up');
});

test('file lands in Root / <Group> [gid] / <date> with sanitized names', () => {
  const gas = runtime();
  const data = crypto.randomBytes(1000);
  const start = init(gas, data.length);
  const done = sendAll(gas, start.uploadId, data);
  const session = [...gas.sessions.values()][0];
  assert.equal(session.meta.name, 'bodycam_20261030-120000_Alice.webm');
  assert.equal(session.meta.mimeType, 'video/webm');
  assert.ok(done.done);
  assert.match(start.folder, /^\d{4}-\d{2}-\d{2}$/);
});

test('status reports progress and resumes after a lost response', () => {
  const gas = runtime();
  const data = crypto.randomBytes(9 * 1024 * 1024);
  const start = init(gas, data.length);
  const first = gas.doPost({ action: 'chunk', idToken: fakeToken('alice'), groupId: GID, uploadId: start.uploadId, offset: 0, data: data.subarray(0, CHUNK).toString('base64') });
  assert.equal(first.nextOffset, CHUNK);
  const status = gas.doPost({ action: 'status', idToken: fakeToken('alice'), groupId: GID, uploadId: start.uploadId });
  assert.equal(status.nextOffset, CHUNK);
  const done = sendAll(gas, start.uploadId, data, { from: status.nextOffset });
  assert.equal(done.done, true);
  assert.ok(gas.fileBytes(done.file.id).equals(data));
  const after = gas.doPost({ action: 'status', idToken: fakeToken('alice'), groupId: GID, uploadId: start.uploadId });
  assert.equal(after.done, true, 'status after completion still reports the file');
});

test('Drive 503 surfaces as a retryable error and the chunk can be resent', () => {
  const gas = runtime();
  const data = crypto.randomBytes(5 * 1024 * 1024);
  const start = init(gas, data.length);
  gas.failures.nextPut.push(503);
  const bad = gas.doPost({ action: 'chunk', idToken: fakeToken('alice'), groupId: GID, uploadId: start.uploadId, offset: 0, data: data.subarray(0, CHUNK).toString('base64') });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'drive_retry');
  const done = sendAll(gas, start.uploadId, data);
  assert.ok(gas.fileBytes(done.file.id).equals(data));
});

test('rejects missing / invalid tokens', () => {
  const gas = runtime();
  assert.equal(gas.doPost({ action: 'init', groupId: GID }).code, 'unauthenticated');
  assert.equal(gas.doPost({ action: 'init', idToken: 'x'.repeat(200), groupId: GID }).code, 'unauthenticated');
  assert.equal(gas.doPost({ action: 'init', idToken: `bad.${'y'.repeat(150)}.z`, groupId: GID }).code, 'unauthenticated');
});

test('rejects non-members', () => {
  const gas = runtime();
  const r = gas.doPost({ action: 'init', idToken: fakeToken('mallory'), groupId: GID, fileName: 'a.webm', mimeType: 'video/webm', size: 10 });
  assert.equal(r.code, 'forbidden');
});

test('another member cannot write into someone else\'s upload session', () => {
  const gas = runtime();
  const start = init(gas, 1000);
  const r = gas.doPost({ action: 'chunk', idToken: fakeToken('owner'), groupId: GID, uploadId: start.uploadId, offset: 0, data: Buffer.alloc(1000).toString('base64') });
  assert.equal(r.code, 'unknown_upload');
});

test('validates group id, mime type, size, alignment and bounds', () => {
  const gas = runtime();
  assert.equal(gas.doPost({ action: 'init', idToken: fakeToken('alice'), groupId: '../etc' }).code, 'bad_request');
  assert.equal(init(gas, 100, { mimeType: 'text/html' }).code, 'bad_request');
  assert.equal(init(gas, 0).code, 'bad_request');
  assert.equal(init(gas, 400 * 1024 * 1024).code, 'too_large');
  const start = init(gas, 2 * 1024 * 1024);
  const misaligned = gas.doPost({ action: 'chunk', idToken: fakeToken('alice'), groupId: GID, uploadId: start.uploadId, offset: 0, data: Buffer.alloc(1000).toString('base64') });
  assert.equal(misaligned.code, 'bad_request');
  const overflow = gas.doPost({ action: 'chunk', idToken: fakeToken('alice'), groupId: GID, uploadId: start.uploadId, offset: 2 * 1024 * 1024 - 10, data: Buffer.alloc(100).toString('base64') });
  assert.equal(overflow.code, 'bad_request');
  assert.equal(gas.doPost({ action: 'chunk', idToken: fakeToken('alice'), groupId: GID, uploadId: 'nope', offset: 0, data: 'AA==' }).code, 'bad_request');
});

test('file name is sanitised and extension forced from the mime type', () => {
  const gas = runtime();
  const start = init(gas, 10, { fileName: '../../evil<script>.exe', mimeType: 'video/mp4' });
  assert.equal(start.ok, true);
  const session = [...gas.sessions.values()][0];
  assert.equal(session.meta.name, 'evil_script_.mp4');
});

test('incident log appends a row and neutralises formula injection', () => {
  const gas = runtime();
  const r = gas.doPost({ action: 'incident', idToken: fakeToken('alice'), groupId: GID, groupName: 'Alpha', text: '=IMPORTXML("http://x")', lat: 1.3, lng: 103.8, acc: 7.4, clientTime: '2026-10-30T12:00:00Z' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const rows = gas.sheetRows('Incidents');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][7], '\'=IMPORTXML("http://x")');
  assert.equal(rows[1][11], 'https://www.google.com/maps?q=1.3,103.8');
  assert.equal(gas.doPost({ action: 'incident', idToken: fakeToken('alice'), groupId: GID, text: '   ' }).code, 'bad_request');
});

test('malformed bodies and unknown actions return JSON errors', () => {
  const gas = runtime();
  assert.equal(gas.doPost('not json').code, 'bad_request');
  assert.equal(gas.doPost({ action: 'drop_tables', idToken: fakeToken('alice'), groupId: GID }).code, 'bad_request');
});

test('case events append structured rows to the Cases tab', () => {
  const gas = runtime();
  const base = { action: 'case', idToken: fakeToken('alice'), groupId: GID, groupName: 'Alpha', caseId: '-Ncase1', type: 'medical', priority: 1, status: 'open', title: 'Fall at Blk 12', description: '=HYPERLINK("x")', lat: 1.3, lng: 103.8, reportedBy: 'Alice' };
  assert.equal(gas.doPost({ ...base, event: 'created' }).ok, true);
  assert.equal(gas.doPost({ ...base, event: 'closed', status: 'closed', responders: 'Bob (Cleared)' }).ok, true);
  const rows = gas.sheetRows('Cases');
  assert.equal(rows.length, 3);
  assert.deepEqual(Array.from(rows[1].slice(1, 9)), ['created', '-Ncase1', GID, 'Alpha', 'Medical', 'P1 Critical', 'open', 'Fall at Blk 12']);
  assert.equal(rows[1][9], '\'=HYPERLINK("x")');
  assert.equal(rows[2][16], 'Bob (Cleared)');
  assert.equal(gas.doPost({ ...base, event: 'deleted_everything' }).code, 'bad_request');
  assert.equal(gas.doPost({ ...base, event: 'created', type: 'alien' }).code, 'bad_request');
  assert.equal(gas.doPost({ ...base, event: 'created', caseId: '../x' }).code, 'bad_request');
  assert.equal(gas.doPost({ ...base, event: 'created', idToken: fakeToken('mallory') }).code, 'forbidden');
});

test('setup renames a folder and log created under the old FieldLink name', () => {
  const gas = runtime();
  gas.setup();
  const folderId = gas.props.get('ROOT_FOLDER_ID');
  const sheetId = gas.props.get('LOG_SHEET_ID');
  gas.renameForTest(folderId, sheetId, 'FieldLink Bodycam Archive', 'FieldLink Archive Log');
  assert.equal(gas.folderName(folderId), 'FieldLink Bodycam Archive');
  gas.setup();
  assert.equal(gas.folderName(folderId), 'Trailguard Essentials Archive');
  assert.equal(gas.spreadsheetName(sheetId), 'Trailguard Essentials Log');
});

test('review workflow events and new case types are logged', () => {
  const gas = runtime();
  const base = { action: 'case', idToken: fakeToken('alice'), groupId: GID, groupName: 'Alpha', caseId: '-Ncase2', type: 'crowd', priority: 2, title: 'Crush risk at gate B' };
  assert.equal(gas.doPost({ ...base, event: 'reported', status: 'pending' }).ok, true);
  assert.equal(gas.doPost({ ...base, event: 'verified', status: 'open', type: 'medical_major' }).ok, true);
  assert.equal(gas.doPost({ ...base, event: 'accepted', status: 'open', responders: 'Bob (accepted)' }).ok, true);
  assert.equal(gas.doPost({ ...base, event: 'rejected', status: 'rejected' }).ok, true);
  const rows = gas.sheetRows('Cases');
  assert.deepEqual(rows.slice(1).map((r) => [r[1], r[5], r[7]]), [
    ['reported', 'Crowd control', 'pending'],
    ['verified', 'Major medical / trauma', 'open'],
    ['accepted', 'Crowd control', 'open'],
    ['rejected', 'Crowd control', 'rejected']
  ]);
});

test('case photo: JPEG saved under the case folder and logged; non-JPEG and non-members refused', () => {
  const gas = runtime();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(5000)]);
  const r = gas.doPost({ action: 'photo', idToken: fakeToken('alice'), groupId: GID, groupName: 'Alpha', caseId: '-Ncase9', mimeType: 'image/jpeg', fileName: 'report_1.jpg', data: jpeg.toString('base64') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.file.url.startsWith('https://drive.google.com/file/d/'));
  assert.ok(gas.fileBytes(r.file.id).equals(jpeg));
  assert.match(gas.folderPath(gas.folderOf(r.file.id).id), /^Trailguard Essentials Archive \/ Alpha \[-Ngroup[^\]]+\] \/ \d{4}-\d{2}-\d{2} \/ Case -Ncase9$/);
  assert.equal(gas.sheetRows('Photos').length, 2);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.equal(gas.doPost({ action: 'photo', idToken: fakeToken('alice'), groupId: GID, caseId: '-Ncase9', mimeType: 'image/jpeg', data: png.toString('base64') }).code, 'bad_request');
  assert.equal(gas.doPost({ action: 'photo', idToken: fakeToken('alice'), groupId: GID, caseId: '-Ncase9', mimeType: 'image/png', data: png.toString('base64') }).code, 'bad_request');
  assert.equal(gas.doPost({ action: 'photo', idToken: fakeToken('mallory'), groupId: GID, caseId: '-Ncase9', mimeType: 'image/jpeg', data: jpeg.toString('base64') }).code, 'forbidden');
  assert.equal(gas.doPost({ action: 'photo', idToken: fakeToken('alice'), groupId: GID, caseId: '../../x', mimeType: 'image/jpeg', data: jpeg.toString('base64') }).code, 'bad_request');
});

test('ePCR: medical responders save to the restricted folder; saving again updates; minimal sheet row', () => {
  const gas = runtime();
  const record = {
    info: { complaint: 'Chest pain', disposition: 'transported', triage: 'red', status: 'open', patient: { age: 54, sex: 'M', ident: 'Bib 4412' } },
    vitals: { v1: { hr: 128, sbp: 92, dbp: 60, spo2: 91, ts: 1 } }
  };
  const base = { action: 'epcr', groupId: GID, groupName: 'Alpha', caseId: '-Ncase7', patientId: '-Npat1', caseTitle: 'Collapse km 12', soap: 'S — Chest pain\nO — HR 128' };
  const r = gas.doPost({ ...base, idToken: fakeToken('medic'), record: JSON.stringify(record) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(gas.folderPath(gas.folderOf(r.file.id).id), /^Trailguard Essentials Archive \/ Patient Records \(restricted\) \/ Alpha \[-Ngroup[^\]]+\] \/ Case -Ncase7$/);
  assert.equal(gas.fileBytes(r.file.id).toString('utf8'), 'S — Chest pain\nO — HR 128');
  const saved = JSON.parse(gas.fileBytes(r.file.jsonId).toString('utf8'));
  assert.equal(saved.record.vitals.v1.hr, 128);
  assert.equal(saved.savedBy.uid, 'medic');
  // Saving again replaces the content of the same files.
  const again = gas.doPost({ ...base, idToken: fakeToken('dee'), record: JSON.stringify({ ...record, info: { ...record.info, status: 'closed' } }), soap: 'updated' });
  assert.equal(again.file.id, r.file.id);
  assert.equal(gas.fileBytes(r.file.id).toString('utf8'), 'updated');
  const rows = gas.sheetRows('Patients');
  assert.equal(rows.length, 3);
  assert.deepEqual(Array.from(rows[1].slice(3, 11)), ['-Ncase7', '-Npat1', 'medic', 'Mia', 'medic@example.com', 'transported', 'red', 'open']);
  assert.equal(rows[2][10], 'closed');
  assert.ok(!rows.flat().some((cell) => String(cell).includes('Bib 4412') || String(cell).includes('Chest pain')), 'no clinical data or identifiers in the sheet');
  // Not medical, not a dispatcher: refused. Bad input: refused.
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('alice'), record: JSON.stringify(record) }).code, 'forbidden');
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('fiona'), record: JSON.stringify(record) }).code, 'forbidden');
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('mallory'), record: JSON.stringify(record) }).code, 'forbidden');
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('medic'), record: '{not json' }).code, 'bad_request');
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('medic'), record: JSON.stringify({ vitals: {} }) }).code, 'bad_request');
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('medic'), patientId: '../x', record: JSON.stringify(record) }).code, 'bad_request');
});

test('after-action report: dispatchers save PDF / CSV to Reports; others refused; content checked', () => {
  const gas = runtime();
  const pdf = Buffer.concat([Buffer.from('%PDF-1.3\n'), crypto.randomBytes(2000)]);
  const r = gas.doPost({ action: 'report', idToken: fakeToken('dee'), groupId: GID, groupName: 'Alpha', fileName: 'after-action_20261031.pdf', mimeType: 'application/pdf', data: pdf.toString('base64') });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(gas.fileBytes(r.file.id).equals(pdf));
  assert.match(gas.folderPath(gas.folderOf(r.file.id).id), /^Trailguard Essentials Archive \/ Alpha \[-Ngroup[^\]]+\] \/ Reports$/);
  const csv = Buffer.from('Metric,Value\r\nTotal cases,4\r\n');
  assert.equal(gas.doPost({ action: 'report', idToken: fakeToken('owner'), groupId: GID, groupName: 'Alpha', fileName: 'report.csv', mimeType: 'text/csv', data: csv.toString('base64') }).ok, true);
  assert.equal(gas.sheetRows('Reports').length, 3);
  assert.equal(gas.doPost({ action: 'report', idToken: fakeToken('medic'), groupId: GID, mimeType: 'application/pdf', data: pdf.toString('base64') }).code, 'forbidden');
  assert.equal(gas.doPost({ action: 'report', idToken: fakeToken('dee'), groupId: GID, mimeType: 'application/pdf', data: csv.toString('base64') }).code, 'bad_request');
  assert.equal(gas.doPost({ action: 'report', idToken: fakeToken('dee'), groupId: GID, mimeType: 'text/html', data: csv.toString('base64') }).code, 'bad_request');
});

test('announcements: dispatchers log any, fire units only fire alerts', () => {
  const gas = runtime();
  const base = { action: 'announcement', groupId: GID, groupName: 'Alpha', announcementId: '-Nann1', level: 'critical', audience: 'all', text: 'Evacuate zone B now' };
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('dee'), kind: 'general' }).ok, true);
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('fiona'), kind: 'fire', caseId: '-Ncase3', lat: 1.3, lng: 103.8 }).ok, true);
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('fiona'), kind: 'general' }).code, 'forbidden');
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('alice'), kind: 'general' }).code, 'forbidden');
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('dee'), level: 'apocalyptic' }).code, 'bad_request');
  assert.equal(gas.doPost({ ...base, idToken: fakeToken('dee'), text: '=cmd|calc' }).ok, true);
  const rows = gas.sheetRows('Announcements');
  assert.equal(rows.length, 4);
  assert.equal(rows[2][6], 'fire');
  assert.equal(rows[2][11], 'https://www.google.com/maps?q=1.3,103.8');
  assert.equal(rows[3][7], "'=cmd|calc");
});

test('case log accepts the 1.4 case types', () => {
  const gas = runtime();
  const base = { action: 'case', idToken: fakeToken('dee'), groupId: GID, groupName: 'Alpha', caseId: '-Ncase8', priority: 1, title: 'Runner down', status: 'open', event: 'created' };
  assert.equal(gas.doPost({ ...base, type: 'cardiac' }).ok, true);
  assert.equal(gas.doPost({ ...base, type: 'transport' }).ok, true);
  assert.deepEqual(gas.sheetRows('Cases').slice(1).map((r) => r[5]), ['Cardiac arrest / collapse', 'Patient transport']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
