// 图标的 SVG path 取自 Feather Icons（MIT License, Copyright (c) 2013-2017 Cole Bemis, https://feathericons.com），见 THIRD_PARTY_NOTICES.md
// ---------------------------------------------------------------------------
// 全站图标统一：按钮 / 菜单 / 快捷栏 / 列表图标位上开头的 emoji → 单色线条 SVG（跟随文字颜色）
//   以前各处混着彩色 emoji（📥 🩺 📊）、单色字符（⚙ ▦ ✕）和彩色箭头，风格不一。
//   做法：页面加载后、以及之后按钮 / 菜单重新渲染时，自动把「标签开头的 emoji」换成同一套线条图标；
//   没有对应图标的 emoji 原样保留（不会坏）。
//   不动的地方：聊天消息 / AI 回复 / 状态提示（#chat-area 里）、输入框、终端 —— 那些是内容，不是图标。
//   新加按钮照常写「📥 草稿」即可，会自动换；不想被换的元素加 data-no-ico。
// ---------------------------------------------------------------------------
(function () {
  const P = {
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    pack: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M11.4 11.6 21 2"/><path d="m16 7 3 3"/><path d="m18.5 4.5 2 2"/>',
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M21 5h-4"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    folderOpen: '<path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    checkSquare: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    bot: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><line x1="9" y1="13" x2="9" y2="15"/><line x1="15" y1="13" x2="15" y2="15"/>',
    pointer: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"/><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    fileEdit: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
    undo: '<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
    chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"/>',
    tag: '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    memory: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    blocks: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 17.5h7M17.5 14v7"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    skip: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6M22 6l-3-3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    diamond: '<path d="M12 2 22 12 12 22 2 12z"/><path d="M12 7l5 5-5 5-5-5z"/>',
    type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
    globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    plusSquare: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    clip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    pin: '<line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24z"/>',
    back: '<polyline points="15 18 9 12 15 6"/>',
    mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>',
    home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    broom: '<path d="M19.36 2.72 20.78 4.14"/><path d="m15 7 5.36-4.28"/><path d="M14 8 4 18l2 2 10-10"/><path d="M14 8l2 2"/>',
  };
  // emoji → 图标名（没列的 emoji 原样保留）
  const MAP = {
    '📥': 'inbox', '⬆': 'upload', '⬇': 'download', '🔄': 'refresh', '↻': 'refresh', '🔁': 'refresh', '📦': 'pack', '🔑': 'key', '🗝': 'key',
    '✨': 'sparkles', '⚠': 'alert', '⚡': 'zap', '🛡': 'shield', '📋': 'clipboard', '📘': 'book', '📖': 'book', '📚': 'book',
    '✏': 'pencil', '✍': 'pencil', '📝': 'fileEdit', '📂': 'folderOpen', '📁': 'folder', '🗂': 'folder', '👥': 'users', '👤': 'user',
    '✅': 'checkCircle', '✓': 'check', '✔': 'check', '☑': 'checkSquare', '💡': 'bulb', '↗': 'external', '🔍': 'search', '🔎': 'search',
    '⚙': 'settings', '👁': 'eye', '💬': 'message', '🤖': 'bot', '👉': 'pointer', '🩺': 'activity', '⏳': 'hourglass', '⌛': 'hourglass',
    '🔒': 'lock', '🔐': 'lock', '❓': 'help', '❔': 'help', '🛒': 'cart', '📄': 'file', '📃': 'file', '🔔': 'bell', '📱': 'phone',
    '↩': 'undo', '📊': 'chart', '📈': 'chart', '🛠': 'wrench', '🔧': 'wrench', '🏷': 'tag', '🗑': 'trash', '🧠': 'memory',
    '🧩': 'blocks', '⏸': 'pause', '🔗': 'link', '💾': 'save', '📨': 'send', '📤': 'share', '⏭': 'skip', '☰': 'menu', '⏰': 'alarm',
    '🖼': 'image', '▦': 'grid', '◈': 'diamond', '🔤': 'type', '🕘': 'clock', '🕐': 'clock', '🌐': 'globe', '🆕': 'plusSquare',
    '📷': 'camera', '📸': 'camera', '📎': 'clip', '✕': 'close', '✖': 'close', '📌': 'pin', '←': 'back', '🎤': 'mic', '🎙': 'mic',
    '🏠': 'home', '▶': 'play', '⏹': 'stop', '🚀': 'rocket', '💻': 'terminal', '⌨': 'terminal', '📑': 'copy', '⭐': 'star', '🧹': 'broom', '🐚': 'terminal', '🧰': 'wrench', '🧪': 'activity', '🔥': 'zap', '📭': 'inbox', '🗄': 'save',
  };
  const NS = 'http://www.w3.org/2000/svg';
  // 图标位：按钮、设置条目、快捷栏、菜单项、列表图标格
  const CAND = 'button, .set-link, .sk, .hd-btn, .mi, .m-ico, .fp-icon, .fp-btn, .ii-icon, .chip-icon, .rb, [data-ico], #ai-banner b, .set-mode, #guide-tip > span:first-child, .ask-head b, .mig-row > span:first-child, #mig-box h3, .action-sheet-title';
  // 内容区不动：聊天消息 / AI 回复 / 状态行、可编辑区、终端、明确不要的
  const SKIP = '#chat-area, .msg, .content, .bubble, textarea, input, [contenteditable], .xterm, [data-no-ico], #plan-sheet-body, #plan-digest, .ask-a';
  const LEAD = /^\s*((?:[←-⇿⌀-⏿■-➿⬀-⯿]|[\uD83C-\uDBFF][\uDC00-\uDFFF])️?)\s?/;

  function svgFor(name) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'ui-ico');
    s.innerHTML = P[name];
    return s;
  }
  // 找元素里第一个有字的文本节点（遇到已换好的图标就停）
  function firstText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { if (n.data.trim()) return n; continue; }
      if (n.nodeType !== 1) continue;
      if (n.classList?.contains('ui-ico') || n.tagName === 'svg' || n.tagName === 'IMG') return null;
      const t = firstText(n); if (t !== undefined) return t;
    }
    return undefined;
  }
  function convert(el) {
    if (!el || el.nodeType !== 1 || el.closest(SKIP)) return;
    const t = firstText(el);
    if (!t) return;
    const m = LEAD.exec(t.data);
    if (!m) return;
    const name = MAP[m[1].replace('️', '')];
    if (!name || !P[name]) return;
    const svg = svgFor(name);
    const rest = t.data.slice(m[0].length);
    t.parentNode.insertBefore(svg, t);
    t.data = rest;
    if (!rest.trim() && !t.nextSibling) svg.classList.add('solo');   // 只有图标的按钮（✕ ☰ 等）：不留右边距
  }
  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches?.(CAND)) convert(root);
    root.querySelectorAll?.(CAND).forEach(convert);
  }
  // 之后重新渲染的按钮 / 菜单（改文字、弹出菜单、抽屉列表）也换；聊天区的变动直接忽略（量大，且不是图标）
  let queue = new Set(), raf = 0;
  const flush = () => { raf = 0; const q = queue; queue = new Set(); q.forEach(scan); };
  function enqueue(n) {
    const el = n.nodeType === 1 ? n : n.parentElement;
    if (!el || el.closest('#chat-area')) return;
    const c = el.closest(CAND);
    queue.add(c || el);
    if (!raf) raf = requestAnimationFrame(flush);
  }
  function start() {
    const css = document.createElement('style');
    css.textContent = '.ui-ico{width:1.05em;height:1.05em;vertical-align:-0.17em;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;margin-right:0.32em}.ui-ico.solo{margin-right:0}';
    document.head.appendChild(css);
    scan(document.body);
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === 'characterData') enqueue(m.target);
        else m.addedNodes.forEach(enqueue);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  window.myhiIcon = (name) => (P[name] ? svgFor(name).outerHTML : '');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
