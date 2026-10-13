// หน้าดูสาธารณะ (SPEC v5 ข้อ 16.1): ผู้ชมทั่วไปเห็นตารางได้ทันทีโดยไม่ต้องล็อกอิน/ไม่ต้องมีลิงก์ — อ่านอย่างเดียว
// เลือกประเภท (กลุ่มเรียน / ครู / ห้องเรียน) → รายการค้นหาได้ → ตาราง + พิมพ์/ส่งออก
// เมื่อแอดมินซ่อนชื่อครู (effectiveHide): ไม่มีตัวเลือก "ครู", ช่องไม่แสดงครู, ส่งออกรายครูไม่ได้ (ข้อมูลครูไม่มีอยู่ใน state ที่ได้มา)
import { ctx, esc, toast, legendHtml, gridHtml, emptyHtml } from './util.js';
import { buildTimetableView, pickItems, printBtn } from './views.js';
import { mountPickList } from './list-kit.js';

const KIND_LABEL = { group: 'กลุ่มเรียน', teacher: 'ครู', classroom: 'ห้องเรียน' };
const EXPORT_KIND = { group: 'group', teacher: 'teacher', classroom: 'classroom' };

const downloadBlob = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
};

export function availableKinds(state) {
  const kinds = ['group'];
  if (!ctx.hideTeachers && (state.teachers || []).length) kinds.push('teacher');
  kinds.push('classroom');
  return kinds.filter((k) => pickItems(state, k).length > 0);
}

// หน้าเมื่อผู้ดูแลปิดโหมดสาธารณะ (HTTP 403 public-disabled)
export function renderPublicDisabled(root) {
  root.innerHTML = `<div class="public-page"><div class="public-disabled empty-state">
      <h1>ผู้ดูแลปิดการเข้าชมสาธารณะ</h1>
      <p>ขณะนี้ไม่เปิดให้ดูตารางโดยไม่เข้าสู่ระบบ ถ้ามีลิงก์แชร์จากผู้ดูแลระบบ ให้เปิดลิงก์นั้น</p>
      <a class="btn btn-primary" href="#/login">เข้าสู่ระบบ</a></div></div>`;
}

export function renderPublic(root) {
  const { state, ui } = ctx;
  if (ctx.publicDisabled) return renderPublicDisabled(root);
  if (ctx.publicError) {
    root.innerHTML = `<div class="public-page"><div class="empty-state"><h1>เปิดดูตารางไม่ได้ในขณะนี้</h1><p>${esc(ctx.publicError)}</p></div></div>`;
    return;
  }
  const kinds = availableKinds(state);
  const p = ui.public && typeof ui.public === 'object' ? ui.public : (ui.public = { kind: 'group', id: null });
  if (!kinds.includes(p.kind)) p.kind = kinds[0] ?? 'group';
  const items = pickItems(state, p.kind);
  if (!kinds.length || !items.length) {
    root.innerHTML = `<div class="public-page"><div class="public-intro"><h1>ตารางเรียนตารางสอน</h1></div>${emptyHtml('ยังไม่มีข้อมูลตาราง')}
      <div class="public-footer"><a class="link-muted" href="#/login">เข้าสู่ระบบแอดมิน</a></div></div>`;
    return;
  }
  if (!items.some((i) => i.id === p.id)) p.id = items[0].id;
  const view = buildTimetableView(state, p.kind, p.id);

  root.innerHTML = `<div class="public-page">
    <div class="public-intro"><h1>ตารางเรียนตารางสอน</h1><p class="text-muted">เลือกกลุ่มเรียน${kinds.includes('teacher') ? ' ครู' : ''} หรือห้องเรียน เพื่อดูตาราง (ดูอย่างเดียว ไม่ต้องเข้าสู่ระบบ)</p></div>
    <div class="public-bar card">
      <fieldset class="chip-group" aria-label="ประเภท">
        ${kinds.map((k) => `<label class="chip"><input type="radio" name="pub-kind" value="${esc(k)}"${k === p.kind ? ' checked' : ''}><span>${esc(KIND_LABEL[k])}</span></label>`).join('')}
      </fieldset>
      <div id="pick-root"></div>
    </div>
    <div class="public-title"><h2>${esc(view.title)}</h2><span class="badge badge-readonly">โหมดดูอย่างเดียว</span>${ctx.hideTeachers ? ' <span class="badge badge-hidden-teachers">ไม่แสดงชื่อครู</span>' : ''}</div>
    <p class="text-muted view-meta">${esc(view.meta)}</p>
    <div class="row">${printBtn}<button type="button" class="btn" id="pub-xlsx">ส่งออก Excel</button><button type="button" class="btn" id="pub-pdf">ส่งออก PDF</button></div>
    <div id="pub-msg" aria-live="polite"></div>
    ${legendHtml(view.legend)}
    ${gridHtml(view.cell)}
    <div class="public-footer"><a class="link-muted" href="#/login">เข้าสู่ระบบแอดมิน</a></div>
  </div>`;

  mountPickList(root.querySelector('#pick-root'), {
    name: `public-${p.kind}`,
    items,
    selectedId: p.id,
    placeholder: `ค้นหา${KIND_LABEL[p.kind]}`,
    onPick: (id) => { p.id = id; ctx.rerender(); },
  });
  root.querySelector('.public-bar')?.addEventListener('change', (e) => {
    if (e.target?.matches?.('[name=pub-kind]')) {
      p.kind = e.target.value;
      p.id = null;
      ctx.rerender();
    }
  });
  root.querySelector('#btn-print')?.addEventListener('click', () => window.print());
  let busy = false;
  const doExport = (format) => async () => {
    if (busy) return;
    busy = true;
    try {
      const ex = await import('../export/index.js');
      const fn = format === 'pdf' ? ex.exportPdf : ex.exportXlsx;
      const out = await fn(ctx.state, { kind: EXPORT_KIND[p.kind], mode: 'one', ids: [p.id] }, { printedAt: new Date() });
      downloadBlob(out.blob, out.fileName);
      toast('สร้างไฟล์เรียบร้อย');
    } catch (err) {
      root.querySelector('#pub-msg').innerHTML = `<div class="alert alert-warning" role="alert">ส่งออกไม่สำเร็จ${err?.message ? `: ${esc(err.message)}` : ''} — ใช้ปุ่ม "พิมพ์" แล้วเลือก "บันทึกเป็น PDF" ได้</div>`;
    } finally {
      busy = false;
    }
  };
  root.querySelector('#pub-xlsx')?.addEventListener('click', doExport('xlsx'));
  root.querySelector('#pub-pdf')?.addEventListener('click', doExport('pdf'));
}
