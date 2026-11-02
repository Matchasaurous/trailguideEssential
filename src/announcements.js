// Broadcast announcements: dispatch sends a short message to everyone or to one
// role (Security, Medical, Fire & Safety, Ushers / Marshals, or dispatchers);
// Fire & Safety units send fire rapid alerts. Each recipient acknowledges, and
// dispatch sees who has. Levels: info, urgent, critical (critical sounds the
// alarm through silent mode on Android, like an SOS).
import { ref, set, push, remove, onValue, query, limitToLast, serverTimestamp } from 'firebase/database';
import { db } from './firebase.js';
import { serverNow } from './clock.js';
import { profileOf, isDispatchRole, ROLES } from './roles.js';

export const LEVELS = {
  info: { label: 'Info' },
  urgent: { label: 'Urgent' },
  critical: { label: 'Critical' }
};

export const AUDIENCES = {
  all: 'Everyone',
  security: ROLES.security.label,
  medical: ROLES.medical.label,
  fire: ROLES.fire.label,
  usher: ROLES.usher.label,
  dispatch: 'Dispatchers'
};

const KEEP = 50;
const ALERT_WINDOW_MS = 6 * 3600 * 1000;   // older announcements no longer alert

/** Is this announcement meant for this member? Dispatchers see every announcement. */
export function isForMember(announcement, member) {
  if (!announcement || !member) return false;
  if (isDispatchRole(member.role)) return true;
  if (announcement.audience === 'all') return true;
  if (announcement.audience === 'dispatch') return false;
  return profileOf(member).unit === announcement.audience;
}

export class AnnouncementCenter extends EventTarget {
  /**
   * Events: 'change' {list}
   * @param {{gid, uid, name, getMe: () => member}} opts
   */
  constructor({ gid, uid, name, getMe }) {
    super();
    this.gid = gid;
    this.uid = uid;
    this.name = name;
    this.getMe = getMe;
    this.list = [];
    this.localAcks = new Set();
    this.unsub = null;
  }

  start() {
    this.unsub = onValue(query(ref(db, `announcements/${this.gid}`), limitToLast(KEEP)), (snap) => {
      const list = [];
      snap.forEach((child) => {
        const v = child.val();
        if (v && typeof v.text === 'string') list.push({ id: child.key, ...v });
      });
      this.list = list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      this.dispatchEvent(new CustomEvent('change', { detail: { list: this.list } }));
    }, () => {});
  }

  stop() {
    if (this.unsub) this.unsub();
    this.unsub = null;
  }

  acked(a) {
    return this.localAcks.has(a.id) || !!(a.acks && a.acks[this.uid]);
  }

  /** Announcements waiting for my acknowledgement, newest first. */
  pendingForMe() {
    const me = this.getMe();
    const now = serverNow();
    return this.list.filter((a) => a.by !== this.uid && !this.acked(a) && now - (a.ts || 0) < ALERT_WINDOW_MS && isForMember(a, me));
  }

  /** Everything addressed to me (or sent by me), newest first, for the announcements list. */
  visibleToMe() {
    const me = this.getMe();
    return this.list.filter((a) => a.by === this.uid || isForMember(a, me));
  }

  async send({ text, level = 'info', audience = 'all', kind = 'general', caseId = null, lat = null, lng = null }) {
    const clean = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 280);
    if (!clean) throw new Error('Write the announcement first.');
    if (!LEVELS[level]) throw new Error('Choose a level.');
    if (!AUDIENCES[audience]) throw new Error('Choose who receives it.');
    const node = push(ref(db, `announcements/${this.gid}`));
    const record = {
      by: this.uid,
      name: this.name,
      text: clean,
      level,
      audience,
      kind: kind === 'fire' ? 'fire' : 'general',
      ts: serverTimestamp()
    };
    if (caseId && /^[A-Za-z0-9_-]{1,64}$/.test(caseId)) record.caseId = caseId;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      record.lat = Math.round(lat * 1e6) / 1e6;
      record.lng = Math.round(lng * 1e6) / 1e6;
    }
    await set(node, record);
    return { id: node.key, ...record };
  }

  async ack(id) {
    this.localAcks.add(id);
    this.dispatchEvent(new CustomEvent('change', { detail: { list: this.list } }));
    await set(ref(db, `announcements/${this.gid}/${id}/acks/${this.uid}`), serverTimestamp()).catch((err) => {
      console.warn('Acknowledgement not saved', err);
    });
  }

  async remove(id) {
    await remove(ref(db, `announcements/${this.gid}/${id}`));
  }
}
