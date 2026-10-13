// หน้าเข้าสู่ระบบแอดมิน (โหมด remote) — ไม่เก็บรหัสผ่านหรือโทเค็นไว้ที่ใด ตัว session เป็น cookie HttpOnly ที่เซิร์ฟเวอร์ตั้ง
import { ApiError } from '../api-client.js';
import { ctx } from './util.js';

// ข้อความคงที่ ไม่บอกว่า username ถูกหรือไม่ (ตาม SPEC ข้อ 7)
const BAD_LOGIN = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';

export function renderLogin(root, { onSuccess } = {}) {
  root.innerHTML = `
    <div class="login-wrap"><form class="login-card card" id="login-form" novalidate autocomplete="on">
      <h1>เข้าสู่ระบบแอดมิน</h1>
      <p class="text-muted">ผู้ดูแลระบบเท่านั้นที่แก้ไขตารางได้ ผู้ใช้ทั่วไปดูตารางได้ที่หน้าแรกหรือผ่านลิงก์ที่ผู้ดูแลระบบส่งให้</p>
      <div id="login-alert" aria-live="polite"></div>
      <div class="field"><label class="field-label" for="f-user">ชื่อผู้ใช้</label>
        <input class="input" id="f-user" name="username" autocomplete="username" maxlength="64" required></div>
      <div class="field"><label class="field-label" for="f-pass">รหัสผ่าน</label>
        <input class="input" id="f-pass" name="password" type="password" autocomplete="current-password" maxlength="256" required></div>
      <div class="field-error" id="login-error" role="alert"></div>
      <button type="submit" class="btn btn-primary" id="login-submit">เข้าสู่ระบบ</button>
    </form></div>`;
  const form = root.querySelector('#login-form');
  const err = root.querySelector('#login-error');
  const alertBox = root.querySelector('#login-alert');
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const username = form.username.value.trim();
    const password = form.password.value;
    err.textContent = '';
    alertBox.innerHTML = '';
    if (!username || !password) {
      err.textContent = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน';
      return;
    }
    busy = true;
    root.querySelector('#login-submit').disabled = true;
    try {
      await ctx.api.login(username, password);
      form.password.value = '';
      await onSuccess?.();
    } catch (ex) {
      form.password.value = '';
      if (ex instanceof ApiError && ex.status === 429) {
        alertBox.innerHTML = '<div class="alert alert-warning" role="alert">ลองเข้าสู่ระบบบ่อยเกินไป โปรดรอสักครู่แล้วลองใหม่ภายหลัง</div>';
      } else if (ex instanceof ApiError && ex.status === 0) {
        err.textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง';
      } else if (ex instanceof ApiError && ex.status >= 500) {
        err.textContent = 'ระบบขัดข้อง โปรดติดต่อผู้ดูแล';
      } else {
        err.textContent = BAD_LOGIN;
      }
    } finally {
      busy = false;
      const btn = root.querySelector('#login-submit');
      if (btn) btn.disabled = false;
    }
  });
}
