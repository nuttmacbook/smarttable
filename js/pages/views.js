// มุมมองอ่านอย่างเดียว: ตารางรายกลุ่มเรียน / รายครู / รายห้องเรียน (พิมพ์ได้) + ตัวสร้างตารางที่ใช้ร่วมกับหน้าสาธารณะ
// รายการเลือกกลุ่ม/ครู/ห้อง เป็นรายการค้นหาได้ (list-kit)
import { canMerge } from '../scheduler.js';
import {
  ctx, esc, byId, gridHtml, legendHtml, pageHeader, emptyHtml, conflictBadge, effectiveTeacherId, markHtml, cellTypeOf,
} from './util.js';
import { mountPickList } from './list-kit.js';
import { recallLast } from './combobox.js';

export const printBtn = '<button type="button" class="btn" id="btn-print">พิมพ์</button>';
// เรียนรวม = วิชาสามัญเดียวกัน วัน+คาบเดียวกัน มีกลุ่มเรียนอื่นด้วย
const sharedAt = (state, e) => {
  const s = byId(state.subjects, e.subjectId);
  return Boolean(s && s.type === 'general' && state.entries.some((o) => o.id !== e.id && o.subjectId === e.subjectId && o.day === e.day && o.period === e.period && o.groupId !== e.groupId));
};
const TOTAL_SLOTS = 11 * 5;
const FREE = { cls: 'is-free is-readonly', html: '<span class="tt-cell-sub">ว่าง</span>' };

// ช่องของมุมมองที่ "หลายรายการอยู่คาบเดียวกันได้" (รายครู/รายห้องเรียน)
// list = entries ในช่องนั้น; clashType = ชนิดที่ถือว่าชนถ้ามีหลายรายการและไม่ใช่เรียนรวม
function multiCell(state, list, clashType, subLabel) {
  if (!list.length) return FREE;
  const subjects = [...new Set(list.map((e) => e.subjectId))].map((id) => byId(state.subjects, id));
  const mergedOk = list.length === 1 || (subjects.length === 1 && canMerge(subjects[0], subjects[0]));
  const cls = mergedOk ? (list.length > 1 ? 'is-filled is-shared' : 'is-filled') : 'is-conflict';
  const rooms = [...new Set(list.map((e) => byId(state.rooms, e.roomId)?.name).filter(Boolean))];
  const badge = !mergedOk
    ? `<span class="tt-cell-badge">${conflictBadge([clashType])}</span>`
    : list.length > 1 ? '<span class="tt-cell-badge">เรียนรวม</span>' : '';
  return {
    cls: `${cls} is-readonly`,
    type: subjects.length === 1 ? cellTypeOf(subjects[0]) : undefined,
    html: `<span class="tt-cell-title">${subjects.length === 1 ? markHtml(subjects[0], mergedOk && list.length > 1) : ''}${esc(subjects.map((s) => s?.name ?? '?').join(' / '))}</span>
      <span class="tt-cell-sub">${esc(subLabel(list))}</span>
      ${rooms.map((r) => `<span class="tt-cell-room">${esc(r)}</span>`).join('')}${badge}`,
  };
}

const groupNames = (state) => (list) => [...new Set(list.map((e) => byId(state.groups, e.groupId)?.name ?? e.groupId))].join(', ');

// สร้างตารางหนึ่งรายการ (ใช้ร่วมกับหน้าสาธารณะ): คืน { title, meta (ข้อความล้วน), legend:[…], cell } หรือ null ถ้าไม่พบ
// ctx.hideTeachers (โหมดสาธารณะซ่อนชื่อครู) → ไม่แสดงบรรทัดครู
export function buildTimetableView(state, kind, id) {
  if (kind === 'group') {
    const group = byId(state.groups, id);
    if (!group) return null;
    const entries = state.entries.filter((e) => e.groupId === group.id);
    return {
      title: `ตารางเรียน กลุ่มเรียน ${group.name}`,
      meta: `${group.level} ${group.major ?? ''} · ลงแล้ว ${entries.length} คาบ ว่าง ${TOTAL_SLOTS - entries.length} คาบ (จาก ${TOTAL_SLOTS} คาบ/สัปดาห์)`,
      legend: ['free', 'general', 'vocational', 'shared', 'lunch'],
      cell: (day, period) => {
        const e = entries.find((x) => x.day === day && x.period === period);
        if (!e) return FREE;
        const s = byId(state.subjects, e.subjectId);
        const t = byId(state.teachers, effectiveTeacherId(state, e));
        const room = byId(state.rooms, e.roomId);
        return {
          cls: 'is-filled is-readonly',
          type: cellTypeOf(s),
          html: `<span class="tt-cell-title">${markHtml(s, sharedAt(state, e))}${esc(s ? s.name : e.subjectId)}</span>
            ${ctx.hideTeachers ? '' : `<span class="tt-cell-sub">${esc(t ? t.name : 'ยังไม่กำหนดครู')}</span>`}
            ${room ? `<span class="tt-cell-room">${esc(room.name)}</span>` : ''}`,
        };
      },
    };
  }
  if (kind === 'teacher') {
    const teacher = byId(state.teachers, id);
    if (!teacher || ctx.hideTeachers) return null;
    // รายครู: นับตามครูที่มีผลของแต่ละคาบ (effectiveTeacherId) รวมทุกกลุ่มเรียน
    const entries = state.entries.filter((e) => effectiveTeacherId(state, e) === teacher.id);
    const mine = new Set(entries.map((e) => e.subjectId));
    return {
      title: `ตารางสอน ครู${teacher.name}`,
      meta: `${teacher.dept ?? ''} · สอน ${entries.length} คาบ/สัปดาห์ (${mine.size} วิชา)`,
      legend: ['free', 'general', 'vocational', 'shared', 'conflict', 'lunch'],
      cell: (day, period) => multiCell(state, entries.filter((e) => e.day === day && e.period === period), 'teacher', groupNames(state)),
    };
  }
  if (kind === 'classroom') {
    const room = byId(state.rooms, id);
    if (!room) return null;
    const entries = state.entries.filter((e) => e.roomId === room.id);
    return {
      title: `ตารางการใช้ห้องเรียน ${room.name}`,
      meta: `${room.building ?? ''}${room.capacity ? ` · ความจุ ${room.capacity} คน` : ''} · ใช้ ${entries.length} คาบ ว่าง ${TOTAL_SLOTS - entries.length} คาบ (จาก ${TOTAL_SLOTS} คาบ/สัปดาห์)`,
      legend: ['free', 'general', 'vocational', 'shared', 'conflict', 'lunch'],
      cell: (day, period) => multiCell(state, entries.filter((e) => e.day === day && e.period === period), 'classroom', groupNames(state)),
    };
  }
  return null;
}

// รายการที่เลือกได้ของแต่ละชนิด: [{ id, label, detail }]
export function pickItems(state, kind) {
  if (kind === 'group') return state.groups.map((g) => ({ id: g.id, label: g.name, detail: `${g.level} ${g.major ?? ''}`.trim() }));
  if (kind === 'teacher') return (state.teachers || []).map((t) => ({ id: t.id, label: t.name, detail: t.dept ?? '' }));
  if (kind === 'classroom') return state.rooms.map((r) => ({ id: r.id, label: r.name, detail: r.building ?? '' }));
  return [];
}

// โครงหน้า: ตัวเลือก (ค้นหาได้) + ตารางของรายการที่เลือก
function renderKindView(root, { kind, title, uiKey, emptyMsg, emptyLink, emptyLinkText, listName, placeholder }) {
  const { state, ui } = ctx;
  const items = pickItems(state, kind);
  if (!items.length) {
    root.innerHTML = pageHeader(title) + emptyHtml(emptyMsg, emptyLink, emptyLinkText);
    return;
  }
  if (!items.some((i) => i.id === ui[uiKey])) ui[uiKey] = recallLast(listName, items) || items[0].id;
  const view = buildTimetableView(state, kind, ui[uiKey]);
  root.innerHTML = `
    ${pageHeader(view.title, printBtn)}
    <div class="card no-print"><div id="pick-root"></div></div>
    <p class="text-muted view-meta">${esc(view.meta)}</p>
    ${legendHtml(view.legend)}
    ${gridHtml(view.cell)}`;
  mountPickList(root.querySelector('#pick-root'), {
    name: listName,
    items,
    selectedId: ui[uiKey],
    placeholder,
    onPick: (id) => { ui[uiKey] = id; ctx.rerender(); },
  });
  root.querySelector('#btn-print')?.addEventListener('click', () => window.print());
}

export function renderGroupView(root) {
  renderKindView(root, { kind: 'group', title: 'ตารางรายกลุ่มเรียน', uiKey: 'groupId', emptyMsg: 'ยังไม่มีกลุ่มเรียน', emptyLink: '#/groups', emptyLinkText: 'ไปหน้ากลุ่มเรียน', listName: 'pick-group', placeholder: 'ค้นหากลุ่มเรียน' });
}
export function renderTeacherView(root) {
  renderKindView(root, { kind: 'teacher', title: 'ตารางรายครู', uiKey: 'teacherId', emptyMsg: 'ยังไม่มีครู', emptyLink: '#/teachers', emptyLinkText: 'ไปหน้าครูผู้สอน', listName: 'pick-teacher', placeholder: 'ค้นหาครู' });
}
export function renderClassroomView(root) {
  renderKindView(root, { kind: 'classroom', title: 'ตารางรายห้องเรียน', uiKey: 'classroomId', emptyMsg: 'ยังไม่มีห้องเรียน', emptyLink: '#/classrooms', emptyLinkText: 'ไปหน้าห้องเรียน', listName: 'pick-classroom', placeholder: 'ค้นหาห้องเรียน' });
}
