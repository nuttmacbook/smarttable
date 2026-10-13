// ข้อมูลหลัก: กลุ่มเรียน (นักเรียนสังกัด) · ห้องเรียน (สถานที่) · ครูผู้สอน — ทุกการแก้ผ่าน op (doOp)
import { mountTableList, searchSelect } from './list-kit.js';
import { uid, applyPlan, removeTeacher, removeRoom, removeGroup } from '../store.js';
import {
  ctx, esc, byId, toast, openModal, doOp, field, optionsHtml, pageHeader, emptyHtml, showFormErrors,
  errorListHtml, opFailureTitle, subjectTeacherIds, editOnly,
} from './util.js';

const SAVE_BUTTONS =
  '<button type="button" class="btn" data-close>ยกเลิก</button><button type="button" class="btn btn-primary" id="f-save">บันทึก</button>';

// ผูกปุ่มบันทึก/Enter ของฟอร์มใน modal (กันกดซ้ำระหว่างรอเซิร์ฟเวอร์)
function bindSubmit(m, formSel, submit) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await submit();
    } finally {
      busy = false;
    }
  };
  m.el.querySelector('#f-save').addEventListener('click', run);
  m.el.querySelector(formSel).addEventListener('submit', (e) => { e.preventDefault(); run(); });
}

// ผล op จาก modal: สำเร็จ → ปิด + แจ้ง + เรนเดอร์ใหม่; ไม่สำเร็จ → แสดงเหตุผลในฟอร์ม
function finish(m, r, okMessage) {
  if (!r.ok) {
    m.el.querySelector('#form-errors').innerHTML = errorListHtml(r.errors, opFailureTitle(r, 'บันทึกไม่ได้'));
    return false;
  }
  m.close();
  toast(okMessage);
  ctx.rerender();
  return true;
}

async function deleteWith(op, okMessage) {
  const r = await doOp(op);
  if (!r.ok) return toast(`${opFailureTitle(r)}: ${r.errors[0] ?? ''}`, 'error');
  toast(okMessage);
  ctx.rerender();
}

const actions = (id, extra = '') =>
  editOnly(`<td class="col-actions">${extra}<button type="button" class="btn btn-sm" data-edit="${esc(id)}">แก้ไข</button>
    <button type="button" class="btn btn-sm btn-danger" data-del="${esc(id)}">ลบ</button></td>`);

// ---------- กลุ่มเรียน ----------
const groupFilters = () => [{ id: 'level', label: 'ระดับ', options: ctx.state.levels.map((l) => [l, l]), test: (g, v) => g.level === v }];

export function renderGroups(root) {
  const { state } = ctx;
  root.innerHTML = `
    ${pageHeader('กลุ่มเรียน', editOnly('<button type="button" class="btn btn-primary" id="btn-add">+ เพิ่มกลุ่มเรียน</button>'))}
    <p class="text-muted">กลุ่มเรียน คือกลุ่มนักเรียนที่เรียนด้วยกัน เช่น ปวช.1/1 (ส่วนสถานที่เรียนอยู่ที่เมนู "ห้องเรียน")</p>
    <div id="list-root"></div>`;
  root.querySelector('#btn-add')?.addEventListener('click', () => groupForm(null));
  if (!state.groups.length) {
    root.querySelector('#list-root').innerHTML = emptyHtml('ยังไม่มีกลุ่มเรียน กด "เพิ่มกลุ่มเรียน" หรือนำเข้าจาก Excel ที่หน้า "ข้อมูล"');
    return;
  }
  const planName = (g) => byId(ctx.state.plans, g.planId)?.name ?? '';
  mountTableList(root.querySelector('#list-root'), {
    name: 'groups',
    def: { fields: (g) => [g.name, g.level, g.major, planName(g)], filters: groupFilters(), sort: { key: (g) => g.name }, placeholder: 'ค้นหาชื่อกลุ่ม/สาขา/แผน' },
    getItems: () => ctx.state.groups,
    headHtml: `<tr><th>ชื่อกลุ่มเรียน</th><th>ระดับ</th><th>สาขาวิชา</th><th>แผนการเรียน</th><th class="col-num">วิชาที่ผูก</th><th class="col-num">คาบที่ลง</th>${editOnly('<th></th>')}</tr>`,
    rowHtml: (g) => {
      const n = ctx.state.entries.filter((e) => e.groupId === g.id).length;
      const plan = byId(ctx.state.plans, g.planId);
      return `<tr><td>${esc(g.name)}</td><td><span class="badge badge-level">${esc(g.level)}</span></td><td>${esc(g.major)}</td>
        <td>${plan ? esc(plan.name) : '<span class="text-muted">ยังไม่เลือก</span>'}</td>
        <td class="col-num">${(g.subjectIds || []).length}</td><td class="col-num">${n}</td>
        ${actions(g.id, `<button type="button" class="btn btn-sm" data-plan="${esc(g.id)}">เลือกแผนการเรียน</button> `)}</tr>`;
    },
    bind: (el) => {
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => groupForm(byId(ctx.state.groups, b.dataset.edit))));
      el.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => planPicker(byId(ctx.state.groups, b.dataset.plan))));
      el.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          const g = byId(ctx.state.groups, b.dataset.del);
          const n = removeGroup(ctx.state, g.id).affected.entriesRemoved;
          if (!confirm(n ? `ลบกลุ่มเรียน "${g.name}" ? จะลบคาบที่ลงตารางไว้ ${n} คาบด้วย` : `ลบกลุ่มเรียน "${g.name}" ?`)) return;
          await deleteWith({ type: 'group.delete', id: g.id }, 'ลบกลุ่มเรียนแล้ว');
        }),
      );
    },
  });
}

export function groupForm(group) {
  if (!ctx.state.levels?.length) return toast('ยังไม่มีระดับ ไปเพิ่มที่เมนู "ระดับ" ก่อน', 'error');
  const isEdit = Boolean(group);
  const m = openModal({
    title: isEdit ? 'แก้ไขกลุ่มเรียน' : 'เพิ่มกลุ่มเรียน',
    bodyHtml: `<form id="group-form" novalidate><div id="form-errors"></div>
      ${field('ชื่อกลุ่มเรียน', `<input class="input" id="f-name" value="${esc(group?.name)}" placeholder="เช่น ปวช.1/1">`, { required: true, id: 'f-name' })}
      ${field('ระดับ', `<select class="select" id="f-level">${optionsHtml(ctx.state.levels.map((l) => [l, l]), group?.level || ctx.state.levels[0])}</select>`, { id: 'f-level', hint: 'ใช้ตรวจว่าลงวิชาที่เปิดสอนในระดับนี้ได้หรือไม่' })}
      ${field('สาขาวิชา', `<input class="input" id="f-major" value="${esc(group?.major)}">`, { id: 'f-major' })}
    </form>`,
    footerHtml: SAVE_BUTTONS,
  });
  const $ = (id) => m.el.querySelector(id);
  bindSubmit(m, '#group-form', async () => {
    const name = $('#f-name').value.trim();
    const errs = [];
    if (!name) errs.push({ input: '#f-name', msg: 'กรุณากรอกชื่อกลุ่มเรียน' });
    else if (ctx.state.groups.some((x) => x.name.trim() === name && x.id !== group?.id)) errs.push({ input: '#f-name', msg: `กลุ่มเรียน ${name} ซ้ำกับที่มีอยู่แล้ว` });
    if (!showFormErrors(m.el, errs, ['#f-name'])) return;
    const row = { id: group?.id ?? uid('g'), name, level: $('#f-level').value, major: $('#f-major').value.trim() };
    finish(m, await doOp({ type: 'group.upsert', group: row }), isEdit ? 'แก้ไขกลุ่มเรียนแล้ว' : 'เพิ่มกลุ่มเรียนแล้ว');
  });
}

// เลือกแผนการเรียนให้กลุ่ม: dropdown เฉพาะแผนที่ระดับตรง → ตัวอย่างวิชาที่จะผูก/ถูกข้าม → ยืนยัน (op group.applyPlan)
export function planPicker(group) {
  const plans = ctx.state.plans.filter((p) => p.level === group.level);
  if (!plans.length) {
    openModal({
      title: `เลือกแผนการเรียน — ${group.name}`,
      bodyHtml: `<div class="alert alert-info">ยังไม่มีแผนการเรียนระดับ ${esc(group.level)} สร้างได้ที่เมนู "แผนการเรียน"</div>`,
      footerHtml: '<button type="button" class="btn" data-close>ปิด</button>',
    });
    return;
  }
  const planSel = searchSelect({
    id: 'f-plan',
    label: 'plan',
    placeholder: 'ค้นหาแผนการเรียน',
    items: plans.map((p) => ({ id: p.id, label: p.name, detail: `${(p.subjectIds || []).length} วิชา` })),
    value: group.planId && plans.some((p) => p.id === group.planId) ? group.planId : plans[0].id,
    onChange: () => paint(),
  });
  const m = openModal({
    title: `เลือกแผนการเรียน — ${group.name} (${group.level})`,
    large: true,
    bodyHtml: `<div id="form-errors"></div>
      ${field('แผนการเรียน', planSel.html, { id: 'f-plan' })}
      <fieldset class="chip-group" aria-label="วิธีผูกวิชา">
        <label class="chip"><input type="radio" name="mode" value="replace" checked><span>แทนที่ (วิชาของกลุ่ม = วิชาของแผน)</span></label>
        <label class="chip"><input type="radio" name="mode" value="merge"><span>เพิ่มเข้าไป (คงวิชาเดิมไว้)</span></label>
      </fieldset>
      <p class="field-hint">การเลือกแผนไม่ลบคาบที่ลงตารางไว้แล้ว</p>
      <div id="plan-preview"></div>`,
    footerHtml: '<button type="button" class="btn" data-close>ยกเลิก</button><button type="button" class="btn btn-primary" id="f-save">ผูกแผนการเรียน</button>',
  });
  const mode = () => (m.el.querySelector('input[name=mode]:checked')?.value === 'merge' ? 'merge' : 'replace');
  const nameOf = (id) => {
    const s = byId(ctx.state.subjects, id);
    return s ? `${s.code} ${s.name}` : id;
  };
  const paint = () => {
    const planId = m.el.querySelector('#f-plan').value;
    const r = applyPlan(ctx.state, group.id, planId, { mode: mode() });
    const box = m.el.querySelector('#plan-preview');
    if (!r.ok) {
      box.innerHTML = errorListHtml(r.errors, 'ผูกแผนไม่ได้');
      return;
    }
    const list = (items) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    box.innerHTML = `
      <div class="alert alert-success"><strong>จะผูกเพิ่ม ${r.added.length} วิชา</strong>${r.added.length ? list(r.added.map(nameOf)) : ''}</div>
      ${r.skipped.length ? `<div class="alert alert-warning"><strong>ข้าม ${r.skipped.length} วิชา</strong>${list(r.skipped.map((x) => x.message))}</div>` : ''}
      ${r.warnings.length ? `<div class="alert alert-warning">${list(r.warnings)}</div>` : ''}`;
  };
  planSel.mount(m.el);
  m.el.querySelectorAll('input[name=mode]').forEach((i) => i.addEventListener('change', paint));
  paint();
  let busy = false;
  m.el.querySelector('#f-save').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await doOp({ type: 'group.applyPlan', groupId: group.id, planId: m.el.querySelector('#f-plan').value, mode: mode() });
      finish(m, r, 'ผูกแผนการเรียนแล้ว');
    } finally {
      busy = false;
    }
  });
}

// ---------- ห้องเรียน (สถานที่) ----------
const roomFields = (r) => [r.name, r.building];

export function renderClassrooms(root) {
  const { state } = ctx;
  root.innerHTML = `
    ${pageHeader('ห้องเรียน', editOnly('<button type="button" class="btn btn-primary" id="btn-add">+ เพิ่มห้องเรียน</button>'))}
    <p class="text-muted">ห้องเรียน คือสถานที่เรียนจริง เช่น 411, ห้องปฏิบัติการคอมพิวเตอร์ ตอนลงตารางเลือกหรือไม่เลือกห้องก็ได้ ถ้าเลือกระบบจะตรวจว่าห้องเดียวกันถูกใช้ซ้อนคาบหรือไม่</p>
    <div id="list-root"></div>`;
  root.querySelector('#btn-add')?.addEventListener('click', () => classroomForm(null));
  if (!state.rooms.length) {
    root.querySelector('#list-root').innerHTML = emptyHtml('ยังไม่มีห้องเรียน กด "เพิ่มห้องเรียน" หรือนำเข้าจาก Excel ที่หน้า "ข้อมูล" (ลงตารางโดยไม่ระบุห้องเรียนได้)');
    return;
  }
  mountTableList(root.querySelector('#list-root'), {
    name: 'rooms',
    def: { fields: roomFields, filters: [], sort: { key: (r) => r.name }, placeholder: 'ค้นหาชื่อห้อง/อาคาร' },
    getItems: () => ctx.state.rooms,
    headHtml: `<tr><th>ชื่อห้องเรียน</th><th>อาคาร</th><th class="col-num">ความจุ</th><th>หมายเหตุ</th><th class="col-num">จำนวนคาบที่ใช้</th>${editOnly('<th></th>')}</tr>`,
    rowHtml: (r) => {
      const n = ctx.state.entries.filter((e) => e.roomId === r.id).length;
      return `<tr><td><span class="badge badge-room">${esc(r.name)}</span></td><td>${esc(r.building)}</td>
        <td class="col-num">${esc(r.capacity)}</td><td>${esc(r.note)}</td><td class="col-num">${n}</td>${actions(r.id)}</tr>`;
    },
    bind: (el) => {
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => classroomForm(byId(ctx.state.rooms, b.dataset.edit))));
      el.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          const room = byId(ctx.state.rooms, b.dataset.del);
          const n = removeRoom(ctx.state, room.id).affected.entriesCleared;
          if (!confirm(n ? `ลบห้องเรียน "${room.name}" ? คาบที่ใช้ห้องนี้ ${n} คาบ จะเปลี่ยนเป็นไม่ระบุห้องเรียน` : `ลบห้องเรียน "${room.name}" ?`)) return;
          await deleteWith({ type: 'room.delete', id: room.id }, 'ลบห้องเรียนแล้ว');
        }),
      );
    },
  });
}

export function classroomForm(room) {
  const isEdit = Boolean(room);
  const m = openModal({
    title: isEdit ? 'แก้ไขห้องเรียน' : 'เพิ่มห้องเรียน',
    bodyHtml: `<form id="classroom-form" novalidate><div id="form-errors"></div>
      ${field('ชื่อห้องเรียน', `<input class="input" id="f-name" value="${esc(room?.name)}" placeholder="เช่น 411">`, { required: true, id: 'f-name', hint: 'ห้ามซ้ำกับห้องเรียนอื่น' })}
      ${field('อาคาร', `<input class="input" id="f-building" value="${esc(room?.building)}">`, { id: 'f-building' })}
      ${field('ความจุ (คน)', `<input class="input" id="f-capacity" type="number" min="0" step="1" value="${esc(room?.capacity ?? '')}">`, { id: 'f-capacity' })}
      ${field('หมายเหตุ', `<input class="input" id="f-note" value="${esc(room?.note)}">`, { id: 'f-note' })}
    </form>`,
    footerHtml: SAVE_BUTTONS,
  });
  const $ = (id) => m.el.querySelector(id);
  bindSubmit(m, '#classroom-form', async () => {
    const name = $('#f-name').value.trim();
    const capRaw = $('#f-capacity').value.trim();
    const errs = [];
    if (!name) errs.push({ input: '#f-name', msg: 'กรุณากรอกชื่อห้องเรียน' });
    else if (ctx.state.rooms.some((x) => x.name.trim() === name && x.id !== room?.id)) errs.push({ input: '#f-name', msg: `ห้องเรียน ${name} ซ้ำกับที่มีอยู่แล้ว` });
    if (capRaw && !(Number.isInteger(Number(capRaw)) && Number(capRaw) >= 0)) errs.push({ input: '#f-capacity', msg: 'ความจุต้องเป็นจำนวนเต็มไม่ติดลบ' });
    if (!showFormErrors(m.el, errs, ['#f-name', '#f-capacity'])) return;
    const row = { id: room?.id ?? uid('r'), name, building: $('#f-building').value.trim(), capacity: capRaw ? Number(capRaw) : null, note: $('#f-note').value.trim() };
    finish(m, await doOp({ type: 'room.upsert', room: row }), isEdit ? 'แก้ไขห้องเรียนแล้ว' : 'เพิ่มห้องเรียนแล้ว');
  });
}

// ---------- ครูผู้สอน ----------
export function renderTeachers(root) {
  const { state } = ctx;
  root.innerHTML = `
    ${pageHeader('ครูผู้สอน', editOnly('<button type="button" class="btn btn-primary" id="btn-add">+ เพิ่มครู</button>'))}
    <div id="list-root"></div>`;
  root.querySelector('#btn-add')?.addEventListener('click', () => teacherForm(null));
  if (!state.teachers.length) {
    root.querySelector('#list-root').innerHTML = emptyHtml('ยังไม่มีครู กด "เพิ่มครู" หรือนำเข้าจาก Excel ที่หน้า "ข้อมูล"');
    return;
  }
  mountTableList(root.querySelector('#list-root'), {
    name: 'teachers',
    def: { fields: (t) => [t.name, t.dept], filters: [], sort: { key: (t) => t.name }, placeholder: 'ค้นหาชื่อครู/แผนก' },
    getItems: () => ctx.state.teachers,
    headHtml: `<tr><th>ชื่อ</th><th>แผนก/สาขา</th><th>วิชาที่สอน</th>${editOnly('<th></th>')}</tr>`,
    rowHtml: (t) => {
      const subs = ctx.state.subjects.filter((s) => subjectTeacherIds(s).includes(t.id));
      return `<tr><td>${esc(t.name)}</td><td>${esc(t.dept)}</td>
        <td>${subs.length ? esc(subs.map((s) => s.name).join(', ')) : '<span class="text-muted">ยังไม่ได้สอนวิชาใด</span>'}</td>${actions(t.id)}</tr>`;
    },
    bind: (el) => {
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => teacherForm(byId(ctx.state.teachers, b.dataset.edit))));
      el.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          const t = byId(ctx.state.teachers, b.dataset.del);
          const { subjectsUpdated, entriesCleared } = removeTeacher(ctx.state, t.id).affected;
          const note = [
            subjectsUpdated ? `จะถอดครูคนนี้ออกจาก ${subjectsUpdated} วิชา` : '',
            entriesCleared ? `${entriesCleared} คาบที่ลงให้ครูคนนี้จะกลายเป็นยังไม่ได้เลือกครู` : '',
          ].filter(Boolean).join(' และ ');
          if (!confirm(note ? `ลบครู "${t.name}" ? ${note}` : `ลบครู "${t.name}" ?`)) return;
          await deleteWith({ type: 'teacher.delete', id: t.id }, 'ลบครูแล้ว');
        }),
      );
    },
  });
}

export function teacherForm(teacher) {
  const isEdit = Boolean(teacher);
  const m = openModal({
    title: isEdit ? 'แก้ไขครู' : 'เพิ่มครู',
    bodyHtml: `<form id="teacher-form" novalidate><div id="form-errors"></div>
      ${field('ชื่อ-สกุล', `<input class="input" id="f-name" value="${esc(teacher?.name)}">`, { required: true, id: 'f-name' })}
      ${field('แผนก/สาขา', `<input class="input" id="f-dept" value="${esc(teacher?.dept)}">`, { id: 'f-dept' })}
    </form>`,
    footerHtml: SAVE_BUTTONS,
  });
  const $ = (id) => m.el.querySelector(id);
  bindSubmit(m, '#teacher-form', async () => {
    const name = $('#f-name').value.trim();
    const errs = name ? [] : [{ input: '#f-name', msg: 'กรุณากรอกชื่อครู' }];
    if (!showFormErrors(m.el, errs, ['#f-name'])) return;
    const row = { id: teacher?.id ?? uid('t'), name, dept: $('#f-dept').value.trim() };
    finish(m, await doOp({ type: 'teacher.upsert', teacher: row }), isEdit ? 'แก้ไขครูแล้ว' : 'เพิ่มครูแล้ว');
  });
}
