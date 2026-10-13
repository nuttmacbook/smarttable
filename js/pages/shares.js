// จัดการลิงก์แชร์แบบดูอย่างเดียว (แอดมิน, โหมด remote): สร้าง/คัดลอก/เพิกถอน/สร้างใหม่ ตามขอบเขต (scope)
// โทเค็นเต็มแสดงครั้งเดียวตอนสร้าง/สร้างใหม่ ไม่เก็บลง localStorage/state (W-04) · รูป response ตาม docs/API.md (id ของลิงก์แยกจากโทเค็น)
import { shareUrl } from '../api-client.js';
import { mountTableList, searchSelect } from './list-kit.js';
import { ctx, esc, byId, toast, openModal, field, optionsHtml, pageHeader, emptyHtml, errorListHtml, editOnly } from './util.js';

const DAY_MS = 86400000;
const DEFAULT_ALL_DAYS = 90; // ลิงก์ scope all หมดอายุโดยค่าเริ่มต้น 90 วัน (SPEC ข้อ 14 W-18/19)
const SCOPE_KINDS = [['all', 'ทั้งหมด (ทุกกลุ่มเรียน/ครู/ห้องเรียน)'], ['group', 'กลุ่มเรียนเดียว'], ['teacher', 'ครูคนเดียว'], ['room', 'ห้องเรียนเดียว']];

const fmtDate = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear() + 543}`;
};

export function scopeLabel(state, scope) {
  if (scope === 'all') return 'ทั้งหมด';
  const [kind, id] = String(scope).split(/:(.+)/);
  const name = { group: byId(state.groups, id)?.name, teacher: byId(state.teachers, id)?.name, room: byId(state.rooms, id)?.name }[kind];
  const prefix = { group: 'กลุ่มเรียน', teacher: 'ครู', room: 'ห้องเรียน' }[kind];
  return prefix ? `${prefix} ${name ?? '(ถูกลบแล้ว)'}` : String(scope);
}

const normList = (res) => (Array.isArray(res) ? res : res?.shares ?? []);

export async function renderShares(root) {
  root.innerHTML = `${pageHeader('ลิงก์แชร์ (ดูอย่างเดียว)', editOnly('<button type="button" class="btn btn-primary" id="btn-add">+ สร้างลิงก์ใหม่</button>'))}
    <div class="alert alert-warning">ตารางทุกมุมมองมีชื่อครู (ข้อมูลส่วนบุคคล) — ส่งลิงก์เฉพาะผู้ที่ควรเห็น ลิงก์ขอบเขต "ทั้งหมด" หมดอายุใน ${DEFAULT_ALL_DAYS} วันโดยค่าเริ่มต้น และเพิกถอนได้ทันที</div>
    <div id="share-list"><p class="text-muted">กำลังโหลด…</p></div>`;
  root.querySelector('#btn-add')?.addEventListener('click', () => createModal(root));
  await paintList(root);
}

async function paintList(root) {
  const box = root.querySelector('#share-list');
  let list;
  try {
    list = normList(await ctx.api.listShares());
  } catch (err) {
    box.innerHTML = errorListHtml([err.message], 'โหลดรายการลิงก์ไม่ได้');
    return;
  }
  if (!list.length) {
    box.innerHTML = emptyHtml('ยังไม่มีลิงก์แชร์ กด "สร้างลิงก์ใหม่"');
    return;
  }
  // รูปตาม docs/API.md: { id, label, scope, createdAt, expiresAt, expired } (ลิงก์ที่เพิกถอนถูกลบออกจากรายการ)
  const statusOf = (s) => (s.expired ? 'expired' : 'active');
  const STATUS_TEXT = { active: 'ใช้งานได้', revoked: 'เพิกถอนแล้ว', expired: 'หมดอายุ' };
  mountTableList(box, {
    name: 'shares',
    def: {
      fields: (x) => [x.label, scopeLabel(ctx.state, x.scope)],
      filters: [{ id: 'status', label: 'สถานะ', options: [['active', 'ใช้งานได้'], ['expired', 'หมดอายุ']], test: (x, v) => statusOf(x) === v }],
      sort: { key: (x) => x.label ?? '' },
      placeholder: 'ค้นหาป้ายชื่อ/ขอบเขต',
    },
    getItems: () => list,
    headHtml: '<tr><th>ป้ายชื่อ</th><th>ขอบเขต</th><th>สถานะ</th><th>สร้างเมื่อ</th><th>หมดอายุ</th><th></th></tr>',
    rowHtml: (x) => {
      const st = statusOf(x);
      const id = String(x.id ?? '');
      return `<tr><td>${esc(x.label || '(ไม่มีชื่อ)')}</td>
        <td><span class="badge badge-scope">${esc(scopeLabel(ctx.state, x.scope))}</span>${x.scope === 'all' ? ' <span class="text-muted">เห็นชื่อครูทั้งหมด ไม่ขึ้นกับการตั้งค่าซ่อน</span>' : ''}</td>
        <td><span class="badge badge-status-${esc(st)}">${esc(STATUS_TEXT[st] ?? st)}</span></td>
        <td>${esc(fmtDate(x.createdAt))}</td><td>${esc(fmtDate(x.expiresAt))}</td>
        <td class="col-actions">
          <button type="button" class="btn btn-sm" data-regen="${esc(id)}">สร้างใหม่</button>
          <button type="button" class="btn btn-sm btn-danger" data-revoke="${esc(id)}">เพิกถอน</button>
        </td></tr>`;
    },
    bind: (el) => {
      el.querySelectorAll('[data-revoke]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          if (!confirm('เพิกถอนลิงก์นี้? ผู้ที่มีลิงก์จะเปิดดูไม่ได้ทันที')) return;
          try {
            await ctx.api.revokeShare(btn.dataset.revoke);
            toast('เพิกถอนลิงก์แล้ว');
          } catch (err) {
            toast(err.message, 'error');
          }
          paintList(root);
        }),
      );
      el.querySelectorAll('[data-regen]').forEach((btn) =>
        btn.addEventListener('click', async () => {
          if (!confirm('สร้างลิงก์ใหม่? ลิงก์เดิมจะใช้ไม่ได้ทันที และได้ลิงก์ใหม่ขอบเขตเดิม')) return;
          try {
            const res = await ctx.api.regenerateShare(btn.dataset.regen);
            revealToken(res);
          } catch (err) {
            toast(err.message, 'error');
          }
          paintList(root);
        }),
      );
    },
  });
}

// แสดงลิงก์เต็มครั้งเดียว — token อยู่ในตัวแปรของ modal เท่านั้น
export function revealToken(res) {
  const token = res?.token;
  if (!token) return toast('เซิร์ฟเวอร์ไม่ได้ส่งโทเค็นกลับมา', 'error');
  const url = shareUrl(token);
  const m = openModal({
    title: 'ลิงก์แชร์ใหม่',
    large: true,
    bodyHtml: `<div class="alert alert-warning token-reveal">คัดลอกตอนนี้ — ระบบจะไม่แสดงลิงก์นี้อีก (ถ้าทำหาย ให้ "สร้างใหม่")</div>
      <div class="share-link"><code class="share-url" id="share-url">${esc(url)}</code><button type="button" class="btn btn-sm" id="btn-copy">คัดลอก</button></div>`,
    footerHtml: '<button type="button" class="btn btn-primary" data-close>เสร็จสิ้น</button>',
  });
  m.el.querySelector('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('คัดลอกลิงก์แล้ว');
    } catch {
      const r = document.createRange?.();
      const code = m.el.querySelector('#share-url');
      if (r && code) {
        r.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      toast('คัดลอกอัตโนมัติไม่ได้ เลือกข้อความแล้วกด Ctrl+C', 'error');
    }
  });
}

export function createModal(root) {
  const { state } = ctx;
  const entityItems = (kind) => ({
    group: state.groups.map((g) => ({ id: g.id, label: g.name, detail: g.level })),
    teacher: state.teachers.map((t) => ({ id: t.id, label: t.name, detail: t.dept })),
    room: state.rooms.map((r) => ({ id: r.id, label: r.name, detail: r.building })),
  }[kind] || []);
  const m = openModal({
    title: 'สร้างลิงก์แชร์ (ดูอย่างเดียว)',
    bodyHtml: `<form id="share-form" novalidate><div id="form-errors"></div>
      ${field('ป้ายชื่อ', '<input class="input" id="f-label" maxlength="80" placeholder="เช่น ครูแผนกคอมพิวเตอร์">', { id: 'f-label', hint: 'ไว้จำว่าส่งให้ใคร (ไม่ใส่ก็ได้)' })}
      ${field('ขอบเขต', `<select class="select" id="f-kind">${optionsHtml(SCOPE_KINDS, 'all')}</select>`, { id: 'f-kind' })}
      <div id="entity-box"></div>
      ${field('วันหมดอายุ (ไม่บังคับ)', '<input class="input" id="f-exp" type="date">', { id: 'f-exp', hint: `ขอบเขต "ทั้งหมด" ถ้าไม่กรอกจะหมดอายุใน ${DEFAULT_ALL_DAYS} วัน` })}
    </form>`,
    footerHtml: '<button type="button" class="btn" data-close>ยกเลิก</button><button type="button" class="btn btn-primary" id="f-save">สร้างลิงก์</button>',
  });
  const $ = (s) => m.el.querySelector(s);
  const paintEntity = () => {
    const kind = $('#f-kind').value;
    if (kind === 'all') {
      $('#entity-box').innerHTML = '';
      return;
    }
    // รายการที่จะแชร์: เกิน 25 รายการใช้รายการค้นหา/แบ่งหน้า
    const sel = searchSelect({ id: 'f-entity', label: 'share-entity', placeholder: 'ค้นหารายการที่จะแชร์', items: entityItems(kind), value: '', blank: '— เลือก —' });
    $('#entity-box').innerHTML = field('เลือกรายการ', sel.html, { id: 'f-entity', required: true });
    sel.mount($('#entity-box'));
  };
  paintEntity();
  $('#f-kind').addEventListener('change', paintEntity);
  let busy = false;
  $('#f-save').addEventListener('click', async () => {
    if (busy) return;
    const kind = $('#f-kind').value;
    const entity = kind === 'all' ? '' : $('#f-entity').value;
    if (kind !== 'all' && !entity) {
      $('#form-errors').innerHTML = errorListHtml(['กรุณาเลือกรายการที่จะแชร์'], 'สร้างลิงก์ไม่ได้');
      return;
    }
    const expRaw = $('#f-exp').value;
    let expiresAt = null;
    try {
      expiresAt = expRaw ? new Date(`${expRaw}T23:59:59`).toISOString() : null;
    } catch {
      $('#form-errors').innerHTML = errorListHtml(['วันหมดอายุไม่ถูกต้อง'], 'สร้างลิงก์ไม่ได้');
      return;
    }
    if (expRaw && Date.parse(expiresAt) < Date.now()) {
      $('#form-errors').innerHTML = errorListHtml(['วันหมดอายุต้องเป็นวันในอนาคต'], 'สร้างลิงก์ไม่ได้');
      return;
    }
    if (kind === 'all' && !expiresAt) expiresAt = new Date(Date.now() + DEFAULT_ALL_DAYS * DAY_MS).toISOString();
    busy = true;
    try {
      const res = await ctx.api.createShare({ scope: kind === 'all' ? 'all' : `${kind}:${entity}`, label: $('#f-label').value.trim(), expiresAt });
      m.close();
      revealToken(res);
      paintList(root);
    } catch (err) {
      $('#form-errors').innerHTML = errorListHtml([err.message], 'สร้างลิงก์ไม่สำเร็จ');
    } finally {
      busy = false;
    }
  });
}
