// แกนของแอป: ตรวจสิทธิ์, router, แถบสถานะ — แยกจาก js/app.js เพื่อทดสอบใน node ได้ (ข้อมูลอยู่บนเซิร์ฟเวอร์เสมอ)
// - แอดมิน: ล็อกอิน (cookie HttpOnly ฝั่งเซิร์ฟเวอร์) ทุกการแก้เป็น op ผ่าน api/ · ผู้ที่ไม่ได้ล็อกอินเห็น "หน้าสาธารณะ" (GET /api/public) ถ้าแอดมินเปิดโหมดไว้
// - viewer: เปิดลิงก์ #/view/<token> → ดูอย่างเดียว เห็นเฉพาะ scope ของลิงก์ (เซิร์ฟเวอร์กรองให้แล้ว)
// โทเค็นของผู้ดูอยู่ในตัวแปรของ createApp เท่านั้น (ไม่เขียน localStorage/sessionStorage) — W-04
import { parseViewRoute, toAdapterClient, ApiError } from './api-client.js';
import { createStorageAdapter } from './storage-adapter.js';
import { emptyState } from './store.js';
import { ctx, esc, setState, openModal } from './pages/util.js';
import { clearListStates } from './pages/list-kit.js';
import { renderPublic } from './pages/public.js';
import { renderSettings, effectiveHide, isUnconfirmed } from './pages/settings.js';
import { renderSchedule } from './pages/schedule.js';
import { renderSubjects } from './pages/subjects.js';
import { renderGroups, renderClassrooms, renderTeachers } from './pages/rooms-teachers.js';
import { renderPlans } from './pages/plans.js';
import { renderLevels } from './pages/levels.js';
import { renderGroupView, renderTeacherView, renderClassroomView } from './pages/views.js';
import { renderData } from './pages/data.js';
import { renderShares, scopeLabel } from './pages/shares.js';
import { renderExport } from './pages/exportbox.js';
import { renderLogin } from './pages/login.js';

// viewer:true = ผู้ดูอย่างเดียวเข้าได้
export const ROUTES = [
  { path: 'schedule', title: 'จัดตาราง', render: renderSchedule },
  { path: 'subjects', title: 'รายวิชา', render: renderSubjects },
  { path: 'groups', title: 'กลุ่มเรียน', render: renderGroups },
  { path: 'levels', title: 'ระดับ', render: renderLevels },
  { path: 'plans', title: 'แผนการเรียน', render: renderPlans },
  { path: 'classrooms', title: 'ห้องเรียน', render: renderClassrooms },
  { path: 'teachers', title: 'ครู', render: renderTeachers },
  { path: 'group-view', title: 'ตารางรายกลุ่มเรียน', render: renderGroupView, viewer: true },
  { path: 'teacher-view', title: 'ตารางรายครู', render: renderTeacherView, viewer: true },
  { path: 'classroom-view', title: 'ตารางรายห้องเรียน', render: renderClassroomView, viewer: true },
  { path: 'export', title: 'ส่งออก/พิมพ์', render: renderExport, viewer: true },
  { path: 'data', title: 'ข้อมูล', render: renderData },
  { path: 'shares', title: 'ลิงก์แชร์', render: renderShares },
  { path: 'settings', title: 'ตั้งค่า', render: renderSettings },
];

const CONN_TEXT = { saved: ['conn-saved', 'บันทึกแล้ว'], saving: ['conn-saving', 'กำลังบันทึก…'], conflict: ['conn-conflict', 'มีผู้แก้ไขพร้อมกัน'], offline: ['conn-offline', 'ออฟไลน์'], error: ['conn-conflict', 'บันทึกไม่สำเร็จ'] };

const viewerHome = (scope) => {
  const kind = String(scope || 'all').split(':')[0];
  return kind === 'teacher' ? 'teacher-view' : kind === 'room' ? 'classroom-view' : 'group-view';
};

// els = { nav, main, status, legacy } · env = { getHash(), setHash(h), title(t) }
export function createApp({ api, els, env }) {
  let viewToken = null;
  let started = false;
  const fresh = () => {
    Object.assign(ctx.ui, { groupId: null, teacherId: null, classroomId: null, moving: null, placingSubjectId: null, viewPage: '', multi: null, public: null });
  };

  function resetSession() {
    // ล้างสำเนาข้อมูลในหน่วยความจำหลังออกจากระบบ (W-17)
    ctx.adapter = null;
    ctx.user = null;
    ctx.viewer = null;
    ctx.conn = 'saved';
    ctx.settings = null;
    ctx.hideTeachers = false;
    ctx.publicDisabled = false;
    ctx.publicError = '';
    clearListStates(); // ล้างค่าค้นหา/ตัวกรอง/ขนาดหน้าที่จำไว้ (V5-07)
    setState(emptyState());
    fresh();
    viewToken = null;
  }

  // ----- เส้นทาง -----
  function allowedRoutes() {
    if (ctx.role === 'viewer') return ROUTES.filter((r) => r.viewer);
    if (ctx.role !== 'admin') return [];
    return ROUTES;
  }
  function currentRoute() {
    const routes = allowedRoutes();
    const hash = env.getHash();
    if (ctx.role === 'viewer') {
      const page = parseViewRoute(hash)?.page || ctx.ui.viewPage || viewerHome(ctx.viewer?.scope);
      return routes.find((r) => r.path === page) || routes.find((r) => r.path === viewerHome(ctx.viewer?.scope)) || routes[0];
    }
    const path = hash.replace(/^#\/?/, '') || 'schedule';
    return routes.find((r) => r.path === path) || routes[0];
  }
  const hrefFor = (r) => (ctx.role === 'viewer' ? `#/view/${viewToken}/${r.path}` : `#/${r.path}`);

  function renderNav(active) {
    els.nav.innerHTML = allowedRoutes()
      .map((r) => `<a class="nav-link${r === active ? ' is-active' : ''}" href="${esc(hrefFor(r))}"${r === active ? ' aria-current="page"' : ''}>${esc(r.title)}</a>`)
      .join('');
  }

  function renderLegacyBar() {
    const n = ctx.role === 'admin' ? ctx.legacy.length : 0;
    els.legacy.innerHTML = n
      ? `<div class="legacy-bar" role="alert">มี ${n} รายการเกินชั่วโมงหรือชน ต้องแก้ก่อนบันทึก <button type="button" class="btn btn-sm" data-action="show-legacy">ดูรายการ</button></div>`
      : '';
  }

  function updateStatus() {
    const parts = [];
    if (ctx.role === 'viewer') {
      parts.push('<span class="badge badge-readonly">โหมดดูอย่างเดียว</span>');
    } else if (ctx.role === 'admin') {
      const [cls, text] = CONN_TEXT[ctx.conn] ?? CONN_TEXT.saved;
      parts.push(`<span class="badge badge-admin">แอดมิน: ${esc(ctx.user ?? '')}</span>`);
      parts.push(`<span class="conn-status ${cls}" role="status">${esc(text)}</span>`);
      parts.push('<button type="button" class="btn btn-sm" data-action="logout">ออกจากระบบ</button>');
    }
    els.status.innerHTML = parts.join(' ');
    renderLegacyBar();
  }

  function render() {
    updateStatus();
    const wantsLogin = env.getHash().replace(/\/+$/, '') === '#/login';
    if (ctx.role === 'anon' || (ctx.role === 'public' && wantsLogin)) {
      els.nav.innerHTML = '';
      env.title('เข้าสู่ระบบ · ระบบจัดตารางเรียนตารางสอน');
      renderLogin(els.main, { onSuccess: afterLogin });
      return;
    }
    if (ctx.role === 'public') {
      els.nav.innerHTML = '';
      env.title('ตารางเรียนตารางสอน');
      try {
        renderPublic(els.main);
      } catch (err) {
        console.error(err);
        els.main.innerHTML = `<div class="alert alert-error" role="alert">เกิดข้อผิดพลาดในการแสดงหน้า: ${esc(err.message)}</div>`;
      }
      return;
    }
    const route = currentRoute();
    renderNav(route);
    env.title(`${route.title} · ระบบจัดตารางเรียนตารางสอน`);
    try {
      route.render(els.main);
      if (ctx.role === 'admin' && isUnconfirmed(ctx.settings) && typeof els.main.insertAdjacentHTML === 'function') {
        els.main.insertAdjacentHTML('afterbegin', '<div class="alert alert-warning unconfirmed-banner" role="alert"><span class="badge badge-unconfirmed">ยังไม่ยืนยัน</span> ตอนนี้ระบบซ่อนรายชื่อครูไว้ก่อน (ค่าเริ่มต้น) — เลือกแสดงเมื่อพร้อม <a href="#/settings">ไปหน้าตั้งค่า</a></div>');
      }
      if (ctx.role === 'viewer') {
        // แทรกแบนเนอร์โดยไม่เขียน innerHTML ทับ (ไม่ทำให้ event listener ของหน้าหาย)
        const banner = `<div class="alert alert-info viewer-banner" role="note">คุณกำลังดูตารางแบบดูอย่างเดียว (ขอบเขต: ${esc(scopeLabel(ctx.state, ctx.viewer?.scope ?? 'all'))}) แก้ไขไม่ได้</div>`;
        if (typeof els.main.insertAdjacentHTML === 'function') els.main.insertAdjacentHTML('afterbegin', banner);
        else els.main.innerHTML = banner + els.main.innerHTML;
      }
    } catch (err) {
      console.error(err);
      els.main.innerHTML = `<div class="alert alert-error" role="alert">เกิดข้อผิดพลาดในการแสดงหน้า: ${esc(err.message)}</div>`;
    }
  }

  function showInvalidLink() {
    resetSession();
    ctx.role = 'none';
    els.nav.innerHTML = '';
    els.status.innerHTML = '';
    els.legacy.innerHTML = '';
    els.main.innerHTML = '<div class="empty-state"><h1>ลิงก์นี้ใช้ไม่ได้</h1><p>ลิงก์อาจถูกเพิกถอนหรือหมดอายุ โปรดขอลิงก์ใหม่จากผู้ดูแลระบบ</p></div>';
    env.title('ลิงก์นี้ใช้ไม่ได้');
  }

  // ----- boot -----
  async function bootViewer(token) {
    resetSession();
    try {
      const res = await api.getSharedState(token);
      viewToken = token;
      ctx.role = 'viewer';
      ctx.viewer = { scope: res.scope ?? 'all', label: res.label ?? '' };
      setState({ ...emptyState(), ...(res.state || {}) });
      ctx.legacy = [];
      render();
    } catch {
      showInvalidLink(); // ไม่บอกรายละเอียดว่าเพราะอะไร
    }
  }

  async function loadAdminRemote() {
    ctx.adapter = createStorageAdapter({ mode: 'remote', apiClient: toAdapterClient(api) });
    const loaded = await ctx.adapter.load();
    if (loaded.ok === false) throw new ApiError(0, null, loaded.errors?.[0]?.message ?? 'โหลดข้อมูลไม่ได้');
    setState(ctx.adapter.getState());
    ctx.role = 'admin';
    ctx.conn = 'saved';
  }

  // ผู้ชมทั่วไป (ไม่ล็อกอิน): GET /api/public — 200 ได้ตารางทั้งสถานศึกษา (อ่านอย่างเดียว) · 403 public-disabled = ปิดโหมด
  async function bootPublic() {
    resetSession();
    ctx.role = 'public';
    try {
      const res = await api.getPublic();
      ctx.hideTeachers = effectiveHide(res.settings); // ไม่มีค่า/null ถือว่าซ่อน (fail-safe)
      setState({ ...emptyState(), ...(res.state || {}) });
      ctx.legacy = [];
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) ctx.publicDisabled = true;
      else ctx.publicError = err instanceof ApiError && err.status === 429 ? 'มีผู้เข้าชมจำนวนมาก โปรดรอสักครู่แล้วลองใหม่' : err instanceof ApiError && err.status === 503 ? 'ระบบขัดข้องชั่วคราว โปรดลองใหม่ภายหลัง' : 'ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้ โปรดลองใหม่ภายหลัง';
      ctx.hideTeachers = true;
    }
    render();
  }

  async function afterLogin() {
    try {
      const me = await api.me();
      ctx.user = me?.username ?? me?.user?.username ?? 'admin';
      await loadAdminRemote();
      ctx.settings = me?.settings ?? null;
      ctx.hideTeachers = false;
      ctx.publicDisabled = false;
      ctx.publicError = '';
      fresh();
      if (env.getHash().replace(/\/+$/, '') === '#/login') env.setHash('#/schedule');
      render();
    } catch (err) {
      ctx.role = 'anon';
      render();
      throw err;
    }
  }

  async function bootAdmin() {
    fresh();
    try {
      const me = await api.me();
      ctx.user = me?.username ?? me?.user?.username ?? 'admin';
      await loadAdminRemote();
      ctx.settings = me?.settings ?? null;
    } catch {
      return bootPublic(); // ยังไม่ได้ล็อกอิน → หน้าสาธารณะ
    }
    render();
  }

  async function start() {
    ctx.api = api;
    ctx.rerender = render;
    ctx.updateStatus = updateStatus;
    ctx.onAuthLost = () => {
      resetSession();
      ctx.role = 'anon';
      render();
    };
    started = true;
    const view = parseViewRoute(env.getHash());
    if (view) return bootViewer(view.token);
    return bootAdmin();
  }

  async function onHashChange() {
    if (!started) return;
    const view = parseViewRoute(env.getHash());
    if (view && view.token !== viewToken) return bootViewer(view.token);
    if (ctx.role === 'viewer') {
      ctx.ui.viewPage = view?.page || ctx.ui.viewPage;
      if (!view) env.setHash(`#/view/${viewToken}/${currentRoute().path}`);
    } else if (!view && ctx.role === 'none') {
      return bootAdmin();
    }
    ctx.ui.moving = null;
    render();
  }

  const actions = {
    async logout() {
      try {
        await api.logout();
      } catch {
        // ออกจากหน้าจอไปก่อนเสมอ แม้เซิร์ฟเวอร์ตอบไม่ได้
      }
      env.setHash('#/');
      await bootPublic(); // ล้างข้อมูลผู้ดูแลแล้วกลับหน้าสาธารณะ
    },
    showLegacy() {
      openModal({
        title: `รายการเกินชั่วโมงหรือชน (${ctx.legacy.length})`,
        large: true,
        bodyHtml: `<ul>${ctx.legacy.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul>`,
        footerHtml: '<button type="button" class="btn" data-close>ปิด</button>',
      });
    },
  };

  // event delegation (ไม่มี inline handler — รองรับ CSP script-src 'self')
  const onClick = (e) => {
    const el = e.target?.closest?.('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'logout') actions.logout();
    else if (el.dataset.action === 'show-legacy') actions.showLegacy();
  };
  els.status.addEventListener?.('click', onClick);
  els.legacy.addEventListener?.('click', onClick);

  return { start, render, onHashChange, actions, afterLogin, get viewToken() { return viewToken; } };
}
