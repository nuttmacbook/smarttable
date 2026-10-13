// หน้ารายวิชา: ตาราง + ฟอร์มเพิ่ม/แก้ไข/ลบ (ตรวจรหัสวิชาไม่ซ้ำ)
import { SUBJECT_TYPES, subjectTypeName } from '../constants.js';
import { uid, removeSubject } from '../store.js';
import { mountTableList, mountChecklist } from './list-kit.js';
import {
  ctx, esc, byId, toast, openModal, doOp, field, optionsHtml,
  pageHeader, emptyHtml, errorListHtml, showFormErrors, levelBadges,
  subjectTeacherIds, editOnly, opFailureTitle,
} from './util.js';

const TP_RE = /^ท-ป\s*(\d+)-(\d+)\s*/;

// ฟิลด์ค้นหาที่ขึ้นกับครู (ชื่อครูอยู่ใน state) สร้างใหม่ทุกครั้งที่เรนเดอร์ เพื่อให้ดัชนี cache ไม่ค้างชื่อครูเก่า
const subjectFilters = () => [
  { id: 'level', label: 'ระดับ', options: ctx.state.levels.map((l) => [l, l]), test: (s, v) => (s.levels || []).includes(v) },
  { id: 'type', label: 'ประเภท', options: SUBJECT_TYPES.map((t) => [t.id, t.name]), test: (s, v) => s.type === v },
];

export function renderSubjects(root) {
  const { state } = ctx;
  root.innerHTML = `
    ${pageHeader('รายวิชา', editOnly('<button type="button" class="btn btn-primary" id="btn-add">+ เพิ่มรายวิชา</button>'))}
    <div id="list-root"></div>`;
  root.querySelector('#btn-add')?.addEventListener('click', () => openForm(null));
  if (!state.subjects.length) {
    root.querySelector('#list-root').innerHTML = emptyHtml('ยังไม่มีรายวิชา กด "เพิ่มรายวิชา" หรือนำเข้าจาก Excel ที่หน้า "ข้อมูล"');
    return;
  }
  const names = (s) => subjectTeacherIds(s).map((id) => byId(state.teachers, id)?.name ?? '').join(' ');
  mountTableList(root.querySelector('#list-root'), {
    name: 'subjects',
    def: { fields: (s) => [s.code, s.name, names(s), (s.levels || []).join(' ')], filters: subjectFilters(), sort: { key: (s) => s.code }, placeholder: 'ค้นหารหัส/ชื่อวิชา/ครู' },
    getItems: () => ctx.state.subjects,
    headHtml: `<tr><th>รหัสวิชา</th><th>ชื่อวิชา</th><th>ประเภท</th><th>ระดับที่เปิดสอน</th><th class="text-center">หน่วยกิต</th>
      <th class="text-center">ชม./สัปดาห์</th><th>ครูผู้สอน</th><th>หมายเหตุ</th><th class="text-center">คาบที่ลง</th>${editOnly('<th></th>')}</tr>`,
    rowHtml: (s) => {
      const st = ctx.state;
      const inUse = st.entries.filter((e) => e.subjectId === s.id).length;
      return `<tr>
        <td>${esc(s.code)}</td><td>${esc(s.name)}</td>
        <td><span class="badge badge-${s.type === 'general' ? 'general' : 'vocational'}">${esc(subjectTypeName(s.type))}</span></td>
        <td>${levelBadges(s.levels)}</td>
        <td class="text-center">${esc(s.credits)}</td><td class="text-center">${esc(s.hours)}</td>
        <td>${subjectTeacherIds(s).length
          ? `<ul class="teacher-list">${subjectTeacherIds(s).map((id) => `<li><span class="badge badge-teacher">${esc(byId(st.teachers, id)?.name ?? id)}</span></li>`).join('')}</ul>`
          : '<span class="text-muted">ยังไม่กำหนด</span>'}</td>
        <td>${esc(s.note)}</td><td class="text-center">${inUse}</td>
        ${editOnly(`<td class="col-actions">
          <button type="button" class="btn btn-sm" data-edit="${esc(s.id)}">แก้ไข</button>
          <button type="button" class="btn btn-sm btn-danger" data-del="${esc(s.id)}">ลบ</button>
        </td>`)}</tr>`;
    },
    bind: (el) => {
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openForm(byId(ctx.state.subjects, b.dataset.edit))));
      el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => remove(byId(ctx.state.subjects, b.dataset.del))));
    },
  });
}

async function remove(subject) {
  // ใช้ helper cascade ของ store (กันอ้างอิงกำพร้า) ดูผลก่อนเพื่อทำข้อความ confirm
  const n = removeSubject(ctx.state, subject.id).affected.entriesRemoved;
  const msg = n
    ? `ลบวิชา "${subject.name}" ? จะลบคาบที่ลงตารางไว้ ${n} คาบด้วย`
    : `ลบวิชา "${subject.name}" ?`;
  if (!confirm(msg)) return;
  const r = await doOp({ type: 'subject.delete', id: subject.id });
  if (!r.ok) return toast(`${opFailureTitle(r)}: ${r.errors[0] ?? ''}`, 'error');
  toast('ลบรายวิชาแล้ว');
  ctx.rerender();
}

export function openForm(subject) {
  if (!ctx.state.levels?.length) return toast('ยังไม่มีระดับ ไปเพิ่มที่เมนู "ระดับ" ก่อน', 'error');
  const { state } = ctx;
  const isEdit = Boolean(subject);
  const tp = subject ? TP_RE.exec(subject.note || '') : null;
  const theory = subject?.theory ?? (tp ? tp[1] : subject ? String(subject.hours) : '2');
  const practice = subject?.practice ?? (tp ? tp[2] : '0');
  const levelChips = state.levels.map(
    (l) => `<label class="chip"><input type="checkbox" name="levels" value="${esc(l)}"${(subject?.levels || []).includes(l) ? ' checked' : ''}><span>${esc(l)}</span></label>`,
  ).join('');
  const extraNote = subject ? (subject.note || '').replace(TP_RE, '') : '';
  const chosen = subjectTeacherIds(subject);
  const m = openModal({
    title: isEdit ? 'แก้ไขรายวิชา' : 'เพิ่มรายวิชา',
    large: true,
    bodyHtml: `<form id="subject-form" novalidate>
      <div id="form-errors"></div>
      <div class="form-grid">
        ${field('รหัสวิชา', `<input class="input" id="f-code" value="${esc(subject?.code)}" placeholder="เช่น 20000-1101">`, { required: true, id: 'f-code', hint: 'ห้ามซ้ำกับวิชาอื่น' })}
        ${field('ชื่อวิชา', `<input class="input" id="f-name" value="${esc(subject?.name)}">`, { required: true, id: 'f-name' })}
        ${field('ประเภท', `<select class="select" id="f-type">${optionsHtml(SUBJECT_TYPES.map((t) => [t.id, t.name]), subject?.type || 'general')}</select>`, { id: 'f-type', hint: 'วิชาสามัญเดียวกันเรียนรวมข้ามกลุ่มเรียนได้' })}
        ${field('หน่วยกิต', `<input class="input" id="f-credits" type="number" min="0" step="1" value="${esc(subject?.credits ?? 2)}">`, { id: 'f-credits' })}
        ${field('ชั่วโมงทฤษฎี (ท)', `<input class="input" id="f-theory" type="number" min="0" step="1" value="${esc(theory)}">`, { id: 'f-theory' })}
        ${field('ชั่วโมงปฏิบัติ (ป)', `<input class="input" id="f-practice" type="number" min="0" step="1" value="${esc(practice)}">`, { id: 'f-practice', hint: 'ชม./สัปดาห์ = ท + ป คือจำนวนคาบที่ต้องเรียนต่อกลุ่มเรียน (ลงเกินไม่ได้)' })}
        ${field('หมายเหตุ', `<input class="input" id="f-note" value="${esc(extraNote)}">`, { id: 'f-note' })}
        <div class="span-2">
          ${field('ครูผู้สอน', '<div id="f-teachers" aria-label="ครูผู้สอน"></div>',
            { hint: 'เลือกได้หลายคน (ไม่เลือก = ยังไม่กำหนดครู) ถ้ามีหลายคน ต้องเลือกครูผู้สอนทีละคาบตอนลงตาราง' })}
        </div>
        <div class="span-2">
          ${field('ระดับที่เปิดสอน', `<fieldset class="chip-group" id="f-levels" aria-label="ระดับที่เปิดสอน">${levelChips}</fieldset>`,
            { required: true, hint: 'กลุ่มเรียนลงวิชานี้ได้เฉพาะระดับที่เลือก (เลือกได้หลายระดับ)' })}
        </div>
      </div>
    </form>`,
    footerHtml: '<button type="button" class="btn" data-close>ยกเลิก</button><button type="button" class="btn btn-primary" id="f-save">บันทึก</button>',
  });
  const $ = (id) => m.el.querySelector(id);
  // ครูผู้สอน: รายการติ๊กเลือก ค้นหา/แบ่งหน้าได้ (ครูอาจมีหลายร้อยคน)
  const teacherPick = mountChecklist($('#f-teachers'), {
    name: 'cl-teachers',
    placeholder: 'ค้นหาครู',
    items: state.teachers.map((t) => ({ id: t.id, label: t.name, detail: t.dept })),
    selected: chosen,
    emptyText: state.teachers.length ? 'ไม่พบครูที่ตรงกับคำค้น' : 'ยังไม่มีครู เพิ่มได้ที่หน้า "ครู"',
  });
  let busy = false;
  const submit = async () => {
    if (busy) return;
    const code = $('#f-code').value.trim();
    const name = $('#f-name').value.trim();
    const t = Number($('#f-theory').value);
    const p = Number($('#f-practice').value);
    const credits = Number($('#f-credits').value);
    const errs = [];
    if (!code) errs.push({ input: '#f-code', msg: 'กรุณากรอกรหัสวิชา' });
    else if (ctx.state.subjects.some((x) => x.code.trim() === code && x.id !== subject?.id)) errs.push({ input: '#f-code', msg: `รหัสวิชา ${code} ซ้ำกับวิชาที่มีอยู่แล้ว` });
    if (!name) errs.push({ input: '#f-name', msg: 'กรุณากรอกชื่อวิชา' });
    const whole = (n) => Number.isInteger(n) && n >= 0;
    if (!whole(t) || !whole(p) || t + p < 1) errs.push({ input: '#f-practice', msg: 'ชม./สัปดาห์ (ท+ป) ต้องเป็นจำนวนเต็มบวก' });
    if (!Number.isFinite(credits) || credits < 0) errs.push({ input: '#f-credits', msg: 'หน่วยกิตต้องไม่ติดลบ' });
    const levels = ctx.state.levels.filter((l) => [...m.el.querySelectorAll('input[name=levels]')].some((i) => i.value === l && i.checked));
    if (!levels.length) errs.push({ input: '#f-levels', msg: 'กรุณาเลือกระดับที่เปิดสอนอย่างน้อย 1 ระดับ' });
    const picked = new Set(teacherPick.getSelected());
    const teacherIds = state.teachers.map((x) => x.id).filter((id) => picked.has(id));
    // ลดชั่วโมงต่ำกว่าที่ลงตารางไว้แล้ว → ไม่ให้บันทึก (บอกกลุ่มเรียนที่ลงเกิน)
    if (isEdit && whole(t) && whole(p) && t + p >= 1) {
      const perGroup = new Map();
      for (const e of ctx.state.entries) if (e.subjectId === subject.id) perGroup.set(e.groupId, (perGroup.get(e.groupId) || 0) + 1);
      for (const [gid, used] of perGroup) {
        if (used > t + p) errs.push({ input: '#f-practice', msg: `กลุ่มเรียน ${byId(ctx.state.groups, gid)?.name ?? gid} ลงวิชานี้แล้ว ${used} คาบ มากกว่า ${t + p} ชม./สัปดาห์ (ลบคาบก่อนจึงลดชั่วโมงได้)` });
      }
    }
    // เอาครูออกจากวิชา แต่ยังมีคาบที่ลงให้ครูคนนั้นอยู่ → ไม่ให้บันทึก
    if (isEdit) {
      for (const tid of chosen.filter((id) => !teacherIds.includes(id))) {
        const n = ctx.state.entries.filter((e) => e.subjectId === subject.id && e.teacherId === tid).length;
        if (n) {
          const tname = byId(ctx.state.teachers, tid)?.name ?? tid;
          errs.push({ input: '#f-teachers', msg: `ยังมี ${n} คาบที่ลงให้ครู${tname} ถอดครูคนนี้ไม่ได้ (เปลี่ยนครูของคาบเหล่านั้นที่หน้าจัดตารางก่อน)` });
        }
      }
    }
    if (!showFormErrors(m.el, errs, ['#f-code', '#f-name', '#f-practice', '#f-credits', '#f-levels', '#f-teachers'])) return;
    const extra = $('#f-note').value.trim();
    const row = {
      id: subject?.id ?? uid('s'), code, name, type: $('#f-type').value, credits, hours: t + p,
      theory: t, practice: p, levels, teacherIds, note: extra,
    };
    busy = true;
    let r;
    try {
      r = await doOp({ type: 'subject.upsert', subject: row });
    } finally {
      busy = false;
    }
    if (!r.ok) {
      $('#form-errors').innerHTML = errorListHtml(r.errors, opFailureTitle(r, 'บันทึกไม่ได้ เพราะทำให้ตารางชนหรือชั่วโมงเกิน'));
      return;
    }
    m.close();
    toast(isEdit ? 'แก้ไขรายวิชาแล้ว' : 'เพิ่มรายวิชาแล้ว');
    ctx.rerender();
  };
  $('#f-save').addEventListener('click', submit);
  $('#subject-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}
