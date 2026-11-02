/* Trailguard Essentials — service-worker side of background operation.
   Imported into the generated service worker (vite.config.js → workbox.importScripts).

   1. Background Sync: positions recorded while offline wait in the IndexedDB
      outbox written by src/background-service.js. When connectivity returns the
      browser fires 'sync' — even if the app tab was closed — and the newest
      position is sent to the Realtime Database REST API with the signed-in
      user's ID token (if it hasn't expired; tokens last one hour).
   2. Notification taps focus the app and open the related case. */

const TG_DB = 'trailguard-bg';
const TG_STORE = 'outbox';
const TG_SYNC_TAG = 'tg-location-sync';

function tgOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(TG_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(TG_STORE, { keyPath: 'path' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tgRequest(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(TG_STORE, mode);
    const req = fn(tx.objectStore(TG_STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
  });
}

async function tgFlushOutbox() {
  const db = await tgOpen();
  try {
    const records = await tgRequest(db, 'readonly', (store) => store.getAll());
    for (const record of records) {
      if (!record.idToken || !record.exp || record.exp < Date.now() + 30000) {
        // Token expired while offline: the app sends a fresh position when it next opens.
        await tgRequest(db, 'readwrite', (store) => store.delete(record.path));
        continue;
      }
      const url = `${record.dbUrl}/${record.path}.json?auth=${encodeURIComponent(record.idToken)}`;
      let res;
      try {
        res = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record.payload)
        });
      } catch (err) {
        throw err; // still offline: let the browser retry the sync later
      }
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        // Written, or refused for good (rate limit, membership removed): don't retry.
        await tgRequest(db, 'readwrite', (store) => store.delete(record.path));
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    }
  } finally {
    db.close();
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === TG_SYNC_TAG) event.waitUntil(tgFlushOutbox());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = clientsList.find((c) => 'focus' in c);
    if (client) {
      await client.focus();
      client.postMessage({ type: 'notification-click', data });
    } else if (self.clients.openWindow) {
      await self.clients.openWindow(self.registration.scope);
    }
  })());
});
