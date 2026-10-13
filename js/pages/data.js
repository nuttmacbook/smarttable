// หน้าข้อมูล: นำเข้า Excel (รายงานก่อนยืนยัน), ส่งออก/นำเข้า JSON, ล้างข้อมูล
// ทุกการเขียนผ่าน op `state.import` (doOp) — เซิร์ฟเวอร์ตรวจซ้ำและตัดสินผลจริง
import { exportJSON, importJSON, emptyState } from '../store.js';
import { importRows, IMPORT_SHEETS } from '../importer.js';
import { applyOp } from '../ops.js';
import { mountTableList } from './list-kit.js';
import { readWorkbook } from '../excel-reader.js';
import { ctx, esc, toast, errorListHtml, pageHeader, doOp, opFailureTitle } from './util.js';

const LEVEL_TEXT = { error: 'ผิดพลาด', warning: 'เตือน', info: 'ข้อมูล' };
const LEVELS_ORDER = ['error', 'warning', 'info'];
const REPORT_FIELDS = (r) => [r.sheet, r.message, r.column];

const counts = (s) => ({
  subjects: s.subjects.length, teachers: s.teachers.length, groups: s.groups.length,
  rooms: s.rooms.length, plans: (s.plans || []).length, entries: s.entries.length,
});
const countText = (c) => `รายวิชา ${c.subjects} · ครู ${c.teachers} · กลุ่มเรียน ${c.groups} · ห้องเรียน ${c.rooms} · แผนการเรียน ${c.plans} · คาบที่ลงตาราง ${c.entries}`;
const hasData = (s) => Object.values(counts(s)).some((n) => n > 0);

// สรุปผลกระทบจริงของ op (dry-run ด้วย applyOp ตัวเดียวกับเซิร์ฟเวอร์): เพิ่ม/แก้/ลบ รวมกี่รายการ
function impactText(op) {
  const r = applyOp(ctx.state, op);
  const t = r.ok ? r.affected?.total : null;
  return t ? `ผลกระทบ: เพิ่ม ${t.added} · แก้ ${t.updated} · ลบ ${t.removed} รายการ` : '';
}

// แทนที่ข้อมูลทั้งก้อนผ่าน op (ระบุจำนวนที่จะถูกแทนที่ในข้อความยืนยันโดยผู้เรียก)
async function replaceAll(nextState) {
  // สำรองข้อมูลปัจจุบันเป็นไฟล์ JSON ให้ก่อนแทนที่ (หลังผู้ใช้ยืนยันแล้ว) — กู้คืนได้ด้วย "นำเข้า JSON"
  if (hasData(ctx.state)) {
    downloadBlob(new Blob([exportJSON(ctx.state)], { type: 'application/json' }), `สำรองก่อนแทนที่-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  }
  const r = await doOp({ type: 'state.import', state: nextState, mode: 'replace' });
  if (r.ok) {
    Object.assign(ctx.ui, { groupId: null, teacherId: null, classroomId: null, moving: null, placingSubjectId: null });
    ctx.updateStatus();
  }
  return r;
}

const downloadBlob = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
};

// ---------- รายงานนำเข้า ----------
// หัวรายงาน (สรุปจำนวน + ตารางสรุปต่อชีต) — รายการแถวผิดแสดงด้วย list-kit (ค้นหา/กรองระดับ/แบ่งหน้า) ที่ #report-list
function reportHtml(report) {
  const rows = report.rows || [];
  const n = (lv) => rows.filter((r) => r.level === lv).length;
  const sheetRows = Object.entries(report.summary || {})
    .map(([name, s]) => `<tr><td>${esc(name)}</td><td class="col-num">${esc(s.add)}</td><td class="col-num">${esc(s.update)}</td><td class="col-num">${esc(s.skip)}</td></tr>`)
    .join('');
  return `
    <div class="report-summary">
      <div class="report-stat is-error"><span class="report-stat-num">${n('error')}</span> ผิดพลาด</div>
      <div class="report-stat is-warning"><span class="report-stat-num">${n('warning')}</span> เตือน</div>
      <div class="report-stat is-info"><span class="report-stat-num">${n('info')}</span> ข้อมูล</div>
    </div>
    ${sheetRows ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>ชีต</th><th class="col-num">เพิ่ม</th><th class="col-num">อัปเดต</th><th class="col-num">ข้าม</th></tr></thead><tbody>${sheetRows}</tbody></table></div>` : ''}
    <div id="report-list"></div>`;
}

export function renderData(root) {
  const { state } = ctx;
  const session = { sheets: null, fileName: '', result: null, filter: new Set(LEVELS_ORDER), trim: false };

  root.innerHTML = `
    ${pageHeader('ข้อมูลระบบ')}
    <div class="card">
      <h2>สถานะข้อมูลบนเซิร์ฟเวอร์</h2>
      <p>${esc(countText(counts(state)))}</p>
      <p class="text-muted">ข้อมูลเก็บบนเซิร์ฟเวอร์ ทุกการแก้ไขบันทึกทันที สำรองข้อมูลได้ด้วยการส่งออกไฟล์ JSON</p>
    </div>

    <div class="card stack">
      <h2>นำเข้าจาก Excel (.xlsx)</h2>
      <p class="field-hint">ไฟล์เดียวหลายชีต: รายวิชา · ครูผู้สอน · ห้องเรียน · กลุ่มเรียน · แผนการเรียน (ชีตที่ไม่มีจะถูกข้าม) · รวมกับข้อมูลเดิมโดยจับคู่ตามรหัสวิชา/ชื่อ ไม่ลบอะไร · ถ้ามีข้อผิดพลาดแม้แถวเดียวจะไม่นำเข้าเลย</p>
      <div class="row">
        <button type="button" class="btn" id="btn-template">ดาวน์โหลดเทมเพลต</button>
        <label class="btn btn-primary" for="file-xlsx" style="display:inline-flex;align-items:center">เลือกไฟล์ .xlsx…</label>
        <input type="file" id="file-xlsx" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
      </div>
      <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="วางไฟล์ .xlsx ที่นี่">หรือลากไฟล์ .xlsx มาวางที่นี่ (ขนาดไม่เกิน 5 MB)</div>
      <div id="xlsx-result" aria-live="polite"></div>
    </div>

    <div class="card stack">
      <h2>ส่งออก / นำเข้า JSON</h2>
      <div class="row">
        <button type="button" class="btn btn-primary" id="btn-export">ส่งออก JSON</button>
        <label class="btn" for="file-import" style="display:inline-flex;align-items:center">นำเข้า JSON…</label>
        <input type="file" id="file-import" accept="application/json,.json" hidden>
      </div>
      <p class="field-hint">การนำเข้าจะตรวจโครงสร้าง การชน และชั่วโมงของทั้งตารางก่อน ถ้าไม่ผ่านจะไม่แทนที่ข้อมูลเดิม · ไฟล์จากระบบรุ่นเก่า (v1–v3) นำเข้าได้ ระบบแปลงให้อัตโนมัติ</p>
      <div id="import-result"></div>
    </div>

    <div class="card stack">
      <h2>ล้างข้อมูล</h2>
      <div class="row">
        <button type="button" class="btn btn-danger" id="btn-clear">ล้างข้อมูลทั้งหมด</button>
      </div>
      <p class="field-hint">ลบข้อมูลทั้งหมด (รายวิชา ครู กลุ่มเรียน ห้องเรียน แผนการเรียน และตาราง) · ระบบดาวน์โหลดไฟล์สำรอง JSON ให้ก่อนเสมอ กู้คืนได้ด้วย "นำเข้า JSON"</p>
    </div>`;

  const $ = (sel) => root.querySelector(sel);

  // ----- Excel -----
  const out = $('#xlsx-result');
  function paintReport() {
    const res = session.result;
    if (!res) return;
    const { report } = res;
    const errCount = report.rows.filter((r) => r.level === 'error').length;
    const overHours = report.rows.some((r) => r.level === 'error' && /ชั่วโมง|hours/i.test(r.message));
    out.innerHTML = `
      <h3>รายงานก่อนนำเข้า — ${esc(session.fileName)}</h3>
      ${reportHtml(report)}
      <div class="row">
        <button type="button" class="btn" id="btn-report">ดาวน์โหลดรายงาน</button>
        <button type="button" class="btn btn-primary" id="btn-confirm"${res.ok ? '' : ' disabled'}>ยืนยันนำเข้า</button>
        ${errCount && overHours ? '<button type="button" class="btn" id="btn-trim">นำเข้าและตัดคาบส่วนเกินออก</button>' : ''}
      </div>
      ${res.ok ? '' : '<p class="field-error">มีข้อผิดพลาด จึงยังนำเข้าไม่ได้ แก้ไฟล์แล้วเลือกใหม่</p>'}`;
    mountTableList(out.querySelector('#report-list'), {
      name: 'import-report',
      def: {
        fields: REPORT_FIELDS,
        filters: [{ id: 'level', label: 'ระดับ', options: LEVELS_ORDER.map((lv) => [lv, LEVEL_TEXT[lv]]), test: (r, v) => r.level === v }],
        sort: undefined,
        placeholder: 'ค้นหาในรายงาน (ชีต/ข้อความ)',
      },
      getItems: () => report.rows,
      emptyText: 'ไม่มีรายการในรายงานที่ตรงกับคำค้น',
      headHtml: '<tr><th>ชีต</th><th class="col-num">แถว</th><th>คอลัมน์</th><th>ระดับ</th><th>ข้อความ</th></tr>',
      rowHtml: (r) => `<tr class="row-${esc(r.level)}"><td>${esc(r.sheet)}</td><td class="col-num">${r.row ? esc(r.row) : '-'}</td><td>${esc(r.column ?? '')}</td>
        <td><span class="level-badge level-${esc(r.level)}">${esc(LEVEL_TEXT[r.level] ?? r.level)}</span></td><td>${esc(r.message)}</td></tr>`,
    });
    out.querySelector('#btn-report')?.addEventListener('click', downloadReport);
    out.querySelector('#btn-confirm')?.addEventListener('click', () => confirmImport(false));
    out.querySelector('#btn-trim')?.addEventListener('click', () => preview(true));
  }

  function preview(trim) {
    session.trim = trim;
    session.result = importRows(ctx.state, Object.fromEntries(session.sheets.map((s) => [s.sheet, s.data])), { trimOverHours: trim });
    if (session.pre?.length) session.result.report.rows.unshift(...session.pre);
    if (session.pre?.length) session.result = { ...session.result, ok: false, report: { ...session.result.report, ok: false } };
    paintReport();
  }

  async function downloadReport() {
    try {
      const ex = await import('../export/index.js');
      const out = await ex.buildImportReportXlsx(session.result.report);
      downloadBlob(out.blob, out.fileName);
    } catch {
      // ทางสำรอง: รายงานเป็น JSON ถ้าสร้าง .xlsx ไม่สำเร็จ
      downloadBlob(new Blob([JSON.stringify(session.result.report, null, 2)], { type: 'application/json' }), 'รายงานนำเข้า.json');
      toast('สร้างรายงาน .xlsx ไม่สำเร็จ ดาวน์โหลดเป็นไฟล์ JSON แทน', 'error');
    }
  }

  async function confirmImport(trim) {
    const t = session.trim || trim;
    const c = counts(ctx.state);
    const trimmed = session.result.report.trimmed?.length ?? 0;
    const msg = `นำเข้าจาก "${session.fileName}" ?\nรวมกับข้อมูลเดิม (${countText(c)}) โดยไม่ลบรายการเดิม${t && trimmed ? `\nจะตัดคาบส่วนเกินออก ${trimmed} คาบ` : ''}`;
    if (!confirm(msg)) return;
    const r = await doOp({ type: 'state.import', rows: Object.fromEntries(session.sheets.map((s) => [s.sheet, s.data])), mode: 'merge', trimOverHours: t });
    if (!r.ok) {
      out.insertAdjacentHTML('afterbegin', errorListHtml(r.errors, opFailureTitle(r, 'นำเข้าไม่สำเร็จ ข้อมูลเดิมไม่ถูกเปลี่ยน')));
      return;
    }
    toast('นำเข้าข้อมูลจาก Excel เรียบร้อย');
    ctx.rerender();
  }

  async function handleFile(file) {
    if (!file) return;
    out.innerHTML = '<p class="text-muted">กำลังตรวจไฟล์…</p>';
    const read = await readWorkbook(file);
    session.fileName = file.name;
    session.sheets = read.sheets;
    session.pre = read.problems.map((p) => ({ sheet: p.sheet ?? '(ไฟล์)', row: p.row ?? 0, ...(p.column ? { column: p.column } : {}), level: p.level, message: p.message }));
    if (!read.ok) {
      session.result = { ok: false, state: null, report: { ok: false, rows: session.pre, summary: {} } };
      paintReport();
      return;
    }
    preview(false);
  }

  const fileInput = $('#file-xlsx');
  fileInput.addEventListener('change', (ev) => {
    const f = ev.target.files[0];
    ev.target.value = '';
    handleFile(f);
  });
  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('is-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('is-over');
    handleFile(e.dataTransfer?.files?.[0]);
  });
  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  $('#btn-template').addEventListener('click', async () => {
    try {
      const ex = await import('../export/index.js');
      const out = await ex.downloadTemplate();
      downloadBlob(out.blob, out.fileName);
    } catch {
      toast('สร้างเทมเพลตไม่สำเร็จ ชีตที่ใช้: ' + Object.values(IMPORT_SHEETS).join(', '), 'error');
    }
  });

  // ----- JSON -----
  $('#btn-export').addEventListener('click', () => {
    downloadBlob(new Blob([exportJSON(ctx.state)], { type: 'application/json' }), `timetable-${new Date().toISOString().slice(0, 10)}.json`);
    toast('ส่งออกไฟล์แล้ว');
  });

  const jsonOut = $('#import-result');
  async function importJsonText(text, fileName, trim) {
    const r = importJSON(text, { trimOverHours: trim });
    if (!r.ok) {
      const overHours = (r.conflicts || []).some((c) => c.type === 'hours');
      jsonOut.innerHTML = errorListHtml(r.errors, `นำเข้า "${fileName}" ไม่ได้ ข้อมูลเดิมไม่ถูกเปลี่ยน`)
        + (overHours && !trim ? '<div class="row"><button type="button" class="btn" id="btn-json-trim">นำเข้าและตัดคาบส่วนเกินออก</button></div>' : '');
      jsonOut.querySelector('#btn-json-trim')?.addEventListener('click', () => importJsonText(text, fileName, true));
      return;
    }
    const cur = counts(ctx.state);
    const next = counts(r.state);
    if (hasData(ctx.state)) {
      const trimNote = r.trimmed?.length ? `\nจะตัดคาบส่วนเกินออก ${r.trimmed.length} คาบ` : '';
      if (!confirm(`นำเข้าจะแทนที่ข้อมูลปัจจุบันทั้งหมด\nที่จะถูกแทนที่: ${countText(cur)}\nข้อมูลใหม่: ${countText(next)}${trimNote}\n${impactText({ type: 'state.import', state: r.state, mode: 'replace' })}\n(ระบบจะดาวน์โหลดไฟล์สำรองข้อมูลปัจจุบันให้ก่อน)\nดำเนินการต่อ?`)) return;
    }
    const res = await replaceAll(r.state);
    if (!res.ok) {
      jsonOut.innerHTML = errorListHtml(res.errors, opFailureTitle(res, 'นำเข้าไม่สำเร็จ ข้อมูลเดิมไม่ถูกเปลี่ยน'));
      return;
    }
    jsonOut.innerHTML = '';
    toast(r.migrated ? 'นำเข้าข้อมูลรุ่นเก่าและแปลงเป็นรุ่นล่าสุดเรียบร้อย' : 'นำเข้าข้อมูลเรียบร้อย');
    ctx.rerender();
  }
  $('#file-import').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    importJsonText(await file.text(), file.name, false);
  });

  // ----- ล้าง -----
  $('#btn-clear').addEventListener('click', async () => {
    if (!confirm(`ล้างข้อมูลทั้งหมด — จะลบ: ${countText(counts(ctx.state))}\n${impactText({ type: 'state.import', state: emptyState(), mode: 'replace' })}\nระบบจะดาวน์โหลดไฟล์สำรองข้อมูลปัจจุบันให้ก่อน (กู้คืนด้วย "นำเข้า JSON") ต้องการดำเนินการต่อ?`)) return;
    const r = await replaceAll(emptyState());
    if (!r.ok) return toast(`${opFailureTitle(r)}: ${r.errors[0] ?? ''}`, 'error');
    toast('ล้างข้อมูลแล้ว');
    ctx.rerender();
  });
}
