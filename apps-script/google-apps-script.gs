/**
 * Trailguard Essentials — Google Apps Script archive endpoint.
 *
 * Receives bodycam clips, case and incident logs, case photos, patient care records
 * (ePCR), broadcast announcements and after-action reports from the Trailguard
 * Essentials app and stores them in the deploying account's Google Drive (Google
 * One storage), with a log spreadsheet.
 *
 * Patient records go to a separate "Patient Records (restricted)" folder that is
 * never shared by this script; only medical responders and dispatchers may save
 * them, and the log sheet keeps only non-clinical fields (no vitals, no patient
 * identifiers). Share that folder with as few people as your data-protection
 * rules (e.g. Singapore PDPA) allow.
 *
 * Video upload is resumable and chunked: the app sends 4 MiB base64 chunks, and
 * this script forwards each chunk to a Google Drive resumable-upload session. The
 * clip is assembled by Drive, never in Apps Script memory, so large clips do not
 * hit the script's memory or payload limits, and an interrupted upload resumes
 * from the last byte Drive committed.
 *
 * Security: every request carries the caller's Firebase ID token. The script
 *   1) verifies the token with Firebase Auth (accounts:lookup), and
 *   2) confirms group membership by reading /groups/{gid}/members/{uid} from the
 *      Realtime Database *as that user* — the database rules only allow members.
 * Upload sessions are bound to the uid and group that created them.
 *
 * Setup (see README):
 *   Project Settings → Script properties:
 *     FIREBASE_API_KEY   Firebase Web API key (Identity Toolkit API must be allowed)
 *     FIREBASE_DB_URL    https://<db>.firebasedatabase.app  (no trailing slash)
 *     MAX_UPLOAD_MB      optional, default 300
 *   Run setup() once from the editor, then Deploy → New deployment → Web app,
 *   Execute as: Me, Who has access: Anyone. Use the /exec URL in VITE_GAS_ENDPOINT.
 */

/* ============================== Constants ============================== */

var ROOT_FOLDER_NAME = 'Trailguard Essentials Archive';
var LOG_SPREADSHEET_NAME = 'Trailguard Essentials Log';
var CHUNK_ALIGN = 262144;                      // Drive requires 256 KiB multiples except the last chunk
var MAX_CHUNK_BYTES = 16 * 1024 * 1024;
var DEFAULT_MAX_UPLOAD_MB = 300;
var AUTH_CACHE_SECONDS = 120;                  // membership revocations take effect within 2 min
var DONE_CACHE_SECONDS = 21600;
var UPLOAD_RECORD_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
var RATE_WINDOW_SECONDS = 600;
var RATE_MAX_REQUESTS = 900;                   // per user per 10 min (~3.6 GB of chunks)
var ALLOWED_MIME = {
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv'
};
var UPLOAD_HEADERS = ['Received', 'Group ID', 'Group', 'User ID', 'Name', 'Email', 'File name',
  'Size (bytes)', 'Duration (s)', 'Recorded at', 'Latitude', 'Longitude', 'Map', 'Drive file ID', 'Drive link'];
var INCIDENT_HEADERS = ['Received', 'Device time', 'Group ID', 'Group', 'User ID', 'Name', 'Email',
  'Note', 'Latitude', 'Longitude', 'Accuracy (m)', 'Map'];
var CASE_HEADERS = ['Received', 'Event', 'Case ID', 'Group ID', 'Group', 'Type', 'Severity', 'Status', 'Title',
  'Description', 'Latitude', 'Longitude', 'Map', 'Reported by', 'Logged by', 'Logged by email', 'Responders'];
var CASE_EVENTS = {
  created: 1, reported: 1, verified: 1, rejected: 1, withdrawn: 1, assigned: 1, accepted: 1,
  updated: 1, closed: 1, reopened: 1, sos: 1, sos_cancelled: 1
};
var CASE_TYPES = {
  sos: 1, medical_minor: 1, medical_major: 1, cardiac: 1, crowd: 1, security: 1, lost: 1, fire: 1, transport: 1, other: 1,
  medical: 1, welfare: 1, traffic: 1
};
var CASE_STATUS = { pending: 1, open: 1, monitoring: 1, closed: 1, rejected: 1 };
var MAX_PHOTO_BYTES = 5 * 1024 * 1024;
var PHOTO_HEADERS = ['Received', 'Group ID', 'Group', 'Case ID', 'User ID', 'Name', 'Email', 'File name', 'Size (bytes)',
  'Drive file ID', 'Drive link'];
var SEVERITY_LABELS = { 1: 'P1 Critical', 2: 'P2 Urgent', 3: 'P3 Routine' };
var CASE_TYPE_LABELS = {
  sos: 'SOS', medical_minor: 'Minor medical', medical_major: 'Major medical / trauma', crowd: 'Crowd control',
  security: 'Security incident', lost: 'Lost person / welfare', fire: 'Fire / hazard', other: 'Other',
  cardiac: 'Cardiac arrest / collapse', transport: 'Patient transport',
  medical: 'Medical', welfare: 'Welfare check', traffic: 'Traffic / road'
};
var PATIENT_FOLDER_NAME = 'Patient Records (restricted)';
var PATIENT_HEADERS = ['Saved', 'Group ID', 'Group', 'Case ID', 'Patient record ID', 'Saved by (uid)', 'Saved by', 'Email',
  'Disposition', 'Triage', 'Record status', 'Drive file ID'];
var MAX_EPCR_CHARS = 200000;
var MAX_SOAP_CHARS = 20000;
var DISPOSITIONS = { released: 1, transported: 1, handover: 1, refused: 1, other: 1 };
var TRIAGE = { red: 1, yellow: 1, green: 1, black: 1 };
var REPORT_HEADERS = ['Saved', 'Group ID', 'Group', 'User ID', 'Name', 'Email', 'File name', 'Type', 'Size (bytes)', 'Drive file ID', 'Drive link'];
var MAX_REPORT_BYTES = 10 * 1024 * 1024;
var ANNOUNCEMENT_HEADERS = ['Received', 'Group ID', 'Group', 'Announcement ID', 'Level', 'Audience', 'Kind', 'Text',
  'Case ID', 'Latitude', 'Longitude', 'Map', 'Sent by (uid)', 'Sent by', 'Email'];
var ANNOUNCE_LEVELS = { info: 1, urgent: 1, critical: 1 };
var ANNOUNCE_AUDIENCES = { all: 1, security: 1, medical: 1, fire: 1, usher: 1, dispatch: 1 };
var FIELD_ROLES = { security: 1, medical: 1, fire: 1, usher: 1 };

/* ============================== Errors & responses ============================== */

function AppError(message, code) {
  this.name = 'AppError';
  this.message = message;
  this.code = code || 'bad_request';
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================== Entry points ============================== */

function doGet() {
  return json_({ ok: true, service: 'trailguard-archive', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    var action = String(body.action || '');
    if (action === 'ping') return json_({ ok: true, time: new Date().toISOString() });

    var groupId = validateGroupId_(body.groupId);
    var caller = authenticate_(body.idToken, groupId);
    rateLimit_(caller.uid);

    switch (action) {
      case 'init': return json_(handleInit_(body, caller, groupId));
      case 'chunk': return json_(handleChunk_(body, caller, groupId));
      case 'status': return json_(handleStatus_(body, caller, groupId));
      case 'incident': return json_(handleIncident_(body, caller, groupId));
      case 'case': return json_(handleCase_(body, caller, groupId));
      case 'photo': return json_(handlePhoto_(body, caller, groupId));
      case 'epcr': return json_(handleEpcr_(body, caller, groupId));
      case 'report': return json_(handleReport_(body, caller, groupId));
      case 'announcement': return json_(handleAnnouncement_(body, caller, groupId));
      default: throw new AppError('Unknown action.', 'bad_request');
    }
  } catch (err) {
    if (err instanceof AppError) return json_({ ok: false, error: err.message, code: err.code });
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'Server error: ' + (err && err.message ? err.message : String(err)), code: 'server' });
  }
}

/* ============================== Request parsing ============================== */

function parseBody_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string' || e.postData.contents.length === 0) {
    throw new AppError('Empty request.', 'bad_request');
  }
  try {
    var parsed = JSON.parse(e.postData.contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (err) {
    throw new AppError('Request body must be JSON.', 'bad_request');
  }
}

function validateGroupId_(groupId) {
  var gid = String(groupId || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(gid)) throw new AppError('Invalid group id.', 'bad_request');
  return gid;
}

function validateUploadId_(uploadId) {
  var id = String(uploadId || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('Invalid upload id.', 'bad_request');
  return id.toLowerCase();
}

function toInt_(value, name) {
  var n = Number(value);
  if (!isFinite(n) || Math.floor(n) !== n || n < 0) throw new AppError('Invalid ' + name + '.', 'bad_request');
  return n;
}

function optionalNumber_(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  var n = Number(value);
  return isFinite(n) && n >= min && n <= max ? n : null;
}

function cleanText_(value, maxLen) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

/** Prevent spreadsheet formula injection from user-supplied text. */
function sheetSafe_(value) {
  var text = String(value === null || value === undefined ? '' : value);
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}

function safeFileName_(name, ext) {
  var base = String(name || 'clip').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  base = base.replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '').slice(0, 100) || 'clip';
  return base + '.' + ext;
}

function safeFolderName_(name) {
  return cleanText_(name, 60).replace(/[\/\\:*?"<>|]+/g, ' ').trim() || 'Group';
}

/* ============================== Config ============================== */

function props_() {
  return PropertiesService.getScriptProperties();
}

function requireProp_(key) {
  var value = props_().getProperty(key);
  if (!value) throw new AppError('Server not configured: script property ' + key + ' is missing.', 'config');
  return value.trim();
}

function maxUploadBytes_() {
  var mb = Number(props_().getProperty('MAX_UPLOAD_MB'));
  return Math.floor((isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024);
}

function dbUrl_() {
  return requireProp_('FIREBASE_DB_URL').replace(/\/+$/, '');
}

/* ============================== Authentication ============================== */

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/**
 * Verifies the Firebase ID token and group membership. Returns {uid, email, name, role, unit}:
 * role is owner | dispatcher | member, unit the member's field role (security, medical, fire, usher) or ''.
 */
function authenticate_(idToken, groupId) {
  var token = String(idToken || '');
  if (token.length < 100 || token.length > 8000 || token.split('.').length !== 3) {
    throw new AppError('Sign in again.', 'unauthenticated');
  }
  var cache = CacheService.getScriptCache();
  var cacheKey = 'auth:' + sha256Hex_(token + '|' + groupId);
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // 1) Token → user (Firebase verifies signature, expiry and revocation state).
  var lookup = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(requireProp_('FIREBASE_API_KEY')),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: token }), muteHttpExceptions: true }
  );
  var lookupCode = lookup.getResponseCode();
  if (lookupCode === 400) throw new AppError('Your session expired. Sign in again.', 'unauthenticated');
  if (lookupCode === 403) throw new AppError('Server API key is restricted; allow the Identity Toolkit API for it.', 'config');
  if (lookupCode !== 200) throw new AppError('Could not verify sign-in (HTTP ' + lookupCode + ').', 'busy');
  var users = (JSON.parse(lookup.getContentText()) || {}).users || [];
  var user = users[0];
  if (!user || !user.localId) throw new AppError('Sign in again.', 'unauthenticated');
  if (user.disabled) throw new AppError('This account is disabled.', 'forbidden');

  // 2) Membership, read with the user's own credentials so database rules decide.
  var memberUrl = dbUrl_() + '/groups/' + groupId + '/members/' + encodeURIComponent(user.localId) +
    '.json?auth=' + encodeURIComponent(token);
  var member = UrlFetchApp.fetch(memberUrl, { method: 'get', muteHttpExceptions: true });
  var memberCode = member.getResponseCode();
  if (memberCode === 401 || memberCode === 403) throw new AppError('You are not a member of this group.', 'forbidden');
  if (memberCode !== 200) throw new AppError('Could not verify group membership (HTTP ' + memberCode + ').', 'busy');
  var record = JSON.parse(member.getContentText());
  if (!record) throw new AppError('You are not a member of this group.', 'forbidden');

  var caller = {
    uid: user.localId,
    email: user.email || '',
    name: cleanText_(record.name || user.displayName || 'Member', 40),
    role: record.role === 'owner' || record.role === 'dispatcher' ? record.role : 'member',
    unit: FIELD_ROLES[record.unit] ? record.unit : ''
  };
  cache.put(cacheKey, JSON.stringify(caller), AUTH_CACHE_SECONDS);
  return caller;
}

function rateLimit_(uid) {
  var cache = CacheService.getScriptCache();
  var bucket = Math.floor(Date.now() / (RATE_WINDOW_SECONDS * 1000));
  var key = 'rl:' + uid + ':' + bucket;
  var count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), RATE_WINDOW_SECONDS + 60);
  if (count > RATE_MAX_REQUESTS) throw new AppError('Too many requests. Wait a few minutes.', 'rate_limited');
}

/* ============================== Drive helpers ============================== */

function getRootFolder_() {
  var props = props_();
  var id = props.getProperty('ROOT_FOLDER_ID');
  if (id) {
    try {
      var existing = DriveApp.getFolderById(id);
      if (!existing.isTrashed()) {
        // Folders created before the Trailguard Essentials rename keep their contents.
        if (existing.getName() !== ROOT_FOLDER_NAME) existing.setName(ROOT_FOLDER_NAME);
        return existing;
      }
    } catch (err) { /* deleted or inaccessible: recreate */ }
  }
  var folder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  folder.setDescription('Bodycam clips and incident logs from Trailguard Essentials. Created by the archive script.');
  props.setProperty('ROOT_FOLDER_ID', folder.getId());
  return folder;
}

function childFolder_(parent, name, matcher) {
  var it = parent.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    if (!f.isTrashed() && matcher(f.getName())) return f;
  }
  return parent.createFolder(name);
}

/** Root / <Group name> [<gid>] / <yyyy-MM-dd> — created under a lock to avoid duplicates. */
function getTargetFolder_(groupId, groupName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var root = getRootFolder_();
    var suffix = '[' + groupId + ']';
    var groupFolder = childFolder_(root, safeFolderName_(groupName) + ' ' + suffix, function (n) {
      return n.slice(-suffix.length) === suffix;
    });
    var day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    return childFolder_(groupFolder, day, function (n) { return n === day; });
  } finally {
    lock.releaseLock();
  }
}

function header_(response, name) {
  var headers = response.getAllHeaders();
  var wanted = name.toLowerCase();
  for (var key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === wanted) {
      var value = headers[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

/* ============================== Upload records ============================== */

function saveUpload_(uploadId, record) {
  props_().setProperty('up_' + uploadId, JSON.stringify(record));
}

function deleteUpload_(uploadId) {
  props_().deleteProperty('up_' + uploadId);
}

function loadUpload_(uploadId, caller, groupId) {
  var done = CacheService.getScriptCache().get('done:' + uploadId);
  if (done) {
    var finished = JSON.parse(done);
    if (finished.uid !== caller.uid || finished.groupId !== groupId) throw new AppError('Upload not found.', 'unknown_upload');
    return { done: true, file: finished.file };
  }
  var raw = props_().getProperty('up_' + uploadId);
  if (!raw) throw new AppError('Upload session expired. It will restart.', 'unknown_upload');
  var record = JSON.parse(raw);
  if (record.uid !== caller.uid || record.groupId !== groupId) throw new AppError('Upload not found.', 'unknown_upload');
  return record;
}

function purgeStaleUploads_() {
  var props = props_();
  var all = props.getProperties();
  var now = Date.now();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf('up_') !== 0) return;
    try {
      var rec = JSON.parse(all[key]);
      if (!rec.createdAt || now - rec.createdAt > UPLOAD_RECORD_MAX_AGE_MS) props.deleteProperty(key);
    } catch (err) {
      props.deleteProperty(key);
    }
  });
}

/* ============================== Actions ============================== */

function handleInit_(body, caller, groupId) {
  var mime = String(body.mimeType || '').split(';')[0].trim().toLowerCase();
  var ext = ALLOWED_MIME[mime];
  if (!ext) throw new AppError('Unsupported video type: ' + mime, 'bad_request');
  var size = toInt_(body.size, 'size');
  if (size <= 0) throw new AppError('Empty file.', 'bad_request');
  if (size > maxUploadBytes_()) throw new AppError('Clip is larger than the server limit.', 'too_large');

  var groupName = cleanText_(body.groupName, 60);
  var fileName = safeFileName_(body.fileName, ext);
  var recordedAt = cleanText_(body.recordedAt, 40);
  var durationSec = optionalNumber_(body.durationSec, 0, 86400);
  var lat = optionalNumber_(body.lat, -90, 90);
  var lng = optionalNumber_(body.lng, -180, 180);

  purgeStaleUploads_();
  var folder = getTargetFolder_(groupId, groupName);

  var metadata = {
    name: fileName,
    mimeType: mime,
    parents: [folder.getId()],
    description: [
      'Trailguard Essentials bodycam clip',
      'Group: ' + (groupName || groupId) + ' (' + groupId + ')',
      'Recorded by: ' + caller.name + ' <' + caller.email + '> (' + caller.uid + ')',
      'Recorded at: ' + (recordedAt || 'unknown'),
      lat !== null && lng !== null ? 'Location: ' + lat + ',' + lng : 'Location: unknown'
    ].join('\n'),
    appProperties: {
      trailguardUid: caller.uid.slice(0, 60),
      trailguardGroup: groupId
    }
  };

  var response = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,mimeType,webViewLink',
    {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(size)
      },
      payload: JSON.stringify(metadata),
      muteHttpExceptions: true
    }
  );
  var code = response.getResponseCode();
  var location = header_(response, 'Location');
  if (code !== 200 || !location) {
    console.error('Drive session error', code, response.getContentText());
    if (code === 403 && /storageQuotaExceeded/i.test(response.getContentText())) {
      throw new AppError('Google Drive storage is full.', 'quota');
    }
    throw new AppError('Google Drive refused the upload (HTTP ' + code + ').', code >= 500 ? 'drive_retry' : 'drive');
  }

  var uploadId = Utilities.getUuid().toLowerCase();
  saveUpload_(uploadId, {
    loc: location,
    uid: caller.uid,
    name: caller.name,
    email: caller.email,
    groupId: groupId,
    groupName: groupName,
    fileName: fileName,
    mime: mime,
    size: size,
    durationSec: durationSec,
    recordedAt: recordedAt,
    lat: lat,
    lng: lng,
    createdAt: Date.now()
  });
  return { ok: true, uploadId: uploadId, chunkSize: CHUNK_ALIGN * 16, folder: folder.getName() };
}

function handleChunk_(body, caller, groupId) {
  var uploadId = validateUploadId_(body.uploadId);
  var record = loadUpload_(uploadId, caller, groupId);
  if (record.done) return { ok: true, done: true, file: record.file };

  var offset = toInt_(body.offset, 'offset');
  if (typeof body.data !== 'string' || body.data.length === 0) throw new AppError('Missing chunk data.', 'bad_request');
  var bytes;
  try {
    bytes = Utilities.base64Decode(body.data);
  } catch (err) {
    throw new AppError('Chunk is not valid base64.', 'bad_request');
  }
  var length = bytes.length;
  if (length === 0 || length > MAX_CHUNK_BYTES) throw new AppError('Invalid chunk size.', 'bad_request');
  var end = offset + length - 1;
  if (end >= record.size) throw new AppError('Chunk exceeds the declared file size.', 'bad_request');
  if (end + 1 < record.size && length % CHUNK_ALIGN !== 0) {
    throw new AppError('Chunks must be multiples of 256 KiB except the last.', 'bad_request');
  }

  var response = UrlFetchApp.fetch(record.loc, {
    method: 'put',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Range': 'bytes ' + offset + '-' + end + '/' + record.size
    },
    payload: Utilities.newBlob(bytes, record.mime),
    muteHttpExceptions: true,
    followRedirects: false // Drive answers 308 "Resume Incomplete"; it is not a redirect
  });
  return interpretDriveResponse_(response, uploadId, record);
}

function handleStatus_(body, caller, groupId) {
  var uploadId = validateUploadId_(body.uploadId);
  var record = loadUpload_(uploadId, caller, groupId);
  if (record.done) return { ok: true, done: true, file: record.file };

  var response = UrlFetchApp.fetch(record.loc, {
    method: 'put',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Range': 'bytes */' + record.size
    },
    payload: '',
    muteHttpExceptions: true,
    followRedirects: false // Drive answers 308 "Resume Incomplete"; it is not a redirect
  });
  return interpretDriveResponse_(response, uploadId, record);
}

function interpretDriveResponse_(response, uploadId, record) {
  var code = response.getResponseCode();
  if (code === 308) {
    var range = header_(response, 'Range'); // e.g. "bytes=0-4194303"
    var match = range ? /bytes=\d+-(\d+)/.exec(range) : null;
    return { ok: true, done: false, nextOffset: match ? Number(match[1]) + 1 : 0 };
  }
  if (code === 200 || code === 201) {
    var file = JSON.parse(response.getContentText());
    return { ok: true, done: true, file: finalizeUpload_(uploadId, record, file) };
  }
  if (code === 404 || code === 410) {
    deleteUpload_(uploadId);
    throw new AppError('Upload session expired. It will restart.', 'unknown_upload');
  }
  console.error('Drive chunk error', code, response.getContentText());
  if (code >= 500 || code === 429) throw new AppError('Google Drive is busy. Retrying…', 'drive_retry');
  if (code === 403 && /storageQuotaExceeded/i.test(response.getContentText())) {
    throw new AppError('Google Drive storage is full.', 'quota');
  }
  throw new AppError('Google Drive rejected the chunk (HTTP ' + code + ').', 'drive');
}

function finalizeUpload_(uploadId, record, driveFile) {
  var file = {
    id: driveFile.id,
    name: driveFile.name,
    size: Number(driveFile.size || record.size),
    url: driveFile.webViewLink || ('https://drive.google.com/file/d/' + driveFile.id + '/view')
  };
  CacheService.getScriptCache().put('done:' + uploadId,
    JSON.stringify({ uid: record.uid, groupId: record.groupId, file: file }), DONE_CACHE_SECONDS);
  deleteUpload_(uploadId);

  try {
    var sheet = getLogSheet_('Uploads', UPLOAD_HEADERS);
    var map = record.lat !== null && record.lng !== null
      ? 'https://www.google.com/maps?q=' + record.lat + ',' + record.lng : '';
    sheet.appendRow([
      new Date(), record.groupId, sheetSafe_(record.groupName), record.uid, sheetSafe_(record.name),
      sheetSafe_(record.email), record.fileName, file.size, record.durationSec, sheetSafe_(record.recordedAt),
      record.lat, record.lng, map, file.id, file.url
    ]);
  } catch (err) {
    console.error('Upload log failed (file is saved):', err);
  }
  return file;
}

function handleIncident_(body, caller, groupId) {
  var text = cleanText_(body.text, 2000);
  if (!text) throw new AppError('Incident note is empty.', 'bad_request');
  var lat = optionalNumber_(body.lat, -90, 90);
  var lng = optionalNumber_(body.lng, -180, 180);
  var acc = optionalNumber_(body.acc, 0, 100000);
  var map = lat !== null && lng !== null ? 'https://www.google.com/maps?q=' + lat + ',' + lng : '';

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getLogSheet_('Incidents', INCIDENT_HEADERS);
    sheet.appendRow([
      new Date(), sheetSafe_(cleanText_(body.clientTime, 40)), groupId, sheetSafe_(cleanText_(body.groupName, 60)),
      caller.uid, sheetSafe_(caller.name), sheetSafe_(caller.email), sheetSafe_(text),
      lat, lng, acc === null ? '' : Math.round(acc), map
    ]);
    return { ok: true, row: sheet.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Structured case log: one row per case event (created, updated, closed, SOS…),
 * so the Cases tab is an append-only audit trail of every case.
 */
function handleCase_(body, caller, groupId) {
  var event = String(body.event || '');
  if (!CASE_EVENTS[event]) throw new AppError('Unknown case event.', 'bad_request');
  var caseId = String(body.caseId || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new AppError('Invalid case id.', 'bad_request');
  var type = String(body.type || '');
  if (!CASE_TYPES[type]) throw new AppError('Invalid case type.', 'bad_request');
  var status = String(body.status || 'open');
  if (!CASE_STATUS[status]) throw new AppError('Invalid case status.', 'bad_request');
  var priority = Number(body.priority);
  var severity = SEVERITY_LABELS[priority] || '';
  var title = cleanText_(body.title, 80);
  if (!title) throw new AppError('Case title is empty.', 'bad_request');
  var lat = optionalNumber_(body.lat, -90, 90);
  var lng = optionalNumber_(body.lng, -180, 180);
  var map = lat !== null && lng !== null ? 'https://www.google.com/maps?q=' + lat + ',' + lng : '';

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getLogSheet_('Cases', CASE_HEADERS);
    sheet.appendRow([
      new Date(), event, caseId, groupId, sheetSafe_(cleanText_(body.groupName, 60)), CASE_TYPE_LABELS[type], severity, status,
      sheetSafe_(title), sheetSafe_(cleanText_(body.description, 1000)), lat, lng, map,
      sheetSafe_(cleanText_(body.reportedBy, 40)), caller.uid + ' ' + sheetSafe_(caller.name), sheetSafe_(caller.email),
      sheetSafe_(cleanText_(body.responders, 400))
    ]);
    return { ok: true, row: sheet.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Archive one report / case photo (JPEG, ≤ 5 MB) to
 * Root / <Group> [gid] / <date> / Case <caseId>/ and log it on the Photos tab.
 * The app keeps a smaller copy in the database for instant review; this is the
 * full-quality record.
 */
function handlePhoto_(body, caller, groupId) {
  var caseId = String(body.caseId || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(caseId)) throw new AppError('Invalid case id.', 'bad_request');
  var mime = String(body.mimeType || '').toLowerCase();
  if (mime !== 'image/jpeg') throw new AppError('Photos must be JPEG.', 'bad_request');
  if (typeof body.data !== 'string' || body.data.length === 0) throw new AppError('Missing photo data.', 'bad_request');
  var bytes;
  try {
    bytes = Utilities.base64Decode(body.data);
  } catch (err) {
    throw new AppError('Photo is not valid base64.', 'bad_request');
  }
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw new AppError('Photo is empty or larger than 5 MB.', 'too_large');
  // JPEG files start with FF D8 FF.
  if ((bytes[0] & 0xff) !== 0xff || (bytes[1] & 0xff) !== 0xd8 || (bytes[2] & 0xff) !== 0xff) {
    throw new AppError('File is not a JPEG image.', 'bad_request');
  }

  var dayFolder = getTargetFolder_(groupId, cleanText_(body.groupName, 60));
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var caseFolder;
  try {
    var name = 'Case ' + caseId;
    caseFolder = childFolder_(dayFolder, name, function (n) { return n === name; });
  } finally {
    lock.releaseLock();
  }
  var fileName = safeFileName_(body.fileName || ('photo_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss')), 'jpg');
  var file = caseFolder.createFile(Utilities.newBlob(bytes, 'image/jpeg', fileName));
  file.setDescription('Trailguard Essentials case photo\nCase: ' + caseId + '\nBy: ' + caller.name + ' <' + caller.email + '>');
  var url = 'https://drive.google.com/file/d/' + file.getId() + '/view';

  try {
    var sheet = getLogSheet_('Photos', PHOTO_HEADERS);
    sheet.appendRow([new Date(), groupId, sheetSafe_(cleanText_(body.groupName, 60)), caseId, caller.uid,
      sheetSafe_(caller.name), sheetSafe_(caller.email), fileName, bytes.length, file.getId(), url]);
  } catch (err) {
    console.error('Photo log failed (file is saved):', err);
  }
  return { ok: true, file: { id: file.getId(), name: fileName, url: url } };
}

function isDispatcher_(caller) {
  return caller.role === 'owner' || caller.role === 'dispatcher';
}

function validateId_(value, what) {
  var id = String(value || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AppError('Invalid ' + what + '.', 'bad_request');
  return id;
}

/** Root / Patient Records (restricted) / <Group> [gid] / Case <caseId> — under the script lock. */
function getPatientFolder_(groupId, groupName, caseId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var root = getRootFolder_();
    var records = childFolder_(root, PATIENT_FOLDER_NAME, function (n) { return n === PATIENT_FOLDER_NAME; });
    var suffix = '[' + groupId + ']';
    var groupFolder = childFolder_(records, safeFolderName_(groupName) + ' ' + suffix, function (n) {
      return n.slice(-suffix.length) === suffix;
    });
    var name = 'Case ' + caseId;
    return childFolder_(groupFolder, name, function (n) { return n === name; });
  } finally {
    lock.releaseLock();
  }
}

/** Create a text file, or replace the content of the file with that name (a record saved again). */
function upsertTextFile_(folder, fileName, content, mimeType, description) {
  var it = folder.getFilesByName(fileName);
  while (it.hasNext()) {
    var existing = it.next();
    if (!existing.isTrashed()) {
      existing.setContent(content);
      return existing;
    }
  }
  var file = folder.createFile(fileName, content, mimeType);
  if (description) file.setDescription(description);
  return file;
}

/**
 * Patient care record (ePCR): the full record as JSON plus the SOAP handover as
 * text, in the restricted Patient Records folder; saving again updates both files.
 * Medical responders and dispatchers only.
 */
function handleEpcr_(body, caller, groupId) {
  if (!isDispatcher_(caller) && caller.unit !== 'medical') {
    throw new AppError('Only medical responders and dispatchers can save patient records.', 'forbidden');
  }
  var caseId = validateId_(body.caseId, 'case id');
  var patientId = validateId_(body.patientId, 'patient record id');
  var recordText = String(body.record || '');
  if (!recordText || recordText.length > MAX_EPCR_CHARS) throw new AppError('Patient record is missing or too large.', 'bad_request');
  var record;
  try {
    record = JSON.parse(recordText);
  } catch (err) {
    throw new AppError('Patient record is not valid JSON.', 'bad_request');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) || !record.info || typeof record.info !== 'object') {
    throw new AppError('Patient record has no details.', 'bad_request');
  }
  var soap = cleanText_(String(body.soap || '').replace(/\r\n/g, '\n'), MAX_SOAP_CHARS);
  var groupName = cleanText_(body.groupName, 60);
  var folder = getPatientFolder_(groupId, groupName, caseId);
  var base = 'PCR ' + caseId + ' ' + patientId;
  var description = 'Trailguard Essentials patient care record\nCase: ' + caseId + ' · ' + cleanText_(body.caseTitle, 80) +
    '\nSaved by: ' + caller.name + ' <' + caller.email + '>';
  var stamped = {
    savedAt: new Date().toISOString(),
    savedBy: { uid: caller.uid, name: caller.name },
    groupId: groupId,
    caseId: caseId,
    patientId: patientId,
    record: record
  };
  var jsonFile = upsertTextFile_(folder, base + '.json', JSON.stringify(stamped, null, 2), 'application/json', description);
  var textFile = upsertTextFile_(folder, base + ' handover.txt', soap || '(no handover text)', 'text/plain', description);
  var url = 'https://drive.google.com/file/d/' + textFile.getId() + '/view';

  var info = record.info;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getLogSheet_('Patients', PATIENT_HEADERS);
    sheet.appendRow([
      new Date(), groupId, sheetSafe_(groupName), caseId, patientId, caller.uid, sheetSafe_(caller.name), sheetSafe_(caller.email),
      DISPOSITIONS[info.disposition] ? info.disposition : '', TRIAGE[info.triage] ? info.triage : '',
      info.status === 'closed' ? 'closed' : 'open', jsonFile.getId()
    ]);
  } finally {
    lock.releaseLock();
  }
  return { ok: true, file: { id: textFile.getId(), jsonId: jsonFile.getId(), name: base + ' handover.txt', url: url } };
}

/** After-action report (PDF or CSV) into <Group> [gid] / Reports. Dispatchers only. */
function handleReport_(body, caller, groupId) {
  if (!isDispatcher_(caller)) throw new AppError('Only dispatchers can save after-action reports.', 'forbidden');
  var mime = String(body.mimeType || '').toLowerCase();
  if (mime !== 'application/pdf' && mime !== 'text/csv') throw new AppError('Reports must be PDF or CSV.', 'bad_request');
  if (typeof body.data !== 'string' || body.data.length === 0) throw new AppError('Missing report data.', 'bad_request');
  var bytes;
  try {
    bytes = Utilities.base64Decode(body.data);
  } catch (err) {
    throw new AppError('Report is not valid base64.', 'bad_request');
  }
  if (bytes.length === 0 || bytes.length > MAX_REPORT_BYTES) throw new AppError('Report is empty or larger than 10 MB.', 'too_large');
  if (mime === 'application/pdf' && !((bytes[0] & 0xff) === 0x25 && (bytes[1] & 0xff) === 0x50 && (bytes[2] & 0xff) === 0x44 && (bytes[3] & 0xff) === 0x46)) {
    throw new AppError('File is not a PDF.', 'bad_request');
  }
  var groupName = cleanText_(body.groupName, 60);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var reports;
  try {
    var root = getRootFolder_();
    var suffix = '[' + groupId + ']';
    var groupFolder = childFolder_(root, safeFolderName_(groupName) + ' ' + suffix, function (n) {
      return n.slice(-suffix.length) === suffix;
    });
    reports = childFolder_(groupFolder, 'Reports', function (n) { return n === 'Reports'; });
  } finally {
    lock.releaseLock();
  }
  var ext = mime === 'application/pdf' ? 'pdf' : 'csv';
  var fileName = safeFileName_(body.fileName || ('after-action_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmm')), ext);
  var file = reports.createFile(Utilities.newBlob(bytes, mime, fileName));
  file.setDescription('Trailguard Essentials after-action report\nBy: ' + caller.name + ' <' + caller.email + '>');
  var url = 'https://drive.google.com/file/d/' + file.getId() + '/view';
  try {
    getLogSheet_('Reports', REPORT_HEADERS).appendRow([new Date(), groupId, sheetSafe_(groupName), caller.uid, sheetSafe_(caller.name),
      sheetSafe_(caller.email), fileName, ext.toUpperCase(), bytes.length, file.getId(), url]);
  } catch (err) {
    console.error('Report log failed (file is saved):', err);
  }
  return { ok: true, file: { id: file.getId(), name: fileName, url: url } };
}

/** Broadcast announcement → Announcements tab. Dispatchers, or a Fire & Safety unit's fire alert. */
function handleAnnouncement_(body, caller, groupId) {
  var kind = body.kind === 'fire' ? 'fire' : 'general';
  if (!isDispatcher_(caller) && !(kind === 'fire' && caller.unit === 'fire')) {
    throw new AppError('Only dispatchers can send announcements.', 'forbidden');
  }
  var id = validateId_(body.announcementId, 'announcement id');
  var level = String(body.level || '');
  if (!ANNOUNCE_LEVELS[level]) throw new AppError('Invalid level.', 'bad_request');
  var audience = String(body.audience || '');
  if (!ANNOUNCE_AUDIENCES[audience]) throw new AppError('Invalid audience.', 'bad_request');
  var text = cleanText_(body.text, 280);
  if (!text) throw new AppError('Announcement is empty.', 'bad_request');
  var caseId = body.caseId ? validateId_(body.caseId, 'case id') : '';
  var lat = optionalNumber_(body.lat, -90, 90);
  var lng = optionalNumber_(body.lng, -180, 180);
  var map = lat !== null && lng !== null ? 'https://www.google.com/maps?q=' + lat + ',' + lng : '';
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getLogSheet_('Announcements', ANNOUNCEMENT_HEADERS);
    sheet.appendRow([new Date(), groupId, sheetSafe_(cleanText_(body.groupName, 60)), id, level, audience, kind, sheetSafe_(text),
      caseId, lat, lng, map, caller.uid, sheetSafe_(caller.name), sheetSafe_(caller.email)]);
    return { ok: true, row: sheet.getLastRow() };
  } finally {
    lock.releaseLock();
  }
}

/* ============================== Log spreadsheet ============================== */

function getLogSpreadsheet_() {
  var props = props_();
  var id = props.getProperty('LOG_SHEET_ID');
  if (id) {
    try {
      var existing = SpreadsheetApp.openById(id);
      if (existing.getName() !== LOG_SPREADSHEET_NAME) existing.rename(LOG_SPREADSHEET_NAME);
      return existing;
    } catch (err) { /* deleted: recreate */ }
  }
  var ss = SpreadsheetApp.create(LOG_SPREADSHEET_NAME);
  var file = DriveApp.getFileById(ss.getId());
  file.moveTo(getRootFolder_());
  props.setProperty('LOG_SHEET_ID', ss.getId());
  return ss;
}

function getLogSheet_(tabName, headers) {
  var ss = getLogSpreadsheet_();
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    var blank = ss.getSheetByName('Sheet1');
    if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  }
  return sheet;
}

/* ============================== One-time setup ============================== */

/**
 * Run once from the Apps Script editor (select "setup" → Run). Grants the OAuth
 * scopes, creates the Drive folder and log spreadsheet, and checks configuration.
 */
function setup() {
  var apiKey = props_().getProperty('FIREBASE_API_KEY');
  var db = props_().getProperty('FIREBASE_DB_URL');
  if (!apiKey || !db) {
    throw new Error('Set script properties FIREBASE_API_KEY and FIREBASE_DB_URL first (Project Settings → Script properties).');
  }
  var root = getRootFolder_();
  var ss = getLogSpreadsheet_();
  getLogSheet_('Uploads', UPLOAD_HEADERS);
  getLogSheet_('Incidents', INCIDENT_HEADERS);
  getLogSheet_('Cases', CASE_HEADERS);
  getLogSheet_('Photos', PHOTO_HEADERS);
  getLogSheet_('Patients', PATIENT_HEADERS);
  getLogSheet_('Reports', REPORT_HEADERS);
  getLogSheet_('Announcements', ANNOUNCEMENT_HEADERS);

  // Reachability checks: an invalid token must be rejected with HTTP 400, not 403 (key restricted).
  var probe = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(apiKey.trim()),
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: 'invalid' }), muteHttpExceptions: true }
  );
  var dbProbe = UrlFetchApp.fetch(db.trim().replace(/\/+$/, '') + '/.json?shallow=true', { muteHttpExceptions: true });

  console.log('Archive folder: ' + root.getUrl());
  console.log('Log spreadsheet: ' + ss.getUrl());
  console.log('Firebase Auth check: HTTP ' + probe.getResponseCode() + (probe.getResponseCode() === 400 ? ' (OK)' : ' — expected 400; check the API key restrictions'));
  console.log('Realtime Database check: HTTP ' + dbProbe.getResponseCode() + (dbProbe.getResponseCode() === 401 ? ' (OK — rules deny anonymous reads)' : ' — expected 401; check FIREBASE_DB_URL and rules'));
  console.log('Max upload: ' + Math.round(maxUploadBytes_() / 1048576) + ' MB');
}
