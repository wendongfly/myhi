// 个人偏好跨设备同步：外观（主题/字号）、会话页的聊天显示与快捷栏。
// 各页面照旧读写 localStorage（myhi_theme / myhi_font / myhi_chat_settings），本脚本负责和服务端 /api/prefs 对齐：
//   · 打开页面：服务端那份比本机新 → 写回 localStorage，有差异就刷新一次让页面按新设置渲染（每个标签页最多一次）；
//     本机比服务端新（或服务端还没有）→ 推上去。
//   · 页面改了设置后调 myhiPrefsPush()（防抖 800ms）推上去。
(function () {
  const LS = { theme: 'myhi_theme', font: 'myhi_font', chat: 'myhi_chat_settings' };
  const AT = 'myhi_prefs_at';   // 本机这份偏好对应的服务端时间戳
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
  const dirty = () => get(AT + '_dirty') === '1';

  function snapshot() {
    let chat = null;
    try { chat = JSON.parse(get(LS.chat) || 'null'); } catch {}
    return { theme: get(LS.theme), font: get(LS.font), chat };
  }

  let timer = null;
  window.myhiPrefsPush = function () {
    set(AT + '_dirty', '1');   // 先记「本机有未推送的改动」，推失败/页面关了下次打开再推
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const r = await fetch('/api/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot()) });
        const d = await r.json();
        if (d.ok) { set(AT, String(d.updatedAt)); set(AT + '_dirty', null); }
      } catch {}
    }, 800);
  };

  fetch('/api/prefs').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d?.ok) return;
    const p = d.prefs;
    const localAt = Number(get(AT) || 0);
    if (!p || dirty() || (p.updatedAt || 0) <= localAt) {
      // 服务端没有 / 本机有没推的改动 / 本机已是最新：本机为准（有值才推，空白新设备不推空值覆盖）
      if ((!p || dirty()) && (get(LS.theme) || get(LS.font) || get(LS.chat))) window.myhiPrefsPush();
      return;
    }
    const before = JSON.stringify(snapshot());
    if (p.theme !== undefined) set(LS.theme, p.theme);
    if (p.font !== undefined) set(LS.font, p.font);
    if (p.chat !== undefined) set(LS.chat, p.chat == null ? null : JSON.stringify(p.chat));
    set(AT, String(p.updatedAt));
    if (JSON.stringify(snapshot()) !== before) {
      try { if (sessionStorage.getItem('myhi_prefs_reloaded')) return; sessionStorage.setItem('myhi_prefs_reloaded', '1'); } catch {}
      location.reload();
    }
  }).catch(() => {});
})();
