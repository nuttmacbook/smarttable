// กล่องส่งออก/พิมพ์ (SPEC v4 ข้อ 8): เลือกประเภท รายการเดียว/หลายรายการ/ทั้งหมด/ทุกประเภท รูปแบบ .xlsx | .pdf
// ใช้ได้ทั้งแอดมินและผู้ดูอย่างเดียว (ผู้ดูส่งออกได้เฉพาะข้อมูลใน scope ที่ API ให้มา — state ถูกกรองมาแล้ว)
// ตัวสร้างไฟล์อยู่ที่ js/export/xlsx.js และ js/export/pdf.js (dynamic import, เจ้าของ อิงค์):
//   สัญญา (js/export/index.js ของอิงค์): exportXlsx|exportPdf(state, scope, { semester, year, printedAt }) -> { blob, fileName, count }
//   scope = { kind, mode, ids } · state ที่ส่งเข้าไปคือข้อมูลที่ผู้ใช้มีสิทธิ์เห็นเท่านั้น (ผู้ดูได้ state ที่กรอง scope แล้ว)
import { buildTimetables, cellText, KINDS, listItems } from '../export/model.js';
import { ctx, esc, toast, field, optionsHtml, pageHeader, emptyHtml } from './util.js';
import { mountListKit } from './list-kit.js';

const EXPORT_FIELDS = (it) => [it.name, it.detail];

const downloadBlob = (blob, name) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
};

const MODE_TEXT = [['one', 'รายการเดียว'], ['many', 'หลายรายการ (ติ๊กเลือก)'], ['all', 'ทั้งหมดของประเภทนี้']];

function printAreaHtml(tables) {
  return tables
    .map((t) => `<section class="print-sheet" style="page-break-after:always">
      <h2>${esc(t.title)}</h2>
      <p class="text-muted">${esc([t.subtitle, ...t.metaLines].filter(Boolean).join(' · '))}</p>
      ${t.empty ? `<p>${esc(t.emptyText)}</p>` : ''}
      <div class="tt-wrap"><table class="timetable"><thead><tr><th class="tt-day" scope="col">วัน / คาบ</th>
        ${t.columns.map((c) => `<th scope="col"${c.type === 'lunch' ? ' class="tt-lunch-head"' : ''}><span class="tt-period-no">${c.type === 'lunch' ? esc(c.label) : `คาบ ${esc(c.label)}`}</span><span class="tt-period-time">${esc(c.time)}</span></th>`).join('')}</tr></thead>
        <tbody>${t.rows.map((r, i) => `<tr><th scope="row">${esc(r.dayName)}</th>${r.cells.map((cell, ci) => {
          if (cell.lunch) return i === 0 ? `<td class="tt-lunch" rowspan="${t.rows.length}">พักเที่ยง</td>` : '';
          const txt = cellText(cell);
          return `<td class="tt-cell ${txt ? 'is-filled' : 'is-free'} is-readonly">${esc(txt).replace(/\n/g, '<br>')}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>
    </section>`)
    .join('');
}

export function renderExport(root) {
  const { state } = ctx;
  const ui = { kind: 'group', mode: 'all', format: 'xlsx', ids: new Set() };
  const hasAny = KINDS.some((k) => listItems(state, k.id).length);
  if (!hasAny) {
    root.innerHTML = pageHeader('ส่งออก / พิมพ์') + emptyHtml('ยังไม่มีข้อมูลให้ส่งออก');
    return;
  }
  root.innerHTML = `${pageHeader('ส่งออก / พิมพ์ตาราง')}
    <div class="export-box card">
      <div class="export-grid">
        ${field('ประเภท', `<select class="select" id="x-kind">${optionsHtml([...KINDS.map((k) => [k.id, k.name]), ['everything', 'ทุกประเภททั้งหมด']], ui.kind)}</select>`, { id: 'x-kind' })}
        ${field('ขอบเขต', `<select class="select" id="x-mode">${optionsHtml(MODE_TEXT, ui.mode)}</select>`, { id: 'x-mode' })}
        ${field('ภาคเรียนที่ (ไม่บังคับ)', '<input class="input" id="x-sem" maxlength="10">', { id: 'x-sem' })}
        ${field('ปีการศึกษา (ไม่บังคับ)', '<input class="input" id="x-year" maxlength="10" placeholder="เช่น 2569">', { id: 'x-year' })}
        <fieldset class="chip-group" aria-label="รูปแบบไฟล์">
          <label class="chip"><input type="radio" name="x-format" value="xlsx" checked><span>Excel (.xlsx)</span></label>
          <label class="chip"><input type="radio" name="x-format" value="pdf"><span>PDF (.pdf)</span></label>
        </fieldset>
      </div>
      <div class="export-list" id="x-list"></div>
      <div class="export-actions">
        <button type="button" class="btn btn-primary" id="x-export">ส่งออกไฟล์</button>
        <button type="button" class="btn" id="x-print">พิมพ์</button>
      </div>
      <div id="x-msg" aria-live="polite"></div>
    </div>
    <div class="print-area" id="print-area"></div>`;
  const $ = (s) => root.querySelector(s);

  const scope = () => ({
    kind: ui.kind === 'everything' ? undefined : ui.kind,
    mode: ui.kind === 'everything' ? 'everything' : ui.mode,
    ids: [...ui.ids],
  });
  const paintList = () => {
    const box = $('#x-list');
    if (ui.kind === 'everything' || ui.mode === 'all') {
      box.innerHTML = '';
      return;
    }
    const items = listItems(state, ui.kind);
    // รายการติ๊กเลือกค้นหา/แบ่งหน้าได้ (list-kit) — ช่องที่ติ๊กไว้จำข้ามหน้าด้วย ui.ids
    mountListKit(box, {
      name: `export-${ui.kind}`,
      def: { fields: EXPORT_FIELDS, filters: [], sort: undefined, placeholder: 'ค้นหารายการที่จะส่งออก' },
      getItems: () => items,
      emptyText: 'ไม่มีรายการ',
      renderBody: (page) => page.map((it) => `<label class="chip"><input type="${ui.mode === 'one' ? 'radio' : 'checkbox'}" name="x-item" value="${esc(it.id)}"${ui.ids.has(it.id) ? ' checked' : ''}><span>${esc(it.name)}${it.detail ? ` (${esc(it.detail)})` : ''}</span></label>`).join(''),
      onRender: (el) => el.querySelectorAll('input[name=x-item]').forEach((i) =>
        i.addEventListener('change', () => {
          if (ui.mode === 'one') ui.ids = new Set([i.value]);
          else if (i.checked) ui.ids.add(i.value);
          else ui.ids.delete(i.value);
        }),
      ),
    });
  };
  $('#x-kind').addEventListener('change', (e) => { ui.kind = e.target.value; ui.ids = new Set(); $('#x-mode').disabled = ui.kind === 'everything'; paintList(); });
  $('#x-mode').addEventListener('change', (e) => { ui.mode = e.target.value; ui.ids = new Set(); paintList(); });
  root.querySelectorAll('input[name=x-format]').forEach((i) => i.addEventListener('change', () => { if (i.checked) ui.format = i.value; }));
  paintList();

  const build = () => {
    const sc = scope();
    if ((sc.mode === 'one' || sc.mode === 'many') && !sc.ids.length) {
      toast('กรุณาเลือกรายการที่จะส่งออก', 'error');
      return null;
    }
    const tables = buildTimetables(state, sc, { semester: $('#x-sem').value, year: $('#x-year').value, printedAt: new Date() });
    if (!tables.length) {
      toast('ไม่มีรายการให้ส่งออก', 'error');
      return null;
    }
    return { tables, sc };
  };

  let busy = false;
  $('#x-export').addEventListener('click', async () => {
    if (busy) return;
    const built = build();
    if (!built) return;
    busy = true;
    $('#x-msg').innerHTML = '<p class="text-muted">กำลังสร้างไฟล์…</p>';
    try {
      // สัญญาของอิงค์ (js/export/index.js): exportXlsx|exportPdf(state, scope, options) -> { blob, fileName, count }
      const ex = await import('../export/index.js');
      const fn = ui.format === 'pdf' ? ex.exportPdf : ex.exportXlsx;
      const out = await fn(state, built.sc, { semester: $('#x-sem').value, year: $('#x-year').value, printedAt: new Date() });
      downloadBlob(out.blob, out.fileName);
      $('#x-msg').innerHTML = '';
      toast(`สร้างไฟล์เรียบร้อย (${out.count} รายการ)`);
    } catch (err) {
      $('#x-msg').innerHTML = `<div class="alert alert-warning" role="alert">ส่งออกเป็น ${ui.format === 'pdf' ? 'PDF' : 'Excel'} ไม่สำเร็จ${err?.message ? `: ${esc(err.message)}` : ''} — ใช้ปุ่ม "พิมพ์" แล้วเลือก "บันทึกเป็น PDF" ในหน้าต่างพิมพ์ของเบราว์เซอร์ได้</div>`;
    } finally {
      busy = false;
    }
  });

  $('#x-print').addEventListener('click', () => {
    const built = build();
    if (!built) return;
    $('#print-area').innerHTML = printAreaHtml(built.tables);
    window.print();
  });
}
