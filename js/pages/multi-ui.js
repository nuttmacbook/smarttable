// UI โหมดเลือกหลายช่องของหน้าจัดตาราง (SPEC v5 ข้อ 15.1) — ใช้ selection-model + multi-actions
// เลือกได้ 4 วิธี: คลิกสะสม · ลาก (pointer events: เมาส์/ปากกา/ทัช) · Shift+คลิก · ปุ่ม "เลือกเป็นช่วง" (แทน Shift บนทัช) · คีย์ลัด Esc = ล้างการเลือก
// ทุกค่าที่ใส่ HTML ผ่าน esc() · ไม่มี inline handler (event delegation ที่ #multi-box และ #grid-box)
// ข้อจำกัด: บนทัชตั้ง touch-action: pan-y จึงลากแนวนอน (ข้ามคาบ) ได้ แต่ลากแนวตั้งข้ามวันจะเลื่อนหน้า → ใช้ปุ่มช่วงแทน · ยังไม่ได้ทดสอบกับเบราว์เซอร์/ทัชจริง
import { dayName, periodLabel } from '../constants.js';
import {
  createSelection, toggleCell, applyRange, beginDrag, dragTo, partitionSelection, cellKey, limitSelection, MAX_SELECTION,
} from '../selection-model.js';
import { remainingQuota, cachedBlockedCells } from '../panel-model.js';
import { ctx, esc, byId, toast, openModal, gridHtml, errorListHtml, opFailureTitle, subjectTeacherIds } from './util.js';
import { searchSelect } from './list-kit.js';
import {
  placeItems, dryRunPlace, placeMany, removalSummary, removeMany, entryIdsAt, hasEntryAt, tooMany, reasonChip,
} from './multi-actions.js';

const newMulti = () => ({
  on: false,
  kind: 'place', // 'place' | 'remove'
  sel: createSelection(),
  skipped: 0,
  preview: null,
  rangeArmed: false,
  rangeMode: 'add',
  teacherId: '',
  roomId: '',
});
export const getMulti = () => {
  if (!ctx.ui.multi) ctx.ui.multi = newMulti();
  return ctx.ui.multi;
};
export const resetMulti = () => { ctx.ui.multi = newMulti(); };
// เปลี่ยนกลุ่มเรียน: ล้างช่องที่เลือก (คงสถานะเปิด/ปิดโหมดไว้)
export const clearMultiSelection = () => {
  const m = getMulti();
  m.sel = createSelection();
  m.skipped = 0;
  m.preview = null;
  m.teacherId = '';
};

let escHandler = null; // ตัวฟัง Esc ระดับเอกสาร (ถอดของเก่าก่อนผูกใหม่ทุกครั้งที่เรนเดอร์หน้า)

// วิชาที่เลือกลงได้ในโหมดหลายช่อง: วิชาของกลุ่มที่ยังเหลือชั่วโมง; ถ้าไม่มี (ยังไม่ผูกวิชา/ไม่เหลือ) ใช้วิชาทั้งหมดที่ระดับตรงกับกลุ่ม
// (ระบบอนุญาตวิชานอกแผนเป็นคำเตือน ไม่บล็อก) — ชั่วโมงเต็มจะถูก dry-run ปฏิเสธรายช่อง
export function multiSubjectItems(state, group, panel) {
  const fromPanel = panel.rows.filter((r) => r.remaining > 0).map((r) => ({ id: r.subject.id, label: `${r.subject.code} ${r.subject.name}`, detail: `เหลือ ${r.remaining} ชม.` }));
  if (fromPanel.length) return fromPanel;
  return (state.subjects || []).filter((s) => (s.levels || []).includes(group.level)).map((s) => ({ id: s.id, label: `${s.code} ${s.name}`, detail: 'นอกแผน/ไม่ได้ผูกกับกลุ่ม' }));
}

const keyOfEl = (td) => (td?.dataset?.day ? cellKey(Number(td.dataset.day), Number(td.dataset.period)) : null);

// opts = { root, group, state, panel, baseCell:(day,period)=>cellObj, onNormalClick:(day,period)=>void, renderLegend:()=>html }
export function mountMulti(opts) {
  const { root, group, state, panel } = opts;
  const m = getMulti();
  const multiBox = root.querySelector('#multi-box');
  const gridBox = root.querySelector('#grid-box');
  let drag = null;

  const subjectRow = () => {
    const id = ctx.ui.placingSubjectId;
    const inPanel = panel.rows.find((r) => r.subject.id === id);
    if (inPanel) return inPanel;
    const subject = byId(state.subjects, id);
    // วิชานอกแผน: ไม่มีสรุปชั่วโมงในแผง แต่ลงได้ (dry-run ตรวจชั่วโมง/ชน ให้ทุกช่อง)
    return subject && multiSubjectItems(state, group, panel).some((x) => x.id === id) ? { subject, remaining: Infinity, status: 'outside', need: Number(subject.hours) || 0, used: 0, over: 0, percent: 0 } : null;
  };
  const usable = (day, period) => (m.kind === 'remove' ? hasEntryAt(state, group.id, day, period) : !hasEntryAt(state, group.id, day, period));
  const keysOf = () => [...m.sel.keys];

  // โควตาชั่วโมงของวิชาที่เลือก (โหมดลงเท่านั้น) : available = ที่ยังเลือกเพิ่มได้ทั้งชุด (Infinity = ไม่จำกัด/ยังไม่เลือกวิชา)
  const quotaOf = (pickedCount = m.sel.keys.size) => {
    const subject = m.kind === 'place' ? subjectRow()?.subject : null;
    return subject ? remainingQuota(state, { groupId: group.id, subjectId: subject.id, picked: pickedCount }) : null;
  };
  const fullMsg = (q) => `ชั่วโมงเต็มแล้ว: วิชานี้เหลือ 0 ชม. (ต้องเรียน ${q.need} จัดแล้ว ${q.used} เลือกแล้ว ${q.picked})`;
  // ช่องที่ลงวิชานี้ไม่ได้ (ชนครู/ห้อง/ระดับ/พักเที่ยง ฯลฯ ตามตัวตรวจกลางของ scheduler ผ่าน blockedCells) — ไม่นับ 'ชั่วโมงเต็ม' อย่างเดียว (ให้ขั้นโควตาจัดการและแจ้งข้อความของมันเอง)
  const blockedNow = () => {
    const row = m.kind === 'place' ? subjectRow() : null;
    return row ? cachedBlockedCells(state, { groupId: group.id, subjectId: row.subject.id, teacherId: m.teacherId, roomId: m.roomId }) : null;
  };
  const hardBlocked = (map, key) => {
    const bl = map?.get(key);
    return bl && !(bl.types.length === 1 && bl.types[0] === 'hours') ? bl : null;
  };

  // ผลการเลือกหลังตัดช่องที่ลงไม่ได้ (เฉพาะช่องใหม่ ช่องที่เลือกไว้แล้วอยู่ต่อ/เอาออกได้เสมอ) และจำกัดตามโควตา — ใช้ทั้งพรีวิวตอนลากและตอนยืนยัน ไม่แตะ state
  function limited(nextKeys) {
    const { usable: ok } = partitionSelection(nextKeys, usable);
    const map = blockedNow();
    const skippedBlocked = [];
    const allowed = ok.filter((k) => {
      if (m.sel.keys.has(k)) return true;
      const bl = hardBlocked(map, k);
      if (bl) { skippedBlocked.push({ key: k, reason: bl.reason }); return false; }
      return true;
    });
    const q = quotaOf(0);
    const { keys, cut } = limitSelection(m.sel.keys, allowed, q ? q.available : Infinity);
    return { keys, cut, q, skippedBlocked };
  }

  // ตัดช่องที่เลือกไม่ได้ในโหมดปัจจุบันออก (ข้ามเงียบ แต่นับไว้แสดงในแถบสถานะ) ข้ามช่องที่ลงไม่ได้ แล้วจำกัดตามโควตาชั่วโมง — แจ้งทันที
  function setSel(next) {
    const { skipped } = partitionSelection(next.keys, usable);
    m.skipped += skipped.length;
    const { keys, cut, q, skippedBlocked } = limited(next.keys);
    const before = m.sel.keys.size;
    m.sel = { keys, anchor: next.anchor };
    if (!skippedBlocked.length && !cut) return;
    const single = keys.size === before && next.keys.size === before + 1;
    if (single) {
      // คลิกเพิ่มช่องเดียวที่ไม่เข้าชุด : บอกเหตุผลของช่องนั้น
      toast(skippedBlocked.length ? `ลงไม่ได้: ${skippedBlocked[0].reason}` : fullMsg({ ...q, picked: keys.size }), 'error');
      return;
    }
    const parts = [];
    if (skippedBlocked.length) parts.push(`ข้ามช่องที่ลงไม่ได้ ${skippedBlocked.length} ช่อง`);
    if (cut && q) parts.push(`ตัดส่วนที่เกิน ${cut} ช่อง — วิชานี้เหลือ ${q.available} ชม. (ต้องเรียน ${q.need} จัดแล้ว ${q.used})`);
    toast(parts.join(' · '), 'error');
  }
  // เปลี่ยนวิชา/ครู/ห้อง/โหลดข้อมูลใหม่ระหว่างมีช่องค้าง : ตัดช่องที่ลงวิชาใหม่ไม่ได้และส่วนที่เกินโควตา แล้วแจ้ง
  function reconcile() {
    if (!m.on || m.kind !== 'place' || !m.sel.keys.size) return;
    const map = blockedNow();
    const kept = [...m.sel.keys].filter((k) => !hardBlocked(map, k));
    const dropped = m.sel.keys.size - kept.length;
    let keys = new Set(kept);
    let cut = 0;
    const q = quotaOf(0);
    if (q && q.available < keys.size) ({ keys, cut } = limitSelection(new Set(), keys, q.available));
    if (!dropped && !cut) return;
    m.sel = { keys, anchor: m.sel.anchor };
    toast(`ปรับชุดที่เลือกตามโควตาและเงื่อนไขของวิชานี้: ตัดช่องที่ลงไม่ได้ ${dropped} ช่อง${cut ? ` · ตัดส่วนเกินโควตา ${cut} ช่อง` : ''}`, 'error');
  }

  function cellDecorated(day, period) {
    const base = opts.baseCell(day, period);
    if (!m.on) return base;
    const key = cellKey(day, period);
    let cls = base.cls;
    const inPreview = m.preview && m.preview.has(key);
    const isSel = m.sel.keys.has(key);
    if (isSel) cls += ' is-selected';
    if (inPreview && !isSel) cls += ' is-range-preview';
    if (m.sel.anchor === key) cls += ' is-anchor';
    if (!usable(day, period)) cls += ' is-skipped';
    return { ...base, cls };
  }

  function paintGrid() {
    const wrap = `${m.on ? 'is-multi' : ''}${m.on && m.kind === 'remove' ? ' is-remove' : ''}${drag ? ' is-selecting' : ''}`.trim();
    gridBox.innerHTML = gridHtml(cellDecorated, { wrapClass: wrap });
    const w = gridBox.querySelector('.tt-wrap');
    if (w && m.on && w.style) w.style.touchAction = 'pan-y';
    if (!m.on) {
      gridBox.querySelectorAll('[data-day]').forEach((el) => {
        const go = () => opts.onNormalClick(Number(el.dataset.day), Number(el.dataset.period));
        el.addEventListener('click', go);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
      });
    }
  }

  // ตัวนับโควตา 'เลือกแล้ว k/N ชม.' (เฉพาะโหมดลงที่เลือกวิชาและวิชามีจำกัดชั่วโมง)
  function quotaBadge() {
    const q = quotaOf();
    if (!q || q.unlimited) return '';
    const full = q.remaining <= 0;
    return `<span class="multi-quota${full ? ' is-full' : ''}">เลือกแล้ว ${q.picked}/${q.available} ชม.${full ? ' · ชั่วโมงเต็ม' : ''}</span>`;
  }

  let barSelects = [];
  function barHtml() {
    barSelects = [];
    const sw = `<label class="switch"><input type="checkbox" role="switch" id="multi-switch"${m.on ? ' checked' : ''}><span class="switch-track"></span><span class="switch-label">โหมดเลือกหลายช่อง</span></label>`;
    if (!m.on) return `<div class="multi-bar">${sw}</div>`;
    const n = m.sel.keys.size;
    const row = subjectRow();
    const kindChips = `<fieldset class="chip-group" aria-label="ชนิดการทำงาน">
      <label class="chip"><input type="radio" name="multi-kind" value="place"${m.kind === 'place' ? ' checked' : ''}><span>ลงวิชา</span></label>
      <label class="chip"><input type="radio" name="multi-kind" value="remove"${m.kind === 'remove' ? ' checked' : ''}><span>ลบวิชาที่ลงแล้ว</span></label></fieldset>`;
    let setup = '';
    if (m.kind === 'place') {
      const subj = row?.subject;
      const tids = subj ? subjectTeacherIds(subj) : [];
      const subjectSel = searchSelect({
        id: 'multi-subject', label: 'multi-subject', placeholder: 'ค้นหาวิชา', blank: '— เลือกวิชา —', value: ctx.ui.placingSubjectId ?? '',
        // ถ้ากลุ่มยังไม่ผูกวิชา (หรือวิชาที่ผูกไม่เหลือ) ใช้วิชาทั้งหมดที่เปิดสอนในระดับของกลุ่มแทน เหมือนตัวเลือกวิชาเดิม (NOTE-19)
        items: multiSubjectItems(state, group, panel),
        onChange: (v) => { ctx.ui.placingSubjectId = v || null; m.teacherId = ''; ctx.rerender(); },
      });
      const teacherSel = tids.length >= 2 ? searchSelect({
        id: 'multi-teacher', label: 'multi-teacher', placeholder: 'ค้นหาครู', blank: '— เลือกครูผู้สอน —', value: m.teacherId,
        items: tids.map((id) => ({ id, label: byId(state.teachers, id)?.name ?? id })),
        onChange: (v) => { m.teacherId = v; paintGrid(); },
      }) : null;
      const roomSel = searchSelect({
        id: 'multi-room', label: 'multi-room', placeholder: 'ค้นหาห้องเรียน', blank: '— ไม่ระบุห้องเรียน —', value: m.roomId,
        items: state.rooms.map((r) => ({ id: r.id, label: r.name + (r.building ? ` (${r.building})` : '') })),
        onChange: (v) => { m.roomId = v; paintGrid(); },
      });
      barSelects.push(subjectSel, ...(teacherSel ? [teacherSel] : []), roomSel);
      setup = `<span class="multi-mode-label">ลงวิชา:</span>
        ${subjectSel.html}
        ${teacherSel ? teacherSel.html : ''}
        ${roomSel.html}`;
    } else {
      setup = '<span class="multi-mode-label">เลือกช่องที่ลงแล้วเพื่อลบ</span>';
    }
    const range = `<fieldset class="chip-group" aria-label="เลือกเป็นช่วง (แทน Shift บนทัช)">
      <label class="chip"><input type="checkbox" id="multi-range"${m.rangeArmed ? ' checked' : ''}><span>เลือกเป็นช่วง</span></label>
      <label class="chip"><input type="radio" name="multi-range-mode" value="add"${m.rangeMode === 'add' ? ' checked' : ''}><span>เพิ่มช่วง</span></label>
      <label class="chip"><input type="radio" name="multi-range-mode" value="remove"${m.rangeMode === 'remove' ? ' checked' : ''}><span>ลบช่วง</span></label></fieldset>`;
    const act = m.kind === 'remove'
      ? `<button type="button" class="btn btn-danger" data-multi-action="remove"${n ? '' : ' disabled'}>ลบที่เลือก (${n})</button>`
      : `<button type="button" class="btn btn-primary" data-multi-action="place"${n && row ? '' : ' disabled'}>ลงตาราง (${n} ช่อง)</button>`;
    return `<div class="multi-bar is-on${m.kind === 'remove' ? ' is-remove' : ''}">
      ${sw}${kindChips}${setup}
      ${quotaBadge()}
      <span class="multi-count" role="status">เลือก ${n} ช่อง${m.skipped ? ` (ข้ามช่องที่เลือกไม่ได้ ${m.skipped})` : ''}${n > MAX_SELECTION ? ` — เกิน ${MAX_SELECTION} ช่อง` : ''}</span>
      ${range}
      ${m.kind === 'place' ? '<span class="field-hint multi-red-note">ชั่วโมงเต็มแล้วช่องที่เหลือจะแดงทันที · ชนครู/ห้องตรวจทีละช่อง และตรวจรวมอีกครั้งตอนกด "ลงตาราง" (ตรวจล่วงหน้า)</span>' : ''}
      <div class="multi-actions">${act}
        <button type="button" class="btn" data-multi-action="clear"${n ? '' : ' disabled'}>ล้างการเลือก</button>
        <button type="button" class="btn" data-multi-action="off">ยกเลิกโหมด</button></div>
    </div>`;
  }
  function paintBar() {
    multiBox.innerHTML = barHtml();
    barSelects.forEach((x) => x.mount(multiBox));
  }
  function paintAll() { paintBar(); paintGrid(); }

  // ----- ผลลัพธ์ -----
  const done = (msg) => { resetSelection(); toast(msg); ctx.rerender(); };
  function resetSelection() { m.sel = createSelection(); m.skipped = 0; m.preview = null; }

  function resultModal(dry, items) {
    const rows = dry.rows.map((x) => `<tr class="row-${x.ok ? 'ok' : 'fail'}"><td>${esc(dayName(x.day))}</td><td>${esc(periodLabel(x.period))}</td>
      <td>${x.ok ? '<span class="reason-chip reason-ok">ลงได้</span> <span class="result-ok">ลงได้</span>' : `<span class="result-fail">ลงไม่ได้</span> ${x.reasons.map((r, i) => { const [cls, label] = reasonChip(x.types[i]); return `<span class="reason-chip ${cls}">${esc(label)}</span> <span class="result-reason">${esc(r)}</span>`; }).join(' ')}`}</td></tr>`).join('');
    const mm = openModal({
      title: 'ผลการตรวจล่วงหน้า',
      large: true,
      bodyHtml: `<p class="result-summary">ลงได้ ${dry.okCount} จาก ${dry.total} ช่อง</p>
        <div class="table-wrap"><table class="data-table result-table"><thead><tr><th>วัน</th><th>คาบ</th><th>สถานะ</th></tr></thead><tbody>${rows}</tbody></table></div>
        <div id="form-errors"></div>`,
      footerHtml: `<button type="button" class="btn" data-close>ยกเลิกทั้งชุด</button>
        <button type="button" class="btn btn-primary" id="m-valid"${dry.okCount ? '' : ' disabled'}>ลงเฉพาะช่องที่ลงได้ (${dry.okCount} จาก ${dry.total})</button>`,
    });
    let busy = false;
    mm.el.querySelector('#m-valid').addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await placeMany(items, 'valid');
        if (!r.ok) {
          mm.el.querySelector('#form-errors').innerHTML = errorListHtml(r.errors, opFailureTitle(r, 'ลงไม่สำเร็จ'));
          return;
        }
        mm.close();
        done(`ลง ${r.placedCount} ช่องแล้ว${r.rejectedCount ? ` (ข้าม ${r.rejectedCount} ช่อง)` : ''}`);
      } finally {
        busy = false;
      }
    });
  }

  let acting = false;
  async function doPlace() {
    if (acting) return;
    const row = subjectRow();
    if (!row) return toast('เลือกวิชาที่จะลงก่อน', 'error');
    const tids = subjectTeacherIds(row.subject);
    if (tids.length >= 2 && !m.teacherId) return toast('วิชานี้มีครูหลายคน กรุณาเลือกครูผู้สอน', 'error');
    const keys = keysOf();
    if (tooMany(keys.length)) return toast(`เลือกได้ไม่เกิน ${MAX_SELECTION} ช่องต่อครั้ง`, 'error');
    const items = placeItems(group.id, keys, { subjectId: row.subject.id, teacherId: tids.length >= 2 ? m.teacherId : '', roomId: m.roomId });
    if (!items.length) return;
    acting = true;
    try {
      const dry = await dryRunPlace(items);
      if (dry.error) return toast(`${opFailureTitle(dry.error)}: ${dry.error.errors[0] ?? ''}`, 'error');
      if (dry.wouldSucceed) {
        const r = await placeMany(items, 'all');
        if (!r.ok) return toast(`${opFailureTitle(r, 'ลงไม่สำเร็จ')}: ${r.errors[0] ?? ''}`, 'error');
        return done(`ลง ${r.placedCount} ช่องแล้ว`);
      }
      resultModal(dry, items);
    } finally {
      acting = false;
    }
  }

  async function doRemove() {
    if (acting) return;
    const ids = entryIdsAt(state, group.id, keysOf());
    if (!ids.length) return;
    if (tooMany(ids.length)) return toast(`เลือกได้ไม่เกิน ${MAX_SELECTION} ช่องต่อครั้ง`, 'error');
    const sum = removalSummary(state, ids);
    if (!confirm(`ลบ ${sum.total} ช่อง (คาบ) ออกจากตาราง?\n${sum.text}`)) return;
    acting = true;
    try {
      const r = await removeMany(ids);
      if (!r.ok) return toast(`${opFailureTitle(r, 'ลบไม่สำเร็จ')}: ${r.errors[0] ?? ''}`, 'error');
      done(`ลบ ${r.removedCount} ช่องแล้ว`);
    } finally {
      acting = false;
    }
  }

  // ----- เหตุการณ์: แถบควบคุม (delegation) -----
  multiBox.addEventListener('change', (e) => {
    const t = e.target;
    if (t?.matches?.('#multi-switch')) {
      m.on = Boolean(t.checked);
      resetSelection();
      ctx.rerender();
    } else if (t?.matches?.('[name=multi-kind]')) {
      m.kind = t.value === 'remove' ? 'remove' : 'place';
      resetSelection();
      paintAll();
    } else if (t?.matches?.('#multi-range')) {
      m.rangeArmed = Boolean(t.checked);
    } else if (t?.matches?.('[name=multi-range-mode]')) {
      m.rangeMode = t.value === 'remove' ? 'remove' : 'add';
    }
  });
  multiBox.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-multi-action]');
    if (!btn) return;
    const a = btn.dataset.multiAction;
    if (a === 'place') doPlace();
    else if (a === 'remove') doRemove();
    else if (a === 'clear') { resetSelection(); paintAll(); }
    else if (a === 'off') { m.on = false; resetSelection(); ctx.rerender(); }
  });

  // ----- เหตุการณ์: ตาราง (delegation; ทำงานเฉพาะเมื่อเปิดโหมด) -----
  const cellAt = (x, y) => keyOfEl(document.elementFromPoint?.(x, y)?.closest?.('[data-day]'));
  const onMove = (e) => {
    if (!drag) return;
    const k = cellAt(e.clientX, e.clientY);
    if (!k || k === drag.last) return;
    drag.last = k;
    drag.moved = true;
    m.preview = limited(dragTo(drag, k).keys).keys;
    paintGrid();
  };
  const endDrag = (commit) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    const d = drag;
    drag = null;
    m.preview = null;
    if (commit && d) setSel(dragTo(d, d.last));
    paintAll();
  };
  const onUp = () => endDrag(true);
  const onCancel = () => endDrag(false);
  gridBox.addEventListener('pointerdown', (e) => {
    if (!m.on || (e.button !== undefined && e.button > 0)) return;
    const td = e.target?.closest?.('[data-day]');
    const key = keyOfEl(td);
    if (!key) return;
    e.target.releasePointerCapture?.(e.pointerId);
    if (e.shiftKey || m.rangeArmed) {
      setSel(applyRange(m.sel, key, e.shiftKey ? 'add' : m.rangeMode));
      paintAll();
      return;
    }
    e.preventDefault?.();
    drag = { ...beginDrag(m.sel, key), last: key, moved: false };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    m.preview = limited(dragTo(drag, key).keys).keys;
    paintGrid();
  });
  gridBox.addEventListener('keydown', (e) => {
    if (!m.on || (e.key !== 'Enter' && e.key !== ' ')) return;
    const key = keyOfEl(e.target?.closest?.('[data-day]'));
    if (!key) return;
    e.preventDefault?.();
    setSel(toggleCell(m.sel, key));
    paintAll();
  });

  if (escHandler) document.removeEventListener('keydown', escHandler);
  escHandler = (e) => {
    if (e.key === 'Escape' && m.on && m.sel.keys.size && !document.getElementById?.('modal-root')?.innerHTML) {
      resetSelection();
      paintAll();
    }
  };
  document.addEventListener('keydown', escHandler);

  reconcile();
  paintAll();
  return { paintAll, state: m };
}
