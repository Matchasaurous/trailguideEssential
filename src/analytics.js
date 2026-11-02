// Post-event after-action analytics: metrics from the case records, plus CSV
// and PDF export.
//
// Time points for each case:
//   Reported  = createdAt (report submitted, or case opened by dispatch / SOS)
//   Verified  = verifiedAt (dispatch approved the report)
//   Accepted  = first unit to accept / start responding (assigned/*/t.accepted,
//               t.enroute or t.onscene, whichever is earliest)
//   On scene  = first unit on scene (assigned/*/t.onscene)
//   Resolved  = closedAt of a closed case
// Records from betas before 1.4 have no step times; for those the time of an
// assignment's current state is used where it applies.
//
// Unit utilisation = time a unit was committed to cases (accepted → cleared,
// declined or case closed) ÷ the report period.
import { jsPDF } from 'jspdf';
import { CASE_TYPES, ROLES, FIELD_UNITS, caseTypeLabel, profileOf, unitLabel } from './roles.js';
import { DISPOSITIONS, TRIAGE } from './epcr-format.js';

export const INTERVALS = {
  reportToVerify: 'Reported → Verified',
  reportToAccept: 'Reported → Accepted',
  acceptToOnScene: 'Accepted → On scene',
  reportToOnScene: 'Reported → On scene',
  onSceneToResolved: 'On scene → Resolved',
  reportToResolved: 'Reported → Resolved'
};

const SEVERITY = { 1: 'P1 Critical', 2: 'P2 Urgent', 3: 'P3 Routine' };

/** {n, avg, median, p90} in seconds, or n: 0. */
export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return { n: 0, avg: null, median: null, p90: null };
  const pick = (q) => {
    const pos = (v.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  };
  return { n: v.length, avg: v.reduce((a, b) => a + b, 0) / v.length, median: pick(0.5), p90: pick(0.9) };
}

function stepTime(a, key) {
  if (a && a.t && Number.isFinite(a.t[key])) return a.t[key];
  if (a && a.state === key && Number.isFinite(a.ts)) return a.ts;
  return null;
}

function minOf(list) {
  const v = list.filter(Number.isFinite);
  return v.length ? Math.min(...v) : null;
}

/** Time points of one case (ms epoch, or null). */
export function caseTimes(inc) {
  const assigns = Object.values(inc.assigned || {});
  const accepted = minOf(assigns.flatMap((a) => [stepTime(a, 'accepted'), stepTime(a, 'enroute'), stepTime(a, 'onscene')]));
  const onScene = minOf(assigns.map((a) => stepTime(a, 'onscene')));
  return {
    reported: Number.isFinite(inc.createdAt) ? inc.createdAt : null,
    verified: Number.isFinite(inc.verifiedAt) ? inc.verifiedAt : null,
    accepted,
    onScene,
    resolved: inc.state === 'closed' && Number.isFinite(inc.closedAt) ? inc.closedAt : null
  };
}

const secs = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null);

function intervalsOf(t, inc) {
  return {
    // Only reports that went through review have a verification delay.
    reportToVerify: inc.verifiedBy && inc.verifiedBy !== inc.createdBy ? secs(t.reported, t.verified) : null,
    reportToAccept: secs(t.reported, t.accepted),
    acceptToOnScene: secs(t.accepted, t.onScene),
    reportToOnScene: secs(t.reported, t.onScene),
    onSceneToResolved: secs(t.onScene, t.resolved),
    reportToResolved: secs(t.reported, t.resolved)
  };
}

function rolesOnCase(inc, members) {
  const roles = new Set();
  for (const [uid, a] of Object.entries(inc.assigned || {})) {
    if (a.state === 'declined') continue;
    const role = FIELD_UNITS.includes(a.unit) ? a.unit : profileOf(members[uid]).unit;
    if (role) roles.add(role);
  }
  return roles;
}

/**
 * Compute the after-action report.
 * @param {object} p
 *   incidents: Map|object of case records, members: {uid: member}, epcr: raw epcr/{gid} tree (optional),
 *   from, to: ms epoch range on case creation (optional), now
 */
export function computeAnalytics({ incidents, members = {}, epcr = null, from = null, to = null, now = Date.now() }) {
  const all = (incidents instanceof Map ? [...incidents.values()] : Object.entries(incidents || {}).map(([id, v]) => ({ id, ...v })))
    .filter((inc) => inc && Number.isFinite(inc.createdAt));
  const start = Number.isFinite(from) ? from : (all.length ? Math.min(...all.map((i) => i.createdAt)) : now);
  const end = Number.isFinite(to) ? to : now;
  const cases = all.filter((inc) => inc.createdAt >= start && inc.createdAt <= end).sort((a, b) => a.createdAt - b.createdAt);
  const periodS = Math.max(60, (end - start) / 1000);

  const totals = { cases: cases.length, sos: 0, reports: 0, verified: 0, rejected: 0, withdrawn: 0, open: 0, closed: 0, autoAssigned: 0, autoLapsed: 0 };
  const bySeverity = { 1: 0, 2: 0, 3: 0 };
  const byType = {};
  const byRole = Object.fromEntries([...FIELD_UNITS, 'none'].map((r) => [r, 0]));
  const intervalLists = Object.fromEntries(Object.keys(INTERVALS).map((k) => [k, []]));
  const bySeverityLists = { 1: {}, 2: {}, 3: {} };
  const byRoleLists = Object.fromEntries(FIELD_UNITS.map((r) => [r, {}]));
  const unitMap = new Map();
  const rows = [];

  const push = (target, key, value) => {
    if (value === null) return;
    (target[key] = target[key] || []).push(value);
  };

  for (const inc of cases) {
    const reviewed = inc.type !== 'sos' && inc.verifiedBy && inc.verifiedBy !== inc.createdBy;
    if (inc.type === 'sos') totals.sos += 1;
    // A field report is any non-SOS case not opened directly by its creator (dispatch or a fire / transport unit).
    if (inc.type !== 'sos' && inc.verifiedBy !== inc.createdBy) totals.reports += 1;
    if (reviewed) totals.verified += 1;
    if (inc.state === 'rejected') totals.rejected += 1;
    if (inc.state === 'closed' && inc.closedBy === inc.createdBy && !inc.verifiedBy && inc.type !== 'sos') totals.withdrawn += 1;
    if (inc.state === 'open' || inc.state === 'monitoring' || inc.state === 'pending') totals.open += 1;
    if (inc.state === 'closed') totals.closed += 1;
    if (SEVERITY[inc.priority]) bySeverity[inc.priority] += 1;
    byType[inc.type] = (byType[inc.type] || 0) + 1;
    const roles = rolesOnCase(inc, members);
    if (!roles.size) byRole.none += 1;
    for (const r of roles) byRole[r] += 1;

    const t = caseTimes(inc);
    const iv = intervalsOf(t, inc);
    for (const [k, v] of Object.entries(iv)) {
      if (v === null) continue;
      intervalLists[k].push(v);
      if (bySeverityLists[inc.priority]) push(bySeverityLists[inc.priority], k, v);
      for (const r of roles) push(byRoleLists[r], k, v);
    }

    const responders = [];
    for (const [uid, a] of Object.entries(inc.assigned || {})) {
      if (a.by === 'auto') totals.autoAssigned += 1;
      if (a.reason === 'timeout') totals.autoLapsed += 1;
      const role = FIELD_UNITS.includes(a.unit) ? a.unit : profileOf(members[uid]).unit;
      let u = unitMap.get(uid);
      if (!u) {
        u = { uid, name: (members[uid] && members[uid].name) || a.name || 'Member', role, cases: 0, declined: 0, timeouts: 0, busyS: 0, acceptDelays: [], responseTimes: [] };
        unitMap.set(uid, u);
      }
      if (!u.role && role) u.role = role;
      if (a.state === 'declined') {
        u.declined += 1;
        if (a.reason === 'timeout') u.timeouts += 1;
      } else {
        u.cases += 1;
        responders.push(`${a.name}${role ? ` (${ROLES[role].short})` : ''}`);
      }
      const begin = minOf([stepTime(a, 'accepted'), stepTime(a, 'enroute'), stepTime(a, 'onscene')]);
      if (begin !== null && a.state !== 'declined') {
        const stop = minOf([stepTime(a, 'cleared'), inc.state === 'closed' ? inc.closedAt : null]) ?? Math.min(now, end);
        const s = secs(Math.max(begin, start), Math.min(stop, end));
        if (s !== null) u.busyS += s;
        const assignedAt = stepTime(a, 'assigned');
        const delay = secs(assignedAt, minOf([stepTime(a, 'accepted'), stepTime(a, 'enroute')]));
        if (delay !== null) u.acceptDelays.push(delay);
        const resp = secs(begin, stepTime(a, 'onscene'));
        if (resp !== null) u.responseTimes.push(resp);
      }
    }

    rows.push({
      id: inc.id,
      created: inc.createdAt,
      type: inc.type,
      severity: inc.priority,
      state: inc.state,
      title: inc.title || '',
      reportedBy: inc.createdByName || '',
      verifiedBy: inc.verifiedByName || '',
      requires: Object.keys(inc.requires || {}).join(' '),
      ...t,
      ...iv,
      responders: responders.join('; '),
      lat: Number.isFinite(inc.lat) ? inc.lat : null,
      lng: Number.isFinite(inc.lng) ? inc.lng : null
    });
  }

  const times = Object.fromEntries(Object.entries(intervalLists).map(([k, v]) => [k, stats(v)]));
  const timesBySeverity = Object.fromEntries(Object.entries(bySeverityLists).map(([s, lists]) => [s,
    Object.fromEntries(Object.keys(INTERVALS).map((k) => [k, stats(lists[k] || [])]))]));
  const timesByRole = Object.fromEntries(Object.entries(byRoleLists).map(([r, lists]) => [r,
    Object.fromEntries(Object.keys(INTERVALS).map((k) => [k, stats(lists[k] || [])]))]));

  // Field units with a role count towards utilisation even if they had no case.
  for (const [uid, m] of Object.entries(members)) {
    const role = profileOf(m).unit;
    if (!role || unitMap.has(uid)) continue;
    unitMap.set(uid, { uid, name: m.name || 'Member', role, cases: 0, declined: 0, timeouts: 0, busyS: 0, acceptDelays: [], responseTimes: [] });
  }
  const units = [...unitMap.values()].map((u) => ({
    uid: u.uid,
    name: u.name,
    role: u.role,
    cases: u.cases,
    declined: u.declined,
    timeouts: u.timeouts,
    busyS: Math.round(u.busyS),
    utilisation: Math.min(1, u.busyS / periodS),
    avgAcceptDelayS: stats(u.acceptDelays).avg,
    avgResponseS: stats(u.responseTimes).avg
  })).sort((a, b) => b.cases - a.cases || b.busyS - a.busyS || a.name.localeCompare(b.name));
  const active = units.filter((u) => u.cases > 0);
  const utilisation = {
    unitsWithRole: units.length,
    activeUnits: active.length,
    avgUtilisation: units.length ? units.reduce((s, u) => s + u.utilisation, 0) / units.length : 0,
    avgUtilisationActive: active.length ? active.reduce((s, u) => s + u.utilisation, 0) / active.length : 0,
    busiest: active[0] ? active[0].name : null
  };

  let patients = null;
  if (epcr && typeof epcr === 'object') {
    const caseIds = new Set(cases.map((c) => c.id));
    patients = { total: 0, byDisposition: {}, byTriage: {}, open: 0 };
    for (const [iid, perCase] of Object.entries(epcr)) {
      if (!caseIds.has(iid) || !perCase) continue;
      for (const rec of Object.values(perCase)) {
        const info = rec && rec.info;
        if (!info) continue;
        patients.total += 1;
        if (info.status !== 'closed') patients.open += 1;
        const d = info.disposition || 'undecided';
        patients.byDisposition[d] = (patients.byDisposition[d] || 0) + 1;
        if (info.triage) patients.byTriage[info.triage] = (patients.byTriage[info.triage] || 0) + 1;
      }
    }
  }

  return { range: { from: start, to: end, hours: periodS / 3600 }, totals, bySeverity, byType, byRole, times, timesBySeverity, timesByRole, units, utilisation, patients, rows, generatedAt: now };
}

/* ============================== Formatting ============================== */

export function formatSeconds(s) {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const pct = (x) => `${Math.round((x || 0) * 100)}%`;

function iso(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : '';
}

function local(ts) {
  return Number.isFinite(ts) ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}

/** One CSV cell: quoted, and protected against spreadsheet formula injection. */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvRow = (cells) => cells.map(csvCell).join(',');
const round1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : '');

/** Whole report as CSV (summary, response times, breakdowns, units, cases). */
export function toCsv(report, { groupName = '' } = {}) {
  const lines = [];
  lines.push(csvRow(['Trailguard Essentials after-action report', groupName]));
  lines.push(csvRow(['Period start', iso(report.range.from)]));
  lines.push(csvRow(['Period end', iso(report.range.to)]));
  lines.push(csvRow(['Generated', iso(report.generatedAt)]));
  lines.push('');
  lines.push(csvRow(['Metric', 'Value']));
  const t = report.totals;
  for (const [label, v] of [['Total cases', t.cases], ['SOS', t.sos], ['Field reports', t.reports], ['Verified after review', t.verified],
    ['Rejected', t.rejected], ['Withdrawn', t.withdrawn], ['Resolved / closed', t.closed], ['Still open', t.open],
    ['Auto-assignments', t.autoAssigned], ['Auto-assignments not answered', t.autoLapsed],
    ['Units with a role', report.utilisation.unitsWithRole], ['Units that responded', report.utilisation.activeUnits],
    ['Average utilisation (all units)', pct(report.utilisation.avgUtilisation)], ['Average utilisation (responding units)', pct(report.utilisation.avgUtilisationActive)]]) {
    lines.push(csvRow([label, v]));
  }
  if (report.patients) {
    lines.push(csvRow(['Patients (ePCR)', report.patients.total]));
    for (const [d, n] of Object.entries(report.patients.byDisposition)) lines.push(csvRow([`Patients — ${DISPOSITIONS[d] || 'Undecided'}`, n]));
    for (const [d, n] of Object.entries(report.patients.byTriage)) lines.push(csvRow([`Triage — ${TRIAGE[d] || d}`, n]));
  }
  lines.push('');
  lines.push(csvRow(['Response time', 'Cases', 'Average (s)', 'Median (s)', '90th percentile (s)']));
  for (const [k, label] of Object.entries(INTERVALS)) {
    const s = report.times[k];
    lines.push(csvRow([label, s.n, round1(s.avg), round1(s.median), round1(s.p90)]));
  }
  lines.push('');
  lines.push(csvRow(['Severity', 'Cases', 'Avg reported→accepted (s)', 'Avg reported→on scene (s)', 'Avg reported→resolved (s)']));
  for (const s of [1, 2, 3]) {
    const ts = report.timesBySeverity[s];
    lines.push(csvRow([SEVERITY[s], report.bySeverity[s], round1(ts.reportToAccept.avg), round1(ts.reportToOnScene.avg), round1(ts.reportToResolved.avg)]));
  }
  lines.push('');
  lines.push(csvRow(['Role', 'Cases', 'Avg reported→accepted (s)', 'Avg accepted→on scene (s)', 'Avg reported→resolved (s)']));
  for (const r of FIELD_UNITS) {
    const ts = report.timesByRole[r];
    lines.push(csvRow([ROLES[r].label, report.byRole[r], round1(ts.reportToAccept.avg), round1(ts.acceptToOnScene.avg), round1(ts.reportToResolved.avg)]));
  }
  lines.push(csvRow(['No unit assigned', report.byRole.none]));
  lines.push('');
  lines.push(csvRow(['Case type', 'Cases']));
  for (const [type, n] of Object.entries(report.byType)) lines.push(csvRow([caseTypeLabel(type), n]));
  lines.push('');
  lines.push(csvRow(['Unit', 'Role', 'Cases', 'Declined', 'Not answered (auto)', 'Committed time (min)', 'Utilisation', 'Avg time to accept (s)', 'Avg accepted→on scene (s)']));
  for (const u of report.units) {
    lines.push(csvRow([u.name, u.role ? unitLabel(u.role) : '', u.cases, u.declined, u.timeouts, round1(u.busyS / 60), pct(u.utilisation), round1(u.avgAcceptDelayS), round1(u.avgResponseS)]));
  }
  lines.push('');
  lines.push(csvRow(['Case ID', 'Reported', 'Type', 'Severity', 'Status', 'Title', 'Reported by', 'Verified by', 'Required equipment',
    'Verified', 'Accepted', 'On scene', 'Resolved', 'Reported→Accepted (s)', 'Accepted→On scene (s)', 'Reported→Resolved (s)', 'Responders', 'Latitude', 'Longitude']));
  for (const r of report.rows) {
    lines.push(csvRow([r.id, iso(r.created), caseTypeLabel(r.type), SEVERITY[r.severity] || '', r.state, r.title, r.reportedBy, r.verifiedBy, r.requires,
      iso(r.verified), iso(r.accepted), iso(r.onScene), iso(r.resolved), round1(r.reportToAccept), round1(r.acceptToOnScene), round1(r.reportToResolved),
      r.responders, r.lat ?? '', r.lng ?? '']));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/* ============================== PDF ============================== */

const PAGE = { w: 210, h: 297, margin: 14 };
const ACCENT = [229, 38, 43];
const INK = [24, 28, 32];
const MUTED = [110, 118, 125];
const RULE = [215, 219, 222];

/** jsPDF's built-in fonts cover Windows-1252 only: map the few other characters we use. */
function pdfSafe(text) {
  return String(text).replace(/→/g, '->').replace(/[‐-‒]/g, '-').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, '?');
}

function pdfText(doc, text, x, y, { size = 9, color = INK, bold = false, align = 'left', maxWidth } = {}) {
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.setFontSize(size);
  doc.setTextColor(...color);
  doc.text(pdfSafe(text), x, y, { align, maxWidth });
}

/** Simple table with header row, wrapping text and page breaks. Returns the new y. */
function pdfTable(doc, y, columns, rows, { title } = {}) {
  const width = PAGE.w - PAGE.margin * 2;
  const total = columns.reduce((s, c) => s + c.w, 0);
  const widths = columns.map((c) => (c.w / total) * width);
  const lineH = 3.8;
  const ensure = (needed) => {
    if (y + needed > PAGE.h - PAGE.margin) {
      doc.addPage();
      y = PAGE.margin + 4;
      return true;
    }
    return false;
  };
  if (title) {
    ensure(16);
    pdfText(doc, title, PAGE.margin, y, { size: 11, bold: true });
    y += 5;
  }
  const header = () => {
    doc.setFillColor(242, 244, 245);
    doc.rect(PAGE.margin, y - 3.2, width, 5.4, 'F');
    let x = PAGE.margin;
    columns.forEach((c, i) => {
      pdfText(doc, c.label, c.align === 'right' ? x + widths[i] - 1.5 : x + 1.5, y, { size: 7.5, bold: true, color: MUTED, align: c.align || 'left' });
      x += widths[i];
    });
    y += 4.6;
  };
  header();
  doc.setFontSize(8);
  for (const row of rows) {
    const cells = row.map((cell, i) => doc.splitTextToSize(pdfSafe(cell ?? ''), widths[i] - 3));
    const h = Math.max(...cells.map((c) => c.length)) * lineH + 1.4;
    if (ensure(h + 2)) header();
    let x = PAGE.margin;
    cells.forEach((lines, i) => {
      const c = columns[i];
      lines.forEach((line, li) => {
        pdfText(doc, line, c.align === 'right' ? x + widths[i] - 1.5 : x + 1.5, y + li * lineH, { size: 8, align: c.align || 'left' });
      });
      x += widths[i];
    });
    y += h;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.2);
    doc.line(PAGE.margin, y - 2.6, PAGE.margin + width, y - 2.6);
  }
  return y + 4;
}

/** After-action report as a PDF (jsPDF document; call .output('blob') or .save()). */
export function toPdf(report, { groupName = '' } = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  let y = PAGE.margin + 6;
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE.w, 4, 'F');
  pdfText(doc, 'After-action report', PAGE.margin, y, { size: 18, bold: true });
  y += 6;
  pdfText(doc, `${groupName || 'Trailguard Essentials'} · ${local(report.range.from)} – ${local(report.range.to)} (${report.range.hours.toFixed(1)} h)`, PAGE.margin, y, { size: 9, color: MUTED });
  y += 4;
  pdfText(doc, `Generated ${local(report.generatedAt)} by Trailguard Essentials`, PAGE.margin, y, { size: 8, color: MUTED });
  y += 8;

  // KPI tiles.
  const t = report.totals;
  const tiles = [
    ['Total cases', String(t.cases)],
    ['Resolved', String(t.closed)],
    ['Avg to accept', formatSeconds(report.times.reportToAccept.avg)],
    ['Avg to on scene', formatSeconds(report.times.reportToOnScene.avg)],
    ['Avg to resolve', formatSeconds(report.times.reportToResolved.avg)],
    ['Unit utilisation', pct(report.utilisation.avgUtilisationActive)]
  ];
  const tileW = (PAGE.w - PAGE.margin * 2 - 5 * 3) / 6;
  tiles.forEach(([label, value], i) => {
    const x = PAGE.margin + i * (tileW + 3);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.3);
    doc.roundedRect(x, y, tileW, 17, 1.5, 1.5, 'S');
    pdfText(doc, label, x + 2.5, y + 5, { size: 7, color: MUTED });
    pdfText(doc, value, x + 2.5, y + 12.5, { size: value.length > 9 ? 9.5 : 12, bold: true });
  });
  y += 25;

  y = pdfTable(doc, y, [
    { label: 'Interval', w: 40 }, { label: 'Cases', w: 12, align: 'right' }, { label: 'Average', w: 20, align: 'right' },
    { label: 'Median', w: 20, align: 'right' }, { label: '90th pct', w: 20, align: 'right' }
  ], Object.entries(INTERVALS).map(([k, label]) => {
    const s = report.times[k];
    return [label, s.n, formatSeconds(s.avg), formatSeconds(s.median), formatSeconds(s.p90)];
  }), { title: 'Response times' });

  y = pdfTable(doc, y, [
    { label: 'Severity', w: 26 }, { label: 'Cases', w: 12, align: 'right' }, { label: 'Reported→Accepted', w: 24, align: 'right' },
    { label: 'Reported→On scene', w: 24, align: 'right' }, { label: 'Reported→Resolved', w: 24, align: 'right' }
  ], [1, 2, 3].map((s) => {
    const ts = report.timesBySeverity[s];
    return [SEVERITY[s], report.bySeverity[s], formatSeconds(ts.reportToAccept.avg), formatSeconds(ts.reportToOnScene.avg), formatSeconds(ts.reportToResolved.avg)];
  }), { title: 'By severity (averages)' });

  y = pdfTable(doc, y, [
    { label: 'Role', w: 26 }, { label: 'Cases', w: 12, align: 'right' }, { label: 'Reported→Accepted', w: 24, align: 'right' },
    { label: 'Accepted→On scene', w: 24, align: 'right' }, { label: 'Reported→Resolved', w: 24, align: 'right' }
  ], [...FIELD_UNITS.map((r) => {
    const ts = report.timesByRole[r];
    return [ROLES[r].label, report.byRole[r], formatSeconds(ts.reportToAccept.avg), formatSeconds(ts.acceptToOnScene.avg), formatSeconds(ts.reportToResolved.avg)];
  }), ['No unit assigned', report.byRole.none, '', '', '']], { title: 'By responding role (averages)' });

  const types = Object.entries(report.byType).sort((a, b) => b[1] - a[1]);
  y = pdfTable(doc, y, [{ label: 'Case type', w: 60 }, { label: 'Cases', w: 15, align: 'right' }, { label: 'Share', w: 15, align: 'right' }],
    types.map(([type, n]) => [caseTypeLabel(type), n, pct(t.cases ? n / t.cases : 0)]), { title: 'Case types' });

  y = pdfTable(doc, y, [
    { label: 'Metric', w: 60 }, { label: 'Value', w: 30, align: 'right' }
  ], [
    ['SOS raised', t.sos], ['Field reports', t.reports], ['Verified after review', t.verified], ['Rejected', t.rejected],
    ['Withdrawn by reporter', t.withdrawn], ['Still open at end of period', t.open],
    ['Auto-assignments', t.autoAssigned], ['Auto-assignments not answered in time', t.autoLapsed],
    ...(report.patients ? [['Patients recorded (ePCR)', report.patients.total],
      ...Object.entries(report.patients.byDisposition).map(([d, n]) => [`  ${DISPOSITIONS[d] || 'Disposition not recorded'}`, n]),
      ...Object.entries(report.patients.byTriage).map(([d, n]) => [`  Triage ${TRIAGE[d] || d}`, n])] : [])
  ], { title: 'Case handling' });

  y = pdfTable(doc, y, [
    { label: 'Unit', w: 30 }, { label: 'Role', w: 22 }, { label: 'Cases', w: 11, align: 'right' }, { label: 'Declined', w: 13, align: 'right' },
    { label: 'Committed', w: 18, align: 'right' }, { label: 'Utilisation', w: 16, align: 'right' }, { label: 'Avg to scene', w: 18, align: 'right' }
  ], report.units.map((u) => [u.name, u.role ? unitLabel(u.role) : '—', u.cases, u.declined, formatSeconds(u.busyS), pct(u.utilisation), formatSeconds(u.avgResponseS)]),
  { title: `Unit utilisation (${report.utilisation.activeUnits} of ${report.utilisation.unitsWithRole} units responded)` });

  pdfTable(doc, y, [
    { label: 'Reported', w: 17 }, { label: 'Type', w: 22 }, { label: 'Sev', w: 8 }, { label: 'Title', w: 40 }, { label: 'Status', w: 14 },
    { label: 'To accept', w: 15, align: 'right' }, { label: 'To scene', w: 15, align: 'right' }, { label: 'To resolve', w: 15, align: 'right' }, { label: 'Responders', w: 34 }
  ], report.rows.map((r) => [local(r.created), CASE_TYPES[r.type] ? CASE_TYPES[r.type].label : r.type, `P${r.severity}`, r.title, r.state,
    formatSeconds(r.reportToAccept), formatSeconds(r.reportToOnScene), formatSeconds(r.reportToResolved), r.responders]), { title: 'Case log' });

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    pdfText(doc, `Trailguard Essentials · ${groupName} · page ${i} of ${pages}`, PAGE.w / 2, PAGE.h - 7, { size: 7, color: MUTED, align: 'center' });
  }
  return doc;
}
