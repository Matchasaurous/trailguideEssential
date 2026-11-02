// Auto-dispatch engine (group setting "Auto-assign closest unit").
//
// Runs on every phone, with no server and no dispatcher needed:
//  * Field units: for each verified, open case that still needs units, every
//    phone ranks the same candidates from the same shared data (positions,
//    presence, status and roles): free, on-duty, online units whose role
//    responds to the case, inside the group radius. Units carrying the case's
//    requested equipment (e.g. an AED) — or a vehicle, for patient transport —
//    come first, then the rest; nearest first within each. Equipment never
//    excludes a unit.
//    A phone that finds itself among the top N (N = units still needed) locks
//    itself to the case (status BUSY) and gets the assignment alarm to confirm.
//    Because every phone ranks the same data, normally exactly the closest unit
//    claims; in a rare tie both are assigned and dispatch can release one.
//  * An auto-assignment not confirmed within the group's answer time lapses: the
//    unit's own phone declines it (releasing its lock), stillNeeded() stops
//    counting it, and the next closest unit is picked.
//  * The online dispatcher with the lowest uid (the "leader") also expires
//    lapsed auto-assignments on phones that went silent, releasing their lock.
//
// Single-task lock: a unit already locked to a case, on a break or off duty is
// never a candidate. database.rules.json re-checks role, equipment and the lock
// for every self-assignment.
import { haversine } from './location.js';
import { serverNow } from './clock.js';
import { responderFit, bestEquipped, isDispatchRole } from './roles.js';
import { isStaleAuto } from './dispatch.js';

const TICK_MS = 4000;
const SETTLE_MS = 3000;            // let positions settle after a case opens
const POSITION_FRESH_MS = 120_000; // a unit must have reported its position recently
const RETRY_MS = 15_000;           // after a refused claim
const LEADER_GRACE_MS = 30_000;    // the unit's own phone gets the first chance to lapse

/**
 * Units eligible to be auto-assigned to a case: best-equipped first, then nearest.
 * @param {object} p
 *   incident, members: {uid: member}, positions: Map<uid,{lat,lng,acc,ts}>,
 *   roster: Map<uid, presence>, effectiveStatus(uid) -> {state, locked},
 *   settings (normalized), now
 * @returns {Array<{uid, distance}>}
 */
export function rankCandidates({ incident, members, positions, roster, effectiveStatus, settings, now = serverNow() }) {
  if (!incident || !Number.isFinite(incident.lat) || !Number.isFinite(incident.lng)) return [];
  const out = [];
  for (const [uid, member] of Object.entries(members || {})) {
    if (!member) continue;
    if (incident.assigned && incident.assigned[uid]) continue;      // already on it, declined or cleared
    if (incident.dismissed && incident.dismissed[uid]) continue;
    const presence = roster.get(uid);
    if (!presence || presence.prox === false || presence.tracking === false) continue;
    const pos = positions.get(uid);
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.ts) || now - pos.ts > POSITION_FRESH_MS) continue;
    const eff = effectiveStatus(uid);
    if (!eff || eff.locked || eff.state !== 'available') continue;
    if (!responderFit(incident, member, settings).ok) continue;
    const distance = haversine(pos, incident);
    if (distance - Math.min(pos.acc || 0, 50) > settings.proximityM) continue;
    out.push({ uid, distance, equipped: bestEquipped(incident, member) });
  }
  return out.sort((a, b) => (b.equipped ? 1 : 0) - (a.equipped ? 1 : 0) || a.distance - b.distance || (a.uid < b.uid ? -1 : 1));
}

/** The online dispatcher with the lowest uid does the housekeeping. */
export function leaderUid(members, roster) {
  const online = Object.entries(members || {})
    .filter(([uid, m]) => m && isDispatchRole(m.role) && roster.has(uid))
    .map(([uid]) => uid)
    .sort();
  return online[0] || null;
}

export class AutoDispatcher extends EventTarget {
  /**
   * Events: 'claimed' {incidentId}
   * @param {object} ctx  uid, dispatch, getMembers(), getPositions(), getRoster(), isDeviceProximityOn()
   */
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.dispatch = ctx.dispatch;
    this.firstSeen = new Map();   // iid -> when this phone first saw it claimable
    this.attempts = new Map();    // iid -> last claim attempt time
    this.busy = false;
    this.timer = null;
    this.onChange = () => this.evaluate();
  }

  start() {
    for (const evt of ['incidents', 'status', 'settings']) this.dispatch.addEventListener(evt, this.onChange);
    this.timer = setInterval(() => this.evaluate(), TICK_MS);
    this.evaluate();
  }

  stop() {
    for (const evt of ['incidents', 'status', 'settings']) this.dispatch.removeEventListener(evt, this.onChange);
    clearInterval(this.timer);
    this.timer = null;
  }

  async evaluate() {
    if (this.busy || !this.dispatch.incidentsLoaded || !this.dispatch.statusLoaded || !this.dispatch.settingsLoaded) return;
    this.busy = true;
    try {
      await this.lapseMine();
      await this.claim();
      await this.housekeeping();
    } catch (err) {
      console.debug('Auto-dispatch:', err.message);
    } finally {
      this.busy = false;
    }
  }

  /** My own unanswered auto-assignment past the answer time: give it to the next unit. */
  async lapseMine() {
    const lock = this.dispatch.myLock();
    if (!lock) return;
    const a = lock.assignment;
    if (isStaleAuto(a, this.dispatch.settings)) await this.dispatch.lapseAutoAssignment(lock.incident.id);
  }

  async claim() {
    const settings = this.dispatch.settings;
    const uid = this.ctx.uid;
    const live = new Set();
    if (!settings.autoAssign || !settings.proximityOn || !this.ctx.isDeviceProximityOn()) {
      this.firstSeen.clear();
      return;
    }
    if (this.dispatch.myLock()) return;
    const members = this.ctx.getMembers();
    const positions = this.ctx.getPositions();
    const roster = this.ctx.getRoster();
    const me = members[uid];
    if (!me) return;
    const now = serverNow();
    const cases = [...this.dispatch.incidents.values()]
      .filter((inc) => inc.state === 'open' && inc.type !== 'sos')
      .sort((a, b) => a.priority - b.priority || (a.createdAt || 0) - (b.createdAt || 0));
    for (const inc of cases) {
      const slots = this.dispatch.stillNeeded(inc);
      if (slots <= 0) continue;
      const ranked = rankCandidates({
        incident: inc, members, positions, roster, settings, now,
        effectiveStatus: (u) => this.dispatch.effectiveStatus(u)
      });
      const rank = ranked.findIndex((c) => c.uid === uid);
      if (rank < 0) continue;
      live.add(inc.id);
      if (!this.firstSeen.has(inc.id)) this.firstSeen.set(inc.id, Date.now());
      if (rank >= slots) continue;
      if (Date.now() - this.firstSeen.get(inc.id) < SETTLE_MS) continue;
      if (Date.now() - (this.attempts.get(inc.id) || 0) < RETRY_MS) continue;
      this.attempts.set(inc.id, Date.now());
      try {
        const ok = await this.dispatch.autoAssignSelf(inc.id, me);
        if (ok) this.dispatchEvent(new CustomEvent('claimed', { detail: { incidentId: inc.id } }));
      } catch (err) {
        console.debug('Auto-assign refused:', err.message);
      }
      return; // one case at a time: the lock now holds this unit
    }
    for (const iid of [...this.firstSeen.keys()]) if (!live.has(iid)) this.firstSeen.delete(iid);
  }

  /** Leader dispatcher: release lapsed auto-assignments of silent phones. */
  async housekeeping() {
    const members = this.ctx.getMembers();
    const roster = this.ctx.getRoster();
    if (leaderUid(members, roster) !== this.ctx.uid) return;
    const settings = this.dispatch.settings;
    const now = serverNow();
    for (const inc of this.dispatch.incidents.values()) {
      if (inc.state !== 'open' && inc.state !== 'monitoring') continue;
      for (const [uid, a] of Object.entries(inc.assigned || {})) {
        if (!isStaleAuto(a, settings, now - LEADER_GRACE_MS)) continue;
        await this.dispatch.expireAutoAssignment(inc.id, uid).catch((err) => console.debug('Expire failed:', err.message));
      }
    }
  }
}
