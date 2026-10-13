// list-kit: ค้นหา + ตัวกรอง + แบ่งหน้า (25/50/100) ที่ใช้เหมือนกันทุกรายการ (SPEC v5 ข้อ 17, 22 V5-07)
// - คำนวณด้วย js/list-model.js (queryList) — ไม่สร้าง RegExp จากคำค้น (ใช้ includes บนข้อความที่ normalize แล้ว)
// - จำค่าต่อรายการใน localStorage 'tt.ui.list.<ชื่อ>' (ผู้ดู/สาธารณะใช้ sessionStorage) · ไม่เชื่อถือค่าที่อ่านกลับ:
//   ตรวจชนิดทีละคีย์ → สร้างออบเจ็กต์ใหม่เอง (ไม่ Object.assign/spread) · pageSize ∈ allowlist · คำค้น ≤ 200 ตัว · ตัวกรองเก็บใน Map
// - ทุกค่าที่ใส่ HTML ผ่าน esc() · ไม่มี inline handler (ใช้ event delegation ที่ container)
import { queryList, PAGE_SIZES, DEFAULT_PAGE_SIZE } from '../list-model.js';
import { ctx, esc } from './util.js';

export const LIST_PREFIX = 'tt.ui.list.';
export const MAX_QUERY_LENGTH = 200;
export const MAX_TERMS = 10;
const NAME_RE = /^[a-z0-9-]{1,40}$/;
const FILTER_VALUE_MAX = 64;

// ---------- สถานะ (pure) ----------
export const emptyListState = () => ({ query: '', filters: new Map(), pageSize: DEFAULT_PAGE_SIZE, page: 1 });

export function cleanQuery(q) {
  const s = typeof q === 'string' ? q.slice(0, MAX_QUERY_LENGTH) : '';
  return s.split(/\s+/).filter(Boolean).slice(0, MAX_TERMS).join(' ');
}

// raw = ค่าที่ parse จาก storage (ไม่น่าเชื่อถือ) ; filterIds = รหัสตัวกรองที่หน้านั้นมีจริง
export function sanitizeListState(raw, filterIds = []) {
  const st = emptyListState();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return st;
  if (typeof raw.query === 'string') st.query = cleanQuery(raw.query);
  if (PAGE_SIZES.includes(raw.pageSize)) st.pageSize = raw.pageSize;
  const f = raw.filters;
  if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
    for (const id of filterIds) {
      // อ่านเฉพาะคีย์ที่หน้านั้นประกาศไว้ (ไม่วนคีย์ตามข้อมูลที่ได้มา) และต้องเป็นข้อความสั้น
      if (Object.prototype.hasOwnProperty.call(f, id) && typeof f[id] === 'string' && f[id].length <= FILTER_VALUE_MAX) st.filters.set(id, f[id]);
    }
  }
  return st;
}

function storageFor() {
  try {
    return ctx.role === 'admin' ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return null;
  }
}
export function loadListState(name, filterIds) {
  if (!NAME_RE.test(name)) return emptyListState();
  try {
    const raw = storageFor()?.getItem(LIST_PREFIX + name);
    return raw ? sanitizeListState(JSON.parse(raw), filterIds) : emptyListState();
  } catch {
    return emptyListState();
  }
}
export function saveListState(name, st) {
  if (!NAME_RE.test(name)) return;
  try {
    storageFor()?.setItem(LIST_PREFIX + name, JSON.stringify({ query: st.query, pageSize: st.pageSize, filters: Object.fromEntries(st.filters) }));
  } catch {
    // เต็ม/ปิดไว้ ก็ใช้โดยไม่จำค่า
  }
}
// ล้างค่าที่จำไว้ทั้งหมด (logout / เปลี่ยนสิทธิ์)
export function clearListStates() {
  for (const s of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      const keys = [];
      for (let i = 0; i < (s?.length ?? 0); i += 1) keys.push(s.key(i));
      keys.filter((k) => typeof k === 'string' && k.startsWith(LIST_PREFIX)).forEach((k) => s.removeItem(k));
    } catch {
      // ข้าม
    }
  }
}

// ---------- ผลลัพธ์ที่แสดง (pure) ----------
// def = { fields: (item)=>string[] (ค่าคงที่ระดับโมดูล เพื่อใช้ดัชนี cache), filters:[{id,label,options:[[value,label]],test:(item,value)=>bool}], sort?:{key,dir} }
export function computeView(items, st, def) {
  const preds = [];
  for (const f of def.filters ?? []) {
    const v = st.filters.get(f.id);
    if (v) preds.push((item) => f.test(item, v));
  }
  return queryList(items, { query: st.query, fields: def.fields, filters: preds, sort: def.sort, page: st.page, pageSize: st.pageSize });
}

// เลขหน้าที่แสดง: หน้าแรก/สุดท้าย + รอบหน้าปัจจุบัน ±1 ที่เหลือเป็น '…'
export function pageWindow(page, totalPages) {
  const keep = new Set([1, totalPages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= totalPages));
  const out = [];
  let prev = 0;
  for (const p of [...keep].sort((a, b) => a - b)) {
    if (p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

// ---------- HTML (ทุกค่าผ่าน esc) ----------
export function barHtml(def, st, view, ns = '') {
  const filters = (def.filters ?? [])
    .map((f) => `<div class="field"><label class="field-label" for="lk-f-${ns}${esc(f.id)}">${esc(f.label)}</label>
      <select class="select" id="lk-f-${ns}${esc(f.id)}" data-lk-filter="${esc(f.id)}">
        <option value="">ทั้งหมด</option>${f.options.map(([v, l]) => `<option value="${esc(v)}"${st.filters.get(f.id) === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select></div>`)
    .join('');
  return `<div class="list-kit-bar">
    <div class="search-box"><input class="input" type="search" id="lk-search${ns}" data-lk-search maxlength="${MAX_QUERY_LENGTH}" value="${esc(st.query)}" placeholder="${esc(def.placeholder ?? 'ค้นหา')}" aria-label="ค้นหา" autocomplete="off">
      <button type="button" class="search-clear" data-lk-clear aria-label="ล้างคำค้น"${st.query ? '' : ' hidden'}>×</button></div>
    ${filters ? `<div class="list-filters">${filters}</div>` : ''}
    <span class="list-count" role="status" data-lk-count>${esc(countText(view))}</span>
  </div>`;
}
export const countText = (view) => (view.total === 0 ? 'ไม่พบรายการ' : `แสดง ${view.from}–${view.to} จาก ${view.total}`);

export function pagerHtml(view) {
  if (view.total === 0) return '';
  const btns = pageWindow(view.page, view.totalPages)
    .map((p) => (p === '…' ? '<span class="pager-gap" aria-hidden="true">…</span>' : `<button type="button" class="btn btn-sm" data-lk-page="${p}"${p === view.page ? ' aria-current="page"' : ''}>${p}</button>`))
    .join('');
  return `<div class="pager"><span class="pager-info">หน้า ${view.page} / ${view.totalPages}</span>
    <div class="pager-btns">
      <button type="button" class="btn btn-sm" data-lk-page="${view.page - 1}"${view.page <= 1 ? ' disabled' : ''}>ก่อนหน้า</button>${btns}
      <button type="button" class="btn btn-sm" data-lk-page="${view.page + 1}"${view.page >= view.totalPages ? ' disabled' : ''}>ถัดไป</button>
    </div>
    <label class="page-size">ต่อหน้า <select class="select" data-lk-size>${PAGE_SIZES.map((n) => `<option value="${n}"${n === view.pageSize ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
  </div>`;
}

// รายการเลือกหนึ่งรายการ (กลุ่ม/ครู/ห้อง/วิชา…): items=[{id,label,detail}] · onPick(id) · selectedId ถูกไฮไลต์ (aria-pressed)
// ฟิลด์ค้นหาเป็นค่าคงที่ระดับโมดูล (ใช้ดัชนี cache ได้) ; ค่าจากข้อมูลผ่าน esc() ทุกจุด
const PICK_FIELDS = (x) => [x.label, x.detail];
const PICK_SORT = { key: (x) => x.label };
export function mountPickList(container, { name, items, selectedId, onPick, placeholder = 'ค้นหา', emptyText = 'ไม่พบรายการ' }) {
  return mountListKit(container, {
    name,
    def: { fields: PICK_FIELDS, filters: [], sort: PICK_SORT, placeholder },
    getItems: () => items,
    emptyText,
    renderBody: (page) => `<ul class="pick-list">${page.map((it) => `<li><button type="button" class="pick-item" data-pick="${esc(it.id)}" aria-pressed="${it.id === selectedId}">
      <span class="pick-item-title">${esc(it.label)}</span>${it.detail ? `<span class="pick-item-sub">${esc(it.detail)}</span>` : ''}</button></li>`).join('')}</ul>`,
    onRender: (el) => el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.pick))),
  });
}

// ----- ตัวเลือก (select) ที่อาจยาว: ≤ 25 ตัวเลือกใช้ <select> ธรรมดา · มากกว่านั้นใช้รายการค้นหา/แบ่งหน้า (list-kit) -----
// items = [{ id, label, detail?, disabled?, note? }] ; blank = ข้อความตัวเลือกว่าง (value '') หรือ null
// ค่าที่เลือกอ่านได้จาก element id เดียวกันด้วย .value ทั้งสองแบบ (แบบค้นหาใช้ input ซ่อน) — ใช้แทน <select> เดิมได้เลย
export const SELECT_PLAIN_MAX = 25;
const SS_FIELDS = (x) => [x.label, x.detail];
export function searchSelect({ id, items, value = '', blank = null, label = '', onChange, placeholder = 'ค้นหา' }) {
  const big = items.length > SELECT_PLAIN_MAX;
  const cur = (v) => items.find((x) => x.id === v)?.label ?? (blank ?? '');
  const optionHtml = (it) => `<option value="${esc(it.id)}"${it.id === value ? ' selected' : ''}${it.disabled ? ' disabled' : ''}>${esc(it.label)}${it.note ? ` — ${esc(it.note)}` : ''}</option>`;
  const html = big
    ? `<div class="field-search" data-ss="${esc(id)}"><input type="hidden" id="${esc(id)}" value="${esc(value)}"><div class="field-hint" data-ss-current>เลือกอยู่: ${esc(cur(value) || '—')}</div><div data-ss-list></div></div>`
    : `<select class="select" id="${esc(id)}">${blank !== null ? `<option value=""${value ? '' : ' selected'}>${esc(blank)}</option>` : ''}${items.map(optionHtml).join('')}</select>`;
  function mount(root) {
    if (!big) {
      root.querySelector(`#${id}`)?.addEventListener('change', (e) => onChange?.(e.target.value));
      return;
    }
    const box = root.querySelector(`[data-ss="${id}"]`);
    const input = box?.querySelector('input[type=hidden]') ?? root.querySelector(`#${id}`);
    const list = [...(blank !== null ? [{ id: '', label: blank }] : []), ...items];
    const curEl = box?.querySelector('[data-ss-current]');
    let kit;
    const pick = (v) => {
      input.value = v;
      if (curEl) curEl.textContent = `เลือกอยู่: ${cur(v) || '—'}`;
      onChange?.(v);
      kit?.refresh();
    };
    kit = mountListKit(box.querySelector('[data-ss-list]'), {
      name: 'select-' + String(label || id).replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 30),
      persist: false,
      def: { fields: SS_FIELDS, filters: [], sort: undefined, placeholder },
      getItems: () => list,
      emptyText: 'ไม่พบรายการ',
      renderBody: (page) => `<ul class="pick-list">${page.map((it) => `<li><button type="button" class="pick-item${it.disabled ? ' is-disabled' : ''}" data-ss-pick="${esc(it.id)}"${it.disabled ? ' aria-disabled="true"' : ''} aria-pressed="${it.id === input.value}">
        <span class="pick-item-title">${esc(it.label)}</span>${it.detail ? `<span class="pick-item-sub">${esc(it.detail)}</span>` : ''}${it.note ? `<span class="pick-item-reason">${esc(it.note)}</span>` : ''}</button></li>`).join('')}</ul>`,
      onRender: (el) => el.querySelectorAll('[data-ss-pick]').forEach((b) => b.addEventListener('click', () => {
        const it = list.find((x) => x.id === b.dataset.ssPick);
        if (it && !it.disabled) pick(it.id);
      })),
    });
  }
  return { html, mount, big };
}

// รายการติ๊กเลือกหลายรายการ (ครูของวิชา, วิชาในแผน…) ค้นหา/แบ่งหน้าได้ ; ค่าที่เลือกอยู่ใน Set (จำข้ามหน้า) อ่านด้วย getSelected()
export function mountChecklist(container, { items, selected = [], name, placeholder = 'ค้นหา', emptyText = 'ไม่มีรายการ' }) {
  const chosen = new Set(selected);
  const kit = mountListKit(container, {
    name,
    persist: false,
    def: { fields: SS_FIELDS, filters: [], sort: undefined, placeholder },
    getItems: () => (typeof items === 'function' ? items() : items),
    emptyText,
    renderBody: (page) => `<fieldset class="chip-group">${page.map((it) => `<label class="chip"><input type="checkbox" data-cl-item value="${esc(it.id)}"${chosen.has(it.id) ? ' checked' : ''}><span>${esc(it.label)}</span></label>`).join('')}</fieldset>`,
    onRender: (el) => el.querySelectorAll('[data-cl-item]').forEach((i) => i.addEventListener('change', () => {
      if (i.checked) chosen.add(i.value);
      else chosen.delete(i.value);
    })),
  });
  return { getSelected: () => [...chosen], refresh: kit.refresh, chosen };
}

// รายการแบบตาราง: cfg = { name, def, getItems, headHtml, rowHtml:(item)=>'<tr>…</tr>', emptyText?, bind?:(bodyEl)=>void }
export function mountTableList(container, cfg) {
  return mountListKit(container, {
    name: cfg.name,
    def: cfg.def,
    getItems: cfg.getItems,
    emptyText: cfg.emptyText,
    renderBody: (items) => `<div class="table-wrap card"><table class="data-table"><thead>${cfg.headHtml}</thead><tbody>${items.map(cfg.rowHtml).join('')}</tbody></table></div>`,
    onRender: cfg.bind,
  });
}

// ---------- ตัวควบคุม (ผูกกับ DOM) ----------
// opts = { name, def, getItems:()=>[], renderBody:(pageItems, view)=>html, onRender?:(bodyEl)=>void, emptyText?:string }
// คืน { refresh, state } · เปลี่ยนคำค้น/ตัวกรอง → กลับหน้า 1 · พิมพ์แล้วกรองหลังหยุด ~150ms
let KIT_COUNT = 0;
export function mountListKit(container, opts) {
  const { name, def } = opts;
  const filterIds = (def.filters ?? []).map((f) => f.id);
  // persist:false = ไม่จำค่าค้นหา (ใช้กับตัวเลือกในโมดัล/ฟอร์ม)
  const persist = opts.persist !== false;
  const ns = String(++KIT_COUNT);
  const st = persist ? loadListState(name, filterIds) : emptyListState();
  let timer = null;
  let view = computeView(opts.getItems(), st, def);
  st.page = view.page;

  container.innerHTML = `<div data-lk-bar>${barHtml(def, st, view, ns)}</div><div class="list-kit-body" data-lk-body></div><div data-lk-pager></div>`;
  const bodyEl = container.querySelector('[data-lk-body]');
  const pagerEl = container.querySelector('[data-lk-pager]');
  const countEl = container.querySelector('[data-lk-count]');
  const clearEl = container.querySelector('[data-lk-clear]');

  function paint() {
    view = computeView(opts.getItems(), st, def);
    st.page = view.page;
    countEl.textContent = countText(view);
    if (clearEl) clearEl.hidden = !st.query;
    bodyEl.innerHTML = view.total === 0
      ? `<div class="list-empty">${esc((typeof opts.emptyText === 'function' ? opts.emptyText() : opts.emptyText) ?? 'ไม่พบรายการ')}</div>`
      : opts.renderBody(view.items, view);
    pagerEl.innerHTML = pagerHtml(view);
    opts.onRender?.(bodyEl, view);
  }
  const resetPage = () => { st.page = 1; if (persist) saveListState(name, st); paint(); };

  container.addEventListener('input', (e) => {
    if (!e.target?.matches?.('[data-lk-search]')) return;
    clearTimeout(timer);
    timer = setTimeout(() => { st.query = cleanQuery(e.target.value); resetPage(); }, 150);
  });
  container.addEventListener('change', (e) => {
    const t = e.target;
    if (t?.matches?.('[data-lk-filter]')) {
      if (t.value) st.filters.set(t.dataset.lkFilter, t.value.slice(0, FILTER_VALUE_MAX));
      else st.filters.delete(t.dataset.lkFilter);
      resetPage();
    } else if (t?.matches?.('[data-lk-size]')) {
      const n = Number(t.value);
      st.pageSize = PAGE_SIZES.includes(n) ? n : DEFAULT_PAGE_SIZE;
      resetPage();
    }
  });
  container.addEventListener('click', (e) => {
    const el = e.target?.closest?.('[data-lk-page],[data-lk-clear]');
    if (!el) return;
    if (el.matches('[data-lk-clear]')) {
      st.query = '';
      const input = container.querySelector('[data-lk-search]');
      if (input) input.value = '';
      resetPage();
    } else {
      const p = Number(el.dataset.lkPage);
      if (Number.isInteger(p)) { st.page = p; paint(); }
    }
  });

  paint();
  return { refresh: paint, state: st };
}
