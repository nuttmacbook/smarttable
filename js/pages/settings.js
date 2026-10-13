// หน้าตั้งค่า (แอดมิน, โหมด remote) — เปิด/ปิดโหมดสาธารณะ + แสดง/ซ่อนชื่อครู (PDPA) · SPEC v5 ข้อ 16.1 และ 22 V5-01
// hideTeacherNames: null = ยังไม่ยืนยัน = ถือว่าซ่อน (effectiveHide = hideTeacherNames !== false) — ผู้ชมเห็นชื่อครูได้ก็ต่อเมื่อแอดมินตั้ง false เอง
import { ctx, esc, toast, pageHeader, errorListHtml, skeletonHtml } from './util.js';

export const effectiveHide = (settings) => settings?.publicMode?.hideTeacherNames !== false;
// ยังไม่ได้ยืนยัน: confirmedAt เป็น null (ถ้าเซิร์ฟเวอร์ไม่ส่ง confirmedAt ใช้ hideTeacherNames === null แทน)
export const isUnconfirmed = (settings) => {
  if (!settings?.publicMode) return false;
  return settings.confirmedAt !== undefined ? settings.confirmedAt === null : settings.publicMode.hideTeacherNames === null;
};

const fmt = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear() + 543} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '-';
};

const row = (id, on, title, desc, extra = '') => `<div class="setting-row${on ? ' is-on' : ''}">
  <div class="setting-text"><div class="setting-title">${esc(title)}</div><div class="setting-desc">${esc(desc)}</div>${extra}</div>
  <label class="switch"><input type="checkbox" role="switch" id="${id}"${on ? ' checked' : ''}><span class="switch-track"></span><span class="switch-label">${on ? 'เปิด' : 'ปิด'}</span></label></div>`;

export async function renderSettings(root) {
  root.innerHTML = `${pageHeader('ตั้งค่า')}<div id="settings-box">${skeletonHtml(3)}</div>`;
  const box = root.querySelector('#settings-box');
  let settings;
  try {
    settings = (await ctx.api.getSettings())?.settings;
  } catch (err) {
    box.innerHTML = errorListHtml([err.message], 'โหลดการตั้งค่าไม่ได้');
    return;
  }
  ctx.settings = settings;
  const pm = settings?.publicMode ?? { enabled: true, hideTeacherNames: null };
  const showNames = pm.hideTeacherNames === false;
  box.innerHTML = `<div class="settings-list">
    ${row('set-enabled', pm.enabled === true, 'เปิดโหมดสาธารณะ', 'ผู้เข้าชมทั่วไป (นักเรียน/ครู) เปิดเว็บแล้วเห็นตารางได้ทันที ไม่ต้องเข้าสู่ระบบและไม่ต้องมีลิงก์ ปิดแล้วต้องใช้ลิงก์แชร์เท่านั้น มีผลทันที')}
    ${row('set-show-names', showNames, 'แสดงชื่อครูในโหมดสาธารณะ', 'เมื่อปิด (ค่าเริ่มต้น): ผู้ชมทั่วไปจะไม่เห็นรายชื่อครู ไม่มีมุมมองรายครู ช่องตารางไม่แสดงครู และส่งออกรายครูไม่ได้ · ชื่อครูเป็นข้อมูลส่วนบุคคล (PDPA) เปิดเมื่อได้รับอนุญาตเท่านั้น',
      '<div class="alert alert-warning pdpa-note">ระบบซ่อนชื่อครูที่มาจากข้อมูลครูให้เท่านั้น — ถ้ามีชื่อครูพิมพ์อยู่ในช่องหมายเหตุของวิชา/ห้อง/กลุ่ม ระบบลบให้ไม่ได้ กรุณาตรวจก่อนเปิดโหมดสาธารณะ</div>')}
  </div>
  <div class="alert alert-warning show-names-warning" id="show-warning" role="alert" hidden>ชื่อครูและตารางสอนจะเป็นสาธารณะ ใครก็เปิดดูได้โดยไม่ต้องมีลิงก์ และไม่มีวันหมดอายุ <button type="button" class="btn btn-sm" id="set-confirm-show">ยืนยันแสดงชื่อครู</button></div>
  ${isUnconfirmed(settings) ? '<div class="alert alert-warning unconfirmed-banner"><span class="badge badge-unconfirmed">ยังไม่ยืนยัน</span> ตอนนี้ระบบซ่อนรายชื่อครูไว้ก่อน (ค่าเริ่มต้น) — เลือกแสดงเมื่อพร้อม กดบันทึกเพื่อยืนยันค่าปัจจุบัน</div>' : (effectiveHide(settings) ? '<p><span class="badge badge-hidden-teachers">ซ่อนชื่อครูในโหมดสาธารณะ</span></p>' : '')}
  <p class="setting-meta text-muted">แก้ไขล่าสุด: ${esc(fmt(settings?.updatedAt))} โดย ${esc(settings?.updatedBy ?? '-')}</p>
  <div id="settings-errors"></div>
  <div class="row"><button type="button" class="btn btn-primary" id="set-save">บันทึกตั้งค่า</button></div>`;

  // เลือกแสดงชื่อครู (จากที่ซ่อนอยู่) ต้องกดยืนยันก่อนจึงบันทึกได้
  let confirmedShow = showNames;
  const warn = box.querySelector('#show-warning');
  box.querySelector('#set-show-names').addEventListener('change', (e) => {
    const on = Boolean(e.target.checked);
    confirmedShow = on && showNames;
    warn.hidden = !on || confirmedShow;
  });
  box.querySelector('#set-confirm-show').addEventListener('click', () => {
    confirmedShow = true;
    warn.hidden = true;
  });
  let busy = false;
  box.querySelector('#set-save').addEventListener('click', async () => {
    if (busy) return;
    if (box.querySelector('#set-show-names').checked && !confirmedShow) {
      warn.hidden = false;
      box.querySelector('#settings-errors').innerHTML = errorListHtml(['กดยืนยันแสดงชื่อครูก่อนบันทึก'], 'ยังบันทึกไม่ได้');
      return;
    }
    busy = true;
    // ส่งทั้งสองช่องเป็น true/false ชัดเจน (ไม่ส่ง null) + revision ล่าสุดที่ได้จาก GET (กันแอดมินสองคนเขียนทับกัน → 409)
    const next = {
      enabled: Boolean(box.querySelector('#set-enabled').checked),
      hideTeacherNames: !box.querySelector('#set-show-names').checked,
    };
    try {
      const res = await ctx.api.putSettings(next, settings?.revision);
      ctx.settings = res?.settings ?? ctx.settings;
      toast('บันทึกตั้งค่าแล้ว');
      ctx.rerender();
    } catch (err) {
      const msgs = Array.isArray(err.body?.errors) ? err.body.errors.map((e) => e.message) : [err.message];
      box.querySelector('#settings-errors').innerHTML = errorListHtml(msgs, err.status === 409 ? 'มีผู้แก้ไขตั้งค่าพร้อมกัน โปรดโหลดหน้าใหม่แล้วลองอีกครั้ง' : 'บันทึกไม่สำเร็จ');
      if (err.status === 409) renderSettings(root); // โหลดค่า/revision ล่าสุด
    } finally {
      busy = false;
    }
  });
}
