// หน้าจัดตาราง: แผงวิชาของกลุ่มเรียน (ต้องเรียน/จัดแล้ว/เหลือ) + ตารางแถว=วัน
//   คลิกวิชาในแผง = เลือก "วิชาที่กำลังลง" → คลิกช่องว่างเพื่อเลือกครู/ห้องเรียนแล้วลง
//   หรือคลิกช่องว่างก่อน → เลือกวิชา · คลิกช่องที่ลงแล้ว → ดู/เปลี่ยนครู-ห้อง/ย้าย/ลบ
// ทุกการแก้ผ่าน op: entry.place / entry.move / entry.update / entry.remove (doOp)
import { checkPlacement, availableClassrooms, canMerge } from '../scheduler.js';
import { uid } from '../store.js';
import { dayName, periodLabel, subjectTypeName } from '../constants.js';
import { groupPanelRows, STATUS_TEXT, cachedBlockedCells } from '../panel-model.js';
import { mountMulti, clearMultiSelection, getMulti } from './multi-ui.js';
import { mountListKit, searchSelect } from './list-kit.js';
import {
  ctx, esc, byId, toast, openModal, doOp, gridHtml, bindCells, legendHtml,
  pageHeader, emptyHtml, errorListHtml, optionsHtml, field, conflictBadge,
  effectiveTeacherId, subjectTeacherIds, markHtml, cellTypeOf, teacherNames, availableTeachers, placeability,
  getOnlyPlaceable, setOnlyPlaceable, opFailureTitle,
} from './util.js';

const sortSubjects = (list) =>
  [...list].sort((a, b) => (a.type === b.type ? String(a.code).localeCompare(String(b.code)) : a.type === 'general' ? -1 : 1));

// กลุ่มเรียนอื่นที่ลงวิชาเดียวกัน (เรียนรวม) ในวัน+คาบเดียวกัน
function sharedGroups(state, subject, groupId, day, period, ignoreEntryId) {
  if (!subject) return [];
  return state.entries
    .filter((e) => e.id !== ignoreEntryId && e.groupId !== groupId && e.day === day && e.period === period)
    .filter((e) => canMerge(subject, byId(state.subjects, e.subjectId)))
    .map((e) => byId(state.groups, e.groupId)?.name ?? e.groupId);
}

const whenText = (day, period) => `วัน${dayName(day)} ${periodLabel(period)}`;
const roomLabel = (r) => r.name + (r.building ? ` (${r.building})` : '');

// ชื่อครูของ entry (effective) หรือข้อความบอกว่ายังไม่ได้เลือก/กำหนด
function entryTeacherLabel(state, entry, subject) {
  const t = byId(state.teachers, effectiveTeacherId(state, entry));
  if (t) return t.name;
  return subjectTeacherIds(subject).length >= 2 ? 'ยังไม่ได้เลือกครู' : 'ยังไม่กำหนดครู';
}

// แถวหนึ่งของแผงวิชา (ปุ่มเลือกวิชา + สถานะ ต้อง/จัดแล้ว/เหลือ + แถบคืบหน้า) — ทุกค่าผ่าน esc
function panelItemHtml(r) {
  const s = r.subject;
  const cls = r.status === 'over' ? 'is-over' : r.status === 'done' ? 'is-done' : 'is-remaining';
  const chipCls = r.status === 'over' ? 'status-over' : r.status === 'done' ? 'status-done' : 'status-remaining';
  const chip = r.status === 'over' ? `เกิน ${r.over} ชม.` : r.status === 'done' ? STATUS_TEXT.done.replace(' ✓', '') : `เหลือ ${r.remaining} ชม.`;
  const active = ctx.ui.placingSubjectId === s.id;
  const names = teacherNames(ctx.state, s);
  return `<li><button type="button" class="subject-item ${cls}${active ? ' is-active' : ''}" data-panel-subject="${esc(s.id)}" aria-pressed="${active}">
    <span class="subject-item-title">${esc(s.code)} ${esc(s.name)}</span>
    <span class="subject-item-sub">${esc(subjectTypeName(s.type))} · ${esc(names ? 'ครู' + names : 'ยังไม่กำหนดครู')}</span>
    <span class="subject-item-hours"><span>ต้อง ${r.need} · จัดแล้ว ${r.used}</span><span class="status-chip ${chipCls}">${esc(chip)}</span></span>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${r.need}" aria-valuenow="${Math.min(r.used, r.need)}" aria-label="ความคืบหน้า ${esc(s.name)}"><div class="progress-bar" style="width:${r.percent}%"></div></div>
  </button></li>`;
}
const PANEL_FIELDS = (r) => [r.subject.code, r.subject.name, r.names];

function panelHtml(group, panel) {
  const { rows, unbound } = panel;
  const remainingCount = rows.filter((r) => r.remaining > 0).length;
  const doneCount = rows.filter((r) => r.status === 'done').length;
  const overCount = rows.filter((r) => r.status === 'over').length;
  return `<aside class="subject-panel" id="subject-panel" aria-label="รายวิชาของกลุ่มเรียน">
    <div class="subject-panel-header"><h2 class="subject-panel-title">วิชาที่ต้องเรียน</h2><button type="button" class="btn btn-sm" id="panel-close">ปิด</button></div>
    ${unbound
      ? `<div class="subject-panel-empty"><p>ยังไม่ได้ผูกวิชา — เลือกแผนการเรียน</p><a class="btn btn-primary" href="#/groups">ไปเลือกแผนการเรียน</a></div>`
      : `<div class="subject-panel-summary">เหลือ ${remainingCount} วิชา · เสร็จ ${doneCount} วิชา${overCount ? ` · เกิน ${overCount} วิชา` : ''}</div>
         <div id="panel-list"></div>`}
  </aside>`;
}

export function renderSchedule(root) {
  const { state, ui } = ctx;
  if (!state.groups.length) {
    root.innerHTML = pageHeader('จัดตาราง') + emptyHtml('ยังไม่มีกลุ่มเรียน เพิ่มกลุ่มเรียนก่อน (หรือนำเข้าจาก Excel ที่หน้า "ข้อมูล")', '#/groups', 'ไปหน้ากลุ่มเรียน');
    return;
  }
  if (!byId(state.groups, ui.groupId)) ui.groupId = state.groups[0].id;
  const group = byId(state.groups, ui.groupId);
  const panel = groupPanelRows(state, group.id);
  panel.rows.forEach((r) => { r.names = teacherNames(state, r.subject); }); // ไว้ค้นหาตามชื่อครู
  const groupEntries = state.entries.filter((e) => e.groupId === group.id);
  const moving = ui.moving ? byId(state.entries, ui.moving) : null;
  if (ui.moving && !moving) ui.moving = null;
  const placingRow = panel.rows.find((r) => r.subject.id === ui.placingSubjectId);
  // โหมดหลายช่องเลือกวิชานอกแผน/วิชาที่ยังไม่ผูกกับกลุ่มได้ (NOTE-19) — คงไว้ ไม่เคลียร์
  const outsideOk = !placingRow && getMulti().on && Boolean(byId(state.subjects, ui.placingSubjectId));
  if (ui.placingSubjectId && !outsideOk && (!placingRow || placingRow.remaining === 0)) ui.placingSubjectId = null;
  const placing = ui.placingSubjectId ? placingRow : null;

  // ช่องที่ลงวิชาที่เลือกไม่ได้ (แดง+ลาย+⊘): คำนวณครั้งเดียวต่อการเปลี่ยนวิชา/ครู/ห้อง/กลุ่ม/ข้อมูล (cache ตาม state)
  const blockedMap = () => {
    const mm = getMulti();
    if (!ui.placingSubjectId || moving || (mm.on && mm.kind === 'remove')) return null;
    return cachedBlockedCells(state, { groupId: group.id, subjectId: ui.placingSubjectId, teacherId: mm.on ? mm.teacherId : '', roomId: mm.on ? mm.roomId : '' });
  };
  const cell = (day, period) => {
    const e = groupEntries.find((x) => x.day === day && x.period === period);
    if (!e) {
      const b = blockedMap()?.get(`${day}:${period}`);
      if (b) {
        return {
          cls: 'is-free is-blocked',
          interactive: true,
          title: `ลงไม่ได้: ${b.reason}`,
          html: `<span class="tt-cell-blocked"><span class="tt-block-icon" aria-hidden="true">⊘</span> <span class="tt-block-text">ลงไม่ได้</span></span><span class="tt-cell-sub tt-block-reason">${esc(b.reason)}</span>`,
        };
      }
      return { cls: 'is-free', html: '<span class="tt-cell-sub">ว่าง</span>', interactive: true };
    }
    const subj = byId(state.subjects, e.subjectId);
    const classroom = byId(state.rooms, e.roomId);
    const check = checkPlacement(state, { groupId: group.id, day, period, subjectId: e.subjectId, roomId: e.roomId, teacherId: e.teacherId ?? undefined, ignoreEntryId: e.id });
    const types = check.conflicts.map((c) => c.type);
    const shared = sharedGroups(state, subj, group.id, day, period, e.id);
    let cls = 'is-filled';
    let badge = '';
    if (types.some((t) => t !== 'level')) { cls = 'is-conflict'; badge = `<span class="tt-cell-badge">${esc(conflictBadge(types))}</span>`; }
    else if (types.includes('level')) { cls = 'is-level-mismatch'; badge = '<span class="tt-cell-badge">ระดับไม่ตรง</span>'; }
    else if (check.warnings.length) { cls = 'is-filled is-warning'; badge = '<span class="tt-cell-badge">เตือน</span>'; }
    else if (shared.length) { cls = 'is-filled is-shared'; badge = '<span class="tt-cell-badge">เรียนรวม</span>'; }
    if (moving && moving.id === e.id) badge += ' <span class="tt-cell-badge">กำลังย้าย</span>';
    return {
      cls,
      interactive: true,
      type: cellTypeOf(subj),
      html: `<span class="tt-cell-title">${markHtml(subj, shared.length > 0)}${esc(subj ? subj.name : e.subjectId)}</span>
        <span class="tt-cell-sub">${esc(entryTeacherLabel(state, e, subj))}</span>
        ${classroom ? `<span class="tt-cell-room">${esc(classroom.name)}</span>` : ''}${badge}`,
    };
  };

  // เลือกกลุ่มเรียน: เกิน 25 กลุ่มใช้รายการค้นหา/แบ่งหน้า
  const groupSel = searchSelect({
    id: 'group-select',
    label: 'group',
    placeholder: 'ค้นหากลุ่มเรียน',
    items: state.groups.map((g) => ({ id: g.id, label: g.name, detail: `${g.level}${g.major ? ' · ' + g.major : ''}` })),
    value: group.id,
    onChange: (v) => {
      ui.groupId = v;
      ui.moving = null;
      ui.placingSubjectId = null;
      clearMultiSelection();
      ctx.rerender();
    },
  });
  root.innerHTML = `
    ${pageHeader('จัดตารางสอน', `<button type="button" class="btn" id="btn-clear-group">ล้างตารางกลุ่มเรียนนี้</button>`)}
    <div class="schedule-layout">
      ${panelHtml(group, panel)}
      <div class="schedule-main">
        <button type="button" class="btn panel-toggle" id="panel-toggle" aria-controls="subject-panel">รายวิชา</button>
        <div class="toolbar">
          <div class="field" style="margin:0">
            <label class="field-label" for="group-select">กลุ่มเรียน</label>
            ${groupSel.html}
          </div>
          <span class="text-muted">ระดับ ${esc(group.level)} · ลงแล้ว ${groupEntries.length} คาบ</span>
        </div>
        ${placing ? `<div class="placing-bar" role="status"><span>กำลังลง: <strong>${esc(placing.subject.name)}</strong> เหลือ ${placing.remaining} ชม.</span><button type="button" class="btn btn-sm" id="btn-stop-placing">ยกเลิก</button></div>` : ''}
        ${moving ? `<div class="alert alert-info" role="status">กำลังย้ายวิชา <strong>${esc(byId(state.subjects, moving.subjectId)?.name ?? '')}</strong> — คลิกช่องว่างที่ต้องการ
          <button type="button" class="btn btn-sm" id="btn-cancel-move">ยกเลิกการย้าย</button></div>` : ''}
        ${state.subjects.length ? '' : '<div class="alert alert-warning">ยังไม่มีรายวิชา เพิ่มที่หน้า "รายวิชา" ก่อนจึงจะลงตารางได้</div>'}
        ${legendHtml(['free', 'blocked', 'general', 'vocational', 'shared', 'warning', 'conflict', 'level', 'lunch'])}
        <div id="multi-box"></div>
        <div id="grid-box"></div>
      </div>
    </div>
    <div class="panel-backdrop" id="panel-backdrop"></div>`;

  // รายการวิชาของกลุ่ม: ค้นหา/แบ่งหน้าได้ (list-kit) คงลำดับ เหลือก่อน เสร็จท้าย
  if (!panel.unbound) {
    const panelKit = mountListKit(root.querySelector('#panel-list'), {
      name: 'panel-subjects',
      def: { fields: PANEL_FIELDS, filters: [], sort: undefined, placeholder: 'ค้นหาวิชาของกลุ่ม' },
      getItems: () => panel.rows,
      emptyText: 'ไม่พบวิชาที่ตรงกับคำค้น',
      renderBody: (page) => `<ul class="subject-list">${page.map(panelItemHtml).join('')}</ul>`,
      onRender: (el) => el.querySelectorAll('[data-panel-subject]').forEach((b) =>
        b.addEventListener('click', () => {
          const row = panel.rows.find((r) => r.subject.id === b.dataset.panelSubject);
          if (!row) return;
          if (row.status === 'done') return toast('วิชานี้จัดครบแล้ว', 'error');
          if (row.status === 'over') return toast(`วิชานี้เกินชั่วโมง ${row.over} ชม. ต้องลบคาบที่เกินก่อน`, 'error');
          ui.placingSubjectId = ui.placingSubjectId === row.subject.id ? null : row.subject.id;
          ui.moving = null;
          ctx.rerender();
        }),
      ),
    });
    void panelKit;
  }

  const panelEl = root.querySelector('#subject-panel');
  const backdrop = root.querySelector('#panel-backdrop');
  const setDrawer = (open) => {
    panelEl.classList.toggle('is-open', open);
    backdrop.classList.toggle('is-open', open);
  };
  root.querySelector('#panel-toggle').addEventListener('click', () => setDrawer(!panelEl.classList.contains('is-open')));
  root.querySelector('#panel-close').addEventListener('click', () => setDrawer(false));
  backdrop.addEventListener('click', () => setDrawer(false));

  root.querySelector('#btn-stop-placing')?.addEventListener('click', () => { ui.placingSubjectId = null; ctx.rerender(); });

  groupSel.mount(root);
  root.querySelector('#btn-clear-group').addEventListener('click', () => clearGroup(group, groupEntries));
  root.querySelector('#btn-cancel-move')?.addEventListener('click', () => { ui.moving = null; ctx.rerender(); });

  // ตาราง + โหมดเลือกหลายช่อง (ปิดอยู่ = คลิกทีละช่องตามเดิม)
  mountMulti({
    root,
    group,
    state,
    panel,
    baseCell: cell,
    onNormalClick: (day, period) => {
      const e = groupEntries.find((x) => x.day === day && x.period === period);
      if (moving) return e ? toast('ช่องนี้มีวิชาแล้ว เลือกช่องว่างเพื่อย้าย', 'error') : moveTo(moving, group, day, period);
      if (e) return openEntryModal(e, group);
      if (placing) return placeSelected(group, day, period, placing.subject.id);
      return openPickModal(group, day, period);
    },
  });
}

async function clearGroup(group, entries) {
  if (!entries.length) return toast('กลุ่มเรียนนี้ยังไม่มีวิชาลงไว้', 'error');
  if (!confirm(`ล้างตารางทั้งหมดของกลุ่มเรียน ${group.name} — จะลบ ${entries.length} คาบ ต้องการดำเนินการต่อ?`)) return;
  let removed = 0;
  for (const e of entries) {
    const r = await doOp({ type: 'entry.remove', entryId: e.id });
    if (!r.ok) {
      toast(`ลบได้ ${removed} จาก ${entries.length} คาบ แล้วหยุด: ${r.errors[0] ?? ''}`, 'error');
      break;
    }
    removed += 1;
  }
  ctx.ui.placingSubjectId = null;
  ctx.rerender();
}

// คลิกช่องว่างขณะเลือกวิชาจากแผง: ตรวจว่าลงได้ → ถ้าไม่ได้แสดงเหตุผล; ได้ → ข้ามขั้นเลือกวิชา
export function placeSelected(group, day, period, subjectId) {
  const p = placeability(ctx.state, { groupId: group.id, day, period, subjectId });
  if (!p.ok) {
    openModal({
      title: 'ลงวิชานี้ในช่องนี้ไม่ได้',
      bodyHtml: errorListHtml(p.reasons, `${byId(ctx.state.subjects, subjectId)?.name ?? ''} — ${whenText(day, period)}`),
      footerHtml: '<button type="button" class="btn" data-close>ปิด</button>',
    });
    return;
  }
  openDetailStep(group, day, period, subjectId, { fromPanel: true });
}

// ฟิลด์/ตัวกรองของรายการวิชา (ค่าคงที่ระดับโมดูลเพื่อใช้ดัชนีค้นหา cache ได้)
const PICK_SUBJECT_FIELDS = (x) => [x.s.code, x.s.name, x.names];
const PICK_SUBJECT_FILTERS = [{ id: 'type', label: 'ประเภท', options: [['general', 'วิชาสามัญ'], ['vocational', 'วิชาชีพ']], test: (x, v) => x.s.type === v }];

// ขั้นที่ 1: เลือกวิชา — ตัวกรอง "แสดงเฉพาะวิชาที่ลงได้" (ค่าเริ่มต้นติ๊ก) ซ่อนวิชาที่ลงไม่ได้ (รวมชั่วโมงเต็ม)
export function openPickModal(group, day, period) {
  const { state } = ctx;
  const subjects = sortSubjects(state.subjects).map((s) => ({ s, names: teacherNames(state, s), p: placeability(state, { groupId: group.id, day, period, subjectId: s.id }) }));

  const itemHtml = ({ s, p }) => {
    const sub = `${esc(s.code)} · ${esc(subjectTypeName(s.type))} · ระดับ ${esc((s.levels || []).join(', '))}`;
    const names = teacherNames(state, s);
    const teacherLine = `<span class="pick-item-teacher">${esc(names ? 'ครู' + names : 'ยังไม่กำหนดครู')}</span>`;
    if (!p.ok) {
      return `<li><button type="button" class="pick-item is-disabled" aria-disabled="true">
        <span class="pick-item-title">${esc(s.name)}</span>${teacherLine}<span class="pick-item-sub">${sub}</span>
        ${p.reasons.map((m) => `<span class="pick-item-reason">${esc(m)}</span>`).join('')}</button></li>`;
    }
    const shared = sharedGroups(state, s, group.id, day, period);
    const multi = p.teachers.length >= 2;
    const freeCount = p.teachers.filter((t) => t.ok).length;
    return `<li><button type="button" class="pick-item${shared.length ? ' is-shared' : ''}${multi ? ' needs-teacher' : ''}" data-subject="${esc(s.id)}">
      <span class="pick-item-title">${esc(s.name)}</span>${teacherLine}
      ${multi ? `<span class="pick-item-hint">ว่าง ${freeCount} จาก ${p.teachers.length} คน</span>` : ''}<span class="pick-item-sub">${sub}</span>
      ${shared.length ? `<span class="pick-item-sub">เรียนรวมกับกลุ่มเรียน ${esc(shared.join(', '))}</span>` : ''}
      ${p.warnings.map((w) => `<span class="pick-item-sub">⚠ ${esc(w)}</span>`).join('')}</button></li>`;
  };

  const m = openModal({
    title: `ลงวิชา — กลุ่มเรียน ${group.name} ${whenText(day, period)}`,
    large: true,
    bodyHtml: `<div class="filter-bar"><div class="field"><div class="chip-group">
        <label class="chip"><input type="checkbox" id="f-only"${getOnlyPlaceable() ? ' checked' : ''}><span>แสดงเฉพาะวิชาที่ลงได้</span></label>
      </div></div></div>
      <div id="hidden-note-box"></div>
      <div id="pick-area"></div>`,
    footerHtml: '<button type="button" class="btn" data-close>ยกเลิก</button>',
  });

  // รายการวิชาค้นหา/แบ่งหน้าได้ (list-kit) ; "แสดงเฉพาะวิชาที่ลงได้" ซ่อนวิชาที่ลงไม่ได้ก่อนค้นหา
  const only = () => m.el.querySelector('#f-only').checked;
  const shown = () => (only() ? subjects.filter((x) => x.p.ok) : subjects);
  const noteBox = m.el.querySelector('#hidden-note-box');
  const paintNote = () => {
    const hidden = subjects.length - shown().length;
    noteBox.innerHTML = only() && hidden ? `<p class="filter-note" id="hidden-note">ซ่อน <strong>${hidden}</strong> วิชาที่ลงไม่ได้</p>` : '';
  };
  const kit = mountListKit(m.el.querySelector('#pick-area'), {
    name: 'pick-subject',
    def: { fields: PICK_SUBJECT_FIELDS, filters: PICK_SUBJECT_FILTERS, sort: undefined, placeholder: 'ค้นหารหัส/ชื่อวิชา/ครู' },
    getItems: shown,
    emptyText: () => (subjects.length
      ? (only() ? 'ไม่มีวิชาที่ลงได้ในช่องนี้ (หรือไม่ตรงคำค้น) เอาติ๊ก "แสดงเฉพาะวิชาที่ลงได้" ออกเพื่อดูเหตุผลของแต่ละวิชา' : 'ไม่พบวิชาที่ตรงกับคำค้น')
      : 'ยังไม่มีรายวิชา เพิ่มที่หน้า "รายวิชา" ก่อน'),
    renderBody: (page) => `<ul class="pick-list">${page.map(itemHtml).join('')}</ul>`,
    onRender: (el) => el.querySelectorAll('[data-subject]').forEach((btn) =>
      btn.addEventListener('click', () => openDetailStep(group, day, period, btn.dataset.subject)),
    ),
  });
  m.el.querySelector('#f-only').addEventListener('change', (ev) => {
    setOnlyPlaceable(ev.target.checked);
    paintNote();
    kit.refresh();
  });
  paintNote();
}

// ขั้นที่ 2: เลือกครูผู้สอน (ชนเป็นเทา+เหตุผล) และห้องเรียน (ไม่บังคับ)
export function openDetailStep(group, day, period, subjectId, { fromPanel = false } = {}) {
  const { state } = ctx;
  const subj = byId(state.subjects, subjectId);
  const teachers = availableTeachers(state, { groupId: group.id, day, period, subjectId });
  const rooms = availableClassrooms(state, { groupId: group.id, day, period, subjectId });
  const okTeachers = teachers.filter((t) => t.ok);
  const needTeacher = teachers.length >= 2;
  const auto = okTeachers.length === 1 ? okTeachers[0].teacher.id : '';
  const tSel = searchSelect({
    id: 'f-teacher',
    label: 'teacher',
    placeholder: 'ค้นหาครู',
    items: teachers.map((t) => ({ id: t.teacher.id, label: t.teacher.name, disabled: !t.ok, note: t.ok ? '' : `ชน: ${t.conflicts[0]?.message ?? 'ไม่ว่าง'}` })),
    value: auto,
    blank: needTeacher && !auto ? '— เลือกครูผู้สอน —' : null,
  });
  const rSel = searchSelect({
    id: 'f-classroom',
    label: 'classroom',
    placeholder: 'ค้นหาห้องเรียน',
    items: rooms.map((r) => ({ id: r.id, label: roomLabel(r) })),
    value: '',
    blank: '— ไม่ระบุห้องเรียน —',
  });
  const teacherSelect = teachers.length
    ? field('ครูผู้สอน',
        tSel.html,
        { required: needTeacher, id: 'f-teacher', hint: needTeacher ? 'วิชานี้มีครูหลายคน ต้องเลือกครูผู้สอนของคาบนี้' : '' })
    : '<div class="alert alert-warning">วิชานี้ยังไม่ได้กำหนดครูผู้สอน (ลงได้ แต่ระบบตรวจครูชนไม่ได้)</div>';
  const m = openModal({
    title: `ลงวิชา ${subj.name} — กลุ่มเรียน ${group.name}`,
    bodyHtml: `<p>${esc(whenText(day, period))}</p>
      ${teachers.length >= 2 ? `<ul class="teacher-list">${teachers.map((t) => `<li><span class="badge ${t.ok ? 'badge-teacher' : 'badge-teacher-busy'}">${esc(t.teacher.name)}${t.ok ? '' : ' — ครูไม่ว่าง'}</span></li>`).join('')}</ul>` : ''}
      ${teacherSelect}
      ${field('ห้องเรียน (ไม่บังคับ)',
        rSel.html,
        { id: 'f-classroom', hint: state.rooms.length ? 'แสดงเฉพาะห้องเรียนที่ว่างในคาบนี้' : 'ยังไม่มีห้องเรียนในระบบ เพิ่มได้ที่หน้า "ห้องเรียน"' })}
      <div id="form-errors"></div>`,
    footerHtml: `<button type="button" class="btn" id="m-back">${fromPanel ? 'ยกเลิก' : 'ย้อนกลับ'}</button>
      <button type="button" class="btn btn-primary" id="m-ok">ลงวิชา</button>`,
  });
  if (teachers.length) tSel.mount(m.el);
  rSel.mount(m.el);
  m.el.querySelector('#m-back').addEventListener('click', () => (fromPanel ? m.close() : openPickModal(group, day, period)));
  let busy = false;
  m.el.querySelector('#m-ok').addEventListener('click', async () => {
    if (busy) return;
    const roomId = m.el.querySelector('#f-classroom').value || null;
    const teacherId = m.el.querySelector('#f-teacher')?.value || null;
    const errBox = m.el.querySelector('#form-errors');
    if (needTeacher && !teacherId) {
      errBox.innerHTML = errorListHtml(['กรุณาเลือกครูผู้สอนของคาบนี้'], 'ลงไม่ได้');
      return;
    }
    const r0 = checkPlacement(ctx.state, { groupId: group.id, day, period, subjectId, roomId, teacherId: teacherId ?? undefined });
    if (!r0.ok) {
      errBox.innerHTML = errorListHtml(r0.conflicts.map((c) => c.message), 'ลงไม่ได้');
      return;
    }
    busy = true;
    let r;
    try {
      r = await doOp({ type: 'entry.place', id: uid('e'), groupId: group.id, day, period, subjectId, roomId, teacherId });
    } finally {
      busy = false;
    }
    if (!r.ok) {
      errBox.innerHTML = errorListHtml(r.errors, opFailureTitle(r, 'ลงไม่ได้'));
      return;
    }
    m.close();
    if (r.warnings.length) toast(r.warnings[0], 'error');
    ctx.rerender();
  });
}

export function openEntryModal(entry, group) {
  const { state } = ctx;
  const subj = byId(state.subjects, entry.subjectId);
  const classroom = byId(state.rooms, entry.roomId);
  const check = checkPlacement(state, { groupId: group.id, day: entry.day, period: entry.period, subjectId: entry.subjectId, roomId: entry.roomId, teacherId: entry.teacherId ?? undefined, ignoreEntryId: entry.id });
  const shared = sharedGroups(state, subj, group.id, entry.day, entry.period, entry.id);
  const slot = { groupId: group.id, day: entry.day, period: entry.period, subjectId: entry.subjectId, ignoreEntryId: entry.id };
  const avail = availableClassrooms(state, slot);
  // ห้องเรียนปัจจุบันต้องอยู่ในตัวเลือกเสมอ แม้ชน (เพื่อแสดงค่าที่เลือกอยู่)
  const options = classroom && !avail.some((r) => r.id === classroom.id) ? [classroom, ...avail] : avail;
  const teachers = availableTeachers(state, slot);
  const current = entry.teacherId || effectiveTeacherId(state, entry) || '';
  const tSel = searchSelect({
    id: 'f-teacher',
    label: 'teacher',
    placeholder: 'ค้นหาครู',
    items: teachers.map((t) => ({ id: t.teacher.id, label: t.teacher.name, disabled: !(t.ok || t.teacher.id === current), note: t.ok || t.teacher.id === current ? '' : `ชน: ${t.conflicts[0]?.message ?? 'ไม่ว่าง'}` })),
    value: current,
    blank: current ? null : '— เลือกครูผู้สอน —',
  });
  const rSel = searchSelect({
    id: 'f-classroom',
    label: 'classroom',
    placeholder: 'ค้นหาห้องเรียน',
    items: options.map((r) => ({ id: r.id, label: roomLabel(r) })),
    value: entry.roomId || '',
    blank: '— ไม่ระบุห้องเรียน —',
  });
  const teacherSelect = teachers.length >= 2
    ? field('เปลี่ยนครูผู้สอน', tSel.html, { id: 'f-teacher', hint: 'ครูที่ชนในคาบนี้เลือกไม่ได้' })
    : '';
  const m = openModal({
    title: `${subj ? subj.name : entry.subjectId}`,
    bodyHtml: `
      <p><strong>กลุ่มเรียน:</strong> ${esc(group.name)} (${esc(group.level)})<br>
      <strong>เวลา:</strong> ${esc(whenText(entry.day, entry.period))}<br>
      <strong>ครูผู้สอน:</strong> ${esc(entryTeacherLabel(state, entry, subj))}<br>
      <strong>ประเภท:</strong> ${esc(subj ? subjectTypeName(subj.type) : '-')}<br>
      <strong>ห้องเรียน:</strong> ${esc(classroom ? classroom.name : 'ไม่ระบุ')}</p>
      ${shared.length ? `<div class="alert alert-info">เรียนรวมกับกลุ่มเรียน ${esc(shared.join(', '))}</div>` : ''}
      ${check.ok ? '' : errorListHtml(check.conflicts.map((c) => c.message), 'รายการนี้ชนกับรายการอื่น')}
      ${teacherSelect}
      ${field('เปลี่ยนห้องเรียน',
        rSel.html,
        { id: 'f-classroom', hint: 'แสดงเฉพาะห้องเรียนที่ว่างในคาบนี้' })}
      <div id="form-errors"></div>`,
    footerHtml: `<button type="button" class="btn" data-close>ปิด</button>
      <button type="button" class="btn" id="m-save">บันทึกครู/ห้องเรียน</button>
      <button type="button" class="btn" id="m-move">ย้าย</button>
      <button type="button" class="btn btn-danger" id="m-del">ลบออกจากตาราง</button>`,
  });
  if (teachers.length >= 2) tSel.mount(m.el);
  rSel.mount(m.el);
  let busy = false;
  const guarded = (fn) => async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  };
  m.el.querySelector('#m-save').addEventListener('click', guarded(async () => {
    const roomId = m.el.querySelector('#f-classroom').value || null;
    const picked = m.el.querySelector('#f-teacher');
    const teacherId = picked ? picked.value || null : entry.teacherId ?? null;
    const errBox = m.el.querySelector('#form-errors');
    if (picked && teachers.length >= 2 && !teacherId) {
      errBox.innerHTML = errorListHtml(['กรุณาเลือกครูผู้สอนของคาบนี้'], 'บันทึกไม่ได้');
      return;
    }
    const r = await doOp({ type: 'entry.update', entryId: entry.id, roomId, teacherId });
    if (!r.ok) {
      errBox.innerHTML = errorListHtml(r.errors, opFailureTitle(r, 'บันทึกไม่ได้'));
      return;
    }
    m.close();
    ctx.rerender();
  }));
  m.el.querySelector('#m-del').addEventListener('click', guarded(async () => {
    const r = await doOp({ type: 'entry.remove', entryId: entry.id });
    if (!r.ok) {
      m.el.querySelector('#form-errors').innerHTML = errorListHtml(r.errors, opFailureTitle(r, 'ลบไม่ได้'));
      return;
    }
    m.close();
    ctx.rerender();
  }));
  m.el.querySelector('#m-move').addEventListener('click', () => {
    ctx.ui.moving = entry.id;
    ctx.ui.placingSubjectId = null;
    m.close();
    ctx.rerender();
  });
}

export function moveTo(entry, group, day, period) {
  const base = { groupId: group.id, day, period, subjectId: entry.subjectId, teacherId: entry.teacherId ?? undefined, ignoreEntryId: entry.id };
  const r = checkPlacement(ctx.state, { ...base, roomId: entry.roomId });
  if (!r.ok) {
    // ชนเฉพาะห้องเรียน → เสนอย้ายโดยไม่ระบุห้องเรียน
    const onlyClassroom = entry.roomId && r.conflicts.every((c) => c.type === 'classroom');
    const m = openModal({
      title: 'ย้ายไปช่องนี้ไม่ได้',
      bodyHtml: errorListHtml(r.conflicts.map((c) => c.message), whenText(day, period)),
      footerHtml: `<button type="button" class="btn" data-close>ปิด</button>${
        onlyClassroom ? '<button type="button" class="btn btn-primary" id="m-move-noroom">ย้ายและไม่ระบุห้องเรียน</button>' : ''}`,
    });
    m.el.querySelector('#m-move-noroom')?.addEventListener('click', async () => {
      m.close();
      await applyMove(entry, day, period, { roomId: null });
    });
    return;
  }
  applyMove(entry, day, period, {});
}

async function applyMove(entry, day, period, extra) {
  const r = await doOp({ type: 'entry.move', entryId: entry.id, day, period, ...extra });
  if (!r.ok) {
    openModal({
      title: 'ย้ายไม่ได้',
      bodyHtml: errorListHtml(r.errors, opFailureTitle(r, whenText(day, period))),
      footerHtml: '<button type="button" class="btn" data-close>ปิด</button>',
    });
    return;
  }
  ctx.ui.moving = null;
  if (r.warnings.length) toast(r.warnings[0], 'error');
  ctx.rerender();
}
