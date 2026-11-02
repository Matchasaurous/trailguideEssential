// Bodycam: one-touch start (front camera + local recording + live broadcast to
// dispatch in a single tap), camera preview (front-facing by default), local recording with
// MediaRecorder, live sharing of the camera track to the group over the WebRTC
// mesh, a persistent IndexedDB outbox, and resumable chunked upload to the
// Google Apps Script endpoint, which streams the clip into Google Drive.
import { ref, push, serverTimestamp } from 'firebase/database';
import { db, config } from './firebase.js';

export const CHUNK_BYTES = 4 * 1024 * 1024;          // multiple of 256 KiB (Drive resumable requirement)
export const MAX_RECORDING_SEC = 10 * 60;            // keeps clips well under the server size cap
const MAX_ATTEMPTS_PER_CHUNK = 4;
const VIDEO_BITRATE = 1_500_000;
const AUDIO_BITRATE = 64_000;

/* ---------------- IndexedDB outbox ---------------- */

const DB_NAME = 'trailguard';
const STORE = 'clips';
let dbPromise = null;

function openOutbox() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('gid', 'gid', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idb(mode, fn) {
  const database = await openOutbox();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; }, reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const outbox = {
  put: (clip) => idb('readwrite', (s) => reqToPromise(s.put(clip))),
  get: (id) => idb('readonly', (s) => reqToPromise(s.get(id))),
  delete: (id) => idb('readwrite', (s) => reqToPromise(s.delete(id))),
  byGroup: (gid) => idb('readonly', (s) => reqToPromise(s.index('gid').getAll(gid))),
  patch: async (id, changes) => {
    const clip = await outbox.get(id);
    if (!clip) return null;
    const next = { ...clip, ...changes };
    await outbox.put(next);
    return next;
  }
};

/* ---------------- Helpers ---------------- */

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4'
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function baseMime(mime) {
  return (mime || 'video/webm').split(';')[0].trim().toLowerCase();
}

function extensionFor(mime) {
  return baseMime(mime) === 'video/mp4' ? 'mp4' : 'webm';
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function safeName(text) {
  return String(text || 'user').normalize('NFKD').replace(/[^\w-]+/g, '_').replace(/_+/g, '_').slice(0, 30) || 'user';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class GasError extends Error {
  constructor(message, code, retryable) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * POST to the Apps Script web app. Content-Type text/plain keeps this a CORS
 * "simple request" (Apps Script cannot answer preflight OPTIONS requests), and
 * the auth token travels in the body for the same reason.
 */
async function callGas(payload) {
  if (!config.gasEndpoint) throw new GasError('Upload endpoint is not configured (VITE_GAS_ENDPOINT).', 'config', false);
  let res;
  try {
    res = await fetch(config.gasEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'omit'
    });
  } catch (err) {
    throw new GasError(`Network error: ${err.message}`, 'network', true);
  }
  if (!res.ok) throw new GasError(`Upload server returned HTTP ${res.status}`, 'http', res.status >= 500 || res.status === 429);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new GasError('Upload server returned an unreadable response. Check the Apps Script deployment access is "Anyone".', 'parse', true);
  }
  if (!body || body.ok !== true) {
    const code = (body && body.code) || 'server';
    throw new GasError((body && body.error) || 'Upload failed', code, code === 'busy' || code === 'drive_retry');
  }
  return body;
}

/* ---------------- Bodycam ---------------- */

export class Bodycam extends EventTarget {
  /**
   * Events: 'preview' {stream, mirrored}, 'recording' {active}, 'tick' {seconds},
   *         'clips' {clips}, 'live' {live}, 'progress' {id, sent, total}, 'error' {message}
   */
  constructor({ gid, groupName, uid, name, mesh, getIdToken, getPosition, setLivePresence }) {
    super();
    this.gid = gid;
    this.groupName = groupName;
    this.uid = uid;
    this.name = name;
    this.mesh = mesh;
    this.getIdToken = getIdToken;
    this.getPosition = getPosition;
    this.setLivePresence = setLivePresence;

    this.stream = null;
    this.facingMode = 'user';
    this.recorder = null;
    this.recordChunks = [];
    this.recordStartedAt = 0;
    this.tickTimer = null;
    this.live = false;
    this.uploading = new Set();
    this.mimeType = pickMimeType();
  }

  get isOpen() { return !!this.stream; }
  get isRecording() { return !!this.recorder && this.recorder.state === 'recording'; }

  async open() {
    if (this.stream) return this.stream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Camera access is not available in this browser.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: this.facingMode,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const video = this.stream.getVideoTracks()[0];
    if (video) {
      video.contentHint = 'motion';
      video.addEventListener('ended', () => this.dispatchEvent(new CustomEvent('error', { detail: { message: 'Camera stopped by the system.' } })));
    }
    this.emitPreview();
    return this.stream;
  }

  emitPreview() {
    this.dispatchEvent(new CustomEvent('preview', { detail: { stream: this.stream, mirrored: this.facingMode === 'user' } }));
  }

  async flip() {
    if (!this.stream) return;
    if (this.isRecording) throw new Error('Stop recording before switching camera.');
    const next = this.facingMode === 'user' ? 'environment' : 'user';
    const fresh = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { exact: next }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false
    }).catch(() => null);
    if (!fresh) throw new Error('This device has no other camera.');
    const newTrack = fresh.getVideoTracks()[0];
    newTrack.contentHint = 'motion';
    for (const old of this.stream.getVideoTracks()) {
      this.stream.removeTrack(old);
      old.stop();
    }
    this.stream.addTrack(newTrack);
    this.facingMode = next;
    if (this.live) await this.mesh.setLocalVideoTrack(newTrack);
    this.emitPreview();
  }

  startRecording() {
    if (!this.stream) throw new Error('Open the camera first.');
    if (this.isRecording) return;
    if (this.mimeType === null) throw new Error('Recording is not supported in this browser.');

    const options = { videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE };
    if (this.mimeType) options.mimeType = this.mimeType;
    this.recordChunks = [];
    this.recorder = new MediaRecorder(this.stream, options);
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.recordChunks.push(e.data); };
    this.recorder.onerror = (e) => {
      this.dispatchEvent(new CustomEvent('error', { detail: { message: `Recorder error: ${e.error ? e.error.message : 'unknown'}` } }));
    };
    this.recorder.start(1000);
    this.recordStartedAt = Date.now();
    this.dispatchEvent(new CustomEvent('recording', { detail: { active: true } }));

    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      const seconds = (Date.now() - this.recordStartedAt) / 1000;
      this.dispatchEvent(new CustomEvent('tick', { detail: { seconds } }));
      if (seconds >= MAX_RECORDING_SEC) {
        // Long shifts are recorded as back-to-back segments so each clip stays
        // small enough to upload; a new segment starts while the camera is on.
        this.stopRecording()
          .then(() => { if (this.stream && this.continuous) this.startRecording(); })
          .catch((err) => this.dispatchEvent(new CustomEvent('error', { detail: { message: err.message } })));
      }
    }, 500);
  }

  /** Stops recording and stores the clip in the outbox. Resolves with the clip record. */
  stopRecording() {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null);
    clearInterval(this.tickTimer);
    this.tickTimer = null;

    return new Promise((resolve, reject) => {
      recorder.addEventListener('stop', async () => {
        this.recorder = null;
        this.dispatchEvent(new CustomEvent('recording', { detail: { active: false } }));
        try {
          const mime = recorder.mimeType || this.mimeType || 'video/webm';
          const blob = new Blob(this.recordChunks, { type: baseMime(mime) });
          this.recordChunks = [];
          if (blob.size === 0) throw new Error('The recording was empty.');
          const startedAt = new Date(this.recordStartedAt);
          const position = this.getPosition ? this.getPosition() : null;
          const clip = {
            id: crypto.randomUUID(),
            gid: this.gid,
            groupName: this.groupName,
            uid: this.uid,
            blob,
            mime: baseMime(mime),
            size: blob.size,
            durationSec: Math.round((Date.now() - this.recordStartedAt) / 1000),
            recordedAt: startedAt.toISOString(),
            fileName: `bodycam_${stamp(startedAt)}_${safeName(this.name)}.${extensionFor(mime)}`,
            lat: position ? position.lat : null,
            lng: position ? position.lng : null,
            uploadId: null
          };
          await outbox.put(clip);
          if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
          await this.refreshClips();
          resolve(clip);
        } catch (err) {
          reject(err);
        }
      }, { once: true });
      try { recorder.requestData(); } catch { /* not recording */ }
      recorder.stop();
    });
  }

  async setLive(on) {
    if (on && !this.stream) await this.open();
    const track = on ? this.stream.getVideoTracks()[0] : null;
    await this.mesh.setLocalVideoTrack(track || null);
    this.live = !!(on && track);
    if (this.setLivePresence) await this.setLivePresence(this.live).catch(() => {});
    this.dispatchEvent(new CustomEvent('live', { detail: { live: this.live } }));
  }

  /**
   * One touch: front camera on, recording started, video broadcast to dispatch.
   * Safe to call again while running (it fills in whatever is not running).
   */
  async oneTouch() {
    if (!this.stream) {
      this.facingMode = 'user';
      await this.open();
    }
    this.continuous = true;
    if (!this.isRecording && this.mimeType !== null) this.startRecording();
    if (!this.live) await this.setLive(true);
    return { recording: this.isRecording, live: this.live };
  }

  get running() {
    return !!this.stream;
  }

  async close() {
    this.continuous = false;
    let saved = null;
    if (this.isRecording) saved = await this.stopRecording().catch(() => null);
    if (this.live) await this.setLive(false);
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.dispatchEvent(new CustomEvent('preview', { detail: { stream: null, mirrored: false } }));
    return saved;
  }

  async listClips() {
    try {
      const clips = await outbox.byGroup(this.gid);
      return clips.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    } catch {
      return [];
    }
  }

  async refreshClips() {
    const clips = await this.listClips();
    this.dispatchEvent(new CustomEvent('clips', { detail: { clips } }));
    return clips;
  }

  async deleteClip(id) {
    if (this.uploading.has(id)) throw new Error('This clip is uploading.');
    await outbox.delete(id);
    await this.refreshClips();
  }

  /** Resumable upload of one outbox clip to Google Drive via Apps Script. */
  async uploadClip(id) {
    if (this.uploading.has(id)) return null;
    this.uploading.add(id);
    try {
      let clip = await outbox.get(id);
      if (!clip) throw new Error('Clip not found.');
      const total = clip.size;
      const progress = (sent) => this.dispatchEvent(new CustomEvent('progress', { detail: { id, sent, total } }));

      let offset = 0;
      if (clip.uploadId) {
        const status = await this.queryStatus(clip).catch(() => null);
        if (status && status.done) return await this.finishUpload(clip, status.file);
        if (status && Number.isFinite(status.nextOffset)) offset = status.nextOffset;
        else clip = await outbox.patch(id, { uploadId: null });
      }
      if (!clip.uploadId) {
        const init = await callGas({
          action: 'init',
          idToken: await this.getIdToken(),
          groupId: this.gid,
          groupName: this.groupName,
          fileName: clip.fileName,
          mimeType: clip.mime,
          size: clip.size,
          durationSec: clip.durationSec,
          recordedAt: clip.recordedAt,
          lat: clip.lat,
          lng: clip.lng
        });
        clip = await outbox.patch(id, { uploadId: init.uploadId });
        offset = 0;
      }
      progress(offset);

      let stalls = 0;
      while (offset < total) {
        const end = Math.min(offset + CHUNK_BYTES, total);
        const data = await blobToBase64(clip.blob.slice(offset, end));
        let result = null;
        for (let attempt = 1; ; attempt++) {
          try {
            result = await callGas({
              action: 'chunk',
              idToken: await this.getIdToken(),
              groupId: this.gid,
              uploadId: clip.uploadId,
              offset,
              data
            });
            break;
          } catch (err) {
            if (!err.retryable || attempt >= MAX_ATTEMPTS_PER_CHUNK) throw err;
            await sleep(1000 * 2 ** (attempt - 1));
            // The previous request may have been applied even though we saw an error.
            const status = await this.queryStatus(clip).catch(() => null);
            if (status && status.done) return await this.finishUpload(clip, status.file);
            if (status && Number.isFinite(status.nextOffset) && status.nextOffset !== offset) {
              result = { done: false, nextOffset: status.nextOffset };
              break;
            }
          }
        }
        if (result.done) return await this.finishUpload(clip, result.file);
        const next = Number(result.nextOffset);
        if (!Number.isFinite(next) || next < 0 || next > total) {
          throw new Error('Upload server reported an invalid offset.');
        }
        stalls = next === offset ? stalls + 1 : 0;
        if (stalls > 3) throw new Error('Upload is not making progress. Try again later.');
        offset = next;
        progress(offset);
      }
      // All bytes sent but no completion seen: ask once more.
      const status = await this.queryStatus(clip);
      if (status && status.done) return await this.finishUpload(clip, status.file);
      throw new Error('Upload did not complete. Try again.');
    } catch (err) {
      if (err && err.code === 'unknown_upload') await outbox.patch(id, { uploadId: null }).catch(() => {});
      throw err;
    } finally {
      this.uploading.delete(id);
    }
  }

  async queryStatus(clip) {
    return callGas({
      action: 'status',
      idToken: await this.getIdToken(),
      groupId: this.gid,
      uploadId: clip.uploadId
    });
  }

  async finishUpload(clip, file) {
    const entry = {
      uid: this.uid,
      name: this.name,
      fileId: String(file && file.id ? file.id : ''),
      fileName: clip.fileName,
      size: clip.size,
      durationSec: clip.durationSec || 0,
      ts: serverTimestamp()
    };
    if (file && file.url) entry.url = String(file.url).slice(0, 500);
    await push(ref(db, `uploads/${this.gid}`), entry).catch((err) => console.warn('Archive log write failed', err));
    await outbox.delete(clip.id);
    this.dispatchEvent(new CustomEvent('progress', { detail: { id: clip.id, sent: clip.size, total: clip.size } }));
    await this.refreshClips();
    return file;
  }

  /** Append a structured case event (created / updated / closed / SOS…) to the Cases log tab. */
  async sendCase(event, inc) {
    const responders = Object.values(inc.assigned || {}).map((a) => `${a.name} (${a.state})`).join(', ');
    return callGas({
      action: 'case',
      idToken: await this.getIdToken(),
      groupId: this.gid,
      groupName: this.groupName,
      event,
      caseId: inc.id,
      type: inc.type,
      priority: inc.priority,
      status: inc.state,
      title: inc.title,
      description: inc.notes || '',
      lat: Number.isFinite(inc.lat) ? inc.lat : null,
      lng: Number.isFinite(inc.lng) ? inc.lng : null,
      reportedBy: inc.createdByName || '',
      responders
    });
  }

  /** Archive a full-quality case photo (JPEG data URL) to Drive. Resolves with {id, url}. */
  async sendPhoto(caseId, dataUrl, fileName) {
    const data = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
    const result = await callGas({
      action: 'photo',
      idToken: await this.getIdToken(),
      groupId: this.gid,
      groupName: this.groupName,
      caseId,
      mimeType: 'image/jpeg',
      fileName,
      data
    });
    return result.file;
  }

  /**
   * Archive a patient care record to the restricted Patient Records folder in Drive
   * (medical responders and dispatchers only — the script checks). record: the
   * {info, vitals, treatments, meds} tree; soap: the handover text. Resolves {id, url}.
   */
  async sendEpcr({ caseId, patientId, caseTitle, record, soap }) {
    const result = await callGas({
      action: 'epcr',
      idToken: await this.getIdToken(),
      groupId: this.gid,
      groupName: this.groupName,
      caseId,
      patientId,
      caseTitle: String(caseTitle || '').slice(0, 80),
      record: JSON.stringify(record).slice(0, 200000),
      soap: String(soap || '').slice(0, 20000)
    });
    return result.file;
  }

  /** Save an after-action report (PDF or CSV Blob) to the group's Reports folder in Drive (dispatchers). */
  async sendReport(blob, fileName) {
    const mimeType = blob.type === 'application/pdf' ? 'application/pdf' : 'text/csv';
    const result = await callGas({
      action: 'report',
      idToken: await this.getIdToken(),
      groupId: this.gid,
      groupName: this.groupName,
      fileName,
      mimeType,
      data: await blobToBase64(blob)
    });
    return result.file;
  }

  /** Log a broadcast announcement to the Announcements tab. */
  async sendAnnouncement(a) {
    return callGas({
      action: 'announcement',
      idToken: await this.getIdToken(),
      groupId: this.gid,
      groupName: this.groupName,
      announcementId: a.id,
      level: a.level,
      audience: a.audience,
      kind: a.kind,
      text: a.text,
      caseId: a.caseId || '',
      lat: Number.isFinite(a.lat) ? a.lat : null,
      lng: Number.isFinite(a.lng) ? a.lng : null
    });
  }

  /** Send a text field note (with current position) to the Apps Script log sheet. */
  async sendIncident(text, at) {
    const note = String(text || '').trim();
    if (!note) throw new Error('Write a note first.');
    const position = at || (this.getPosition ? this.getPosition() : null);
    return callGas({
      action: 'incident',
      idToken: await this.getIdToken(),
      groupId: this.gid,
      groupName: this.groupName,
      text: note.slice(0, 2000),
      lat: position ? position.lat : null,
      lng: position ? position.lng : null,
      acc: position ? position.acc : null,
      clientTime: new Date().toISOString()
    });
  }
}
