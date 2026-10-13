// ตัวช่วยกลางของทุกหน้า: ctx (state ปัจจุบัน), escape, toast, modal, commit, ตารางคาบ
import { DAYS, PERIODS, LUNCH, STATE_VERSION } from '../constants.js';
import * as sched from '../scheduler.js';
import { emptyState, legacyViolations } from '../store.js';
import { fsLevel, plainFromHtml, titleTextOf } from '../cell-size.js';

// ctx = สถานะรวมของแอป (หน้าทั้งหมดอ่านจากที่นี่ ไม่แก้ state ตรง ๆ — ทุกการแก้ผ่าน doOp)
//   ข้อมูลอยู่บนเซิร์ฟเวอร์ (api/) ทุก op บันทึกทันที ไม่มีฉบับร่าง
//   role 'admin' | 'viewer' (ลิงก์ดูอย่างเดียว) | 'public' (ผู้ชมทั่วไป) | 'anon' (หน้าล็อกอิน) | 'none' (ลิงก์ใช้ไม่ได้)
export const ctx = {
  role: 'admin',
  user: null,
  viewer: null, // { scope, label } เมื่อ role === 'viewer'
  adapter: null,
  api: null,
  state: emptyState(),
  legacy: [], // ข้อมูลเดิมที่เกินชั่วโมง/ชน (legacyViolations)
  conn: 'saved', // 'saved' | 'saving' | 'conflict' | 'offline' | 'error' (โหมด remote)
  settings: null, // ตั้งค่าของแอดมิน (publicMode…) จาก /api/auth/me หรือ /api/settings
  hideTeachers: false, // โหมดสาธารณะ: ซ่อนชื่อครู (ไม่มีข้อมูลครูใน state ที่ได้มา)
  publicDisabled: false, // โหมดสาธารณะถูกปิด (403 public-disabled)
  publicError: '', // เปิดโหมดสาธารณะไม่ได้ด้วยเหตุอื่น (ข้อความแสดงผู้ใช้)
  ui: { groupId: null, teacherId: null, classroomId: null, moving: null, placingSubjectId: null, viewPage: '' },
  get readOnly() {
    return this.role !== 'admin';
  },
  rerender() {},
  updateStatus() {},
  onAuthLost() {},
};

export function setState(next) {
  ctx.state = next;
  ctx.legacy = legacyViolations(next);
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
export const byId = (list, id) => (list || []).find((x) => x.id === id);

// ---------- toast ----------
export function toast(message, kind = 'success') {
  const area = document.getElementById('toast-area');
  if (!area) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  area.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
}

// ---------- modal ----------
let closeCurrent = null;
export function openModal({ title, bodyHtml, footerHtml = '', large = false }) {
  if (closeCurrent) closeCurrent();
  const root = document.getElementById('modal-root');
  const previousFocus = document.activeElement;
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${large ? 'modal-lg' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-header">
          <h2 class="modal-title" id="modal-title">${esc(title)}</h2>
          <button type="button" class="modal-close" data-close aria-label="ปิด">&times;</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
      </div>
    </div>`;
  const backdrop = root.firstElementChild;
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  function close() {
    document.removeEventListener('keydown', onKey);
    root.innerHTML = '';
    closeCurrent = null;
    if (previousFocus && previousFocus.focus) previousFocus.focus();
  }
  closeCurrent = close;
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  const first = root.querySelector('input, select, textarea, .pick-item:not(.is-disabled), .btn-primary');
  if (first) first.focus();
  return { el: root, close };
}

// ---------- แก้ข้อมูล (ทุกอย่างผ่าน op ของ js/ops.js) ----------
const msgOf = (e) => (typeof e === 'string' ? e : e?.message ?? 'เกิดข้อผิดพลาด');
const result = (raw) => ({
  ok: Boolean(raw.ok),
  errors: raw.ok ? [] : (raw.errors || []).map(msgOf),
  rawErrors: raw.ok ? [] : raw.errors || [],
  warnings: raw.warnings || [],
  legacy: !raw.ok && (raw.errors || []).some((e) => e?.type === 'legacy'),
  conflict: Boolean(raw.conflict),
  offline: Boolean(raw.offline),
  raw,
});
const failed = (message) => result({ ok: false, errors: [{ type: 'invalid', message }] });

// ทุก op บันทึกผ่านเซิร์ฟเวอร์ทันที (op เดียวต่อคำขอ)
// คืน { ok, errors:[string], warnings, legacy, conflict, offline, raw }
export async function doOp(op) {
  if (ctx.readOnly) return failed('โหมดดูอย่างเดียว แก้ไขไม่ได้');
  const dry = op.dryRun === true; // ตรวจล่วงหน้า: ไม่เขียน ไม่เปลี่ยน state/สถานะการเชื่อมต่อ
  if (!dry) {
    ctx.conn = 'saving';
    ctx.updateStatus();
  }
  let r;
  try {
    r = await ctx.adapter.apply(op);
  } catch {
    r = { ok: false, offline: true, errors: [{ type: 'network', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง' }] };
  }
  if (dry && r.ok) return result(r);
  // แสดงเฉพาะสถานะที่เซิร์ฟเวอร์ยืนยันจริง: state ในหน้าจอ = state ของ adapter เสมอ
  // (สำเร็จ = ผลที่เซิร์ฟเวอร์รับ · ล้มเหลว/409 = adapter โหลดฉบับล่าสุดจากเซิร์ฟเวอร์ให้แล้ว ไม่ค้างค่าที่ทำนายไว้)
  setState(ctx.adapter.getState());
  ctx.conn = r.ok ? 'saved' : r.conflict ? 'conflict' : r.offline ? 'offline' : 'error';
  const authLost = !r.ok && (r.errors || [])[0]?.type === 'auth' && r.status === 401;
  ctx.updateStatus();
  if (authLost) ctx.onAuthLost();
  return result(r);
}

// ส่วนที่เป็นปุ่ม/ฟอร์มแก้ไข: ไม่ใส่ลงหน้าเลยเมื่อเป็นโหมดดูอย่างเดียว (ไม่ใช่แค่ซ่อนด้วย CSS)
export const editOnly = (html) => (ctx.readOnly ? '' : html);

// ผลของ doOp ที่ล้มเหลว → ข้อความอธิบายหัวข้อ ตามชนิด (legacy / ชนพร้อมกัน / ออฟไลน์ / ทั่วไป)
export function opFailureTitle(r, fallback = 'ทำรายการไม่ได้') {
  if (r.legacy) return 'มีรายการเดิมที่เกินชั่วโมงหรือชน ต้องแก้ก่อนจึงทำรายการนี้ได้';
  if (r.conflict) return 'มีผู้แก้ไขพร้อมกัน โปรดตรวจสอบข้อมูลล่าสุด';
  if (r.offline) return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';
  return fallback;
}

export function errorListHtml(errors, title = 'ไม่สามารถทำรายการได้') {
  return `<div class="alert alert-error" role="alert"><strong>${esc(title)}</strong><ul>${errors
    .map((m) => `<li>${esc(m)}</li>`)
    .join('')}</ul></div>`;
}

export function field(label, inputHtml, { required = false, hint = '', id = '' } = {}) {
  return `<div class="field">
    <label class="field-label"${id ? ` for="${id}"` : ''}>${esc(label)}${required ? ' <span class="required">*</span>' : ''}</label>
    ${inputHtml}${hint ? `<span class="field-hint">${esc(hint)}</span>` : ''}
  </div>`;
}

export function optionsHtml(items, selected, { blank = null } = {}) {
  const opts = items.map(
    ([value, label]) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`,
  );
  if (blank !== null) opts.unshift(`<option value=""${!selected ? ' selected' : ''}>${esc(blank)}</option>`);
  return opts.join('');
}

// ---------- ตารางคาบ (แถว = วัน จ–ศ, คอลัมน์ = คาบ 1–4 | พักเที่ยง | คาบ 5–11) ----------
// cellFn(day, period) -> { cls, html, interactive }
export function gridHtml(cellFn, { wrapClass = '' } = {}) {
  const th = (p) =>
    `<th scope="col"><span class="tt-period-no">คาบ ${p.id}</span><span class="tt-period-time">${p.start}-${p.end}</span></th>`;
  const head = PERIODS.map((p) =>
    p.id === LUNCH.afterPeriod
      ? th(p) + `<th class="tt-lunch-head" scope="col">พักเที่ยง<span class="tt-period-time">${LUNCH.start}-${LUNCH.end}</span></th>`
      : th(p),
  ).join('');
  const rows = DAYS.map((d, i) => {
    const cells = PERIODS.map((p) => {
      const c = cellFn(d.id, p.id);
      const attrs = c.interactive ? ` tabindex="0" role="button" data-day="${d.id}" data-period="${p.id}"` : '';
      // ขนาดตัวอักษรตามความยาวชื่อวิชา (tt-fs-1..4) + ชนิดวิชา (type-general|type-vocational) + title เต็มเมื่อข้อความยาว
      // (ข้อความในช่องผ่าน esc มาแล้ว; title ตัดแท็กออกเหลือแต่ข้อความ/entity)
      const lvl = fsLevel(titleTextOf(c.html));
      const plain = plainFromHtml(c.html);
      const title = lvl >= 3 && plain ? ` title="${plain}"` : '';
      const type = c.type === 'general' || c.type === 'vocational' ? ` type-${c.type}` : '';
      let h = `<td class="tt-cell ${c.cls}${type} tt-fs-${lvl}"${attrs}${title}>${c.html}</td>`;
      if (p.id === LUNCH.afterPeriod && i === 0) h += `<td class="tt-lunch" rowspan="${DAYS.length}"><span class="tt-lunch-text">พักเที่ยง</span></td>`;
      return h;
    }).join('');
    return `<tr><th scope="row">${esc(d.name)}</th>${cells}</tr>`;
  }).join('');
  return `<div class="tt-wrap${wrapClass ? ` ${esc(wrapClass)}` : ''}"><table class="timetable"><thead><tr><th class="tt-day" scope="col">วัน / คาบ</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// สัญลักษณ์ชนิดวิชาหน้าชื่อในช่อง (ไม่พึ่งสีอย่างเดียว): ส = สามัญ · ช = ชีพเฉพาะ · ร = เรียนรวม (ช่องเรียนรวมใช้ ร ตัวเดียว)
export function markHtml(subject, shared = false) {
  if (shared) return '<span class="tt-mark tt-mark-shared" aria-label="เรียนรวม">ร</span>';
  if (subject?.type === 'general') return '<span class="tt-mark tt-mark-general" aria-label="วิชาสามัญ">ส</span>';
  if (subject?.type === 'vocational') return '<span class="tt-mark tt-mark-vocational" aria-label="วิชาชีพเฉพาะ">ช</span>';
  return '';
}
export const cellTypeOf = (subject) => (subject?.type === 'general' || subject?.type === 'vocational' ? subject.type : undefined);

// ผูกคลิก/Enter/Space กับช่องที่มี data-day
export function bindCells(root, handler) {
  root.querySelectorAll('[data-day]').forEach((el) => {
    const go = () => handler(Number(el.dataset.day), Number(el.dataset.period), el);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
}

export function legendHtml(items) {
  const all = {
    free: ['is-free', 'ว่าง'],
    filled: ['is-filled', 'ลงวิชาแล้ว'],
    general: ['type-general', 'วิชาสามัญ (ส)'],
    vocational: ['type-vocational', 'วิชาชีพเฉพาะ (ช)'],
    shared: ['is-shared', 'เรียนรวม (วิชาสามัญเดียวกันหลายกลุ่มเรียน)'],
    warning: ['is-warning', 'เกินชั่วโมง/สัปดาห์'],
    conflict: ['is-conflict', 'ชน'],
    level: ['is-level-mismatch', 'ระดับไม่ตรง'],
    lunch: ['is-lunch', 'พักเที่ยง'],
  };
  return `<div class="legend" aria-label="คำอธิบายสี">${items
    .map((k) => `<span class="legend-item"><span class="legend-swatch ${all[k][0]}"></span>${all[k][1]}</span>`)
    .join('')}</div>`;
}

export function pageHeader(title, actionsHtml = '') {
  return `<div class="page-header"><h1>${esc(title)}</h1><div class="row">${actionsHtml}</div></div>`;
}

export function emptyHtml(message, linkHref = '', linkText = '') {
  return `<div class="empty-state"><p>${esc(message)}</p>${
    linkHref ? `<a class="btn btn-primary" href="${esc(linkHref)}" style="text-decoration:none;display:inline-block">${esc(linkText)}</a>` : ''
  }</div>`;
}

// แสดงข้อผิดพลาดใต้ช่อง (.field-error) + ขีดแดงช่อง และรวมใน .alert ด้านบนฟอร์ม
// errs = [{ input: '#f-code', msg }] ; allInputs = ช่องทั้งหมดที่ตรวจ (ไว้ล้างสถานะเดิม)
export function showFormErrors(modalEl, errs, allInputs = []) {
  modalEl.querySelectorAll('.field-error').forEach((n) => n.remove());
  allInputs.forEach((sel) => modalEl.querySelector(sel)?.classList.remove('is-invalid'));
  for (const { input, msg } of errs) {
    const el = modalEl.querySelector(input);
    if (!el) continue;
    el.classList.add('is-invalid');
    el.setAttribute('aria-invalid', 'true');
    const note = document.createElement('span');
    note.className = 'field-error';
    note.textContent = msg;
    el.closest('.field')?.appendChild(note);
  }
  modalEl.querySelector('#form-errors').innerHTML = errs.length
    ? errorListHtml(errs.map((e) => e.msg), 'กรุณาแก้ไขข้อมูล')
    : '';
  return errs.length === 0;
}

// ป้ายชนิดการชน ตามชนิดจาก scheduler
const CONFLICT_BADGE = { group: 'ชนกลุ่มเรียน', teacher: 'ชนครู', classroom: 'ชนห้องเรียน', hours: 'เกินชั่วโมง' };
export function conflictBadge(types) {
  const t = ['group', 'teacher', 'classroom', 'hours'].find((x) => types.includes(x));
  return t ? CONFLICT_BADGE[t] : 'ชน';
}

export const levelBadges = (levels) =>
  `<span class="badge-list">${(levels || []).map((l) => `<span class="badge badge-level">${esc(l)}</span>`).join('')}</span>`;

// ---------- ครูผู้สอน (v3: หลายครูต่อวิชา; ยังอ่านรูปแบบ v2 ที่มี teacherId ได้) ----------
export const isV3 = () => STATE_VERSION >= 3;

export const subjectTeacherIds = (s) => s?.teacherIds ?? (s?.teacherId ? [s.teacherId] : []);

export function effectiveTeacherId(state, entry) {
  if (typeof sched.effectiveTeacherId === 'function') return sched.effectiveTeacherId(state, entry);
  if (entry.teacherId) return entry.teacherId;
  const ids = subjectTeacherIds(byId(state.subjects, entry.subjectId));
  return ids.length === 1 ? ids[0] : null;
}

// ชื่อครูผู้สอนทั้งหมดของวิชา คั่นด้วยจุลภาค
export function teacherNames(state, subject) {
  return subjectTeacherIds(subject).map((id) => byId(state.teachers, id)?.name ?? id).join(', ');
}

// ครูของวิชา + ว่างหรือไม่ ณ คาบนั้น -> [{teacher, ok, conflicts}]
export function availableTeachers(state, params) {
  if (typeof sched.availableTeachers === 'function') return sched.availableTeachers(state, params);
  const subject = byId(state.subjects, params.subjectId);
  return subjectTeacherIds(subject).map((id) => {
    const r = sched.checkPlacement(state, { ...params, teacherId: id });
    const conflicts = r.conflicts.filter((c) => c.type === 'teacher');
    return { teacher: byId(state.teachers, id) ?? { id, name: id }, ok: conflicts.length === 0, conflicts };
  });
}

// ลงวิชานี้ในช่องนี้ได้ไหม (วิชาหลายครู: ได้เมื่อมีครูอย่างน้อย 1 คนที่ไม่ชน)
// คืน { ok, reasons:[string], warnings:[string], teachers:[...] }
export function placeability(state, { groupId, day, period, subjectId, ignoreEntryId }) {
  const subject = byId(state.subjects, subjectId);
  const base = sched.checkPlacement(state, { groupId, day, period, subjectId, ignoreEntryId });
  const teachers = availableTeachers(state, { groupId, day, period, subjectId, ignoreEntryId });
  const reasons = base.conflicts.map((c) => c.message);
  let ok = base.ok;
  if (subjectTeacherIds(subject).length >= 2 && base.ok && !teachers.some((t) => t.ok)) {
    ok = false;
    teachers.forEach((t) => t.conflicts.forEach((c) => reasons.push(c.message)));
  }
  return { ok, reasons, warnings: base.warnings, teachers };
}

// ---------- ตัวกรอง "แสดงเฉพาะวิชาที่ลงได้" (จำค่าใน localStorage ไม่อยู่ใน state/export) ----------
const ONLY_KEY = 'timetable.ui.onlyPlaceable';
export function getOnlyPlaceable() {
  try {
    return localStorage.getItem(ONLY_KEY) !== '0';
  } catch {
    return true;
  }
}
export function setOnlyPlaceable(on) {
  try {
    localStorage.setItem(ONLY_KEY, on ? '1' : '0');
  } catch {
    // ใช้ localStorage ไม่ได้ก็ข้าม ค่าจะกลับเป็นติ้กเมื่อโหลดใหม่
  }
}
