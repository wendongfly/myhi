// 任务「要不要你看一眼」的判定，首页卡片 / 会话页切换面板 / 其他任务提醒共用。
//   wait：AI 在等你回答提问 / 审批方案（最优先）
//   busy：正在执行
//   done：你上次看过之后又有了新动静（本设备未读）
// 「看过」记在本机 localStorage（myhi_seen：{会话id: 毫秒}），不跨设备同步——手机上看过不代表电脑上看过。
(function () {
  const KEY = 'myhi_seen';
  let seen = null, raw = null;
  // 每次都看一眼 localStorage：工作台里「看过」是右侧会话页（iframe）写的，左侧列表若只在加载时读一次，
  // 就一直拿旧值 → 正开着的任务也显示「新完成」。内容没变就不重新 parse
  function load() {
    let r = null; try { r = localStorage.getItem(KEY); } catch {}
    if (r !== raw) { raw = r; try { seen = JSON.parse(r || 'null'); } catch { seen = null; } }
    return seen;
  }
  function save() { try { raw = JSON.stringify(seen); localStorage.setItem(KEY, raw); } catch {} }
  const ts = (s) => {
    const v = s.lastActivityAt || 0;
    return typeof v === 'number' ? v : (new Date(v).getTime() || 0);
  };

  window.myhiAttn = {
    // 首次使用（本机还没有记录）：把现有任务全当已读，免得一上来满屏未读
    init(list) {
      if (load() || !(list && list.length)) return;
      seen = {};
      for (const s of list || []) seen[s.id] = Date.now();
      save();
    },
    markSeen(id) {
      load(); if (!seen) seen = {};
      seen[id] = Date.now();
      // 顺手清掉早已不存在的老记录（只留最近 200 个）
      const ids = Object.keys(seen);
      if (ids.length > 200) ids.sort((a, b) => seen[a] - seen[b]).slice(0, ids.length - 200).forEach((k) => delete seen[k]);
      save();
    },
    of(s) {
      if (s.pending > 0) return 'wait';
      if (s.busy) return 'busy';
      const t = ts(s); const v = (load() || {})[s.id];
      return v != null && t > v + 1000 ? 'done' : '';
    },
    rank(a) { return { wait: 0, busy: 1, done: 2 }[a] ?? 3; },
    label: { wait: '等你回复', busy: '执行中', done: '新完成' },
    color: { wait: 'var(--orange, #db6d28)', busy: 'var(--blue, #2f81f7)', done: 'var(--green, #3fb950)' },
  };
})();
