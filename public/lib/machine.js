// 机器标识：多台电脑都跑 myhi 时，浏览器标签全叫「myhi」分不清。
// 拉 /api/machine-name（只是 myhi 的显示名，不动电脑主机名）→
// ① 首页 / 分屏 / 管理页：标题里的「myhi」换成「机器名」并放最前（标签被挤窄时先露出来的是机器名）；
//    会话页（<script data-session>）：标题只留任务名，机器靠标签图标区分；
// ② 标签图标换成按机器名哈希配色 + 首字的圆角方块，一眼认出是哪台。
// 页面后续自己改 document.title（如「会话名 — myhi」）也会被 MutationObserver 接住重写。
(function () {
  const sessionPage = document.currentScript?.hasAttribute('data-session');
  let name = '';
  try { name = localStorage.getItem('myhi_machine_name') || ''; } catch {}   // 先用缓存，避免标题闪一下 myhi

  function fmt(t) {
    if (sessionPage) {
      // 会话页设的标题是「任务名 — myhi」，只留任务名（任务名本身叫 myhi 也照样显示 myhi）；
      // 还没加载出任务时是页面自带的「myhi 会话」，先显示机器名
      const m = t.match(/^(.*?)\s*—\s*myhi$/);
      if (m && m[1].trim()) return m[1].trim();
      return /^myhi (会话|终端)$/.test(t) ? (name || 'myhi') : t;   // 只认页面自带的占位标题，改写后的结果再进来保持不动
    }
    if (!name || t.startsWith(name + ' · ')) return t;
    const rest = t.replace(/\s*—\s*myhi$/, '').replace(/^myhi\s*/, '').trim();
    return rest ? `${name} · ${rest}` : `${name} · myhi`;
  }
  let busy = false;
  function applyTitle() {
    if (busy) return;
    const t = fmt(document.title);
    if (t !== document.title) { busy = true; document.title = t; busy = false; }
  }

  function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; }
  function applyIcon() {
    if (!name) return;
    const ch = [...name][0].toUpperCase().replace(/[<&>"]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${hue(name)},62%,46%)"/>` +
      `<text x="32" y="45" font-size="38" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${ch}</text></svg>`;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.type = 'image/svg+xml';
    link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function apply() { applyTitle(); applyIcon(); }
  window.myhiSetMachineName = function (n) {
    const old = name;
    name = n || '';
    try { localStorage.setItem('myhi_machine_name', name); } catch {}
    // 已按旧名字改写过的标题，先剥掉旧前缀再按新名字重写
    if (old && document.title.startsWith(old + ' · ')) { busy = true; document.title = document.title.slice(old.length + 3); busy = false; }
    apply();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply); else apply();
  const titleEl = document.querySelector('title');
  if (titleEl) new MutationObserver(applyTitle).observe(titleEl, { childList: true, characterData: true, subtree: true });

  fetch('/api/machine-name').then(r => r.ok ? r.json() : null).then(d => {
    if (d && d.name && d.name !== name) window.myhiSetMachineName(d.name);
  }).catch(() => {});
})();
