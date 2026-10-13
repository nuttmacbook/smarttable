// combobox: ช่องค้นหา+เลือกจากรายการยาว แบบย่อโดยค่าเริ่มต้น (แสดงรายการที่เลือกในช่องเดียว) — รายการเต็มลอยทับ (.combo-pop) ไม่ดันเนื้อหาใต้ช่อง
// - เปิดเมื่อโฟกัส/คลิก/พิมพ์/กดปุ่มลูกศร · ปิดเมื่อเลือก/คลิกนอก/Esc/Tab ออก
// - คีย์บอร์ด: ↓ ↑ เลื่อน (ข้ามรายการที่ disabled) · Enter เลือก · Esc ปิด (ครั้งที่สองล้างคำค้น) · Home/End ไปต้น/ท้ายรายการเมื่อเริ่มเลื่อนด้วยลูกศรแล้ว
// - ARIA: input role=combobox aria-expanded aria-controls aria-activedescendant aria-autocomplete=list · ul role=listbox · li role=option aria-selected
// - ค้นด้วย queryList ของ js/list-model.js (ตัวเดียวกับ list-kit: ไทย/ตัวพิมพ์/ช่องว่าง ไม่สร้าง RegExp จากคำค้น) ; คำค้นตัดตามสัญญา list-kit (≤200 ตัว ≤10 คำ)
// - เรนเดอร์ไม่เกิน MAX_RENDER รายการ (ที่เหลือบอกจำนวน ให้พิมพ์เพิ่ม) ; ค่าจากข้อมูลผ่าน esc() ทุกจุด ; id ของ aria สร้างเอง (ไม่ใช้ id จากข้อมูล) ; ไม่มี inline handler
// - จำการเลือกล่าสุดต่อหน้า (id เท่านั้น ไม่เก็บชื่อ) ในกลไกเดิม tt.ui.list.<ชื่อ> : rememberLast/recallLast
import { queryList } from '../list-model.js';
import { icon } from '../icons.js';
import { esc } from './util.js';
import { cleanQuery, MAX_QUERY_LENGTH, loadListState, saveListState } from './list-kit.js';

export const MAX_RENDER = 50;
const FIELDS = (x) => [x.label, x.detail];
const SORT = { key: (x) => x.label };
let CB_COUNT = 0;

// ---------- pure ----------
// ตำแหน่งที่ active ถัดไป (-1 = ยังไม่มี) ; disabled[i] = true ข้ามรายการนั้น ; key: ArrowDown|ArrowUp|Home|End
export function moveActive(active, count, key, disabled = []) {
  if (!count) return -1;
  const ok = (i) => !disabled[i];
  if (key === 'Home' || key === 'End') {
    const order = key === 'Home' ? [...Array(count).keys()] : [...Array(count).keys()].reverse();
    return order.find(ok) ?? -1;
  }
  const step = key === 'ArrowUp' ? -1 : 1;
  let i = active;
  for (let n = 0; n < count; n += 1) {
    i = i < 0 ? (step > 0 ? 0 : count - 1) : (i + step + count) % count;
    if (ok(i)) return i;
  }
  return -1;
}

// กรอง+เรียงรายการด้วยคำค้น → { shown, total } (shown ไม่เกิน MAX_RENDER)
export function filterCombo(items, query) {
  const r = queryList(items, { query: cleanQuery(query), fields: FIELDS, filters: [], sort: SORT, page: 1, pageSize: MAX_RENDER });
  return { shown: r.items, total: r.total };
}

// ---------- จำการเลือกล่าสุด ----------
export function rememberLast(name, id) {
  if (typeof id !== 'string' || !id) return;
  const st = loadListState(name, []);
  st.last = id;
  saveListState(name, st);
}
// คืน id ที่จำไว้ถ้ายังอยู่ใน items ไม่งั้น ''
export function recallLast(name, items) {
  const { last } = loadListState(name, []);
  return last && items.some((x) => x.id === last) ? last : '';
}

// ---------- ปิดเมื่อคลิกนอก (ตัวฟังเดียวระดับเอกสาร) ----------
const instances = new Set();
// ล้างตัวที่ถูกถอดออกจากเอกสารแล้ว (หน้าถูกเรนเดอร์ใหม่) — เรียกก่อนวางตำแหน่ง/ก่อนสร้างตัวใหม่/ตอนคลิกนอก
export function pruneComboboxes() {
  for (const inst of [...instances]) if (inst.root.isConnected === false) instances.delete(inst);
  kbSync();
  return instances.size;
}

// bottom sheet บนจอ ≤480: คีย์บอร์ดมือถือบังส่วนล่าง → ตั้ง --kb-inset (px) บน <html> จาก visualViewport ตอนมี combobox เปิดอยู่ ; ล้างเมื่อปิดทั้งหมด
// ไม่มี visualViewport = ไม่ทำอะไร (ค่าเริ่มต้นใน CSS = 0) ; ยังไม่เคยทดสอบบนเครื่องมือถือจริง
let kbOn = false;
export function kbInsetPx(vv, innerHeight) {
  if (!vv || !Number.isFinite(vv.height)) return 0;
  return Math.max(0, Math.round(innerHeight - vv.height - (vv.offsetTop || 0)));
}
function kbUpdate() {
  const vv = globalThis.visualViewport;
  globalThis.document?.documentElement?.style?.setProperty?.('--kb-inset', `${kbInsetPx(vv, globalThis.innerHeight ?? 0)}px`);
}
export function kbSync() {
  const vv = globalThis.visualViewport;
  const want = Boolean(vv) && (globalThis.innerWidth ?? 1024) <= 480 && [...instances].some((i) => i.isOpen);
  if (want === kbOn) { if (want) kbUpdate(); return; }
  kbOn = want;
  if (want) {
    vv.addEventListener?.('resize', kbUpdate);
    vv.addEventListener?.('scroll', kbUpdate);
    kbUpdate();
  } else {
    vv?.removeEventListener?.('resize', kbUpdate);
    vv?.removeEventListener?.('scroll', kbUpdate);
    globalThis.document?.documentElement?.style?.removeProperty?.('--kb-inset');
  }
}
let docBound = false;
function bindDocument() {
  if (docBound || typeof document === 'undefined' || !document.addEventListener) return;
  docBound = true;
  const outside = (e) => {
    for (const inst of [...instances]) {
      if (inst.root.isConnected === false) { instances.delete(inst); continue; }
      if (!inst.root.contains?.(e.target)) inst.close();
    }
  };
  document.addEventListener('mousedown', outside);
  document.addEventListener('touchstart', outside, { passive: true });
  // เลื่อนหน้า/ปรับขนาดหน้าต่างขณะเปิด: จัดตำแหน่งลิสต์ที่วางแบบ fixed ใหม่
  const reposition = () => { pruneComboboxes(); instances.forEach((i) => i.place?.()); };
  globalThis.addEventListener?.('scroll', reposition, true);
  globalThis.addEventListener?.('resize', reposition);
}

// ---------- คอมโพเนนต์ ----------
// opts = { name, items:[{id,label,detail?,disabled?,note?}], value, blank?:string|null, placeholder, ariaLabel, onChange(id), remember?:true, emptyText? }
// blank = ข้อความตัวเลือกว่าง (id '') ; คืน { getValue, setValue, open, close, el }
export function mountCombobox(container, opts) {
  const { name, items: baseItems, onChange } = opts;
  const blank = opts.blank ?? null;
  const items = blank !== null ? [{ id: '', label: blank }, ...baseItems] : baseItems;
  const remember = opts.remember !== false && typeof name === 'string' && name;
  const uid = `cb${++CB_COUNT}`;
  const listId = `${uid}-list`;
  const labelOf = (id) => items.find((x) => x.id === id)?.label ?? '';
  // ตัวเลือกว่าง (blank) อยู่บนสุดเสมอเมื่อไม่ได้พิมพ์ค้น ; ที่เหลือเรียงตามชื่อ
  const compute = (q) => {
    const r = filterCombo(baseItems, q);
    if (blank === null || cleanQuery(q)) return r;
    return { shown: [{ id: '', label: blank }, ...r.shown.slice(0, MAX_RENDER - 1)], total: r.total + 1 };
  };
  let value = typeof opts.value === 'string' ? opts.value : '';
  let query = '';
  let isOpen = false;
  let active = -1;
  let shown = [];
  let navigated = false; // เริ่มเลื่อนด้วยลูกศรแล้ว (Home/End ใช้ได้)

  container.innerHTML = `<div class="combo" data-cb-root data-open="false">
    <div class="combo-field">
      <input class="input combo-input" type="text"${opts.inputId ? ` id="${esc(opts.inputId)}"` : ''} role="combobox" data-cb-input aria-expanded="false" aria-controls="${listId}" aria-autocomplete="list" aria-haspopup="listbox" aria-label="${esc(opts.ariaLabel ?? opts.placeholder ?? 'เลือกรายการ')}" placeholder="${esc(opts.placeholder ?? 'ค้นหา')}" maxlength="${MAX_QUERY_LENGTH}" autocomplete="off" spellcheck="false" value="${esc(labelOf(value))}">
      <button type="button" class="combo-clear" data-cb-clear aria-label="ล้างคำค้น" tabindex="-1" hidden>${icon('x')}</button>
      <button type="button" class="combo-toggle" data-cb-toggle aria-label="เปิดรายการ" aria-controls="${listId}" aria-expanded="false" tabindex="-1">${icon('chevron-down')}</button>
    </div>
    <div class="combo-pop" id="${listId}-pop" data-cb-pop hidden>
      <div class="combo-meta" data-cb-meta role="status" aria-live="polite"></div>
      <ul class="combo-list" id="${listId}" role="listbox" data-cb-list></ul>
    </div>
  </div>`;
  const root = container.querySelector('[data-cb-root]');
  const input = container.querySelector('[data-cb-input]');
  const pop = container.querySelector('[data-cb-pop]');
  const list = container.querySelector('[data-cb-list]');
  const meta = container.querySelector('[data-cb-meta]');
  const clearBtn = container.querySelector('[data-cb-clear]');
  const toggleBtn = container.querySelector('[data-cb-toggle]');

  function paintList() {
    const r = compute(query);
    shown = r.shown;
    if (active >= shown.length) active = shown.length - 1;
    meta.textContent = r.total === 0 ? (opts.emptyText ?? 'ไม่พบรายการ') : r.total > shown.length ? `แสดง ${shown.length} จาก ${r.total} — พิมพ์เพื่อค้นหาเพิ่ม` : `${r.total} รายการ`;
    if (!shown.length) {
      list.innerHTML = `<li class="combo-empty" role="presentation">${esc(opts.emptyText ?? 'ไม่พบรายการ')}</li>`;
      input.setAttribute('aria-activedescendant', '');
      return;
    }
    list.innerHTML = shown.map((it, i) => `<li class="combo-option${it.disabled ? ' is-disabled' : ''}${i === active ? ' is-active' : ''}" role="option" id="${uid}-o${i}" data-cb-opt="${i}" aria-selected="${it.id === value}"${it.disabled ? ' aria-disabled="true"' : ''}>
      <span class="combo-label">${esc(it.label)}</span>${it.detail ? `<span class="combo-detail">${esc(it.detail)}</span>` : ''}${it.note ? `<span class="combo-note">${esc(it.note)}</span>` : ''}</li>`).join('');
    input.setAttribute('aria-activedescendant', active >= 0 ? `${uid}-o${active}` : '');
  }
  // ในโมดัลที่เลื่อนได้ ลิสต์ลอยจะถูกตัดตามกรอบ → วางแบบ fixed ตามตำแหน่งช่อง (ไม่ใช้บนจอแคบ ≤480 ที่ CSS ทำ bottom sheet)
  const inScroller = () => Boolean(root.closest?.('.modal-body'));
  const wide = () => (globalThis.innerWidth ?? 1024) > 480;
  function place() {
    if (!isOpen || !inScroller() || !wide()) return unplace();
    const r = container.querySelector('.combo-field')?.getBoundingClientRect?.();
    if (!r) return;
    const vh = globalThis.innerHeight ?? 768;
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 180 && above > below;
    pop.classList.add('is-fixed');
    Object.assign(pop.style, {
      position: 'fixed',
      left: `${Math.round(r.left)}px`,
      width: `${Math.round(r.width)}px`,
      top: up ? 'auto' : `${Math.round(r.bottom + 4)}px`,
      bottom: up ? `${Math.round(vh - r.top + 4)}px` : 'auto',
      maxHeight: `${Math.max(120, Math.min(320, up ? above : below))}px`,
    });
  }
  function unplace() {
    pop.classList?.remove?.('is-fixed');
    for (const k of ['position', 'left', 'width', 'top', 'bottom', 'maxHeight']) pop.style[k] = '';
  }
  function paintState() {
    root.dataset.open = String(isOpen);
    input.setAttribute('aria-expanded', String(isOpen));
    toggleBtn.setAttribute('aria-expanded', String(isOpen));
    toggleBtn.setAttribute('aria-label', isOpen ? 'ปิดรายการ' : 'เปิดรายการ');
    pop.hidden = !isOpen;
    clearBtn.hidden = !(isOpen && query);
    place();
  }
  function open() {
    if (isOpen) return;
    isOpen = true;
    query = '';
    navigated = false;
    const cur = shownIndexOf(value);
    active = cur;
    paintList();
    paintState();
    kbSync();
  }
  function shownIndexOf(id) {
    const r = compute('').shown;
    const i = r.findIndex((x) => x.id === id && !x.disabled);
    return i;
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    query = '';
    active = -1;
    input.value = labelOf(value);
    paintState();
    input.setAttribute('aria-activedescendant', '');
    kbSync();
  }
  function choose(i) {
    const it = shown[i];
    if (!it || it.disabled) return;
    const changed = it.id !== value;
    value = it.id;
    if (remember && value) rememberLast(name, value);
    close();
    if (changed) onChange?.(value);
  }

  pruneComboboxes();
  const inst = { root, close, place, get isOpen() { return isOpen; } };
  instances.add(inst);
  bindDocument();

  container.addEventListener('input', (e) => {
    if (!e.target?.matches?.('[data-cb-input]')) return;
    if (!isOpen) { isOpen = true; navigated = false; }
    query = cleanQuery(e.target.value);
    // ถ้ากำลังพิมพ์ให้ active ไปที่ผลแรกที่เลือกได้
    const r = compute(query);
    active = moveActive(-1, r.shown.length, 'ArrowDown', r.shown.map((x) => Boolean(x.disabled)));
    paintList();
    paintState();
  });
  container.addEventListener('focusin', (e) => {
    if (e.target?.matches?.('[data-cb-input]')) { open(); e.target.select?.(); }
  });
  container.addEventListener('focusout', (e) => {
    const next = e.relatedTarget;
    if (next && root.contains?.(next)) return;
    close();
  });
  container.addEventListener('mousedown', (e) => {
    // คลิกในรายการ/ปุ่มต้องไม่ดึงโฟกัสออกจากช่อง (กัน focusout ปิดก่อนเลือก)
    if (e.target?.closest?.('[data-cb-opt],[data-cb-toggle],[data-cb-clear],[data-cb-pop]')) e.preventDefault?.();
  });
  container.addEventListener('click', (e) => {
    const t = e.target;
    const opt = t?.closest?.('[data-cb-opt]');
    if (opt) { choose(Number(opt.dataset.cbOpt)); return; }
    if (t?.closest?.('[data-cb-clear]')) {
      query = '';
      input.value = '';
      active = -1;
      paintList();
      paintState();
      input.focus?.();
      return;
    }
    if (t?.closest?.('[data-cb-toggle]')) {
      if (isOpen) close();
      else { open(); input.focus?.(); }
      return;
    }
    if (t?.matches?.('[data-cb-input]') && !isOpen) open();
  });
  container.addEventListener('keydown', (e) => {
    if (!e.target?.matches?.('[data-cb-input]')) return;
    const k = e.key;
    const dis = shown.map((x) => Boolean(x.disabled));
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault?.();
      if (!isOpen) { open(); if (k === 'ArrowDown' && active >= 0) return; }
      navigated = true;
      active = moveActive(active, shown.length, k, dis);
      paintList();
      paintState();
    } else if ((k === 'Home' || k === 'End') && isOpen && navigated) {
      e.preventDefault?.();
      active = moveActive(active, shown.length, k, dis);
      paintList();
    } else if (k === 'Enter') {
      if (isOpen && active >= 0) { e.preventDefault?.(); choose(active); }
    } else if (k === 'Escape') {
      if (isOpen) {
        e.preventDefault?.();
        e.stopPropagation?.();
        if (query) { query = ''; input.value = ''; active = -1; paintList(); paintState(); } else close();
      }
    } else if (k === 'Tab') {
      close();
    }
  });

  paintState();
  return {
    el: root,
    open,
    close,
    getValue: () => value,
    setValue: (v) => { value = typeof v === 'string' ? v : ''; if (!isOpen) input.value = labelOf(value); },
  };
}
