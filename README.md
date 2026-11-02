# Trailguard Essentials — event medical, security & fire dispatch (beta)

Mobile-first PWA and Android app for event medical cover, security and dispatch — marathons, mass sporting events, remote expeditions — with groups of up to ~15 members each:

> **Beta safety note.** Trailguard Essentials alerts *your own team* only. It does not contact emergency services. Train every volunteer to call **995** (SCDF ambulance / fire) first for life-threatening emergencies; the SOS screens carry a one-tap Call 995 button (`VITE_EMERGENCY_NUMBER`).

**Roles and what each one sees** (primary role in the role chip; dispatchers are appointed by the group owner):

| Role | Gets |
|---|---|
| **Security** | Bodycam streaming, incident / disturbance logging, push-to-talk, proximity alerts |
| **Medical** | ePCR (vital signs, treatments, medications, SOAP handover), patient-transport requests, proximity alerts, main + **medical** PTT channel |
| **Fire & Safety** | Hold-to-send **FIRE** rapid alert, fire / hazard reporting without review, incident dispatch, PTT, proximity alerts |
| **Usher / Marshal** | Simplified screen: a big *Report case* button, the map, broadcast announcements (listen-only on the main channel) |
| **Dispatcher** (owner or appointed) | Everything: review queue, unit tracking, bodycam feeds, assignment, announcements, settings, map layers, after-action reports |

- **Equipment sub-roles** — Medical: AED, Aid Bag, Trauma Kit, ALS / Doctor; Fire: Fire Extinguisher, First Responder Kit; Security: Crowd Control, Mobile Escort; plus how the responder travels (on foot, bicycle, vehicle). Badges (AED, BAG, TRM, ALS, EXT, FRK, CRD, ESC, BIKE, VEH) show on every map marker. Equipment is **informational**: a case can request equipment (a cardiac arrest requests an AED by default) and the request shows on alerts and markers, but every unit of the right primary role is alerted and may respond. Auto-assign prefers units that carry the requested equipment (or a vehicle, for patient transport), then the nearest.
- **Report → review → verified case** — anyone can report a case by dropping a pin or using their GPS position, with details, required equipment and up to 3 photos. Reports wait in the dispatcher's *Pending Review* queue; a dispatcher verifies (optionally correcting type, severity and equipment) or rejects with a reason. Dispatcher cases, a Fire & Safety unit's fire alert and a medic's transport request open at once.
- **Proximity alerts** — default radius **600 m**, adjustable **100–2000 m** by dispatch, with a group master switch and a per-device switch (and an optional per-device radius). Free units whose role and equipment fit a verified case get a drop-down banner with distance and ETA, an alarm and *Accept* / *Dismiss*.
- **Auto-assign** (optional, dispatch settings) — the closest free unit of the right role (units carrying the requested equipment first) is locked to the case (BUSY) at once and asked to confirm; if it doesn't answer within the answer time (default 90 s) the assignment lapses to the next closest unit. Runs on the phones themselves — no server or online dispatcher needed.
- **Single-task lock** — a unit that accepts or is assigned a case is BUSY (then EN ROUTE / ON SCENE) and gets no proximity alarms or auto-assignments until it marks the case *Resolved* or dispatch closes it. Enforced by the database rules. A teammate's SOS overrides the lock; a dispatcher can release a unit whose phone died.
- **ETA** — each responder's phone routes itself to its case (foot, bike or car profile by travel mode) through an OSRM server and shares the ETA with dispatch; a straight-line estimate (marked “~”) otherwise.
- **SOS** — press and hold for 1.5 s (or hold the Samsung Top key). Every other member gets a full-screen alarm until they acknowledge or respond.
- **Critical alerts** — SOS, P1 cases, fire alerts and critical announcements use a separate Android notification channel with the alarm sound, a full-screen alert over the lock screen, and a looping alarm on the *alarm* stream, so the ringer's silent/vibrate switch doesn't mute it. Once the user grants *Do Not Disturb access* (button under *This device*), the channel also bypasses DND. Optionally raises the alarm volume to 80 % while it sounds.
- **Push-to-talk** — Zello-style hold-to-talk over WebRTC with server-arbitrated floors on two channels: *Main* (everyone) and *Medical* (medical units and dispatchers only — the audio is only sent to them). Talk from the on-screen button, a keyboard key (Space, rebindable; Bluetooth PTT buttons), a hardware button on Android — Samsung XCover key (1015), `KEYCODE_STEM_PRIMARY` (264), `KEYCODE_STEM_1` (265), any key you add — or a **Knox PTT intent** on managed Samsung devices (`com.samsung.android.knox.intent.action.PTT_PRESS` / `PTT_RELEASE` by default; the action names are configurable).
- **One-touch bodycam** (Security, dispatchers) — one tap turns on the front camera, records and broadcasts live to dispatch; the dispatcher's screen opens the feed by itself. Controls stay above the video (high z-index).
- **ePCR and handover** — per patient on a case: age / sex / optional identifier, triage colour, chief complaint, history, allergies, own medications, timed vital-sign sets (HR, BP, SpO₂, RR, temperature, GCS E/V/M, BGL, pain — abnormal values flagged), examination, assessment, treatments, medications given, plan, disposition and destination. Entries are append-only. *Handover (SOAP)* builds a structured note to copy or share; *Save to Drive* archives the record and handover to a restricted *Patient Records* folder.
- **Course-map overlays** — dispatchers upload GeoJSON or KML (e.g. a Google My Maps export): course tracks, kilometre markers, aid stations, water points, road closures and emergency access corridors, styled by category and shown on every phone.
- **Announcements** — dispatch broadcasts info / urgent / critical messages to everyone or to one role; recipients acknowledge and dispatch sees who has.
- **After-action report** — total cases, breakdown by severity, case type and responding role, average / median / 90th-percentile times *Reported → Accepted → On scene → Resolved*, unit utilisation, ePCR dispositions; download CSV or PDF, or save the PDF to Drive.
- **Background running (Android)** — while on duty, a foreground service keeps GPS, alerts and incoming audio running with the screen off; the service worker sends positions queued offline when the connection returns.
- **Groups** — create, join by code or link, leave, disband, remove and block members, rotate invite codes.

```
 Phone A ──┐  locations · presence · PTT floor · WebRTC signalling   ┌── Phone B
           ├──────────────► Firebase Realtime Database ◄─────────────┤
           │                (database.rules.json enforces isolation)  │
           └◄═══════════ WebRTC audio + video (peer-to-peer) ════════►┘
           │
           └─ bodycam clip, 4 MiB chunks ─► Apps Script doPost ─► Drive resumable upload ─► Google Drive (Google One)
                                            (verifies Firebase ID token + group membership)
```

## Files

| File | Purpose |
|---|---|
| `package.json`, `vite.config.js` (PWA manifest) | Dependencies, scripts, app manifest and service worker |
| `index.html` | UI layout: map, role-gated dock (PTT / Report / Bodycam / ePCR), SOS and FIRE buttons, role & equipment picker, settings, ePCR, board, announcements, layers, reports |
| `src/styles.css` | Dark operational UI, role themes, z-index layering, PTT / bodycam controls, ePCR form, report tables |
| `src/app.js` | Bootstrap, auth, group session lifecycle, role-based feature toggling, presence, device settings, UI wiring |
| `src/roles.js` | Roles, equipment sub-roles, travel modes, case types, role → feature and case-type matrices, matching (`responderFit`) |
| `src/auto-dispatch.js` | Auto-assign engine: ranks the closest fitting free unit; lapses unanswered assignments |
| `src/location.js` | GPS tracking and sync, Haversine, 100–2000 m proximity checks, routed ETA, GeoJSON / KML overlay loader |
| `src/voice-ptt.js` | Push-to-talk channels, floor control, speaker overlay events, keyboard / XCover / Knox-intent bindings |
| `src/bodycam.js` | One-touch camera, recording, live share, chunked Drive upload, ePCR / report / announcement archiving calls |
| `src/background-service.js` | Offline outbox + Background Sync, alarm sound with mute and the native critical alarm |
| `src/alerts.js` | SOS / assignment / proximity / announcement / review alerts, critical flag, notifications, background polling |
| `src/analytics.js` | After-action metrics, CSV and PDF export |
| `src/epcr.js`, `src/epcr-format.js`, `src/epcr-ui.js` | Patient records (data), vital ranges and SOAP generator, ePCR screen |
| `src/announcements.js`, `src/ops-ui.js` | Broadcasts; announcements, map layers and report screens |
| `src/dispatch.js`, `src/dispatch-ui.js` | Cases, review, assignments and the task lock, settings; board, case detail, report form, role picker |
| `src/rtc-mesh.js`, `src/map.js`, `src/groups.js` | WebRTC mesh (per-listener audio), Leaflet map (badges, overlays), group lifecycle |
| `src/native.js`, `src/firebase.js`, `src/clock.js`, `src/ui.js` | Android bridges, config + SDK init, server clock, DOM helpers |
| `public/sw-background.js` | Service-worker side: Background Sync of queued positions, notification taps |
| `apps-script/google-apps-script.gs` | Apps Script web app: auth, Drive uploads, case / incident / photo / ePCR / report / announcement logs |
| `database.rules.json` | Realtime Database security rules |
| `android/` | Android wrapper: `HardwareKeyPlugin` + `HardKeyReceiver` + `KnoxPttReceiver` (keys, Knox intents), `CriticalAlertPlugin` (DND-bypassing alerts) |
| `tests/` | Rules, unit, Apps Script, two-phone, dispatch and 15-phone tests |

Dependencies: `firebase` 13, `leaflet` 1.9, `jspdf` 4 (PDF reports, loaded on first use), `@capacitor/core` + `@capacitor/android` + `@capacitor/app` + `@capacitor/local-notifications` 8, `@capacitor-community/background-geolocation` 1.3; dev: `vite` 8, `vite-plugin-pwa` 2, `@vitejs/plugin-basic-ssl`, `@capacitor/cli`, `firebase-tools`, and test-only `targaryen`, `ws`, `playwright-core`. Node 20.19+.

## 1. Firebase

1. Create a project at console.firebase.google.com (the free Spark plan is enough).
2. **Authentication → Sign-in method →** enable **Email/Password**.
3. **Realtime Database → Create database** (pick the region closest to your users, e.g. `asia-southeast1`), start in locked mode.
4. **Project settings → Your apps → Web app**: register an app and copy its config.
5. Deploy the security rules:
   ```bash
   npx firebase login
   npx firebase use --add          # pick your project
   npm run deploy:rules
   ```

## 2. Google Apps Script (Drive archive)

Use the Google account whose Drive (Google One) storage should hold the clips.

1. Go to script.google.com → **New project**.
2. **Project Settings** → tick **Show "appsscript.json" manifest file**. Replace its contents with `apps-script/appsscript.json`.
3. Replace `Code.gs` with `apps-script/google-apps-script.gs`.
4. **Project Settings → Script properties**, add:
   - `FIREBASE_API_KEY` — the Web API key from step 1.4
   - `FIREBASE_DB_URL` — your database URL, e.g. `https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app`
   - `MAX_UPLOAD_MB` — optional, default `300`
5. In the editor select **setup** → **Run** and approve the permissions. The log prints the archive folder, the log spreadsheet and two checks (Firebase Auth `400 (OK)`, Database `401 (OK)`).
6. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Copy the URL ending in `/exec`.

If you restrict the Firebase API key by HTTP referrer, the script's token check gets `403`: allow the **Identity Toolkit API** for that key without a referrer restriction, or create a second key limited to that API and use it here.

Clips and photos land in `Trailguard Essentials Archive / <Group> [groupId] / <yyyy-MM-dd>/`, after-action reports in `… / <Group> [groupId] / Reports/`, and patient records in `Trailguard Essentials Archive / Patient Records (restricted) / <Group> [groupId] / Case <id>/` (one JSON record and one handover text per patient, updated when saved again). The **Trailguard Essentials Log** spreadsheet has *Uploads*, *Incidents*, *Cases*, *Photos*, *Patients*, *Reports* and *Announcements* tabs; the *Patients* tab holds only non-clinical fields (case, record id, who saved it, disposition, triage).

Share the archive folder with supervisors so the “Drive” links in the app open for them — but **not** the *Patient Records (restricted)* folder: share that only with the medical lead, as your data-protection rules (Singapore PDPA or equivalent) require. Only medical responders and dispatchers can read patient records in the app or save them to Drive.

## 3. Configure and run

```bash
npm install
cp .env.example .env      # fill in the Firebase config and VITE_GAS_ENDPOINT
npm run dev               # https://<your-LAN-IP>:5173 — accept the self-signed certificate
npm run build             # production build in dist/ (static; host anywhere with HTTPS)
```

Camera, microphone and GPS only work over HTTPS (or `localhost`).

## 3a. Hosting the web app (trailguardessentials.com on Hostinger)

The web app is static files: once uploaded, phones and the dispatch console run it from the website, with Firebase and Apps Script in the cloud — nothing runs on your computer.

```bash
npm run build:site        # dist/ + trailguard-site.zip (no source maps, never contains trailguard-config.js)
```

1. **hPanel → Websites → Manage → File Manager → `public_html`**: delete Hostinger's placeholder `default.php` / `index.php`, upload `trailguard-site.zip`, right-click → **Extract** into `public_html` (files at its top level, including the hidden `.htaccess`).
2. Rename `trailguard-config.example.js` → `trailguard-config.js` and fill in the `firebase` values and `gasEndpoint`. This file replaces `.env` for the website, so the uploaded build needs no secrets or rebuild; edit it any time.
3. **hPanel → Security → SSL**: install the free certificate for the domain. `.htaccess` forces HTTPS, sends `www.` to the bare domain, keeps the service worker and settings uncached and lets `/assets/` cache for a year.
4. Firebase console → **Authentication → Settings → Authorized domains → Add domain** `trailguardessentials.com`. If your API key has HTTP-referrer restrictions, add `https://trailguardessentials.com/*`.

Updating later: upload the new `trailguard-site.zip` and extract over the old files; `trailguard-config.js` is left alone. If Hostinger CDN is on, purge its cache afterwards.

The same `dist/` works on any HTTPS static host. `firebase.json` also has a Firebase Hosting section: `npx firebase deploy --only hosting` (put a filled `trailguard-config.js` in `dist/` first), then connect the domain in Firebase console → Hosting → Add custom domain.

**TURN server:** STUN alone connects phones on most Wi-Fi networks. Phones on mobile data behind carrier-grade NAT usually need a TURN relay (coturn, Cloudflare Calls TURN, Twilio, metered.ca…). Put it in `VITE_ICE_SERVERS`.

## 4. Android (Capacitor)

The `android/` project is already generated with the plugins registered and the camera, microphone, location, foreground-service, notification and vibration permissions in `AndroidManifest.xml`. `capacitor.config.json` sets `useLegacyBridge: true`, which the background-location plugin needs so updates don't stop after 5 minutes in the background.

```bash
npm run cap:sync          # build the web app and copy it into android/
npm run cap:open          # open in Android Studio → Run (or Build → Generate Signed APK for the beta)
```

On first use the app asks for location (“While using the app” is enough — the foreground service covers the background), notifications, microphone and camera.

**Critical alerts:** in *Members → This device → Critical alerts*, tap **Allow through Do Not Disturb** (Settings opens at *Do Not Disturb access*; switch Trailguard Essentials on and come back) and, on Android 14+, **Allow full-screen alerts**. The app re-creates its critical channel with DND bypass once access is granted.

**Samsung XCover / managed devices:** for unmanaged phones choose *Settings → Advanced features → XCover key → Control XCover key with app → Trailguard Essentials*. For fleets managed with Knox Service Plugin, map the XCover (or Top) key to *send broadcast intent* with the action `com.samsung.android.knox.intent.action.PTT_PRESS` on press and `com.samsung.android.knox.intent.action.PTT_RELEASE` on release (or a single action with the `KEY_REPORT_TYPE` extra, 1 = down, 2 = up), targeted at package `com.dnex.trailguard`. Other action names can be entered under *This device → Knox PTT intents*. Any app on the phone could send these broadcasts, so the switch there turns them off, and every transmission is capped at 60 s with the on-air indicator.

**Set up each responder's phone for background running:**
1. Allow notifications (the on-duty notification and alerts need them).
2. Settings → Apps → Trailguard Essentials → Battery → **Unrestricted**. On Samsung also remove it from *Sleeping apps*; on Xiaomi/Oppo/Vivo enable *Autostart*. Without this, aggressive battery savers can kill the service and the phone stops receiving alerts.
3. Don't swipe Trailguard Essentials away from recent apps while on duty.

How it works in the background: the foreground service keeps the app process alive; while the app isn't in the foreground, location writes go through native HTTP to the Realtime Database REST API (Android throttles WebView requests after a few minutes in the background), and incidents are also polled every 30 s over native HTTP so an SOS or assignment still raises a notification if the live connection has been throttled.

## 5. Tests

```bash
npm test                  # rules + unit + Apps Script + both end-to-end scenarios
npm run test:rules        # 77 security-rule cases (targaryen rules simulator)
npm run test:unit         # 21 cases: role / equipment matching, proximity, auto-assign ranking, overlays, ePCR, analytics
npm run test:gas          # 21 cases running the real .gs file against fake Drive / Sheets / Firebase
npm run test:e2e          # two headless Chrome phones with fake camera, mic and GPS (17 steps)
npm run test:dispatch     # three phones, 35 steps (see below)
npm run test:scale        # 15 phones in one group (about 1.5 minutes; needs ~3 GB RAM)
```

The dispatch test covers role and equipment selection and role-gated screens; SOS; report → review → proximity alarm → accept → lock → routed ETA → resolve; direct assignment; rejection; radius settings; a cardiac arrest that only alerts a unit once it carries an AED (and the AED badge on the map); a full ePCR with SOAP handover archived to the restricted Drive folder; auto-assign of the closest unit; the per-device proximity switch; GeoJSON and KML layers; the Sheet case log; background notifications; keyboard PTT and rebinding; bodycam request and one-touch auto-open; offline outbox; the medical PTT channel reaching the dispatcher but not Security; a critical announcement to Medical only; the usher screen; a fire rapid alert; and the after-action report (CSV download, PDF to Drive) — with zero database-rule denials. The scale test checks the 15-phone voice mesh, audio to all 14 listeners, video only to the viewer and an SOS to all 14.

The end-to-end tests run the real app against a local WebSocket backend that enforces `database.rules.json` on every read and write, and the real Apps Script file behind an HTTP server. They need Chromium (set `CHROME_PATH` if Playwright's isn't at the default path). They do not replace a run against a real Firebase project and real phones — in particular the Android-only parts (critical-alert channel, DND bypass, XCover keys and Knox intents) need testing on the actual devices.

## Security model

- Dispatch rules: any member can raise an SOS (only in their own name), acknowledge alerts for themselves and self-dispatch to an open SOS; the SOS sender can only cancel it; only dispatchers/owner verify, edit, assign, close or delete cases (Fire & Safety may open a fire case, Medical a transport request); a responder can self-accept — or auto-assign themselves when the group allows it — only cases whose type their role responds to, whose required equipment they carry, and (for transport) with a vehicle, and never while locked to another case; an assigned responder changes only their own assignment; step times (assigned, accepted, en route, on scene, cleared) must be the server's time; incident creators and creation times are immutable; log entries can't be edited or forged.
- Patient records are readable and writable only by medical responders and dispatchers; vital signs, treatments and medications are append-only and recorded in the writer's own name; only dispatchers can delete. The medical PTT channel's floor accepts only medical units and dispatchers, and the talker's phone sends its audio only to them. Ushers cannot take a PTT floor. Announcements are sent by dispatchers (fire units: fire alerts only); map layers are dispatcher-only.
- Every read and write is checked by `database.rules.json`: only members read a group's data; members write only their own location and presence; joining requires the current invite code and no block; only the floor holder (or the owner, or after 65 s) can release the PTT floor; signalling messages can only be sent between current members, by their real sender, and only read by their recipient; server timestamps can't be forged; location writes are rate limited.
- Voice and video travel peer-to-peer (DTLS-SRTP encrypted) between members; Firebase only carries the session setup.
- The Apps Script endpoint verifies the caller's Firebase ID token with Firebase Auth, then reads the caller's membership record *as the caller*, so the database rules decide. Upload sessions are bound to the uploader, file names are sanitised, types and sizes are checked, spreadsheet cells are protected against formula injection, and each user is rate limited.
- No secrets are embedded in the client; all `VITE_*` values are public configuration.

## Limits to know before deployment

- **Background is Android-only.** The Android app keeps running with the screen off (see above). The web/PWA version — fine for a dispatcher at a laptop — stops GPS and audio when the tab is hidden or the phone locks; iOS has the same limit.
- **No server push yet.** Alerts reach phones whose app is running (foreground or on duty in the background). If a phone's app was force-stopped, swiped away, or killed by the battery saver, it gets nothing until reopened. A Firebase Cloud Messaging push (needs Cloud Functions on the Blaze plan) is the next step before relying on it for real call-outs.
- **Talking from the background.** Incoming audio plays with the screen off, but sending needs the app on screen (the PTT button). Android also blocks background microphone use without a microphone-type service.
- **Group size.** Voice uses a full mesh: each phone keeps one connection per other online member. Tested with 15 phones in one group (full mesh in about a second; each talker sends ~32 kbps to each of 14 listeners, ~0.5 Mbps uplink). Live video is sent only to members actively viewing it. Beyond ~20, use an SFU media server.
- **Free-tier quotas.** Firebase Spark: 100 simultaneous connections, 1 GB stored, 10 GB/month downloaded. Location writes are capped at one per 2 s per member (heartbeat every 30 s when still). With 15 members all moving, expect roughly 80 MB of database downloads per hour of operation; a 4-hour event uses about 300 MB. Apps Script (consumer account): 20,000 URL fetches/day — each 4 MiB chunk uses one, so roughly 75 GB/day. Drive storage is the deploying account's Google One quota.
- **Routing.** ETAs use the free FOSSGIS OSRM servers by default (fair use, at most one request per second). The app routes each responder's own active case only, caches results and falls back to straight-line estimates, which suits a beta; for regular operations run your own OSRM server and set `VITE_ROUTING_URL`.
- **Pending reports need a dispatcher.** Member reports do not alert units until a dispatcher verifies them; the report form warns when no dispatcher is online. Keep at least one dispatcher on shift, and use SOS for anything urgent.
- **Map tiles.** The default OpenStreetMap tile servers are for light use; use a tile provider for a deployed fleet.
- **iOS.** The PWA works in Safari on iOS 16.4+ (wake lock, recording as MP4), with the same background limits.
- **Critical alerts are Android-only.** Browsers cannot override silent mode or Do Not Disturb; on the web, critical notifications stay on screen and vibrate longer, and the siren plays only while the page is open. DND bypass needs the user to grant *Do Not Disturb access* once per phone.
- **Auto-assign** ranks units from the positions every phone shares, so a unit whose GPS is stale (> 2 min), off duty, opted out on its device or offline is skipped. In the rare case two phones see different positions at the same instant, both may claim; the case then shows two units and dispatch can release one.
- **Patient data.** ePCR records are stored in your Firebase Realtime Database (choose its region to meet your data-residency rules) and, when saved, in the deploying account's Drive. Record only what care and handover need — the patient identifier is optional, and names / NRIC numbers aren't asked for. Set a retention period and delete records (dispatchers can) when it ends. This beta is a field tool, not a certified clinical records system.
- **Knox intents.** The action names `com.samsung.android.knox.intent.action.PTT_PRESS` / `PTT_RELEASE` are what Trailguard listens for by default; Samsung's public Knox documentation describes the `HARD_KEY_REPORT` broadcast (also supported) but not a standard PTT action, so set the same names in your Knox Service Plugin key mapping, or change them on the phone.

## Upgrading from 1.4.1

Nothing in the database changes. The website can now be configured with `trailguard-config.js` instead of `.env` (§3a); a build that still has `.env` keeps working, and values in `trailguard-config.js` win where both are set.

## Upgrading from 1.4.0

1. `npm run deploy:rules` — equipment and travel mode no longer restrict who may accept a case. **If role selection, push-to-talk or new cases fail with “permission denied” / “channel busy”, the Firebase project is still on older rules: deploy them.**
2. Rebuild the app (`npm run build`, `npm run cap:sync`; `versionCode` is 6).

## Upgrading from 1.3

1. `npm install`, then `npm run deploy:rules` — the rules add the 1.4 roles, equipment, travel mode, settings v2 (100–2000 m, master switch, auto-assign), equipment-matched accept, step times, PTT channels, ePCR, announcements and map layers. The 1.3 unit names (Bicycle Medic, Medic, Ambulance) are no longer valid.
2. Apps Script: paste the new `apps-script/google-apps-script.gs`, Deploy → Manage deployments → edit → **New version**, then run `setup` once (adds the *Patients*, *Reports* and *Announcements* tabs).
3. Rebuild the Android app (`npm run cap:sync`, then build the signed APK; `versionCode` is 5). Then on each phone grant *Do Not Disturb access* for critical alerts.
4. Existing groups: the first dispatcher to open the group writes 1.4 dispatch settings (an earlier radius is kept, within 100–2000 m). Each responder is asked to pick their role again — Bicycle Medic and Medic become **Medical** (bicycle / on foot), Ambulance becomes **Medical** with a vehicle — and to tick their equipment.
