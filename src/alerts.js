// Alert centre: works out which alerts need this member's attention, sounds the
// alarm until they are handled, raises notifications while the app is in the
// background (critical ones through silent mode / DND on Android), and — on
// Android in the background — polls cases over native HTTP so alerts still
// arrive if the live connection is throttled.
//
// Alert kinds (most urgent first):
//   sos          — a team member's SOS (everyone except the sender)     · full screen
//   assignment   — dispatch (or auto-dispatch) assigned me to a case     · drop-down banner
//   proximity    — a verified case my role and equipment fit is within my
//                  radius, and I am free (not locked, not off duty)      · drop-down banner
//   announcement — a broadcast from dispatch or a fire rapid alert       · drop-down banner
//   review       — (dispatchers) a report is waiting in Pending Review  · drop-down banner
//
// Critical (red) alerts: SOS, P1 assignments and proximity alerts, critical
// announcements and fire rapid alerts. They use the urgent siren, the native
// alarm stream on Android and the critical notification channel.
//
// Alerts are derived from state, not from one-off events, so they survive app
// restarts: an SOS stays until acknowledged, an assignment until accepted or
// declined, a proximity alert until accepted, dismissed, filled or out of range,
// an announcement until acknowledged.
import { isNative, isForeground, onAppStateChange, notify, clearNotification, restGet, useNativeHttp } from './native.js';
import { Alarm } from './background-service.js';
import { findProximityCases, formatEta } from './location.js';
import { caseTypeLabel } from './roles.js';
import { AUDIENCES } from './announcements.js';

const BACKGROUND_POLL_MS = 30_000;
const RANK = { sos: 0, assignment: 1, proximity: 2, announcement: 3, review: 4 };

export function isCritical(alert) {
  if (alert.kind === 'sos') return true;
  if (alert.kind === 'announcement') return alert.announcement.level === 'critical' || alert.announcement.kind === 'fire';
  if (alert.kind === 'review') return false;
  return alert.incident.priority === 1;
}

export class AlertCenter extends EventTarget {
  /**
   * Events: 'pending' {alerts: Array<{key, kind, critical, incident?, announcement?, distance?, eta?}>}
   * @param {object} opts
   *   gid, uid, dispatch, announcements (AnnouncementCenter), getIdToken,
   *   isDispatcher(): boolean, getMember(): my member record, getMyFix(): fix|null,
   *   isOffDuty(): boolean, getDeviceProximity(): {on: boolean, radiusM: number|null}
   */
  constructor({ gid, uid, dispatch, announcements, getIdToken, isDispatcher, getMember, getMyFix, isOffDuty, getDeviceProximity }) {
    super();
    this.gid = gid;
    this.uid = uid;
    this.dispatch = dispatch;
    this.announcements = announcements || null;
    this.getIdToken = getIdToken;
    this.isDispatcher = isDispatcher || (() => false);
    this.getMember = getMember || (() => null);
    this.getMyFix = getMyFix || (() => null);
    this.isOffDuty = isOffDuty || (() => false);
    this.getDeviceProximity = getDeviceProximity || (() => ({ on: true, radiusM: null }));
    this.alarm = new Alarm();
    this.pending = [];
    this.notified = new Set();
    this.dismissedLocal = new Set();
    this.snoozeUntil = 0;
    this.snoozeTimer = null;
    this.pollTimer = null;
    this.unsubs = [];
    this.lastFixEval = 0;
    this.onChange = () => this.evaluate();
  }

  start() {
    for (const evt of ['incidents', 'status', 'settings']) {
      this.dispatch.addEventListener(evt, this.onChange);
      this.unsubs.push(() => this.dispatch.removeEventListener(evt, this.onChange));
    }
    if (this.announcements) {
      this.announcements.addEventListener('change', this.onChange);
      this.unsubs.push(() => this.announcements.removeEventListener('change', this.onChange));
    }
    this.unsubs.push(onAppStateChange((fg) => this.handleAppState(fg)));
    this.handleAppState(isForeground());
    this.evaluate();
  }

  /** Call from a user gesture so the alarm can make sound. */
  unlock() {
    this.alarm.unlock();
  }

  /** New GPS fix: proximity may have changed (throttled to every 3 s). */
  onFix() {
    const now = Date.now();
    if (now - this.lastFixEval < 3000) return;
    this.lastFixEval = now;
    this.evaluate();
  }

  /** Hide a proximity alert at once (the dismissal is also written to the case). */
  dismissLocally(iid) {
    this.dismissedLocal.add(iid);
    this.evaluate();
  }

  /** Silence the alarm for ms (alerts stay pending and sound again afterwards). */
  snooze(ms) {
    this.snoozeUntil = Date.now() + ms;
    this.alarm.stop();
    clearTimeout(this.snoozeTimer);
    this.snoozeTimer = setTimeout(() => this.evaluate(), ms + 50);
  }

  /** The radius my proximity alerts use: my device's own setting, else the group's. */
  radiusM() {
    const device = this.getDeviceProximity();
    return device && Number.isFinite(device.radiusM) ? device.radiusM : this.dispatch.settings.proximityM;
  }

  evaluate() {
    const incidents = this.dispatch.incidents;
    const alerts = [];
    const lock = this.dispatch.myLock();

    for (const inc of incidents.values()) {
      const mine = inc.assigned && inc.assigned[this.uid];
      const acked = !!(inc.acks && inc.acks[this.uid]);
      if (inc.type === 'sos') {
        if (inc.state === 'open' && inc.createdBy !== this.uid && !acked && !mine) {
          alerts.push({ key: `sos:${inc.id}`, kind: 'sos', incident: inc });
        }
        continue;
      }
      if (mine && mine.state === 'assigned' && (inc.state === 'open' || inc.state === 'monitoring')) {
        alerts.push({ key: `assign:${inc.id}`, kind: 'assignment', incident: inc, auto: mine.by === 'auto' });
      } else if (inc.state === 'pending' && this.isDispatcher()) {
        alerts.push({ key: `review:${inc.id}`, kind: 'review', incident: inc });
      }
    }

    const device = this.getDeviceProximity();
    const proximity = findProximityCases({
      incidents,
      uid: this.uid,
      member: this.getMember(),
      fix: this.getMyFix(),
      settings: this.dispatch.settings,
      radiusM: this.radiusM(),
      locked: !!lock,
      offDuty: this.isOffDuty(),
      dismissed: this.dismissedLocal,
      stillNeeded: (inc) => this.dispatch.stillNeeded(inc),
      deviceOn: !device || device.on !== false
    });
    for (const p of proximity) {
      alerts.push({ key: `near:${p.incident.id}`, kind: 'proximity', incident: p.incident, distance: p.distance, eta: p.eta });
    }

    if (this.announcements) {
      for (const a of this.announcements.pendingForMe()) {
        alerts.push({ key: `ann:${a.id}`, kind: 'announcement', announcement: a });
      }
    }

    for (const a of alerts) a.critical = isCritical(a);
    const prio = (a) => (a.incident ? a.incident.priority : 2);
    const created = (a) => (a.incident ? a.incident.createdAt || 0 : a.announcement.ts || 0);
    alerts.sort((a, b) => (b.critical ? 1 : 0) - (a.critical ? 1 : 0)
      || RANK[a.kind] - RANK[b.kind]
      || prio(a) - prio(b)
      || (a.distance || 0) - (b.distance || 0)
      || created(a) - created(b));

    const keys = new Set(alerts.map((a) => a.key));
    for (const old of this.pending) {
      if (!keys.has(old.key)) {
        clearNotification(old.key);
        this.notified.delete(old.key);
      }
    }
    this.pending = alerts;
    this.updateAlarm();
    if (!isForeground()) this.notifyPending();
    this.dispatchEvent(new CustomEvent('pending', { detail: { alerts } }));
  }

  updateAlarm() {
    // Review alerts only sound for P1 reports, info announcements never do; everything else always sounds.
    const loud = this.pending.filter((a) => {
      if (a.kind === 'review') return a.incident.priority === 1;
      if (a.kind === 'announcement') return a.announcement.level !== 'info' || a.critical;
      return true;
    });
    if (!loud.length || Date.now() < this.snoozeUntil) {
      this.alarm.stop();
      return;
    }
    const critical = loud.some((a) => a.critical);
    const urgent = critical || loud.some((a) => a.kind === 'announcement' && a.announcement.level === 'urgent');
    this.alarm.start(urgent ? 'urgent' : 'normal', { critical });
  }

  describe(alert) {
    if (alert.kind === 'announcement') {
      const a = alert.announcement;
      const fire = a.kind === 'fire';
      return {
        title: `${fire ? '🔥 FIRE ALERT' : a.level === 'critical' ? '🚨 CRITICAL' : a.level === 'urgent' ? 'URGENT' : 'Announcement'} — ${a.name}`,
        body: `${a.text}${a.audience !== 'all' ? ` (to ${AUDIENCES[a.audience] || a.audience})` : ''}`
      };
    }
    const inc = alert.incident;
    const where = Number.isFinite(alert.distance) ? ` · ${Math.round(alert.distance)} m away` : '';
    switch (alert.kind) {
      case 'sos':
        return { title: `🚨 SOS — ${inc.createdByName}`, body: 'Needs help now. Open Trailguard to acknowledge or respond.' };
      case 'assignment':
        return {
          title: `${alert.auto ? 'Auto-assigned' : 'Assigned'} P${inc.priority}: ${inc.title}`,
          body: `${caseTypeLabel(inc.type)}. You are the closest matching unit — open Trailguard to accept or decline.`
        };
      case 'proximity':
        return {
          title: `Nearby P${inc.priority} ${caseTypeLabel(inc.type)}${where}`,
          body: `${inc.title} — ETA ~${formatEta(alert.eta.seconds)}. Open Trailguard to accept.`
        };
      default:
        return { title: `Report to review P${inc.priority}: ${inc.title}`, body: `From ${inc.createdByName}. Open Trailguard to verify or reject.` };
    }
  }

  notifyPending() {
    for (const alert of this.pending) {
      if (this.notified.has(alert.key)) continue;
      this.notified.add(alert.key);
      const { title, body } = this.describe(alert);
      const incidentId = alert.incident ? alert.incident.id : (alert.announcement.caseId || '');
      notify({ key: alert.key, title, body, critical: alert.critical, data: { incidentId, gid: this.gid, key: alert.key } });
    }
  }

  handleAppState(fg) {
    if (!fg) this.notifyPending();
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!fg && isNative) this.pollTimer = setInterval(() => this.poll(), BACKGROUND_POLL_MS);
  }

  async poll() {
    if (!useNativeHttp()) return;
    try {
      const value = await restGet(`incidents/${this.gid}`, await this.getIdToken());
      this.dispatch.ingestIncidents(value);
    } catch (err) {
      console.debug('Background case poll failed', err);
    }
  }

  stop() {
    clearInterval(this.pollTimer);
    clearTimeout(this.snoozeTimer);
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    for (const alert of this.pending) clearNotification(alert.key);
    this.pending = [];
    this.alarm.close();
  }
}
