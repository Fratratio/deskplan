/* ============================================================
   统一数据层（主进程专用）
   ------------------------------------------------------------
   一份 JSON 承载两个界面的全部数据：
     root.settings  悬浮窗的各项偏好
     root.notes     悬浮窗的便签（items / archived）
     root.plan      周计划页的完整状态（items / todos / settings / cursor…）
     root.shared    两边共用的主题与字体（避免各存一份打架）
     root.ui        窗口位置等界面状态

   两端各拿到"自己那一格"的视图，写回来时再合进同一份 root，
   所以悬浮窗和计划页天然共享同一份数据源。
   ============================================================ */
'use strict';

const SCHEMA_V = 3;

function defaultRoot() {
  return {
    v: SCHEMA_V,
    createdAt: Date.now(),
    updatedAt: 0,

    settings: {
      skin: 'rice', edge: 'right', lock: false, pin: true, stealth: true,
      idle: 35, blur: 44, alpha: 80, grain: 35,
      archiveAfter: 10, draftColor: 'ou', bootLaunch: false,
      motion: true, x: null, y: null, font: 'sans',
      dockTab: 'today',        // 侧边栏默认停在哪个标签：notes | today
      autoDock: true,          // 周计划窗口失焦 3 秒后自动收起成悬浮条
    },

    /* 悬浮窗：便签 */
    notes: { items: [], archived: [] },

    /* 周计划页：与 weekplan.v1 的 localStorage 结构一一对应 */
    plan: {
      version: 1,
      items: [],
      todos: [],
      settings: {
        startHour: 6, endHour: 24, hourH: 44, skin: 'rice', font: 'kai',
        sideCollapsed: false,   // 右侧「待办 + 时间统计」面板折叠
        showEarly: false,       // 00:00 起点的早间时段是否展开（默认折叠成细线）
        snapMin: 15,            // 拖拽 / 点空格新建的时间吸附粒度（分钟）
      },
      cursor: null,
      selDay: null,
      filterTags: [],
    },

    /* 两边共用的外观，canonical：skin=rice|mist|sakura|dusk|nebula|forge，font=default|kai|xing|li|fang */
    shared: { skin: 'rice', font: 'kai', motion: true },

    ui: { planBounds: null },
    migratedFrom: null,
  };
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* ---------- 外观：把两边的叫法归一到 canonical ---------- */
/* 皮肤：外观的唯一维度。每套自带完整底色/文字/五色，不另设明暗开关
   （原来的 theme=light|dusk 已经变成 rice|dusk 两套皮肤）。 */
const SKINS = [
  { id: 'rice',   label: '宣纸', hint: '素白宣底，五色矿物字' },
  { id: 'mist',   label: '青山', hint: '风景。青绿山岚，石青配苔绿' },
  { id: 'sakura', label: '樱SA', hint: '动漫。樱粉淡紫，藕荷配朱砂' },
  { id: 'dusk',   label: '暮色', hint: '深蓝夜色，五色提亮一档' },
  { id: 'nebula', label: '星野', hint: '航天。深空紫蓝，星点铺底' },
  { id: 'forge',  label: '熔炉', hint: '游戏。暗铜炭底，火色高亮' },
];
const SKIN_IDS = SKINS.map(s => s.id);
function canonSkin(s) {
  if (s === 'light') return 'rice';      // 历史值
  return SKIN_IDS.indexOf(s) >= 0 ? s : 'rice';
}
/* 旧接口保留：theme 现在等价于 skin 的深浅，不再是独立开关 */
function canonTheme(t) { return canonSkin(t) === 'dusk' ? 'dusk' : 'light'; }

/* canonical 字体：kai 楷体 / xing 行楷 / li 隶书 / fang 仿宋，其余一律 default（黑体）
   历史值 'jin'（瘦金体）本机与多数机器都没有，统一迁移到 xing 行楷 */
const FONT_KEYS = ['kai', 'xing', 'li', 'fang'];
function canonFont(f) {
  if (f === 'jin') return 'xing';
  return FONT_KEYS.indexOf(f) >= 0 ? f : 'default';
}
/* canonical 字体 → 某一端的本地叫法（悬浮窗用 sans，计划页用 default） */
function fontFor(f, fallback) { return f === 'default' ? fallback : canonFont(f); }

function deriveSharedFrom(settings) {
  if (!isObj(settings)) return null;
  return { skin: canonSkin(settings.skin), font: canonFont(settings.font) };
}

/* 把 canonical 外观写回某一端的习惯叫法 */
function applySharedTo(target, shared) {
  if (!shared) return target;
  if (shared.skin) target.skin = canonSkin(shared.skin);
  return target;
}

/* ---------- 归一化：缺字段补默认，坏字段丢掉 ---------- */
function normalize(raw) {
  const d = defaultRoot();
  if (!isObj(raw)) return d;

  const r = Object.assign({}, d, raw);
  r.v = SCHEMA_V;

  /* 旧版 deskmemo：items / archived 平铺在根节点上 */
  if (!isObj(r.notes) && Array.isArray(r.items)) {
    r.notes = { items: r.items, archived: Array.isArray(r.archived) ? r.archived : [] };
    delete r.items; delete r.archived;
    r.migratedFrom = r.migratedFrom || 'deskmemo.memo.json';
  }

  r.settings = Object.assign({}, d.settings, isObj(r.settings) ? r.settings : {});
  r.notes = Object.assign({}, d.notes, isObj(r.notes) ? r.notes : {});
  r.notes.items = Array.isArray(r.notes.items) ? r.notes.items : [];
  r.notes.archived = Array.isArray(r.notes.archived) ? r.notes.archived : [];

  const p = Object.assign({}, d.plan, isObj(r.plan) ? r.plan : {});
  p.items = Array.isArray(p.items) ? p.items : [];
  p.todos = Array.isArray(p.todos) ? p.todos : [];
  p.settings = Object.assign({}, d.plan.settings, isObj(p.settings) ? p.settings : {});
  p.filterTags = Array.isArray(p.filterTags) ? p.filterTags : [];
  r.plan = p;

  r.shared = Object.assign({}, d.shared, isObj(r.shared) ? r.shared : {});
  /* 历史数据里皮肤记在 shared.theme（rice/light/dusk），这里迁移到 shared.skin */
  if (r.shared.skin === undefined || SKIN_IDS.indexOf(r.shared.skin) < 0) {
    r.shared.skin = canonSkin(r.shared.theme);
  }
  delete r.shared.theme;
  r.shared.font = canonFont(r.shared.font);
  r.ui = Object.assign({}, d.ui, isObj(r.ui) ? r.ui : {});

  return r;
}

/* ---------- 落地文件读写 ---------- */
function read(file) {
  let raw = null;
  try { raw = JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch (e) { raw = null; }
  return normalize(raw);
}

function write(file, root) {
  try {
    const fs = require('fs');
    const dir = require('path').dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    root.updatedAt = Date.now();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}

/* ---------- 给悬浮窗的视图（沿用原 deskmemo 的 items/archived/settings 结构） ---------- */
function widgetView(root) {
  const v = {
    v: root.v,
    settings: Object.assign({}, root.settings),
    items: root.notes.items,
    archived: root.notes.archived,
  };
  // canonical → 悬浮窗叫法（skin 直接同名，sans / kai / xing / li / fang）
  v.settings.skin = canonSkin(root.shared.skin);
  delete v.settings.theme;
  v.settings.font = fontFor(root.shared.font, 'sans');
  return v;
}

/* 悬浮窗写回来的内容 → 合进 root */
function mergeWidget(root, payload) {
  if (!isObj(payload)) return;
  if (isObj(payload.settings)) {
    Object.assign(root.settings, payload.settings);
    const s = deriveSharedFrom(payload.settings);
    if (s) Object.assign(root.shared, s);
  }
  if (Array.isArray(payload.items)) root.notes.items = payload.items;
  if (Array.isArray(payload.archived)) root.notes.archived = payload.archived;
}

/* ---------- 给计划页的视图（就是 weekplan.v1 的整份 state） ---------- */
function planView(root) {
  const p = JSON.parse(JSON.stringify(root.plan));
  p.settings = p.settings || {};
  p.settings.skin = canonSkin(root.shared.skin);
  delete p.settings.theme;
  p.settings.font = fontFor(root.shared.font, 'default');
  return p;
}

function mergePlan(root, payload) {
  if (!isObj(payload)) return;
  const p = Object.assign({ version: 1 }, root.plan, payload);
  p.items = Array.isArray(payload.items) ? payload.items : [];
  p.todos = Array.isArray(payload.todos) ? payload.todos : [];
  p.settings = Object.assign({}, root.plan.settings, isObj(payload.settings) ? payload.settings : {});
  if (!Array.isArray(p.filterTags)) p.filterTags = [];
  root.plan = p;
  const s = deriveSharedFrom(p.settings);
  if (s) Object.assign(root.shared, s);
}

/* ============================================================
   侧边栏「今日」页
   ------------------------------------------------------------
   悬浮条与周计划页共用同一份 root.plan，这里给出只读视图和一组
   原子改动，主进程改完后统一落盘、再通知另一端刷新。
   ============================================================ */
const DAY_MIN = 24 * 60;

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function parseTags(raw) {
  const out = [];
  String(raw || '').split(/[\s,，、#]+/).forEach(t => { t = t.trim(); if (t && !out.includes(t)) out.push(t); });
  return out.slice(0, 4);
}

function todayView(root, todayStr) {
  const p = root.plan || {};
  const items = (p.items || [])
    .filter(i => i.date === todayStr)
    .slice()
    .sort((a, b) => (a.startMin || 0) - (b.startMin || 0))
    .map(i => ({
      id: i.id, title: i.title || '', note: i.note || '',
      startMin: i.startMin || 0, dur: i.dur || 60,
      tags: Array.isArray(i.tags) ? i.tags : [],
      color: i.color || 'dai', done: !!i.done,
    }));
  const todos = (p.todos || [])
    .filter(t => !t.done)
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(t => ({
      id: t.id, title: t.title || '',
      tags: Array.isArray(t.tags) ? t.tags : [],
      color: t.color || 'dai',
    }));
  const doneCount = (p.todos || []).filter(t => t.done).length;
  return {
    todayStr,
    items,
    todos,
    doneCount,
    pending: items.filter(i => !i.done).length + todos.length,
    minutes: items.reduce((s, i) => s + (i.dur || 0), 0),
  };
}

/* 今天从 fromMin 起第一个放得下 dur 的整半点空位 */
function nextFreeSlot(root, todayStr, dur, fromMin) {
  const used = (root.plan.items || [])
    .filter(i => i.date === todayStr)
    .map(i => [i.startMin || 0, (i.startMin || 0) + (i.dur || 60)])
    .sort((a, b) => a[0] - b[0]);
  const start = Math.max(0, Math.min(DAY_MIN - dur, Math.round((fromMin == null ? 9 * 60 : fromMin) / 30) * 30));
  for (let s = start; s + dur <= DAY_MIN; s += 30) {
    if (!used.some(([a, b]) => s < b && s + dur > a)) return s;
  }
  return null;
}

/* 一组原子改动，改完直接返回新的今日视图 */
function todayAct(root, act, todayStr) {
  const p = root.plan;
  const kind = String(act && act.kind || '');
  const todos = p.todos || (p.todos = []);
  const items = p.items || (p.items = []);

  if (kind === 'todo:add') {
    const title = String(act.title || '').trim();
    if (!title) return null;
    const tags = parseTags((title.match(/#([^\s#]+)/g) || []).join(' '));
    const clean = title.replace(/#([^\s#]+)/g, '').replace(/\s+/g, ' ').trim() || title;
    todos.push({ id: uid(), title: clean, note: '', tags, color: act.color || 'dai', done: false, createdAt: Date.now() });
  } else if (kind === 'todo:toggle') {
    const t = todos.find(x => x.id === act.id); if (!t) return null;
    t.done = !t.done;
  } else if (kind === 'todo:del') {
    const i = todos.findIndex(x => x.id === act.id); if (i < 0) return null;
    todos.splice(i, 1);
  } else if (kind === 'todo:schedule') {
    const i = todos.findIndex(x => x.id === act.id); if (i < 0) return null;
    const [t] = todos.splice(i, 1);
    const dur = Number(act.dur) || 60;
    const start = Number.isFinite(act.startMin) ? act.startMin : nextFreeSlot(root, todayStr, dur, nowRounded());
    if (start == null) { todos.splice(i, 0, t); return null; }
    items.push({
      id: uid(), title: t.title || '待办', note: t.note || '', date: todayStr,
      startMin: start, dur, tags: t.tags || [], color: t.color || 'dai',
      done: false, createdAt: Date.now(),
    });
  } else if (kind === 'item:add') {
    const title = String(act.title || '').trim();
    if (!title) return null;
    const dur = Number(act.dur) || 60;
    const start = Number.isFinite(act.startMin) ? act.startMin : nextFreeSlot(root, todayStr, dur, nowRounded());
    if (start == null) return null;
    items.push({
      id: uid(), title, note: '', date: todayStr, startMin: start, dur,
      tags: parseTags(act.tags || []), color: act.color || 'dai', done: false, createdAt: Date.now(),
    });
  } else if (kind === 'item:toggle') {
    const it = items.find(x => x.id === act.id); if (!it) return null;
    it.done = !it.done;
  } else if (kind === 'item:del') {
    const i = items.findIndex(x => x.id === act.id); if (i < 0) return null;
    items.splice(i, 1);
  } else {
    return null;
  }
  return todayView(root, todayStr);
}

function nowRounded() {
  const d = new Date();
  return Math.ceil((d.getHours() * 60 + d.getMinutes()) / 30) * 30;
}

/* ---------- 悬浮窗底部那条"今日安排"摘要 ---------- */
function planSummary(root, todayStr) {
  const items = (root.plan && Array.isArray(root.plan.items)) ? root.plan.items : [];
  const today = items.filter(i => i.date === todayStr && !i.done)
    .sort((a, b) => (a.startMin || 0) - (b.startMin || 0));
  const todos = (root.plan && Array.isArray(root.plan.todos))
    ? root.plan.todos.filter(t => !t.done).length : 0;
  return { todayCount: today.length, next: today[0] ? today[0].title : '', todoCount: todos };
}

module.exports = {
  SCHEMA_V, defaultRoot, normalize, read, write,
  widgetView, mergeWidget, planView, mergePlan,
  planSummary, canonSkin, canonFont, SKINS, SKIN_IDS, applySharedTo, deriveSharedFrom,
  todayView, todayAct, nextFreeSlot,
};
