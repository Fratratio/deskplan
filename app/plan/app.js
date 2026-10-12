/* 周计划备忘录 · 纯本地（localStorage），无依赖、无联网、无付费 */
'use strict';

const KEY = 'weekplan.v1';
/* 矿物色：不在这里写死。每套皮肤在 app/shared/skins.css 里定义自己的
   --dai/--tai/--ou/--tong/--zhu，这里运行时从 CSS 变量读出来，
   切皮肤时卡片和标签色自动跟着变（原来写死成宣纸那组，切了皮肤颜色不动）。 */
let COLORS = { dai: '#33587C', tai: '#467A4E', ou: '#6D4C85', tong: '#8F6432', zhu: '#953F37' };
const CKEYS = Object.keys(COLORS);
const DARK_SKINS = new Set(['dusk', 'nebula', 'forge']);
function refreshColors() {
  const cs = getComputedStyle(document.documentElement);
  CKEYS.forEach(k => {
    const v = cs.getPropertyValue('--' + k).trim();
    if (v && /^#[0-9a-f]{3,8}$/i.test(v)) COLORS[k] = v;
  });
}
/* 皮肤清单：与 store-schema.js 的 SKINS 保持一致（计划页走 localStorage，不引主进程模块）。
   sw = 该皮肤的预览色板三支代表色，取自 skins.css 里的五色。
   注意这份是副本：改皮肤要同时改 store-schema.js 和 widget/renderer.js。 */
const SKINS = [
  { id: 'rice',   label: '宣纸', hint: '素白宣底，五色矿物字', sw: ['#467A4E', '#33587C', '#6D4C85'] },
  { id: 'mist',   label: '青山', hint: '风景。青绿山岚，石青配苔绿', sw: ['#3F7A4A', '#2C5F6B', '#5D6B86'] },
  { id: 'sakura', label: '樱SA', hint: '动漫。樱粉淡紫，藕荷配朱砂', sw: ['#5E8C55', '#8E5A9E', '#B24A5C'] },
  { id: 'dusk',   label: '暮色', hint: '深蓝夜色，五色提亮一档', sw: ['#8FAD83', '#86A8C6', '#C79CB8'] },
  { id: 'nebula', label: '星野', hint: '航天。深空紫蓝，星点铺底', sw: ['#6FD6A8', '#7FB4E8', '#B79BF0'] },
  { id: 'forge',  label: '熔炉', hint: '游戏。暗铜炭底，火色高亮', sw: ['#8FBF6A', '#7FA0C4', '#E0A44E'] },
];
const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const NARROW = window.matchMedia('(max-width: 780px)');

/* ---------------- 日期工具 ---------------- */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const startOfWeek = d => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const dowIndex = d => (d.getDay() + 6) % 7;
const fmtMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rgba = (hex, a) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const hashColor = str => { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CKEYS[h % CKEYS.length]; };
const tagColor = t => COLORS[hashColor(t)];
const parseTags = raw => {
  const out = [];
  String(raw || '').split(/[\s,，、#]+/).forEach(t => { t = t.trim(); if (t && !out.includes(t)) out.push(t); });
  return out.slice(0, 4);
};
function weekNumber(d) { // ISO 周序号
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 4 - ((t.getDay() + 6) % 7));
  const y0 = new Date(t.getFullYear(), 0, 1);
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

/* ---------------- 状态 ---------------- */
const DEFAULT = {
  version: 1,
  items: [],
  todos: [],
  settings: {
    startHour: 6, endHour: 24, hourH: 44, skin: 'rice', font: 'kai',
    sideCollapsed: false,   // 右侧「待办 + 时间统计」面板收起
    showEarly: false,       // 00:00 起的早间时段展开（默认折叠成一条细线）
    snapMin: 15,            // 拖拽 / 点空格新建的时间吸附粒度（分钟）
  },
  cursor: null,   // 当前周（周一）
  selDay: null,   // 移动端选中的那一天
  filterTags: []
};

function seed() {
  const s = JSON.parse(JSON.stringify(DEFAULT));
  const mon = startOfWeek(new Date());
  s.cursor = iso(mon);
  s.selDay = iso(new Date());
  s.items.push({
    id: uid(), title: '示例：点我可以查看详情', note: '这是一条示例备忘。\n点空白处新建，点卡片看详情，卡片可直接拖动改期。',
    date: iso(addDays(mon, 0)), startMin: 9 * 60, dur: 60, tags: ['示例'], color: 'dai', done: false, createdAt: Date.now()
  });
  s.items.push({
    id: uid(), title: '示例：周三下午的例会', note: '带上上周的进度表',
    date: iso(addDays(mon, 2)), startMin: 14 * 60, dur: 90, tags: ['工作'], color: 'tong', done: false, createdAt: Date.now()
  });
  s.todos.push({ id: uid(), title: '示例：还没定时间的事，先收在待办', note: '', tags: ['示例'], color: 'tai', done: false, createdAt: Date.now() });
  return s;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return seed();
    const s = JSON.parse(raw);
    const d = JSON.parse(JSON.stringify(DEFAULT));
    d.items = Array.isArray(s.items) ? s.items : [];
    d.todos = Array.isArray(s.todos) ? s.todos : [];
    Object.assign(d.settings, s.settings || {});
    d.cursor = s.cursor || iso(startOfWeek(new Date()));
    d.selDay = s.selDay || iso(new Date());
    d.filterTags = Array.isArray(s.filterTags) ? s.filterTags : [];
    return d;
  } catch (e) { return seed(); }
}

let state = load();
let saveTimer = null;
function save(now) {
  const doIt = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { toast('保存失败：本地存储不可用'); } };
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (now) doIt(); else saveTimer = setTimeout(doIt, 160);
}

/* ---------------- DOM ---------------- */
const $ = id => document.getElementById(id);
const el = {
  grid: $('grid'), weekRange: $('weekRange'), dayChips: $('dayChips'),
  tagList: $('tagList'), stats: $('stats'),
  todoInput: $('todoInput'), todoList: $('todoList'), todoDone: $('todoDone'),
  todoDoneWrap: $('todoDoneWrap'), doneCount: $('doneCount'), statPanel: $('statPanel'),
  sideToggle: $('sideToggle'), sideMini: $('sideMini'), sideMiniNum: $('sideMiniNum'),
  editorModal: $('editorModal'), edTitle: $('edTitle'), fTitle: $('fTitle'), fNote: $('fNote'),
  fDate: $('fDate'), fStart: $('fStart'), fDur: $('fDur'), fTags: $('fTags'), fColors: $('fColors'),
  edDelete: $('edDelete'), edCancel: $('edCancel'), edSave: $('edSave'),
  detailModal: $('detailModal'), dTitle: $('dTitle'), dMeta: $('dMeta'), dTags: $('dTags'),
  dNote: $('dNote'), dDelete: $('dDelete'), dDone: $('dDone'), dEdit: $('dEdit'),
  settingsModal: $('settingsModal'), sStart: $('sStart'), sEnd: $('sEnd'), sHourH: $('sHourH'),
  sSnap: $('sSnap'),
  search: $('search'), searchResults: $('searchResults'),
  toast: $('toast'), fileInput: $('fileInput'),
  clock: $('clock'), overviewPanel: $('overviewPanel'),
  sbToday: $('sbToday'), sbWeek: $('sbWeek'), sbNext: $('sbNext')
};

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(msg, undoFn) {
  el.toast.textContent = '';
  const span = document.createElement('span'); span.textContent = msg;
  el.toast.appendChild(span);
  if (undoFn) {
    const b = document.createElement('button'); b.textContent = '撤销';
    b.onclick = () => { undoFn(); hideToast(); };
    el.toast.appendChild(b);
  }
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, undoFn ? 5200 : 2200);
}
function hideToast() { el.toast.hidden = true; }

/* ---------------- 弹层 ---------------- */
function showModal(m) { m.hidden = false; }
function closeModal(m) { (m || document.querySelector('.modal:not([hidden])'))?.setAttribute('hidden', ''); }
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal')) closeModal(e.target);
  if (e.target.closest('[data-close]')) closeModal(e.target.closest('.modal'));
});

/* ---------------- 渲染：周导航 ---------------- */
function weekDates() {
  const start = state.cursor ? parseDate(state.cursor) : startOfWeek(new Date());
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
function visibleDates() {
  const all = weekDates();
  if (!NARROW.matches) return all;
  const sel = all.find(d => iso(d) === state.selDay) ? state.selDay : iso(all[0]);
  return all.filter(d => iso(d) === sel);
}

function renderWeekNav() {
  const ds = weekDates();
  const a = ds[0], b = ds[6];
  const head = a.getFullYear() !== b.getFullYear()
    ? `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日`
    : `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日`;
  const tail = a.getMonth() !== b.getMonth()
    ? `${b.getMonth() + 1}月${b.getDate()}日`
    : `${b.getDate()}日`;
  el.weekRange.textContent = `${head} – ${tail} · 第 ${weekNumber(a)} 周`;
}

/* ---------------- 网格坐标系（唯一真源） ----------------
   像素 ↔ 时间怎么换算、按多长粒度吸附、可见时段从几点到几点，一律从这里取：
   渲染、点空格新建、卡片拖拽、待办投放共用同一套。
   之前各处各算一遍（有的把顶边当 startHour、有的当 0），于是早间展开后就整体偏移 6 小时。 */
function snapMin() {
  const s = +state.settings.snapMin;
  return (s === 5 || s === 10 || s === 15 || s === 30 || s === 60) ? s : 15;
}
function gridRange() {
  const S = state.settings;
  const startHour = clamp(+S.startHour, 0, 23);
  const endHour = clamp(+S.endHour, startHour + 1, 24);
  const showEarly = !!S.showEarly && startHour > 0;   // 早间展开后，网格顶边就是 00:00
  return {
    startHour, endHour, showEarly,
    sH: showEarly ? 0 : startHour,                    // 网格第一行对应的小时
    H: +S.hourH || 44,
  };
}
const pxToMin = (px, r) => r.sH * 60 + (px / r.H) * 60;   // 列内像素 → 连续分钟
const minToPx = (m, r) => (m - r.sH * 60) / 60 * r.H;     // 分钟 → 列内像素
/* 吸附到固定粒度，并夹在可见时段内：拖出网格上下的部分不会再被算成别的时刻 */
function snapTo(m, r) {
  const s = snapMin();
  return clamp(Math.round(m / s) * s, r.sH * 60, r.endHour * 60 - s);
}
/* 按横坐标定目标列：不依赖 elementFromPoint，光标落到滚动区外或被卡片挡住时也能定列 */
function colAtX(clientX) {
  const cols = gridWrap.querySelectorAll('.cols .day-col');
  if (!cols.length) return null;
  for (const c of cols) {
    const rc = c.getBoundingClientRect();
    if (clientX >= rc.left && clientX < rc.right) return c;
  }
  const first = cols[0].getBoundingClientRect();
  const last = cols[cols.length - 1].getBoundingClientRect();
  if (clientX < first.left) return cols[0];
  if (clientX >= last.right) return cols[cols.length - 1];
  return null;
}
/* 拖拽过程中把卡片上的时间文字同步成"松手后会落到的时间"，所见即所得 */
function setEvLabel(node, start, dur) {
  const m = node.querySelector('.ev-m');
  if (m) { m.textContent = `${fmtMin(start)}–${fmtMin(start + dur)}`; return; }
  const t = node.querySelector('.ev-t');
  if (!t) return;
  if (t.dataset.raw == null) t.dataset.raw = t.textContent;
  t.textContent = `${fmtMin(start)} ${t.dataset.raw}`;
}

/* ---------------- 渲染：网格 ---------------- */
function layoutDay(list) {
  const sorted = list.slice().sort((x, y) => x.startMin - y.startMin || y.dur - x.dur);
  const clusters = []; let cur = null, curEnd = -1;
  sorted.forEach(it => {
    if (cur && it.startMin < curEnd) { cur.push(it); curEnd = Math.max(curEnd, it.startMin + it.dur); }
    else { cur = [it]; clusters.push(cur); curEnd = it.startMin + it.dur; }
  });
  const out = [];
  clusters.forEach(cl => {
    const laneEnd = [], recs = [];
    cl.forEach(it => {
      let li = laneEnd.findIndex(end => end <= it.startMin);
      if (li < 0) { laneEnd.push(it.startMin + it.dur); li = laneEnd.length - 1; }
      else laneEnd[li] = it.startMin + it.dur;
      const r = { it, lane: li }; recs.push(r);
    });
    recs.forEach(r => { r.laneCount = laneEnd.length; out.push(r); });
  });
  return out;
}

function isDimmed(it) {
  if (!state.filterTags.length) return false;
  return !state.filterTags.some(t => (it.tags || []).includes(t));
}

function renderGrid() {
  const S = state.settings;
  const r = gridRange();
  const startHour = r.startHour, eH = r.endHour;
  /* 早间时段（00:00 到起始小时）默认折叠成一条细线，点一下展开 */
  const showEarly = r.showEarly, sH = r.sH, H = r.H;
  const rows = eH - sH;
  const dates = visibleDates();
  const todayIso = iso(new Date());

  let head = '<div class="gutter"></div>';
  dates.forEach(d => {
    const ds = iso(d), w = d.getDay() === 0 || d.getDay() === 6, t = ds === todayIso;
    head += `<div class="day-head${w ? ' is-weekend' : ''}${t ? ' is-today' : ''}">`
         + `<span class="dow">${DOW[dowIndex(d)]}${t ? ' · 今天' : ''}</span>`
         + `<span class="dnum">${d.getDate()}</span></div>`;
  });

  let hours = '';
  for (let h = sH; h < eH; h++) hours += `<div class="hour" style="height:${H}px"><span>${pad(h)}:00</span></div>`;

  let cols = '';
  dates.forEach(d => {
    const ds = iso(d), w = d.getDay() === 0 || d.getDay() === 6, t = ds === todayIso;
    const laid = layoutDay(state.items.filter(i => i.date === ds));
    let evs = '';
    laid.forEach(r => {
      const it = r.it;
      const top = (it.startMin - sH * 60) / 60 * H;
      const hgt = Math.max(17, it.dur / 60 * H - 3);
      const wpc = 100 / r.laneCount;
      const c = COLORS[it.color] || COLORS.dai;
      // 左侧色条与极淡底色按标签走：一眼分出事项类型；没标签才用自选颜色
      const tc = (it.tags && it.tags.length) ? tagColor(it.tags[0]) : c;
      const clip = it.startMin < sH * 60 || it.startMin + it.dur > eH * 60;
      const cls = ['ev'];
      if (isDimmed(it)) cls.push('is-dim');
      if (it.done) cls.push('is-done');
      if (clip) cls.push('is-clip');
      evs += `<div class="${cls.join(' ')}" data-id="${it.id}" tabindex="0"
        style="top:${top}px;height:${hgt}px;left:calc(${r.lane * wpc}% + 3px);width:calc(${wpc}% - 6px);--c:${c};--tc:${tc};background:${rgba(tc, DARK_SKINS.has(S.skin) ? 0.40 : 0.30)}">
        <div class="ev-t mf">${esc(it.title)}</div>
        ${hgt > 32 ? `<div class="ev-m">${fmtMin(it.startMin)}–${fmtMin(it.startMin + it.dur)}</div>` : ''}
        ${(it.tags && it.tags.length && hgt > 54) ? `<div class="ev-tags">${it.tags.map(t => `<i style="background:${tagColor(t)}"></i>`).join('')}</div>` : ''}
        <span class="rz rz-t" data-rz="t" title="拖这里改开始时间"></span>
        <span class="rz rz-b" data-rz="b" title="拖这里改时长"></span>
      </div>`;
    });
    let now = '';
    if (t) {
      const nd = new Date(), m = nd.getHours() * 60 + nd.getMinutes();
      if (m >= sH * 60 && m <= eH * 60) {
        now = `<div class="nowline" style="top:${(m - sH * 60) / 60 * H}px">`
            + `<span class="now-label">${fmtMin(m)}</span></div>`;
      }
    }
    cols += `<div class="day-col${w ? ' is-weekend' : ''}${t ? ' is-today' : ''}" data-date="${ds}">`
          + Array.from({ length: rows }, () => `<div class="cell" style="height:${H}px"></div>`).join('')
          + evs + now + `</div>`;
  });

  /* 早间细线：00:00 到起始小时，默认折叠，点一下展开 */
  let early = '';
  if (startHour > 0) {
    const cells = dates.map(d => {
      const ds = iso(d), w = d.getDay() === 0 || d.getDay() === 6, t = ds === todayIso;
      const n = state.items.filter(i => i.date === ds && (i.startMin || 0) < startHour * 60).length;
      return `<div class="early-cell${w ? ' is-weekend' : ''}${t ? ' is-today' : ''}${showEarly ? ' is-open' : ''}">`
           + (n ? `<span class="early-n">${n}</span>` : '') + `</div>`;
    }).join('');
    const full = `00:00–${pad(startHour)}:00`;
    early = `<div class="grid-early${showEarly ? ' is-open' : ''}" data-early="1" title="${showEarly ? '点击收起早间时段' : '点击展开 ' + full}">
      <div class="gutter"><span class="early-lab">${showEarly ? '▲ 收起早间' : '早间 00:00–' + pad(startHour) + ' · 点击展开'}</span></div>
      ${cells}</div>`;
  }

  el.grid.innerHTML = `<div class="grid-head">${head}</div>${early}`
    + `<div class="grid-body"><div class="hours">${hours}</div><div class="cols">${cols}</div></div>`;
  renderDayChips();
}

function renderDayChips() {
  if (!NARROW.matches) { el.dayChips.hidden = true; el.dayChips.innerHTML = ''; return; }
  el.dayChips.hidden = false;
  const todayIso = iso(new Date());
  el.dayChips.innerHTML = weekDates().map(d => {
    const ds = iso(d);
    return `<button class="dchip${ds === state.selDay ? ' is-on' : ''}${ds === todayIso ? ' is-today' : ''}" data-date="${ds}">`
         + `${DOW[dowIndex(d)]}<small>${d.getMonth() + 1}/${d.getDate()}</small></button>`;
  }).join('');
}

/* ---------------- 渲染：标签 / 统计 ---------------- */
function allTags() {
  const m = new Map();
  state.items.forEach(i => (i.tags || []).forEach(t => m.set(t, (m.get(t) || 0) + 1)));
  state.todos.forEach(i => (i.tags || []).forEach(t => m.set(t, (m.get(t) || 0) + 1)));
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function renderTags() {
  const tags = allTags();
  let html = `<button class="tagchip${state.filterTags.length ? '' : ' is-on'}" data-tag="">全部</button>`;
  tags.forEach(([t, n]) => {
    const on = state.filterTags.includes(t);
    html += `<button class="tagchip${on ? ' is-on' : ''}" data-tag="${esc(t)}" style="--c:${tagColor(t)}"><i></i>#${esc(t)} ${n}</button>`;
  });
  if (state.filterTags.length) html += `<button class="tagchip is-clear" data-clear="1" title="清除标签筛选，恢复显示全部">清除筛选 ×</button>`;
  el.tagList.innerHTML = html;
}
/* ---------------- 统计：全站唯一口径 ----------------
   右侧两张卡片、顶部状态条都从这两个函数取数，不再各自 filter。
   之前「今日概览」只数今天、「本周时间分配」只数本周，新增到别的日期时
   概览就一直显示 0，看着像没保存上；现在两张卡片都标清统计范围。 */
function dayStats(dateStr) {
  const list = state.items.filter(i => i.date === dateStr);
  const done = list.filter(i => i.done).length;
  const sum = a => a.reduce((s, i) => s + (i.dur || 0), 0);
  return {
    date: dateStr, total: list.length, done, pending: list.length - done,
    minutes: sum(list), doneMinutes: sum(list.filter(i => i.done)),
  };
}
function weekStats() {
  const set = new Set(weekDates().map(iso));
  const list = state.items.filter(i => set.has(i.date));
  const done = list.filter(i => i.done).length;
  const byTag = new Map();
  list.forEach(i => {
    const k = (i.tags && i.tags[0]) || '未分类';
    byTag.set(k, (byTag.get(k) || 0) + (i.dur || 0));
  });
  return {
    count: list.length, done, pending: list.length - done,
    minutes: list.reduce((s, i) => s + (i.dur || 0), 0),
    byTag: [...byTag.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function renderStats() {
  const wk = weekStats(), td = dayStats(iso(new Date()));
  const undone = state.todos.filter(t => !t.done).length;
  el.stats.textContent = `本周 ${wk.count} 条（已完成 ${wk.done}） · ${(wk.minutes / 60).toFixed(1)} 小时`
    + ` · 今日 ${td.total} 条（已完成 ${td.done}）`
    + ` · 待办 ${undone} 未完成 / ${state.todos.length - undone} 已完成`;
}

/* ---------------- 渲染：待办 ---------------- */
function renderTodos() {
  const undone = state.todos.filter(t => !t.done).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const done = state.todos.filter(t => t.done).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const row = t => {
    const dim = state.filterTags.length && !state.filterTags.some(x => (t.tags || []).includes(x));
    return `<div class="todo${t.done ? ' done' : ''}${dim ? ' is-dim' : ''}" data-id="${t.id}">
      <button class="cb" data-act="toggle" aria-label="完成"></button>
      <div class="todo-main">
        <div class="todo-text mf" data-act="edit">${esc(t.title)}</div>
        ${(t.tags && t.tags.length) ? `<div class="todo-meta">${t.tags.map(x => `<span class="mini-tag" style="--c:${tagColor(x)}">#${esc(x)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="todo-acts">
        <button data-act="plan" title="安排到具体时段">排期</button>
        <button data-act="del" title="删除">✕</button>
      </div>
    </div>`;
  };
  el.todoList.innerHTML = undone.length ? undone.map(row).join('') : `<p class="muted" style="padding:6px 2px">暂时没有待办，上面加一条。</p>`;
  el.todoDone.innerHTML = done.map(row).join('');
  el.todoDoneWrap.hidden = done.length === 0;
  el.doneCount.textContent = `已完成 ${done.length}`;
}

/* 迷你环形图：用 stroke-dasharray 拼扇形，直径 54px，不高不占版面 */
function donutSVG(rows, total, size = 54) {
  const r = size / 2 - 5;
  const circ = 2 * Math.PI * r;
  const mid = size / 2;
  let acc = 0, segs = '';
  rows.forEach(([t, m]) => {
    const frac = total ? m / total : 0;
    if (frac <= 0) return;
    const len = circ * frac;
    const c = t === '未分类' ? '#8B9099' : tagColor(t);
    segs += `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="${c}" stroke-width="5.5"`
         + ` stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}"`
         + ` stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${mid} ${mid})"></circle>`;
    acc += len;
  });
  if (!segs) segs = `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--line)"`
    + ` stroke-width="5.5" stroke-dasharray="${circ.toFixed(2)} 0"></circle>`;
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">`
       + `<circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--line-soft)" stroke-width="5.5"></circle>`
       + segs
       + `<text class="donut-t" x="${mid}" y="${mid}" text-anchor="middle" dy="0.36em">${(total / 60).toFixed(1)}h</text>`
       + `</svg>`;
}

function renderStatsPanel() {
  const wk = weekStats();
  const rows = wk.byTag, total = wk.minutes;
  /* 可见时段按实际渲染的起止算（早间展开与否会变），占比说的是"已排"占可见时段多少，
     不再拿「空档」去比——那样会把睡觉时间也算成空档，得出"空档 126 小时、占可见时段 100%"这种怪话 */
  const r = gridRange();
  const span = Math.max(0, (r.endHour - r.sH) * 7 * 60);

  /* 迷你环形进度条：每个标签一段，颜色与卡片一致，尺寸控制在 54px 内 */
  let html = `<div class="sp-head"><span>本周时间分配</span>${donutSVG(rows, total)}</div>`;
  html += `<div class="sp-count">本周 ${wk.count} 条 · 已完成 ${wk.done} · 未完成 ${wk.pending}</div>`;
  if (!rows.length) {
    html += `<p class="sp-empty">本周还没有安排。在左边网格空白处点一下就能加一条。</p>`;
  } else {
    rows.forEach(([t, m]) => {
      const c = t === '未分类' ? '#8B9099' : tagColor(t);
      const pct = total ? (m / total * 100) : 0;
      html += `<div class="sp-row">
        <span class="sp-name" style="--c:${c}"><i></i>${esc(t)}</span>
        <span class="sp-bar"><b style="width:${pct.toFixed(1)}%;background:${c}"></b></span>
        <span class="sp-num">${(m / 60).toFixed(1)}h</span>
      </div>`;
    });
  }
  html += `<div class="sp-foot">已排 ${(total / 60).toFixed(1)} 小时`
        + (span ? ` · 占可见时段 ${Math.round(total / span * 100)}%` : '') + '</div>';
  el.statPanel.innerHTML = html;
}

/* 距下个安排：先看有没有正在进行的，没有再取全局最早尚未开始的 */
function nextEvent() {
  const nowMs = Date.now();
  let running = null, upcoming = null;
  state.items.forEach(i => {
    if (i.done) return;
    const d = parseDate(i.date);
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).getTime() + i.startMin * 60000;
    const e = s + (i.dur || 0) * 60000;
    if (s <= nowMs && nowMs < e) { if (!running || s < running.t) running = { t: s, it: i, running: true }; }
    else if (s > nowMs) { if (!upcoming || s < upcoming.t) upcoming = { t: s, it: i, running: false }; }
  });
  return running || upcoming;
}

/* 右下「今日概览」：填掉空白，并给出安静的"距下个安排"临近度指示（环形填充+临近轻微脉冲） */
function renderOverview() {
  if (!el.overviewPanel) return;
  const todayIso = iso(new Date());
  const td = dayStats(todayIso);          // 当日：计划数 / 已完成 / 未完成 / 已排时长
  const wk = weekStats();                 // 本周：新增到别的日期时，这一行会立刻动
  const unscheduled = state.todos.filter(t => !t.done).length;

  const ne = nextEvent();
  const now = Date.now();
  const WIN = 180;                        // 临近度窗口（分钟）
  let ringFrac = 0, label = '接下来没有安排', sub = '', near = false;
  if (ne) {
    label = ne.it.title;
    if (ne.running) {
      sub = `正在进行 · ${fmtMin(ne.it.startMin)}–${fmtMin(ne.it.startMin + ne.it.dur)}`;
      ringFrac = 1; near = true;
    } else {
      const minsTo = Math.round((ne.t - now) / 60000);
      sub = minsTo >= 60 ? `还有 ${Math.floor(minsTo / 60)} 小时 ${minsTo % 60} 分` : `还有 ${minsTo} 分钟`;
      ringFrac = clamp(1 - minsTo / WIN, 0, 1);
      near = minsTo <= 10;
    }
  } else {
    sub = td.total ? '今天的安排都走完了' : '今天还没有安排';
  }
  const size = 38, r = size / 2 - 4, circ = 2 * Math.PI * r, mid = size / 2;
  const off = (circ * (1 - ringFrac)).toFixed(2);
  const ring = `<svg class="ov-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--line-soft)" stroke-width="4"/>
      <circle cx="${mid}" cy="${mid}" r="${r}" fill="none" stroke="var(--accent)" stroke-width="4"
        stroke-linecap="round" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${off}"
        transform="rotate(-90 ${mid} ${mid})"/></svg>`;

  const empty = td.total === 0 && unscheduled === 0;
  el.overviewPanel.innerHTML =
    `<div class="ov-head">今日概览<span class="ov-date">${todayIso.slice(5)}</span></div>
     <div class="ov-tiles">
       <div class="ov-tile"><div class="n">${td.total}</div><div class="l">今日计划</div></div>
       <div class="ov-tile"><div class="n">${td.done}</div><div class="l">已完成</div></div>
       <div class="ov-tile"><div class="n">${unscheduled}</div><div class="l">未排期</div></div>
     </div>
     <div class="ov-week">本周共 ${wk.count} 条 · 已完成 ${wk.done} 条 · 今日已排 ${(td.minutes / 60).toFixed(1)} 小时</div>
     ${empty ? `<p class="ov-empty">今天还是空的：左边网格点一下加计划，右边上方加待办。</p>`
              : `<div class="ov-next${near ? ' is-near' : ''}">
                    ${ring}
                    <div class="ov-txt"><div class="ov-t">${esc(label)}</div><div class="ov-s">${esc(sub)}</div></div>
                  </div>`}`;
}

/* 顶栏当前时间组件 */
function updateClock() {
  const d = new Date();
  if (el.clock) el.clock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function render() {
  renderWeekNav(); renderGrid(); renderTags(); renderStats(); renderTodos(); renderStatsPanel(); renderOverview(); renderStatusBar();
  applySide();
}

/* ---------------- 底部状态栏：今日 / 本周完成度 + 接下来要做的事 ---------------- */
function sbProgress(done, total) {
  const pct = total ? (done / total * 100) : 0;
  return `<span class="sb-track"><b style="width:${pct.toFixed(1)}%"></b></span>`;
}
function renderStatusBar() {
  if (!el.sbToday) return;
  const td = dayStats(iso(new Date()));
  const wk = weekStats();

  /* dayStats 的总数叫 total，weekStats 的叫 count —— 这里统一取 */
  const piece = (label, s) => {
    const n = s.total != null ? s.total : s.count;
    return n
      ? `<span class="sb-item">${label} ${sbProgress(s.done, n)} <span>${s.done}/${n} 完成</span></span>`
      : `<span class="sb-item is-empty">${label} ${sbProgress(0, 1)} <span>无安排</span></span>`;
  };
  el.sbToday.innerHTML = piece('今日', td);
  el.sbWeek.innerHTML = piece('本周', wk);

  /* 筛选开着的时候，不符合的那批卡片会被压暗——
     不写一句话说明，用户只会以为"卡片颜色太淡"，所以在状态栏点出来 */
  if (state.filterTags.length) {
    el.sbNext.innerHTML = `已按 #${state.filterTags.map(esc).join(' #')} 筛选 · 其他卡片已压暗`
      + ` <b class="sb-clear" id="sbClearFilter" role="button" tabindex="0">清除</b>`;
    const btn = document.getElementById('sbClearFilter');
    if (btn) btn.addEventListener('click', () => { state.filterTags = []; render(); save(true); });
    return;
  }

  const ne = nextEvent();
  let next = '今天没有更多安排';
  if (ne) {
    const minsTo = Math.round((ne.t - Date.now()) / 60000);
    const d = new Date(ne.t);
    const t = fmtMin(d.getHours() * 60 + d.getMinutes());
    if (minsTo <= 0) next = `正在进行 <b>${esc(ne.it.title)}</b>`;
    else next = `接下来 <b>${t} ${esc(ne.it.title)}</b> · ${minsTo >= 60 ? `${Math.floor(minsTo / 60)} 小时 ${minsTo % 60} 分后` : `${minsTo} 分钟后`}`;
  }
  el.sbNext.innerHTML = next;
}

/* 右侧「待办 + 时间统计」面板：收起后时间网格占满宽度 */
function applySide() {
  const collapsed = !!state.settings.sideCollapsed;
  document.body.dataset.side = collapsed ? '0' : '1';
  const n = state.todos.filter(t => !t.done).length;
  if (el.sideMiniNum) el.sideMiniNum.textContent = String(n);
  if (el.sideToggle) el.sideToggle.textContent = collapsed ? '‹' : '›';
  if (el.sideToggle) el.sideToggle.title = collapsed ? '展开面板' : '收起面板，时间网格占满宽度';
}
function toggleSide(force) {
  state.settings.sideCollapsed = force == null ? !state.settings.sideCollapsed : !!force;
  applySide(); save(true);
}

/* ---------------- 备忘增删查改 ---------------- */
function addItem(data) {
  const it = Object.assign({ id: uid(), title: '', note: '', date: iso(new Date()), startMin: 9 * 60, dur: 60, tags: [], color: 'dai', done: false, createdAt: Date.now() }, data);
  state.items.push(it); save(true); render(); return it;
}
function removeItem(id) {
  const idx = state.items.findIndex(i => i.id === id); if (idx < 0) return null;
  const [it] = state.items.splice(idx, 1); save(true); render(); return it;
}

/* 编辑器 */
let edCtx = { id: null, fromTodo: null };
let curColor = 'dai';
function fillSelects() {
  let t = ''; for (let m = 0; m < 24 * 60; m += 30) t += `<option value="${m}">${fmtMin(m)}</option>`;
  el.fStart.innerHTML = t;
  let d = ''; [30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480].forEach(v => {
    const label = v < 60 ? `${v} 分钟`
      : (v % 60 === 0 ? `${v / 60} 小时` : `${Math.floor(v / 60)} 小时 ${v % 60} 分`);
    d += `<option value="${v}">${label}</option>`;
  });
  el.fDur.innerHTML = d;
  let sh = ''; for (let h = 0; h <= 23; h++) sh += `<option value="${h}">${pad(h)}:00</option>`;
  el.sStart.innerHTML = sh;
  let eh = ''; for (let h = 1; h <= 24; h++) eh += `<option value="${h}">${pad(h % 24)}:00</option>`;
  el.sEnd.innerHTML = eh;
  /* 皮肤网格 + 字体分段在启动时就建好并同步选中态，
     这样不进设置弹层也能看到当前外观，弹层一打开就是对的。 */
  buildSkinGrid();
  syncSkinGrid(state.settings.skin);
  syncFontSeg(state.settings.font);
  el.fColors.innerHTML = CKEYS.map(k => `<button data-color="${k}" style="--c:${COLORS[k]}" aria-label="${k}"></button>`).join('');
}
function setColor(k) {
  curColor = k;
  [...el.fColors.children].forEach(b => b.classList.toggle('is-on', b.dataset.color === k));
}
function openEditor(o) {
  o = o || {};
  edCtx = { id: o.id || null, fromTodo: o.fromTodo || null };
  const it = o.id ? state.items.find(i => i.id === o.id) : null;
  el.edTitle.textContent = it ? '编辑备忘' : (o.fromTodo ? '把待办安排到时段' : '新建备忘');
  el.fTitle.value = it ? it.title : (o.title || '');
  el.fNote.value = it ? it.note : (o.note || '');
  el.fDate.value = it ? it.date : (o.date || (NARROW.matches ? state.selDay : iso(new Date())));
  const sH = +state.settings.startHour * 60;
  el.fStart.value = it ? it.startMin : (o.start != null ? o.start : clamp(Math.max(sH, 9 * 60), 0, 23 * 60 + 30));
  el.fDur.value = it ? it.dur : (o.dur || 60);
  el.fTags.value = (it ? it.tags : (o.tags || [])).join(' ');
  setColor(it ? it.color : (o.color || hashColor(o.title || uid())));
  el.edDelete.hidden = !it;
  showModal(el.editorModal);
  setTimeout(() => { el.fTitle.focus(); el.fTitle.select(); }, 40);
}
function saveEditor() {
  const title = el.fTitle.value.trim();
  if (!title) { el.fTitle.focus(); toast('标题不能为空'); return; }
  const data = {
    title, note: el.fNote.value.trim(),
    date: el.fDate.value || iso(new Date()),
    startMin: +el.fStart.value, dur: +el.fDur.value,
    tags: parseTags(el.fTags.value), color: curColor
  };
  if (edCtx.id) {
    Object.assign(state.items.find(i => i.id === edCtx.id), data, { updatedAt: Date.now() });
  } else {
    state.items.push(Object.assign({ id: uid(), done: false, createdAt: Date.now() }, data));
    if (edCtx.fromTodo) removeTodo(edCtx.fromTodo, true);
  }
  save(true); closeModal(el.editorModal); render();
  toast(edCtx.id ? '已保存' : '已添加');
}

/* 详情 */
let detailId = null;
function openDetail(id) {
  const it = state.items.find(i => i.id === id); if (!it) return;
  detailId = id;
  el.dTitle.textContent = it.title;
  const d = parseDate(it.date);
  el.dMeta.textContent = `${it.date} ${DOW[dowIndex(d)]} · ${fmtMin(it.startMin)}–${fmtMin(it.startMin + it.dur)} · 时长 ${it.dur >= 60 ? (it.dur / 60) + ' 小时' : it.dur + ' 分钟'}`;
  el.dTags.innerHTML = (it.tags && it.tags.length)
    ? it.tags.map(t => `<span class="tag" style="--c:${tagColor(t)}">#${esc(t)}</span>`).join('')
    : '<span class="muted" style="font-size:12px">无标签</span>';
  el.dNote.textContent = it.note || '（暂无备注）';
  el.dDone.textContent = it.done ? '标记未完成' : '标记完成';
  showModal(el.detailModal);
}

/* ---------------- 待办 ---------------- */
function addTodo(titleRaw) {
  const title = String(titleRaw || '').trim();
  if (!title) return;
  const tags = parseTags(title.match(/#([^\s#]+)/g)?.join(' ') || '');
  const clean = title.replace(/#([^\s#]+)/g, '').replace(/\s+/g, ' ').trim() || title;
  state.todos.push({ id: uid(), title: clean, note: '', tags, color: hashColor(clean), done: false, createdAt: Date.now() });
  save(true); render();
}
function removeTodo(id, silent) {
  const idx = state.todos.findIndex(t => t.id === id); if (idx < 0) return;
  const [t] = state.todos.splice(idx, 1);
  save(true); render();
  if (!silent) toast('已删除', () => { state.todos.splice(idx, 0, t); save(true); render(); });
}
function startTodoEdit(id, node) {
  const t = state.todos.find(x => x.id === id); if (!t) return;
  const input = document.createElement('input');
  input.className = 'todo-edit mf'; input.value = t.title;
  node.replaceWith(input); input.focus(); input.select();
  let closed = false;
  const finish = commit => {
    if (closed) return; closed = true;
    if (commit && input.value.trim() && input.value.trim() !== t.title) {
      t.title = input.value.trim();
      t.tags = parseTags(input.value.match(/#([^\s#]+)/g)?.join(' ') || '');
      t.title = t.title.replace(/#([^\s#]+)/g, '').replace(/\s+/g, ' ').trim() || t.title;
      save(true);
    }
    render();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

/* ---------------- 搜索 ---------------- */
function doSearch(q) {
  q = String(q || '').trim().toLowerCase();
  if (!q) { el.searchResults.hidden = true; el.searchResults.innerHTML = ''; return; }
  const hit = (o, extra) => {
    const text = [o.title, o.note, (o.tags || []).join(' ')].join(' ').toLowerCase();
    return text.includes(q) || (extra || '').toLowerCase().includes(q);
  };
  const items = state.items.filter(i => hit(i)).sort((a, b) => (b.date < a.date ? -1 : 1)).slice(0, 10);
  const todos = state.todos.filter(t => hit(t)).slice(0, 6);
  let html = '';
  items.forEach(i => { html += `<div class="res-item" data-kind="item" data-id="${i.id}"><b>${esc(i.title)}</b><span class="r-meta">${i.date} ${fmtMin(i.startMin)} · ${esc((i.tags || []).map(t => '#' + t).join(' '))}</span></div>`; });
  todos.forEach(t => { html += `<div class="res-item" data-kind="todo" data-id="${t.id}"><b>${esc(t.title)}</b><span class="r-meta">待办 · ${esc((t.tags || []).map(x => '#' + x).join(' '))}</span></div>`; });
  el.searchResults.innerHTML = html || '<div class="res-empty">没有找到相关内容</div>';
  el.searchResults.hidden = false;
}
function jumpToItem(id) {
  const it = state.items.find(i => i.id === id); if (!it) return;
  state.cursor = iso(startOfWeek(parseDate(it.date)));
  state.selDay = it.date;
  save(); render();
  setTimeout(() => {
    const node = el.grid.querySelector(`.ev[data-id="${it.id}"]`);
    if (node) { node.scrollIntoView({ block: 'center' }); node.classList.add('is-hit'); setTimeout(() => node.classList.remove('is-hit'), 1800); }
  }, 60);
}
function jumpToTodo(id) {
  document.body.dataset.view = 'todo';
  document.querySelectorAll('.mtab').forEach(b => b.classList.toggle('is-on', b.dataset.view === 'todo'));
  setTimeout(() => {
    const node = el.todoList.querySelector(`.todo[data-id="${id}"]`) || el.todoDone.querySelector(`.todo[data-id="${id}"]`);
    if (node) { node.scrollIntoView({ block: 'center' }); node.classList.add('is-hit'); setTimeout(() => node.classList.remove('is-hit'), 1800); }
  }, 60);
}

/* ---------------- 网格交互：点击 / 拖拽 ---------------- */
const gridWrap = el.grid;
let suppressClick = false;
let drag = null;

gridWrap.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  // 早间那条细线：点一下展开 / 收起 00:00 到起始小时
  if (e.target.closest('.grid-early')) {
    state.settings.showEarly = !state.settings.showEarly;
    save(true); render();
    toast(state.settings.showEarly ? '早间时段已展开' : '早间时段已折叠为细线');
    return;
  }
  const evEl = e.target.closest('.ev');
  if (evEl) { openDetail(evEl.dataset.id); return; }
  const col = e.target.closest('.day-col'); if (!col) return;
  /* 与拖拽同一套换算：点在哪一格就落在哪一格对应的时刻（按吸附粒度对齐） */
  const r = gridRange(), rect = col.getBoundingClientRect();
  openEditor({ date: col.dataset.date, start: snapTo(pxToMin(e.clientY - rect.top, r), r), dur: 60 });
});
gridWrap.addEventListener('keydown', e => {
  const evEl = e.target.closest('.ev');
  if (evEl && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openDetail(evEl.dataset.id); }
});

gridWrap.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  const evEl = e.target.closest('.ev'); if (!evEl) return;
  const it = state.items.find(i => i.id === evEl.dataset.id); if (!it) return;
  const mode = e.target.closest('.rz-b') ? 'rz-b' : (e.target.closest('.rz-t') ? 'rz-t' : 'move');
  const box = evEl.getBoundingClientRect();
  drag = {
    id: it.id, node: evEl, mode, x: e.clientX, y: e.clientY, active: false, hint: null,
    o: { startMin: it.startMin, dur: it.dur },
    grab: e.clientY - box.top,     // 光标落在卡片内的纵向位置，拖动全程保持不变
    homeLeft: box.left,            // 原列左边缘，用来算横向位移
  };
});
window.addEventListener('pointermove', e => {
  if (!drag) return;
  const r = gridRange(), H = r.H;
  if (!drag.active) {
    if (Math.abs(e.clientX - drag.x) < 4 && Math.abs(e.clientY - drag.y) < 4) return;
    drag.active = true;
    drag.node.classList.add('is-drag');
    if (drag.mode === 'move') { drag.hint = document.createElement('div'); drag.hint.className = 'drophint'; }
  }
  const it = state.items.find(i => i.id === drag.id); if (!it) return;

  /* 只有把卡片拖出网格可视区之外才自动滚动（越远滚得越快）。
     光标还在可视区里面时绝不滚动画布，否则画布一动，落点就跟手指错位了。 */
  const sc = gridWrap.closest('.grid-scroll');
  if (sc) {
    const sr = sc.getBoundingClientRect();
    if (e.clientY < sr.top) sc.scrollTop -= clamp((sr.top - e.clientY) / 4, 6, 20);
    else if (e.clientY > sr.bottom) sc.scrollTop += clamp((e.clientY - sr.bottom) / 4, 6, 20);
  }

  if (drag.mode === 'move') {
    const col = colAtX(e.clientX);
    document.querySelectorAll('.day-col.is-target').forEach(c => c.classList.remove('is-target'));
    if (!col) { drag.target = null; if (drag.hint && drag.hint.parentNode) drag.hint.remove(); return; }
    col.classList.add('is-target');
    const colRect = col.getBoundingClientRect();
    /* 卡片顶边跟着光标走（保留抓取偏移）→ 换算成连续时间 → 吸附到固定粒度 */
    const start = snapTo(pxToMin((e.clientY - colRect.top) - drag.grab, r), r);
    const topPx = minToPx(start, r);
    drag.target = { date: col.dataset.date, start };
    /* 实时反馈：卡片自己吸附到落点，再配一条虚线占位和时间标签，松手前就看清会落到几点 */
    drag.node.style.transform =
      `translate(${Math.round(colRect.left - drag.homeLeft + 3)}px, ${Math.round(topPx - drag.node.offsetTop)}px)`;
    setEvLabel(drag.node, start, it.dur);
    drag.hint.style.top = topPx + 'px';
    drag.hint.style.height = Math.max(17, it.dur / 60 * H - 3) + 'px';
    drag.hint.innerHTML = `<span class="drophint-t">${fmtMin(start)}–${fmtMin(start + it.dur)}</span>`;
    if (drag.hint.parentNode !== col) col.appendChild(drag.hint);
    return;
  }

  // 拉伸：按吸附粒度一档一档走，实时改高度并刷新时间文字
  const snap = snapMin();
  const delta = Math.round(((e.clientY - drag.y) / H * 60) / snap) * snap;
  let ns = drag.o.startMin, nd = drag.o.dur;
  if (drag.mode === 'rz-b') nd = clamp(drag.o.dur + delta, snap, 24 * 60 - drag.o.startMin);
  else {
    ns = clamp(Math.round((drag.o.startMin + delta) / snap) * snap, 0, drag.o.startMin + drag.o.dur - snap);
    nd = drag.o.startMin + drag.o.dur - ns;
  }
  drag.next = { startMin: ns, dur: nd };
  drag.node.style.top = minToPx(ns, r) + 'px';
  drag.node.style.height = Math.max(17, nd / 60 * H - 3) + 'px';
  setEvLabel(drag.node, ns, nd);
});
window.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  d.node.classList.remove('is-drag');
  d.node.style.transform = '';
  if (d.hint && d.hint.parentNode) d.hint.remove();
  document.querySelectorAll('.day-col.is-target').forEach(c => c.classList.remove('is-target'));
  if (!d.active) return;
  suppressClick = true;
  const it = state.items.find(i => i.id === d.id); if (!it) return;

  if (d.mode === 'move') {
    /* 没取到落点、或落点没变，也要整屏重绘一次，把拖拽中途改过的文字/位移还原 */
    if (!d.target || (it.date === d.target.date && it.startMin === d.target.start)) { render(); return; }
    const from = { date: it.date, startMin: it.startMin };
    it.date = d.target.date; it.startMin = d.target.start;
    save(true); render();
    // render() 会按新的 startMin 重排卡片顺序、刷新时间标签与右侧统计
    toast(`已移到 ${d.target.date} ${fmtMin(d.target.start)}`, () => {
      const back = state.items.find(i => i.id === d.id);
      if (back) { back.date = from.date; back.startMin = from.startMin; save(true); render(); }
    });
  } else if (d.next) {
    if (it.startMin === d.next.startMin && it.dur === d.next.dur) { render(); return; }
    it.startMin = d.next.startMin; it.dur = d.next.dur;
    save(true); render();
    toast(`已调整为 ${fmtMin(it.startMin)}–${fmtMin(it.startMin + it.dur)}（${it.dur >= 60 ? (it.dur / 60) + ' 小时' : it.dur + ' 分钟'}）`);
  }
});

/* ---------------- 事件绑定 ---------------- */
$('prevWeek').addEventListener('click', () => { state.cursor = iso(addDays(parseDate(state.cursor), -7)); save(); render(); });
$('nextWeek').addEventListener('click', () => { state.cursor = iso(addDays(parseDate(state.cursor), 7)); save(); render(); });
$('thisWeek').addEventListener('click', () => { state.cursor = iso(startOfWeek(new Date())); state.selDay = iso(new Date()); save(); render(); });
$('copyLast').addEventListener('click', () => {
  const mon = parseDate(state.cursor), lastMon = addDays(mon, -7);
  const set = new Set(Array.from({ length: 7 }, (_, i) => iso(addDays(lastMon, i))));
  const src = state.items.filter(i => set.has(i.date));
  if (!src.length) { toast('上一周没有可复制的安排'); return; }
  src.forEach(i => state.items.push(Object.assign({}, i, {
    id: uid(), date: iso(addDays(parseDate(i.date), 7)), done: false, createdAt: Date.now()
  })));
  save(true); render();
  toast(`已复制 ${src.length} 条到本周`);
});

el.tagList.addEventListener('click', e => {
  const chip = e.target.closest('.tagchip'); if (!chip) return;
  if (chip.dataset.clear) { state.filterTags = []; }
  else {
    const t = chip.dataset.tag;
    if (!t) state.filterTags = [];
    else state.filterTags = state.filterTags.includes(t) ? state.filterTags.filter(x => x !== t) : state.filterTags.concat(t);
  }
  save(); render();
});

el.dayChips.addEventListener('click', e => {
  const c = e.target.closest('.dchip'); if (!c) return;
  state.selDay = c.dataset.date; save(); render();
});

el.todoList.addEventListener('click', onTodoClick);
el.todoDone.addEventListener('click', onTodoClick);
function onTodoClick(e) {
  const row = e.target.closest('.todo'); if (!row) return;
  const id = row.dataset.id;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'toggle') {
    const t = state.todos.find(x => x.id === id);
    if (t) { t.done = !t.done; save(true); render(); }
  } else if (act === 'edit') {
    startTodoEdit(id, e.target.closest('[data-act="edit"]'));
  } else if (act === 'plan') {
    const t = state.todos.find(x => x.id === id); if (!t) return;
    openEditor({ title: t.title, note: t.note, tags: t.tags, color: t.color, fromTodo: t.id, date: state.selDay });
  } else if (act === 'del') {
    removeTodo(id);
  }
}
/* 待办拖到网格排期（鼠标拖拽；触屏用「排期」按钮） */
let todoDrag = null;
function onTodoPointerDown(e) {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  if (e.target.closest('[data-act]')) return;
  const row = e.target.closest('.todo'); if (!row) return;
  const t = state.todos.find(x => x.id === row.dataset.id); if (!t) return;
  todoDrag = { id: t.id, t, x: e.clientX, y: e.clientY, active: false };
}
el.todoList.addEventListener('pointerdown', onTodoPointerDown);
el.todoDone.addEventListener('pointerdown', onTodoPointerDown);
window.addEventListener('pointermove', e => {
  if (!todoDrag) return;
  if (!todoDrag.active) {
    if (Math.abs(e.clientX - todoDrag.x) < 6 && Math.abs(e.clientY - todoDrag.y) < 6) return;
    todoDrag.active = true;
    const g = document.createElement('div');
    g.className = 'dragghost'; g.textContent = todoDrag.t.title;
    document.body.appendChild(g);
    todoDrag.ghost = g;
  }
  todoDrag.ghost.style.left = (e.clientX + 12) + 'px';
  todoDrag.ghost.style.top = (e.clientY + 8) + 'px';
  const col = colAtX(e.clientX);
  document.querySelectorAll('.day-col.is-target').forEach(c => c.classList.remove('is-target'));
  if (!col) { todoDrag.target = null; return; }
  col.classList.add('is-target');
  /* 与卡片拖拽同一套坐标系：待办落点也按吸附粒度对齐 */
  const r = gridRange(), rect = col.getBoundingClientRect();
  todoDrag.target = { date: col.dataset.date, start: snapTo(pxToMin(e.clientY - rect.top, r), r) };
});
window.addEventListener('pointerup', () => {
  if (!todoDrag) return;
  const d = todoDrag; todoDrag = null;
  if (d.ghost) d.ghost.remove();
  document.querySelectorAll('.day-col.is-target').forEach(c => c.classList.remove('is-target'));
  if (!d.active || !d.target) return;
  openEditor({
    title: d.t.title, note: d.t.note, tags: d.t.tags, color: d.t.color,
    fromTodo: d.t.id, date: d.target.date, start: d.target.start
  });
});

$('todoAdd').addEventListener('click', () => { addTodo(el.todoInput.value); el.todoInput.value = ''; el.todoInput.focus(); });
el.todoInput.addEventListener('keydown', e => { if (e.key === 'Enter') { addTodo(el.todoInput.value); el.todoInput.value = ''; } });
$('clearDone').addEventListener('click', () => {
  const n = state.todos.filter(t => t.done).length; if (!n) return;
  const backup = state.todos.slice();
  state.todos = state.todos.filter(t => !t.done); save(true); render();
  toast(`已清除 ${n} 条`, () => { state.todos = backup; save(true); render(); });
});

/* 弹层按钮 */
el.edSave.addEventListener('click', saveEditor);
el.edCancel.addEventListener('click', () => closeModal(el.editorModal));
el.edDelete.addEventListener('click', () => {
  if (!edCtx.id) return;
  const idx = state.items.findIndex(i => i.id === edCtx.id);
  const it = state.items[idx];
  removeItem(edCtx.id); closeModal(el.editorModal);
  toast('已删除', () => { state.items.splice(idx, 0, it); save(true); render(); });
});
el.fColors.addEventListener('click', e => { const b = e.target.closest('[data-color]'); if (b) setColor(b.dataset.color); });
el.dEdit.addEventListener('click', () => { const id = detailId; closeModal(el.detailModal); openEditor({ id }); });
el.dDelete.addEventListener('click', () => {
  const idx = state.items.findIndex(i => i.id === detailId);
  const it = state.items[idx];
  removeItem(detailId); closeModal(el.detailModal);
  toast('已删除', () => { state.items.splice(idx, 0, it); save(true); render(); });
});
el.dDone.addEventListener('click', () => {
  const it = state.items.find(i => i.id === detailId);
  if (it) { it.done = !it.done; save(true); render(); }
  closeModal(el.detailModal);
});
el.fTitle.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveEditor(); } });

/* 搜索 */
let searchTimer = null;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => doSearch(el.search.value), 140);
});
el.searchResults.addEventListener('click', e => {
  const r = e.target.closest('.res-item'); if (!r) return;
  el.searchResults.hidden = true; el.search.value = '';
  if (r.dataset.kind === 'item') jumpToItem(r.dataset.id); else jumpToTodo(r.dataset.id);
});
document.addEventListener('click', e => { if (!e.target.closest('.searchbox')) el.searchResults.hidden = true; });

/* 设置 */
/* 备忘正文可选的中文字体；与悬浮窗、主进程共用同一组 canonical 值 */
const PLAN_FONTS = ['kai', 'xing', 'li', 'fang'];

/* ============================================================
   外观设置：皮肤色板 + 字体分段，全部即时生效
   —— 从「只能在小方块里改」搬到日历主界面，两边共用 shared，
   改动立刻经 pushShared 同步到悬浮窗，不用点任何「应用」按钮。
   ============================================================ */
function chipGrad(sk) {
  const c = (sk.sw && sk.sw.length === 3) ? sk.sw : ['#888', '#666', '#444'];
  return `linear-gradient(135deg,${c[0]} 0 33%, ${c[1]} 33% 66%, ${c[2]} 66% 100%)`;
}
function buildSkinGrid() {
  const grid = $('skinGrid');
  if (!grid || grid.children.length) return;
  grid.innerHTML = SKINS.map(sk => `
    <button class="skin-chip" data-skin="${sk.id}" title="${(sk.hint || sk.label).replace(/"/g, '&quot;')}">
      <span class="skin-sw" style="background:${chipGrad(sk)}" aria-hidden="true"></span>
      <span class="skin-name">${sk.label}</span>
    </button>`).join('');
  grid.addEventListener('click', e => {
    const b = e.target.closest('.skin-chip');
    if (b) applySkin(b.dataset.skin);
  });
}
function syncSkinGrid(cur) {
  const grid = $('skinGrid');
  if (!grid) return;
  [...grid.querySelectorAll('.skin-chip')].forEach(b => {
    b.classList.toggle('is-on', b.dataset.skin === cur);
  });
}
function syncFontSeg(cur) {
  const seg = $('fontSeg');
  if (!seg) return;
  [...seg.querySelectorAll('button')].forEach(b => {
    b.classList.toggle('is-on', b.dataset.font === cur);
  });
}
function applySkin(id) {
  const sk = SKINS.find(k => k.id === id);
  state.settings.skin = sk ? sk.id : 'rice';
  applySettings();
  syncSkinGrid(state.settings.skin);
  save(true);
  render();
  pushShared();
  if (sk) toast(`皮肤：${sk.label}`);
}
function applyFont(id) {
  state.settings.font = PLAN_FONTS.indexOf(id) >= 0 ? id : 'default';
  applySettings();
  syncFontSeg(state.settings.font);
  save(true);
  render();
  pushShared();
  const lb = { default: '黑体', kai: '楷体', xing: '行楷', li: '隶书', fang: '仿宋' };
  toast(`字体：${lb[state.settings.font] || '黑体'}`);
}

el.sideToggle.addEventListener('click', () => toggleSide());
el.sideMini.addEventListener('click', () => toggleSide(false));

/* 日历 ↔ 小方框：只把对方叫出来，日历自己不动 */
$('toggleWidget').addEventListener('click', () => {
  if (window.api && window.api.toggleWidget) window.api.toggleWidget();
  else toast('浏览器模式下没有小方块');
});

$('openSettings').addEventListener('click', () => {
  el.sStart.value = state.settings.startHour;
  el.sEnd.value = state.settings.endHour;
  el.sHourH.value = state.settings.hourH;
  el.sSnap.value = snapMin();
  buildSkinGrid();
  syncSkinGrid(state.settings.skin);
  syncFontSeg(state.settings.font);
  showModal(el.settingsModal);
});

function applySettings() {
  const S = state.settings;
  S.startHour = clamp(+S.startHour, 0, 23);
  S.endHour = clamp(+S.endHour, S.startHour + 1, 24);
  /* 归一：外部写入的脏值一律落回 rice，
     绝不让 data-skin="" 导致整套颜色失效 */
  S.skin = SKINS.some(k => k.id === S.skin) ? S.skin : 'rice';
  document.documentElement.dataset.skin = S.skin;
  refreshColors();
  document.documentElement.dataset.font = PLAN_FONTS.indexOf(S.font) >= 0 ? S.font : 'default';
}
el.sStart.addEventListener('change', () => { state.settings.startHour = +el.sStart.value; if (state.settings.endHour <= state.settings.startHour) { state.settings.endHour = state.settings.startHour + 1; el.sEnd.value = state.settings.endHour; } applySettings(); save(true); render(); });
el.sEnd.addEventListener('change', () => { state.settings.endHour = +el.sEnd.value; if (state.settings.endHour <= state.settings.startHour) { state.settings.startHour = state.settings.endHour - 1; el.sStart.value = state.settings.startHour; } applySettings(); save(true); render(); });
el.sHourH.addEventListener('change', () => { state.settings.hourH = +el.sHourH.value; save(true); render(); });
el.sSnap.addEventListener('change', () => { state.settings.snapMin = +el.sSnap.value; save(true); render(); });
$('fontSeg').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) applyFont(b.dataset.font);
});

$('btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `周计划备份-${iso(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('btnImport').addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files && el.fileInput.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const s = JSON.parse(r.result);
      if (!Array.isArray(s.items) && !Array.isArray(s.todos)) throw new Error('格式不对');
      state.items = Array.isArray(s.items) ? s.items : [];
      state.todos = Array.isArray(s.todos) ? s.todos : [];
      Object.assign(state.settings, s.settings || {});
      applySettings(); save(true); render(); closeModal(el.settingsModal);
      toast('已导入备份');
    } catch (err) { toast('导入失败：文件不是本应用导出的备份'); }
  };
  r.readAsText(f);
  el.fileInput.value = '';
});
$('btnClear').addEventListener('click', () => {
  if (!confirm('确定清空全部备忘和待办？此操作不可撤销（建议先导出备份）。')) return;
  state.items = []; state.todos = []; state.filterTags = [];
  save(true); render(); closeModal(el.settingsModal); toast('已清空');
});

/* 移动端分页 */
document.querySelectorAll('.mtab').forEach(b => b.addEventListener('click', () => {
  document.body.dataset.view = b.dataset.view;
  document.querySelectorAll('.mtab').forEach(x => x.classList.toggle('is-on', x === b));
}));

/* 键盘 */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); el.searchResults.hidden = true; return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (typing || document.querySelector('.modal:not([hidden])')) return;
  if (e.key === 'ArrowLeft') $('prevWeek').click();
  if (e.key === 'ArrowRight') $('nextWeek').click();
  if (e.key === 'n' || e.key === 'N') {
    const now = new Date();
    openEditor({ date: NARROW.matches ? state.selDay : iso(now), start: clamp(Math.round((now.getHours() * 60 + now.getMinutes()) / 30) * 30, 0, 23 * 60 + 30) });
  }
  if (e.key === 't' || e.key === 'T') $('thisWeek').click();
});

/* 断点切换 + 当前时间线刷新 */
if (NARROW.addEventListener) NARROW.addEventListener('change', () => render());
setInterval(updateClock, 1000);                                                   // 顶栏时钟每秒走
/* 每半分钟整体刷新一遍：当前时间线会走，右侧两张统计卡也跟着重算
   （跨零点、事件开始/结束时，"当日"口径会自动跟上） */
setInterval(() => {
  if (document.querySelector('.modal:not([hidden])')) return;
  renderGrid(); renderStats(); renderStatsPanel(); renderOverview(); renderStatusBar();
}, 30000);

/* ---------------- 与悬浮小方框共用一份数据、一套外观 ----------------
   浏览器模式下没有 window.api，下面这些自动跳过，页面照常独立运行。

   pushShared 用函数声明而不是 const 箭头函数：applySkin / applyFont
   在文件中部就要调它，const 版本在那个位置还处于 TDZ，直接抛
   "Cannot access 'pushShared' before initialization"。 */
function pushShared() {
  if (window.api && window.api.sharedSet) {
    window.api.sharedSet({ skin: state.settings.skin, font: state.settings.font });
  }
}

if (window.api) {
  /* 侧边栏那边改了数据（新增待办、排期、勾选），这里整份重载 */
  if (window.api.onPlanExternal) window.api.onPlanExternal(() => {
    state = load();
    applySettings(); render();
  });
  /* 侧边栏点某一条 → 打开完整窗口并跳到那条 */
  if (window.api.onGoto) window.api.onGoto(p => {
    if (p && p.id) { setTimeout(() => jumpToItem(p.id), 60); }
  });

  // 悬浮窗那边改了皮肤/字体，这里跟着换（含设置弹层里的选中态）
  if (window.api.onShared) window.api.onShared(s => {
    let changed = false;
    if (s.skin && s.skin !== state.settings.skin) { state.settings.skin = s.skin; changed = true; }
    const f = PLAN_FONTS.indexOf(s.font) >= 0 ? s.font : 'default';
    if (f !== state.settings.font) { state.settings.font = f; changed = true; }
    if (changed) {
      applySettings(); render();
      syncSkinGrid(state.settings.skin);
      syncFontSeg(state.settings.font);
    }   // 只改内存，不回写，避免两边互推
  });
  /* 皮肤 / 字体在 applySkin / applyFont 里各自调 pushShared 了，
     这里不需要再挂 change 监听（旧的 el.sSkin / el.sFont 下拉框已删）。 */
}

/* ---------------- 启动 ---------------- */
document.body.dataset.view = 'plan';
fillSelects();
applySettings();
applySide();
if (!state.cursor) state.cursor = iso(startOfWeek(new Date()));
if (!state.selDay) state.selDay = iso(new Date());
updateClock();
render();
