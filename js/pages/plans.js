// หน้าแผนการเรียน (ชุดวิชา/โครงหลักสูตร): CRUD แผน + เลือกวิชาแบบ checkbox กรองตามระดับ
// การผูกแผนเข้ากลุ่มเรียนทำที่หน้า "กลุ่มเรียน" (ปุ่ม "เลือกแผนการเรียน")
import { uid } from '../store.js';
import { mountTableList, mountChecklist } from './list-kit.js';
import {
  ctx, esc, byId, toast, openModal, doOp, field, optionsHtml, pageHeader, emptyHtml, showFormErrors,
  errorListHtml, opFailureTitle, editOnly,
} from './util.js';

const planFilters = () => [{ id: 'level', label: 'ระดับ', options: ctx.state.levels.map((l) => [l, l]), test: (p, v) => p.level === v }];

export function renderPlans(root) {
  const { state } = ctx;
  root.innerHTML = `
    ${pageHeader('แผนการเรียน', editOnly('<button type="button" class="btn btn-primary" id="btn-add">+ เพิ่มแผนการเรียน</button>'))}
    <p class="text-muted">แผนการเรียน คือชุดวิชาที่กลุ่มเรียนต้องเรียนในระดับนั้น เลือกใช้กับกลุ่มเรียนได้ที่เมนู "กลุ่มเรียน" แล้วหน้าจัดตารางจะแสดงวิชาที่ต้องเรียนพร้อมจำนวนชั่วโมงที่เหลือ</p>
    <div id="list-root"></div>`;
  root.querySelector('#btn-add')?.addEventListener('click', () => planForm(null));
  if (!state.plans.length) {
    root.querySelector('#list-root').innerHTML = emptyHtml('ยังไม่มีแผนการเรียน กด "เพิ่มแผนการเรียน" หรือนำเข้าจาก Excel ที่หน้า "ข้อมูล"');
    return;
  }
  const subjectNames = (p) => p.subjectIds.map((id) => byId(ctx.state.subjects, id)?.name ?? '').join(' ');
  mountTableList(root.querySelector('#list-root'), {
    name: 'plans',
    def: { fields: (p) => [p.name, p.level, p.note, subjectNames(p)], filters: planFilters(), sort: { key: (p) => p.name }, placeholder: 'ค้นหาชื่อแผน/วิชาในแผน' },
    getItems: () => ctx.state.plans,
    headHtml: `<tr><th>ชื่อแผน</th><th>ระดับ</th><th class="col-num">จำนวนวิชา</th><th>วิชา</th><th>หมายเหตุ</th><th class="col-num">กลุ่มที่ใช้</th>${editOnly('<th></th>')}</tr>`,
    rowHtml: (p) => {
      const used = ctx.state.groups.filter((g) => g.planId === p.id).length;
      const names = p.subjectIds.map((id) => byId(ctx.state.subjects, id)?.name ?? id);
      return `<tr><td>${esc(p.name)}</td><td><span class="badge badge-level">${esc(p.level)}</span></td>
        <td class="col-num">${p.subjectIds.length}</td>
        <td>${esc(names.slice(0, 6).join(', '))}${names.length > 6 ? ` … (+${names.length - 6})` : ''}</td>
        <td>${esc(p.note)}</td><td class="col-num">${used}</td>
        ${editOnly(`<td class="col-actions"><button type="button" class="btn btn-sm" data-edit="${esc(p.id)}">แก้ไข</button>
          <button type="button" class="btn btn-sm btn-danger" data-del="${esc(p.id)}">ลบ</button></td>`)}</tr>`;
    },
    bind: (el) => {
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => planForm(byId(ctx.state.plans, b.dataset.edit))));
      el.querySelectorAll('[data-del]').forEach((b) =>
        b.addEventListener('click', async () => {
          const p = byId(ctx.state.plans, b.dataset.del);
          const n = ctx.state.groups.filter((g) => g.planId === p.id).length;
          if (!confirm(n ? `ลบแผน "${p.name}" ? ${n} กลุ่มเรียนที่ใช้แผนนี้จะกลายเป็นยังไม่เลือกแผน (วิชาที่ผูกไว้ยังอยู่)` : `ลบแผน "${p.name}" ?`)) return;
          const r = await doOp({ type: 'plan.delete', id: p.id });
          if (!r.ok) return toast(`${opFailureTitle(r)}: ${r.errors[0] ?? ''}`, 'error');
          toast('ลบแผนการเรียนแล้ว');
          ctx.rerender();
        }),
      );
    },
  });
}

export function planForm(plan) {
  if (!ctx.state.levels?.length) return toast('ยังไม่มีระดับ ไปเพิ่มที่เมนู "ระดับ" ก่อน', 'error');
  const isEdit = Boolean(plan);
  const chosen = new Set(plan?.subjectIds || []);
  const m = openModal({
    title: isEdit ? 'แก้ไขแผนการเรียน' : 'เพิ่มแผนการเรียน',
    large: true,
    bodyHtml: `<form id="plan-form" novalidate><div id="form-errors"></div>
      <div class="form-grid">
        ${field('ชื่อแผน', `<input class="input" id="f-name" value="${esc(plan?.name)}" placeholder="เช่น ปวช.1 เทคโนโลยีสารสนเทศ">`, { required: true, id: 'f-name', hint: 'ห้ามซ้ำกับแผนอื่น' })}
        ${field('ระดับ', `<select class="select" id="f-level">${optionsHtml(ctx.state.levels.map((l) => [l, l]), plan?.level || ctx.state.levels[0])}</select>`, { id: 'f-level' })}
        <div class="span-2">${field('หมายเหตุ', `<input class="input" id="f-note" value="${esc(plan?.note)}">`, { id: 'f-note' })}</div>
        <div class="span-2">${field('วิชาในแผน', '<div id="f-subjects" aria-label="วิชาในแผน"></div>',
          { hint: 'แสดงเฉพาะวิชาที่เปิดสอนในระดับที่เลือก' })}</div>
      </div>
    </form>`,
    footerHtml: '<button type="button" class="btn" data-close>ยกเลิก</button><button type="button" class="btn btn-primary" id="f-save">บันทึก</button>',
  });
  const $ = (id) => m.el.querySelector(id);
  // วิชาในแผน: รายการติ๊กเลือกค้นหา/แบ่งหน้าได้ (วิชาอาจมีหลายร้อย) แสดงเฉพาะวิชาที่เปิดสอนในระดับที่เลือก
  const subjectsForLevel = () => ctx.state.subjects.filter((x) => (x.levels || []).includes($('#f-level').value)).map((x) => ({ id: x.id, label: `${x.code} ${x.name}` }));
  const subjectPick = mountChecklist($('#f-subjects'), {
    name: 'cl-plan-subjects',
    placeholder: 'ค้นหาวิชา',
    items: subjectsForLevel,
    selected: chosen,
    emptyText: 'ยังไม่มีวิชาที่เปิดสอนระดับนี้ (หรือไม่ตรงคำค้น)',
  });
  $('#f-level').addEventListener('change', () => subjectPick.refresh());
  let busy = false;
  const submit = async () => {
    if (busy) return;
    const name = $('#f-name').value.trim();
    const errs = [];
    if (!name) errs.push({ input: '#f-name', msg: 'กรุณากรอกชื่อแผน' });
    else if (ctx.state.plans.some((x) => x.name.trim() === name && x.id !== plan?.id)) errs.push({ input: '#f-name', msg: `แผน ${name} ซ้ำกับที่มีอยู่แล้ว` });
    if (!showFormErrors(m.el, errs, ['#f-name'])) return;
    const allowed = new Set(subjectsForLevel().map((x) => x.id));
    const subjectIds = subjectPick.getSelected().filter((id) => allowed.has(id)); // เฉพาะวิชาที่เปิดสอนในระดับของแผน
    busy = true;
    let r;
    try {
      r = await doOp({ type: 'plan.upsert', plan: { id: plan?.id ?? uid('p'), name, level: $('#f-level').value, subjectIds, note: $('#f-note').value.trim() } });
    } finally {
      busy = false;
    }
    if (!r.ok) {
      $('#form-errors').innerHTML = errorListHtml(r.errors, opFailureTitle(r, 'บันทึกไม่ได้'));
      return;
    }
    m.close();
    toast(isEdit ? 'แก้ไขแผนการเรียนแล้ว' : 'เพิ่มแผนการเรียนแล้ว');
    ctx.rerender();
  };
  $('#f-save').addEventListener('click', submit);
  $('#plan-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}
