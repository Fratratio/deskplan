/* ============================================================
   motion.js — 过渡动效引擎（零依赖，可一键关闭）
   思路来自两类开源方案：
   1) FormKit auto-animate 的 FLIP 做法：先量旧位置 → 改 DOM → 量新位置
      → 用 transform 反向补偿再播放，元素"从旧位置滑到新位置"
   2) Chrome View Transitions API：整块内容切换时由浏览器截图做交叉淡入，
      而不是把 DOM 瞬间换掉
   两者都只动 transform / opacity，不触发重排，且都可降级为瞬时切换。
   ============================================================ */
window.MOTION = (function () {
  'use strict';

  const DUR = {
    flip: 240,      // 列表位移/新增
    ghost: 200,     // 被移除条目的淡出
    panelIn: 190,   // 浮层进场
    panelOut: 150,  // 浮层退场
    stagger: 14,    // 逐条错开
  };
  const EASE_OUT = 'cubic-bezier(.22,.68,.28,1)';   // 快启动、慢收尾
  const EASE_SOFT = 'cubic-bezier(.32,.72,0,1)';
  const MAX_STAGGER = 70;

  // 三态：undefined = 跟随系统（尊重"减少动态效果"）；true = 用户明确要动效；
  // false = 用户明确关掉。系统默认关动画时，用户仍可在应用里强制打开。
  let userPref = undefined;

  const reduced = () =>
    !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function isEnabled() { return userPref === undefined ? !reduced() : !!userPref; }

  // 只有完整态才做动画：贴边收缩/预览态下合成开销不划算，也看不清
  function ok() {
    return isEnabled() && !document.hidden &&
           (document.body.dataset.mode || 'full') === 'full';
  }

  function setPref(v) { userPref = (v === undefined || v === null) ? undefined : !!v; }
  function setEnabled(v) { setPref(v); }

  /* ---------- FLIP：列表增删 / 完成移动 / 拖拽重排 ---------- */
  function flip(containers, mutate) {
    if (typeof mutate !== 'function') return;
    if (!ok()) { mutate(); return; }

    const list = (containers || []).filter(Boolean);
    const first = new Map();               // data-id -> { rect, node }
    try {
      list.forEach(c => c.querySelectorAll('[data-id]').forEach(n => {
        const r = n.getBoundingClientRect();
        if (r.height > 0) first.set(n.dataset.id, { r, n });
      }));
    } catch (e) { mutate(); return; }

    mutate();                              // 数据照旧立刻落盘，动画只是视觉层

    const jobs = [];
    try {
      list.forEach(c => c.querySelectorAll('[data-id]').forEach(n => {
        const before = first.get(n.dataset.id);
        const after = n.getBoundingClientRect();
        if (!before) { jobs.push({ n, kind: 'in' }); return; }
        first.delete(n.dataset.id);
        const dx = before.r.left - after.left;
        const dy = before.r.top - after.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) jobs.push({ n, kind: 'move', dx, dy });
      }));
    } catch (e) { return; }

    // 关键顺序：必须等上面匹配完，仍然留在 first 里的才是"真的被移除"的条目，
    // 这时才克隆成残影淡出（不阻塞数据写入，删除/完成依旧即时生效）
    first.forEach(({ r, n }) => ghost(n, r));

    jobs.forEach((j, i) => {
      const delay = Math.min(i * DUR.stagger, MAX_STAGGER);
      try {
        if (j.kind === 'in') {
          j.n.animate(
            [{ opacity: 0, transform: 'translateY(-6px) scale(.985)' },
             { opacity: 1, transform: 'none' }],
            { duration: DUR.flip, delay, easing: EASE_OUT, fill: 'backwards' });
        } else {
          j.n.animate(
            [{ transform: `translate(${j.dx}px, ${j.dy}px)` },
             { transform: 'none' }],
            { duration: DUR.flip, delay, easing: EASE_SOFT });
        }
      } catch (e) { /* 单个元素动画失败不影响其余 */ }
    });
  }

  function ghost(node, rect) {
    if (!node || !rect) return;
    try {
      const g = node.cloneNode(true);
      const cs = getComputedStyle(node);
      g.classList.add('motion-ghost');
      g.removeAttribute('draggable');
      Object.assign(g.style, {
        position: 'fixed',
        left: rect.left + 'px',
        top: rect.top + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
        margin: '0',
        zIndex: '9',
        borderRadius: cs.borderRadius,
        background: cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? '' : cs.backgroundColor,
      });
      document.body.appendChild(g);
      const kill = () => { try { g.remove(); } catch (e) {} };
      const a = g.animate(
        [{ opacity: 0.85, transform: 'none' },
         { opacity: 0, transform: 'translateX(12px) scale(.97)' }],
        { duration: DUR.ghost, easing: EASE_OUT });
      a.onfinish = kill;
      a.oncancel = kill;
      setTimeout(kill, 1000);              // 兜底清理，绝不残留
    } catch (e) { /* 残影失败无所谓，主流程不受影响 */ }
  }

  /* ---------- View Transitions：整块内容切换 ---------- */
  function vt(update) {
    if (typeof update !== 'function') return;
    const safe = () => { try { update(); } catch (e) { console.error(e); } };
    if (!ok() || typeof document.startViewTransition !== 'function') { safe(); return; }
    try {
      const t = document.startViewTransition(safe);
      if (t && t.finished && typeof t.finished.catch === 'function') t.finished.catch(() => {});
    } catch (e) { safe(); }
  }

  /* ---------- 浮层：进出场对称 ---------- */
  function show(node) {
    if (!node) return;
    node.hidden = false;
    node.dataset.closing = '';
    if (!ok()) return;
    try {
      node.animate(
        [{ opacity: 0, transform: 'translateY(-6px) scale(.985)' },
         { opacity: 1, transform: 'none' }],
        { duration: DUR.panelIn, easing: EASE_OUT });
    } catch (e) {}
  }

  function hide(node) {
    if (!node || node.hidden) return;
    if (!ok()) { node.hidden = true; node.dataset.closing = ''; return; }
    node.dataset.closing = '1';            // 退场动画期间对外算"已关闭"
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      node.hidden = true;
      node.dataset.closing = '';
    };
    try {
      const a = node.animate(
        [{ opacity: 1, transform: 'none' },
         { opacity: 0, transform: 'translateY(-4px) scale(.99)' }],
        { duration: DUR.panelOut, easing: EASE_OUT });
      a.onfinish = finish;
      a.oncancel = finish;
      setTimeout(finish, DUR.panelOut + 150);   // 兜底
    } catch (e) { finish(); }
  }

  // 动画期间"是否算打开"，供外部点击判定使用
  function isOpen(node) { return !!node && !node.hidden && node.dataset.closing !== '1'; }
  function toggle(node) { if (isOpen(node)) hide(node); else show(node); }

  return { flip, vt, show, hide, toggle, isOpen, setPref, setEnabled, isEnabled, DUR, reduced };
})();
