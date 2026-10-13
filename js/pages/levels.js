// หน้า "ระดับ" (แอดมิน): ระดับชั้นที่ใช้ในวิชา/กลุ่มเรียน/แผน — เพิ่ม · แก้ชื่อ (cascade) · ย้ายลำดับ · ลบ (ลบไม่ได้ถ้ายังมีการใช้งาน)
// ข้อมูลอยู่ที่ state.levels (สัญญา v5) · ทุกการแก้ผ่าน op level.add | level.rename | level.remove | level.move (doOp)
// ชื่อทุกค่าผ่าน esc() · ปุ่มอ้างระดับด้วยลำดับ (data-i) ไม่ใส่ชื่อลง attribute · ไม่ใช้ object เป็นดัชนีด้วยชื่อระดับ
import { MAX_LEVELS, LEVEL_NAME_MAX } from '../constants.js';
import { normalizeLevelName, levelNameIssue, levelKey, levelUsage } from '../store.js';
import { ctx, esc, toast, pageHeader, doOp, opFailureTitle } from './util.js';

const usageText = (u) => {
  if (!u.total) return 'ยังไม่มีการใช้งาน';
  return [u.subjects && `วิชา ${u.subjects}`, u.groups && `กลุ่มเรียน ${u.groups}`, u.plans && `แผน ${u.plans}`].filter(Boolean).join(' · ');
};

// ตรวจชื่อล่วงหน้า (ข้อความไทยจาก store.levelNameIssue + ซ้ำ) ; ignoreIndex = แถวที่กำลังแก้ชื่อ
export function levelFormIssue(levels, raw, ignoreIndex = -1) {
  const name = normalizeLevelName(raw);
  const issue = levelNameIssue(name);
  if (issue) return issue;
  const k = levelKey(name);
  if (levels.some((l, i) => i !== ignoreIndex && levelKey(l) === k)) return `มีระดับ "${name}" อยู่แล้ว`;
  return null;
}

export function renderLevels(root) {
  root.innerHTML = `${pageHeader('ระดับ')}
    <p class="text-muted">ระดับชั้นที่ใช้กับรายวิชา กลุ่มเรียน และแผนการเรียน (เช่น ปวช.1) เรียงตามลำดับที่ตั้งไว้ ใช้เรียงตารางตอนส่งออก · เปลี่ยนชื่อระดับจะเปลี่ยนในวิชา กลุ่มเรียน และแผนทั้งหมดให้อัตโนมัติ</p>
    <div id="level-box"></div>`;
  const box = root.querySelector('#level-box');
  const ui = { editing: -1, rowError: null, addError: '', addValue: '', editValue: '', busy: false };

  function paint() {
    const { state } = ctx;
    const levels = state.levels;
    const full = levels.length >= MAX_LEVELS;
    const rows = levels.map((name, i) => {
      const u = levelUsage(state, name);
      const locked = u.total > 0;
      const editing = ui.editing === i;
      const err = ui.rowError?.index === i ? `<div class="level-error-note" role="alert">${esc(ui.rowError.message)}</div>` : '';
      const nameCell = editing
        ? `<input class="input level-edit-input" data-level-input maxlength="${LEVEL_NAME_MAX * 2}" aria-label="ชื่อระดับใหม่" value="${esc(ui.editValue)}">
           <button type="button" class="btn btn-sm btn-primary" data-act="save" data-i="${i}">บันทึก</button>
           <button type="button" class="btn btn-sm" data-act="cancel">ยกเลิก</button>`
        : `<span class="level-name">${esc(name)}</span>`;
      return `<li class="level-row${editing ? ' is-editing' : ''}${locked ? ' is-locked' : ''}">
        <span class="level-index">${i + 1}</span>
        ${nameCell}
        <span class="level-usage${locked ? ' is-used' : ''}">${esc(usageText(u))}</span>
        <span class="level-actions">
          <button type="button" class="btn btn-sm btn-icon" data-act="up" data-i="${i}" aria-label="เลื่อนขึ้น"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="btn btn-sm btn-icon" data-act="down" data-i="${i}" aria-label="เลื่อนลง"${i === levels.length - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="btn btn-sm" data-act="edit" data-i="${i}">แก้ชื่อ</button>
          <button type="button" class="btn btn-sm btn-danger" data-act="remove" data-i="${i}"${locked ? ' disabled' : ''}>ลบ</button>
        </span>
        ${locked ? `<div class="level-lock-note">ลบไม่ได้ เพราะยังมีการใช้งาน ${u.total} รายการ — ย้ายหรือเปลี่ยนระดับของรายการเหล่านั้นก่อน</div>` : ''}
        ${err}
      </li>`;
    }).join('');
    box.innerHTML = `<div class="level-manager">
      <p class="level-count" role="status">ระดับทั้งหมด ${levels.length} จาก ${MAX_LEVELS}</p>
      ${levels.length ? `<ul class="level-list">${rows}</ul>` : '<p class="text-muted">ยังไม่มีระดับ เพิ่มระดับแรกด้านล่าง</p>'}
      <form class="level-add" id="level-add" novalidate>
        <div class="field">
          <label class="field-label" for="f-level-name">เพิ่มระดับใหม่</label>
          <input class="input" id="f-level-name" maxlength="${LEVEL_NAME_MAX * 2}" placeholder="เช่น ปวช.4" value="${esc(ui.addValue)}"${full ? ' disabled' : ''}>
          <span class="field-hint">ยาวไม่เกิน ${LEVEL_NAME_MAX} ตัวอักษร ห้ามซ้ำ และห้ามมีเครื่องหมายจุลภาค (,)${full ? ` · ครบ ${MAX_LEVELS} ระดับแล้ว` : ''}</span>
          <div class="field-error" id="level-add-error" role="alert">${esc(ui.addError)}</div>
        </div>
        <button type="submit" class="btn btn-primary"${full ? ' disabled' : ''}>เพิ่มระดับ</button>
      </form>
    </div>`;
    const input = box.querySelector('[data-level-input]');
    if (input) input.focus?.();
  }

  // รัน op เดียว: สำเร็จ → วาดใหม่ ; ล้มเหลว → ข้อความไทยในแถว/ฟอร์ม (ไม่ throw)
  async function run(op, onFail) {
    if (ui.busy) return false;
    ui.busy = true;
    try {
      const r = await doOp(op);
      if (!r.ok) {
        onFail(r.errors[0] || opFailureTitle(r, 'ทำรายการไม่ได้'));
        paint();
        return false;
      }
      return true;
    } finally {
      ui.busy = false;
    }
  }

  const rowFail = (index) => (message) => { ui.rowError = { index, message }; };

  box.addEventListener('submit', async (e) => {
    if (!e.target?.matches?.('#level-add')) return;
    e.preventDefault();
    const raw = box.querySelector('#f-level-name').value;
    ui.addValue = raw;
    const issue = levelFormIssue(ctx.state.levels, raw);
    if (issue) { ui.addError = issue; paint(); return; }
    if (await run({ type: 'level.add', name: normalizeLevelName(raw) }, (m) => { ui.addError = m; })) {
      ui.addError = '';
      ui.addValue = '';
      ui.rowError = null;
      toast('เพิ่มระดับแล้ว');
      paint();
    }
  });

  box.addEventListener('click', async (e) => {
    const btn = e.target?.closest?.('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    const i = Number(btn.dataset.i);
    const levels = ctx.state.levels;
    const name = levels[i];
    ui.rowError = null;
    if (act === 'cancel') { ui.editing = -1; paint(); return; }
    if (act === 'edit') { ui.editing = i; ui.editValue = name; paint(); return; }
    if (!Number.isInteger(i) || name === undefined) return;
    if (act === 'save') {
      const raw = box.querySelector('[data-level-input]')?.value ?? '';
      ui.editValue = raw;
      const issue = levelFormIssue(levels, raw, i);
      if (issue) { ui.rowError = { index: i, message: issue }; paint(); return; }
      const to = normalizeLevelName(raw);
      if (to === name) { ui.editing = -1; paint(); return; }
      const u = levelUsage(ctx.state, name);
      if (u.total && !confirm(`เปลี่ยนชื่อระดับ "${name}" เป็น "${to}"?\nจะเปลี่ยนในรายการที่ใช้อยู่ทั้งหมด (${usageText(u)})`)) return;
      if (await run({ type: 'level.rename', from: name, to }, rowFail(i))) {
        ui.editing = -1;
        toast('เปลี่ยนชื่อระดับแล้ว');
        paint();
      }
    } else if (act === 'up' || act === 'down') {
      const toIndex = act === 'up' ? i - 1 : i + 1;
      if (toIndex < 0 || toIndex >= levels.length) return;
      if (await run({ type: 'level.move', name, toIndex }, rowFail(i))) paint();
    } else if (act === 'remove') {
      if (!confirm(`ลบระดับ "${name}"?`)) return;
      if (await run({ type: 'level.remove', name }, rowFail(i))) {
        ui.editing = -1;
        toast('ลบระดับแล้ว');
        paint();
      }
    }
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.editing >= 0) { ui.editing = -1; ui.rowError = null; paint(); }
    if (e.key === 'Enter' && e.target?.matches?.('[data-level-input]')) {
      e.preventDefault();
      box.querySelector('[data-act=save]')?.click?.();
    }
  });
  paint();
}
