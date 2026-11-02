// Runs apps-script/google-apps-script.gs inside Node with in-memory fakes of the
// Apps Script services it uses (Drive resumable uploads, Sheets, Cache,
// Properties, Firebase Auth lookup, Realtime Database REST). Used by
// tests/gas.test.mjs and by the end-to-end test's mock upload server.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const toBuffer = (arr) => Buffer.from(arr.map((b) => b & 0xff));

/**
 * @param {{members: Record<string, Record<string, {name: string, role: string}>>}} opts
 *   members[gid][uid] — fake Realtime Database membership. Tokens look like "fake.<uid>.<pad>".
 */
export function createGasRuntime({ members = {} } = {}) {
  const props = new Map([
    ['FIREBASE_API_KEY', 'test-key'],
    ['FIREBASE_DB_URL', 'https://test-db.firebasedatabase.app']
  ]);
  const cache = new Map();
  const folders = new Map();
  const sessions = new Map();
  const files = new Map();
  const spreadsheets = new Map();
  const failures = { nextPut: [] };    // e.g. [503] makes the next Drive PUT fail once
  let idSeq = 0;
  const newId = (p) => `${p}${++idSeq}`;

  function makeFolder(name, parentId = null) {
    const folder = {
      id: newId('folder'), name, parentId, trashed: false, children: [],
      getId() { return this.id; },
      getName() { return this.name; },
      setName(n) { this.name = n; return this; },
      getUrl() { return `https://drive.mock/folders/${this.id}`; },
      isTrashed() { return this.trashed; },
      setDescription() { return this; },
      createFolder(child) { const f = makeFolder(child, this.id); this.children.push(f.id); return f; },
      createFile(blobOrName, content, mimeType) {
        const id = newId('file');
        const record = typeof blobOrName === 'string'
          ? { name: blobOrName, mimeType, bytes: Buffer.from(String(content), 'utf8'), parentId: this.id }
          : { name: blobOrName.name, mimeType: blobOrName.mime, bytes: toBuffer(blobOrName.bytes), parentId: this.id };
        files.set(id, record);
        return fileHandle(id);
      },
      getFilesByName(name) {
        const list = [...files.entries()].filter(([, f]) => f.parentId === this.id && f.name === name).map(([id]) => fileHandle(id));
        let i = 0;
        return { hasNext: () => i < list.length, next: () => list[i++] };
      },
      getFolders() {
        const list = this.children.map((id) => folders.get(id));
        let i = 0;
        return { hasNext: () => i < list.length, next: () => list[i++] };
      }
    };
    folders.set(folder.id, folder);
    return folder;
  }

  function fileHandle(id) {
    return {
      getId: () => id,
      isTrashed: () => false,
      setDescription() { return this; },
      setContent(text) { files.get(id).bytes = Buffer.from(String(text), 'utf8'); return this; }
    };
  }

  function makeSpreadsheet(name) {
    const ss = {
      id: newId('sheet'), name, sheets: new Map([['Sheet1', makeSheet('Sheet1')]]),
      getId() { return this.id; },
      getName() { return this.name; },
      rename(n) { this.name = n; },
      getUrl() { return `https://docs.mock/${this.id}`; },
      getSheetByName(n) { return this.sheets.get(n) || null; },
      insertSheet(n) { const s = makeSheet(n); this.sheets.set(n, s); return s; },
      getSheets() { return [...this.sheets.values()]; },
      deleteSheet(s) { this.sheets.delete(s.name); }
    };
    spreadsheets.set(ss.id, ss);
    return ss;
  }

  function makeSheet(name) {
    return {
      name, rows: [],
      appendRow(row) { this.rows.push(row); return this; },
      setFrozenRows() { return this; },
      getRange() { return { setFontWeight() { return this; } }; },
      getLastRow() { return this.rows.length; }
    };
  }

  function response(code, body = '', headers = {}) {
    return {
      getResponseCode: () => code,
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
      getAllHeaders: () => headers
    };
  }

  function uidFromToken(token) {
    const m = /^fake\.([A-Za-z0-9_-]+)\./.exec(token || '');
    return m ? m[1] : null;
  }

  function fetch(url, opts = {}) {
    const method = (opts.method || 'get').toLowerCase();
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const { idToken } = JSON.parse(opts.payload);
      const uid = uidFromToken(idToken);
      if (!uid) return response(400, { error: { message: 'INVALID_ID_TOKEN' } });
      return response(200, { users: [{ localId: uid, email: `${uid}@example.com`, displayName: uid }] });
    }
    if (url.startsWith('https://test-db.firebasedatabase.app/')) {
      if (url.endsWith('/.json?shallow=true')) return response(401, { error: 'Permission denied' });
      const m = /\/groups\/([^/]+)\/members\/([^/.]+)\.json\?auth=(.*)$/.exec(url);
      if (!m) return response(404, 'null');
      const token = decodeURIComponent(m[3]);
      const caller = uidFromToken(token);
      if (!caller) return response(401, { error: 'Auth token is expired' });
      const group = members[m[1]] || {};
      if (!group[caller]) return response(401, { error: 'Permission denied' });
      return response(200, group[decodeURIComponent(m[2])] || null);
    }
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
      const meta = JSON.parse(opts.payload);
      const total = Number(opts.headers['X-Upload-Content-Length']);
      const id = newId('session');
      sessions.set(id, { meta, total, bytes: Buffer.alloc(0), mime: opts.headers['X-Upload-Content-Type'] });
      return response(200, '', { Location: `https://drive.mock/session/${id}` });
    }
    if (url.startsWith('https://drive.mock/session/') && method === 'put') {
      const session = sessions.get(url.split('/').pop());
      if (!session) return response(404, 'gone');
      if (failures.nextPut.length) return response(failures.nextPut.shift(), 'injected failure');
      const range = opts.headers['Content-Range'];
      const done = () => {
        const fileId = newId('file');
        files.set(fileId, { ...session.meta, bytes: session.bytes });
        session.file = { id: fileId, name: session.meta.name, size: String(session.total), mimeType: session.mime, webViewLink: `https://drive.google.com/file/d/${fileId}/view` };
        return response(200, session.file);
      };
      const partial = () => response(308, '', session.bytes.length ? { Range: `bytes=0-${session.bytes.length - 1}` } : {});
      if (session.file) return response(200, session.file);
      let m = /^bytes \*\/(\d+)$/.exec(range);
      if (m) return session.bytes.length === session.total ? done() : partial();
      m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (!m) return response(400, 'bad range');
      const start = Number(m[1]);
      const end = Number(m[2]);
      if (start > session.bytes.length) return response(400, 'gap');
      const chunk = toBuffer(opts.payload.bytes);
      if (chunk.length !== end - start + 1) return response(400, 'length mismatch');
      session.bytes = Buffer.concat([session.bytes.subarray(0, start), chunk]);
      return session.bytes.length === session.total ? done() : partial();
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  }

  const services = {
    console,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
        deleteProperty: (k) => { props.delete(k); },
        getProperties: () => Object.fromEntries(props)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => toSigned(crypto.createHash(alg).update(text, 'utf8').digest()),
      base64Decode: (s) => {
        if (!/^[A-Za-z0-9+/=\r\n]*$/.test(s)) throw new Error('Could not decode string.');
        return toSigned(Buffer.from(s, 'base64'));
      },
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d) => d.toISOString().slice(0, 10)
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } })
    },
    ScriptApp: { getOAuthToken: () => 'oauth-token' },
    Session: { getScriptTimeZone: () => 'Asia/Singapore' },
    DriveApp: {
      createFolder: (name) => makeFolder(name),
      getFolderById: (id) => { const f = folders.get(id); if (!f) throw new Error('No folder'); return f; },
      getFileById: () => ({ moveTo() {} })
    },
    SpreadsheetApp: {
      create: (name) => makeSpreadsheet(name),
      openById: (id) => { const s = spreadsheets.get(id); if (!s) throw new Error('No sheet'); return s; }
    },
    UrlFetchApp: { fetch }
  };

  const context = vm.createContext(services);
  const source = readFileSync(new URL('../apps-script/google-apps-script.gs', import.meta.url), 'utf8');
  vm.runInContext(source, context, { filename: 'google-apps-script.gs' });

  return {
    doPost(body) {
      const out = context.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
      return JSON.parse(out.text);
    },
    doGet() { return JSON.parse(context.doGet().text); },
    setup() { return context.setup(); },
    props, cache, files, sessions, spreadsheets, failures, members,
    folderName(id) { return folders.get(id).name; },
    folderOf(fileId) { const f = files.get(fileId); return f && folders.get(f.parentId); },
    folderPath(folderId) {
      const names = [];
      for (let f = folders.get(folderId); f; f = folders.get(f.parentId)) names.unshift(f.name);
      return names.join(' / ');
    },
    renameForTest(folderId, sheetId, folderName, sheetName) {
      folders.get(folderId).name = folderName;
      spreadsheets.get(sheetId).name = sheetName;
    },
    spreadsheetName(id) { return spreadsheets.get(id).name; },
    fileBytes(id) { return files.get(id).bytes; },
    sheetRows(tab) {
      const ss = spreadsheets.get(props.get('LOG_SHEET_ID'));
      const sheet = ss ? ss.getSheetByName(tab) : null;
      return sheet ? sheet.rows : [];
    }
  };
}

export function fakeToken(uid) {
  return `fake.${uid}.${'x'.repeat(120)}`;
}
