/* ============================================================
   桌边 · DeskMemo 渲染层
   三档形态：collapsed → peek → full（由主进程根据鼠标位置驱动）
   单条备忘三层：标题行 / 悬停操作 / 点击展开详情
   ============================================================ */

const COLORS = {
  dai:  { key: 'dai',  css: 'var(--c-dai)',  label: '黛' },
  tong: { key: 'tong', css: 'var(--c-tong)', label: '铜' },
  tai:  { key: 'tai',  css: 'var(--c-tai)',  label: '苔' },
  ou:   { key: 'ou',   css: 'var(--c-ou)',   label: '藕' },
  zhu:  { key: 'zhu',  css: 'var(--c-zhu)',  label: '朱' },
};
const COLOR_ORDER = ['dai', 'tong', 'tai', 'ou', 'zhu'];

const TIPS = [
  '想到就敲，回车即存',
  '按住顶栏可以拖到任意位置',
  '鼠标离开，它会自己贴回边缘',
  '双击文字可以改',
  '输入 ! 标记为重要',
  '输入 #标签 方便归类',
  '点右侧箭头可以展开备注和子任务',
];

/* ---------- 数据桥接 ---------- */
/* ============================================================
   皮肤清单：与 app/shared/store-schema.js 的 SKINS 保持一致。
   渲染进程开了 contextIsolation 且没打包器，不能 require 主进程模块，
   所以这份是刻意复制的——改皮肤清单时两处都要改。
   ============================================================ */
/* sw = 该皮肤的预览色板（三段渐变，取自 skins.css 里的五色）。
   六块色板要同时显示，没法靠逐个切 data-skin 激活，只能直接给色值。 */
const S_SKIN = [
  { id: 'rice',   label: '宣纸', hint: '素白宣底，五色矿物字', sw: ['#467A4E', '#33587C', '#6D4C85'] },
  { id: 'mist',   label: '青山', hint: '风景。青绿山岚，石青配苔绿', sw: ['#3F7A4A', '#2C5F6B', '#5D6B86'] },
  { id: 'sakura', label: '樱SA', hint: '动漫。樱粉淡紫，藕荷配朱砂', sw: ['#5E8C55', '#8E5A9E', '#B24A5C'] },
  { id: 'dusk',   label: '暮色', hint: '深蓝夜色，五色提亮一档', sw: ['#8FAD83', '#86A8C6', '#C79CB8'] },
  { id: 'nebula', label: '星野', hint: '航天。深空紫蓝，星点铺底', sw: ['#6FD6A8', '#7FB4E8', '#B79BF0'] },
  { id: 'forge',  label: '熔炉', hint: '游戏。暗铜炭底，火色高亮', sw: ['#8FBF6A', '#7FA0C4', '#E0A44E'] },
];
const S_SKIN_IDS = new Set(S_SKIN.map(k => k.id));
/* 三段色板渐变：把该皮肤的三支代表色摆成135°斜条 */
function chipGrad(sk) {
  const c = (sk.sw && sk.sw.length === 3) ? sk.sw : ['#888', '#666', '#444'];
  return `linear-gradient(135deg,${c[0]} 0 33%, ${c[1]} 33% 66%, ${c[2]} 66% 100%)`;
}

const IS_ELECTRON = typeof window.api !== 'undefined' && window.api?.ready === true;

async function loadState() {
  if (IS_ELECTRON) return await window.api.load();
  try {
    const raw = localStorage.getItem('deskmemo');
    if (raw) return JSON.parse(raw);
  } catch (e) { /* 读坏了就重来 */ }
  return null;
}
function saveState() {
  if (IS_ELECTRON) { window.api.save(JSON.parse(JSON.stringify(state))); return; }
  try { localStorage.setItem('deskmemo', JSON.stringify(state)); } catch (e) {}
}

/* ---------- 状态 ---------- */
function defaultState() {
  return {
    v: 2,
    settings: {
      skin: 'rice',
      edge: 'right',
      lock: false,
      pin: true,
      stealth: true,
      idle: 35,
      blur: 26,
      alpha: 72,
      grain: 35,
      archiveAfter: 10,
      draftColor: 'dai',
      bootLaunch: false,
    },
    items: [
      { id: uid(), text: '鼠标移到屏幕右边，我就滑出来', note: '', subs: [], done: false,
        star: true, color: 'dai', tags: [], remindAt: null, createdAt: Date.now(), doneAt: null },
      { id: uid(), text: '移开几秒，我贴回边缘，只留一条细线', note: '', subs: [], done: false,
        star: false, color: 'tai', tags: [], remindAt: null, createdAt: Date.now() - 1000, doneAt: null },
      { id: uid(), text: '点右边这个箭头，能加备注和子任务', note: '大事项拆成小步骤，一条备忘就够了。',
        subs: [{ id: uid(), text: '试试给这条加个子任务', done: false }],
        done: false, star: false, color: 'tong', tags: [], remindAt: null,
        createdAt: Date.now() - 2000, doneAt: null, open: true },
    ],
    archived: [],
  };
}

const state = defaultState();
let draftColor = 'dai';
let remindTargetId = null;
let dragId = null;
let mode = 'full';
let filterTag = null;
let dockTab = 'today';        // 侧边栏停在哪个标签：notes | today
let todayData = null;         // 今日页的数据快照（来自同一份 store.json）

/* ---------- 工具 ---------- */
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pad(n) { return String(n).padStart(2, '0'); }

function fmtRemind(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const tmr = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = sameDay(d, now) ? '今天' : sameDay(d, tmr) ? '明天' : `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${day} ${time}`;
}
function fmtAge(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} 天前` : `${new Date(ts).getMonth() + 1}月${new Date(ts).getDate()}日`;
}
function parseInput(raw) {
  let s = raw.trim();
  if (!s) return null;
  const tags = [];
  s = s.replace(/#([^\s#]{1,10})/g, (_, t) => { tags.push(t); return ''; });
  const star = s.includes('!');
  s = s.replace(/!/g, '');
  const text = s.replace(/\s{2,}/g, ' ').trim();
  if (!text) return { text: tags.join(' ') || '#', star, tags };
  return { text, star, tags };
}
function firstUrl(s) {
  const m = String(s || '').match(/https?:\/\/[^\s，。）】]+/);
  return m ? m[0] : '';
}
function normalize(i) {
  i.subs = Array.isArray(i.subs) ? i.subs : [];
  i.note = i.note || '';
  i.tags = Array.isArray(i.tags) ? i.tags : [];
  return i;
}

/* ---------- DOM ---------- */
const $ = id => document.getElementById(id);
const el = {
  card: $('card'), date: $('dateLabel'), pending: $('pendingChip'),
  input: $('input'), composerBar: $('composerBar'), swatches: $('swatches'),
  list: $('list'), listWrap: $('listWrap'), empty: $('empty'),
  doneZone: $('doneZone'), doneHead: $('doneHead'), doneList: $('doneList'), doneCount: $('doneCount'),
  footTip: $('footTip'), clearDone: $('clearDone'),
  planBtn: $('planBtn'), planTip: $('planTip'),
  menuBtn: $('menuBtn'), lockBtn: $('lockBtn'),
  sheet: $('sheet'), skinGrid: $('skinGrid'), edgeSeg: $('edgeSeg'), fontSeg: $('fontSeg'),
  idleRange: $('idleRange'), pinSw: $('pinSw'), lockSw: $('lockSw'),
  stealthSw: $('stealthSw'), bootSw: $('bootSw'), motionSw: $('motionSw'),
  blurRange: $('blurRange'), alphaRange: $('alphaRange'), grainRange: $('grainRange'),
  blurVal: $('blurVal'), alphaVal: $('alphaVal'), grainVal: $('grainVal'),
  archiveSeg: $('archiveSeg'),
  exportBtn: $('exportBtn'), quitBtn: $('quitBtn'), sheetNote: $('sheetNote'),
  remindSheet: $('remindSheet'), remindChips: $('remindChips'),
  remindInput: $('remindInput'), remindSet: $('remindSet'), remindClear: $('remindClear'),
  archiveBtn: $('archiveBtn'), archiveSheet: $('archiveSheet'),
  archiveList: $('archiveList'), archiveCount: $('archiveCount'),
  archiveClear: $('archiveClear'), archiveClose: $('archiveClose'),
  toast: $('toast'),

  /* 贴边悬浮条 + 备忘/今日双标签 */
  bar: $('bar'), barAdd: $('barAdd'), barNum: $('barNum'), barOpen: $('barOpen'),
  tabs: $('tabs'), tabNote: $('tabNote'), expandBtn: $('expandBtn'),
  paneNotes: $('paneNotes'), paneToday: $('paneToday'),
  todayDate: $('todayDate'), todaySum: $('todaySum'),
  todayInput: $('todayInput'), todayAdd: $('todayAdd'),
  todayPlanList: $('todayPlanList'), todayTodoList: $('todayTodoList'),
  secPlanCount: $('secPlanCount'), secTodoCount: $('secTodoCount'),
  todayEmpty: $('todayEmpty'),
};

const ICON = {
  check:  '<svg viewBox="0 0 12 12"><path d="M2.5 6.2 4.7 8.4 9.5 3.6"/></svg>',
  subChk: '<svg viewBox="0 0 12 12"><path d="M2.5 6.2 4.7 8.4 9.5 3.6"/></svg>',
  star:   '<svg viewBox="0 0 12 12"><path d="M6 1.4l1.5 3.1 3.4.5-2.5 2.4.6 3.4L6 9.2 2.9 10.8l.6-3.4L1 5l3.4-.5z" stroke-linejoin="round"/></svg>',
  bell:   '<svg viewBox="0 0 12 12"><path d="M3.2 5.2a2.8 2.8 0 0 1 5.6 0c0 2 .7 2.7.7 3.3H2.5c0-.6.7-1.3.7-3.3z"/><path d="M5.1 10.1a1.1 0 0 0 1.8 0"/></svg>',
  trash:  '<svg viewBox="0 0 12 12"><path d="M2.4 3.5h7.2M4.6 3.5V2.4h2.8v1.1M3.4 3.5l.5 6.1h4.2l.5-6.1"/></svg>',
  expand: '<svg viewBox="0 0 12 12"><path d="M4 2.5 8 6l-4 3.5" stroke-linejoin="round"/></svg>',
  pencil: '<svg viewBox="0 0 12 12"><path d="M8.3 1.9l1.8 1.8-5.6 5.6-2.3.6.6-2.3z" stroke-linejoin="round"/><path d="M7.5 2.7l1.8 1.8"/></svg>',
  x:      '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
};

/* ============================================================
   渲染
   ============================================================ */
function render() {
  const s = state.settings;

  document.body.dataset.skin = S_SKIN_IDS.has(s.skin) ? s.skin : 'rice';
  document.body.dataset.edge = s.edge || 'right';
  document.body.dataset.font = canonFontKey(s.font);

  applyTexture();
  syncControls();

  const now = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  el.date.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${week}`;

  el.composerBar.style.setProperty('--draft-color', COLORS[draftColor].css);
  [...el.swatches.children].forEach(b => b.classList.toggle('is-on', b.dataset.color === draftColor));

  state.items.forEach(normalize);
  const open = state.items.filter(i => !i.done && (!filterTag || (i.tags || []).includes(filterTag)));
  const done = state.items.filter(i => i.done);

  // 列表整块重建：用 FLIP 包一层，让新增/移除/换位变成滑动而不是瞬切。
  // 注意 mutate 内部只做 DOM 更新，数据在此之前已经改完，动画失败也不影响数据。
  MOTION.flip([el.list, el.doneList], () => {
    el.list.innerHTML = open.map(i => liHTML(i, false)).join('');
    el.empty.hidden = open.length > 0;

    el.doneZone.hidden = done.length === 0;
    el.doneCount.textContent = `已完成 ${done.length}`;
    el.doneList.innerHTML = done.slice().sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
                                       .map(i => liHTML(i, true)).join('');
  });

  el.pending.textContent = filterTag ? `#${filterTag} · ${open.length}` : (open.length ? `${open.length} 件待办` : '');

  const starred = open.filter(i => i.star).length;
  el.footTip.textContent = open.length === 0
    ? (done.length ? '都做完了，挺好' : pickTip())
    : (starred ? `${starred} 件重要 · ${open.length} 件待办` : `${open.length} 件待办`);
  if (filterTag) el.footTip.textContent = `只看 #${filterTag} · 点标签退出`;

  // 归档入口
  const n = state.archived.length;
  el.archiveBtn.hidden = n === 0;
  el.archiveBtn.textContent = `归档 ${n}`;
  el.clearDone.hidden = done.length === 0;

  el.lockBtn.classList.toggle('is-on', !!s.lock);

  applyTab();
  bindList();
  fitWindow();
}

// 整块内容要换掉时用 View Transitions 做交叉淡入（不支持就退化成瞬时切换）
function renderTransitioned() { MOTION.vt(() => render()); }

/* ============================================================
   侧边栏两个标签：备忘（原便签） / 今日（今日待办与快速排期）
   ============================================================ */
const TAG_C = ['#33587C', '#467A4E', '#6D4C85', '#8F6432', '#953F37'];
function tagColor(t) {
  let h = 0;
  for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TAG_C[h % TAG_C.length];
}
function fmtMin(m) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
function todayLabel(ds) {
  const p = String(ds || '').split('-').map(Number);
  if (p.length < 3) return '今天';
  const d = new Date(p[0], p[1] - 1, p[2]);
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${p[1]}月${p[2]}日 ${w}`;
}

function applyTab() {
  document.body.dataset.tab = dockTab;
  el.paneNotes.hidden = dockTab !== 'notes';
  el.paneToday.hidden = dockTab !== 'today';
  el.tabs.querySelectorAll('.tab').forEach(b => b.classList.toggle('is-on', b.dataset.tab === dockTab));
}
function setTab(t, silent) {
  dockTab = t === 'notes' ? 'notes' : 'today';
  applyTab();
  if (!silent) { state.settings.dockTab = dockTab; saveState(); }
  setTimeout(fitWindow, 40);
}

/* 今日页 + 悬浮条上的数量，都用同一份数据 */
function paintToday(v) {
  if (!v) return;
  todayData = v;
  const items = v.items || [];
  const todos = v.todos || [];

  el.barNum.textContent = String(v.pending || 0);
  el.todayDate.textContent = `今日 · ${todayLabel(v.todayStr)}`;
  el.todaySum.textContent = `${items.length} 项日程 · ${((v.minutes || 0) / 60).toFixed(1)} 小时`;
  el.secPlanCount.textContent = `(${items.length})`;
  el.secTodoCount.textContent = v.doneCount ? `(${todos.length} · 已完成 ${v.doneCount})` : `(${todos.length})`;
  el.tabNote.textContent = v.pending ? `${v.pending} 项待办` : '';

  const rowItem = i => `
    <li class="trow${i.done ? ' is-done' : ''}" data-kind="item" data-id="${esc(i.id)}">
      <button class="tchk" data-act="item-toggle" aria-label="完成"></button>
      <span class="ttime">${fmtMin(i.startMin)}</span>
      <span class="ttitle mf">${esc(i.title)}</span>
      ${(i.tags && i.tags.length) ? `<span class="tdot" style="--c:${tagColor(i.tags[0])}" title="#${esc(i.tags[0])}"></span>` : ''}
      <span class="tacts"><button data-act="goto" title="在完整窗口里打开">↗</button></span>
    </li>`;
  const rowTodo = t => `
    <li class="trow" data-kind="todo" data-id="${esc(t.id)}">
      <button class="tchk" data-act="todo-toggle" aria-label="完成"></button>
      <span class="ttitle mf">${esc(t.title)}</span>
      ${(t.tags && t.tags.length) ? `<span class="tdot" style="--c:${tagColor(t.tags[0])}" title="#${esc(t.tags[0])}"></span>` : ''}
      <span class="tacts">
        <button data-act="todo-plan" title="排到今天最近的空档">排期</button>
        <button data-act="todo-del" title="删除">✕</button>
      </span>
    </li>`;

  MOTION.flip([el.todayPlanList, el.todayTodoList], () => {
    el.todayPlanList.innerHTML = items.length ? items.map(rowItem).join('')
      : '<li class="tsec-empty">今天还没有排任何时段</li>';
    el.todayTodoList.innerHTML = todos.length ? todos.map(rowTodo).join('')
      : '<li class="tsec-empty">待办清完了</li>';
  });
  el.todayEmpty.hidden = items.length > 0 || todos.length > 0;
  setTimeout(fitWindow, 40);
}

/* 今日页的改动都走主进程，改完它把新视图推回来 */
async function todayDo(act) {
  if (!IS_ELECTRON || !window.api.todayAct) return;
  const v = await window.api.todayAct(act);
  if (v) paintToday(v);
}

function addTodayTodo() {
  const title = el.todayInput.value.trim();
  if (!title) { el.todayInput.focus(); return; }
  el.todayInput.value = '';
  todayDo({ kind: 'todo:add', title });
}

function onTodayClick(e) {
  const btn = e.target.closest('[data-act]');
  const row = e.target.closest('.trow');
  if (!row) return;
  const id = row.dataset.id;
  const act = btn ? btn.dataset.act : (row.dataset.kind === 'item' ? 'goto' : '');
  if (!act) return;
  if (act === 'item-toggle') todayDo({ kind: 'item:toggle', id });
  else if (act === 'todo-toggle') todayDo({ kind: 'todo:toggle', id });
  else if (act === 'todo-del') todayDo({ kind: 'todo:del', id });
  else if (act === 'todo-plan') todayDo({ kind: 'todo:schedule', id });
  else if (act === 'goto') {
    if (IS_ELECTRON && window.api.gotoPlan) window.api.gotoPlan({ id });
    else if (IS_ELECTRON) window.api.openPlan();
  }
}

/* 悬浮条上的「+」：展开到完整态并把光标放进当前标签的输入框 */
function quickAdd() {
  if (!IS_ELECTRON) { setTab(dockTab); return; }
  window.api.requestFull();
  setTimeout(() => {
    const inp = dockTab === 'today' ? el.todayInput : el.input;
    try { inp.focus(); } catch (e) {}
  }, 420);
}

/* ============================================================
   质感：不透明度 / 毛玻璃 / 纸张噪点 / 闲置淡化
   ------------------------------------------------------------
   为什么必须同时写给 html 和 body：
   --bg-a / --blur / --grain 在 skins.css 里挂在
   「:root, html[data-skin=…], body[data-skin=…」两个作用域上，
   而悬浮窗的皮肤属性打在 <body> 上。body[data-skin="rice"] 这条
   声明比 html 上的内联样式离 .card 更近，只用
   documentElement.style.setProperty 写会被它整条盖掉，
   于是 JS 里变量确实变了、实际渲染纹丝不动。
   ============================================================ */
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};

function applyTexture() {
  const s = state.settings;
  const alpha = clampNum(s.alpha, 20, 100, 90) / 100;   // 20% ≈ 接近全透明
  const blur = clampNum(s.blur, 0, 44, 26);             // 0 = 关掉毛玻璃
  const grain = clampNum(s.grain, 0, 100, 35) / 1000;   // 0–100 → 0–0.10
  const idle = clampNum(s.idle, 10, 100, 35) / 100;

  const write = (node) => {
    node.style.setProperty('--bg-a', String(alpha));
    node.style.setProperty('--blur', blur + 'px');
    node.style.setProperty('--grain', String(grain));
    node.style.setProperty('--idle-o', String(Math.max(0.1, Math.min(1, idle))));
  };
  write(document.documentElement);
  write(document.body);

  // blur 为 0 时把整个 backdrop-filter 摘掉，避免 saturate 继续染色
  document.documentElement.dataset.blurOff = blur === 0 ? '1' : '0';
}

/* 三项质感在面板右侧的实时读数，拖的时候能看见数字在动 */
function textureReadout() {
  const s = state.settings;
  const blur = clampNum(s.blur, 0, 44, 26);
  if (el.blurVal) el.blurVal.textContent = blur === 0 ? '关' : blur + 'px';
  if (el.alphaVal) el.alphaVal.textContent = clampNum(s.alpha, 20, 100, 90) + '%';
  if (el.grainVal) el.grainVal.textContent = clampNum(s.grain, 0, 100, 35) === 0 ? '关' : String(clampNum(s.grain, 0, 100, 35));
}

function syncControls() {
  const s = state.settings;
  syncSkinGrid(s.skin);
  [...el.edgeSeg.children].forEach(b => b.classList.toggle('is-on', b.dataset.edge === (s.edge || 'right')));
  [...el.fontSeg.children].forEach(b => b.classList.toggle('is-on', b.dataset.font === (s.font || 'sans')));
  [...el.archiveSeg.children].forEach(b => b.classList.toggle('is-on', Number(b.dataset.min) === s.archiveAfter));
  el.idleRange.value = s.idle;
  el.blurRange.value = s.blur;
  el.alphaRange.value = s.alpha;
  el.grainRange.value = s.grain;
  el.pinSw.setAttribute('aria-checked', String(s.pin));
  el.lockSw.setAttribute('aria-checked', String(s.lock));
  el.stealthSw.setAttribute('aria-checked', String(s.stealth));
  el.bootSw.setAttribute('aria-checked', String(s.bootLaunch));
  MOTION.setPref(s.motion);                       // undefined=跟随系统 / true / false
  el.motionSw.setAttribute('aria-checked', String(MOTION.isEnabled()));
  textureReadout();
}

let tipIdx = -1;
function pickTip() { tipIdx = (tipIdx + 1) % TIPS.length; return TIPS[tipIdx]; }

function liHTML(i, isDone) {
  const c = COLORS[i.color] || COLORS.dai;
  const meta = [];
  if (i.remindAt) {
    const over = !isDone && i.remindAt < Date.now();
    meta.push(`<span class="bell is-hot" style="color:${over ? 'var(--c-zhu)' : ''}">${ICON.bell}${fmtRemind(i.remindAt)}</span>`);
  }
  const subDone = i.subs.filter(s => s.done).length;
  if (i.subs.length) meta.push(`<span>${subDone}/${i.subs.length} 步</span>`);
  if (i.note) meta.push(`<span>有备注</span>`);
  (i.tags || []).forEach(t => meta.push(`<span class="tag" data-tag="${esc(t)}">#${esc(t)}</span>`));
  if (isDone && i.doneAt) meta.push(`<span>${fmtAge(i.doneAt)}完成</span>`);
  else if (!meta.length) meta.push(`<span>${fmtAge(i.createdAt)}</span>`);

  const url = firstUrl(i.text + ' ' + i.note);

  return `
  <li class="item ${isDone ? 'is-done' : ''} ${i._new ? 'new' : ''} ${i.open ? 'open' : ''}" draggable="true"
      data-id="${i.id}" style="--item-color:${c.css}">
    <button class="check" data-act="toggle" aria-label="完成">${ICON.check}</button>
    <div class="item-body">
      <p class="item-text" data-act="edit">${esc(i.text)}</p>
      <div class="item-meta">${meta.join('')}</div>
      <div class="detail">
        <textarea class="note-area" data-act="note" placeholder="补充几句…">${esc(i.note)}</textarea>
        <ul class="subs">
          ${i.subs.map(s => `
            <li class="sub ${s.done ? 'done' : ''}" data-sub="${s.id}">
              <button class="sub-check" data-act="sub-toggle">${ICON.subChk}</button>
              <span class="sub-text" data-act="sub-edit">${esc(s.text)}</span>
              <button class="sub-del" data-act="sub-del">${ICON.x}</button>
            </li>`).join('')}
        </ul>
        <input class="sub-input" data-act="sub-add" placeholder="子任务，回车添加" hidden />
        <button class="add-sub" data-act="sub-start">+ 添加子任务</button>
        ${url ? `<a class="detail-link" href="${esc(url)}" target="_blank">${esc(url)}</a>` : ''}
      </div>
    </div>
    <div class="item-acts">
      <button class="act" data-act="edit-title" title="改文字">${ICON.pencil}</button>
      <button class="act" data-act="expand" title="展开备注与子任务（双击条目同效）">${ICON.expand}</button>
      <button class="act ${i.star ? 'is-on' : ''}" data-act="star" title="标记重要">${ICON.star}</button>
      <button class="act ${i.remindAt ? 'is-on' : ''}" data-act="remind" title="设置提醒">${ICON.bell}</button>
      <button class="act del" data-act="del" title="删除">${ICON.trash}</button>
    </div>
  </li>`;
}

/* ---------- 列表事件 ---------- */
function bindList() {
  document.querySelectorAll('.item').forEach(node => {
    node.addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'edit' || act === 'note' || act === 'sub-edit') return;
      const id = node.dataset.id;
      if (act === 'toggle') toggleDone(id);
      if (act === 'edit-title') { startEdit(id, node.querySelector('.item-text')); return; }
      if (act === 'star')   toggleStar(id);
      if (act === 'del')    removeItem(id);
      if (act === 'remind') openRemind(id);
      if (act === 'expand') { toggleOpen(id); return; }
      if (act === 'sub-start') { const inp = node.querySelector('.sub-input'); inp.hidden = false; inp.focus(); return; }
      if (act === 'sub-toggle') {
        const sid = btn.closest('.sub').dataset.sub;
        subToggle(id, sid); return;
      }
      if (act === 'sub-del') {
        const sid = btn.closest('.sub').dataset.sub;
        subRemove(id, sid); return;
      }
      const tagEl = e.target.closest('.tag');
      if (tagEl) filterTag = filterTag === tagEl.dataset.tag ? null : tagEl.dataset.tag;
      if (tagEl) { renderTransitioned(); }
    });

    // 标签筛选（meta 区点击）
    node.querySelectorAll('.tag').forEach(t => {
      t.addEventListener('click', ev => {
        ev.stopPropagation();
        filterTag = filterTag === t.dataset.tag ? null : t.dataset.tag;
        renderTransitioned();
      });
    });

    // 备注输入
    const note = node.querySelector('.note-area');
    if (note) {
      note.addEventListener('input', () => {
        const i = state.items.find(x => x.id === node.dataset.id);
        if (i) { i.note = note.value; saveState(); autoGrow(note); }
      });
      requestAnimationFrame(() => autoGrow(note));
    }

    // 子任务输入
    const si = node.querySelector('.sub-input');
    if (si) {
      si.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && si.value.trim()) {
          ev.preventDefault();
          subAdd(node.dataset.id, si.value.trim());
          si.value = '';
        }
        if (ev.key === 'Escape') { si.value = ''; si.hidden = true; }
      });
      si.addEventListener('blur', () => { if (!si.value.trim()) si.hidden = true; });
    }

    // 双击主任务 = 展开/收起备注与子任务（符合"双击看整体"的习惯）
    // 改文字改由悬停工具栏的铅笔按钮承担，功能不丢失
    node.addEventListener('dblclick', e => {
      const st = e.target.closest('.sub-text');
      if (st) { startSubEdit(node.dataset.id, st.closest('.sub').dataset.sub, st); return; }
      if (e.target.closest('.detail')) return;                       // 详情区里双击不该折叠
      if (e.target.closest('.item-acts') || e.target.closest('.check')) return;
      toggleOpen(node.dataset.id);
    });

    // 拖拽排序
    node.addEventListener('dragstart', e => {
      dragId = node.dataset.id;
      node.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {}
    });
    node.addEventListener('dragend', () => {
      node.classList.remove('dragging'); clearDropMarks(); dragId = null;
    });
    node.addEventListener('dragover', e => {
      if (!dragId || dragId === node.dataset.id) return;
      e.preventDefault(); clearDropMarks();
      const r = node.getBoundingClientRect();
      node.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
    });
    node.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragId || dragId === node.dataset.id) return;
      const r = node.getBoundingClientRect();
      reorder(dragId, node.dataset.id, e.clientY > r.top + r.height / 2);
      clearDropMarks(); dragId = null;
    });
  });
  requestAnimationFrame(() => {
    document.querySelectorAll('.item.new').forEach(n => n.classList.remove('new'));
  });
}

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after')
          .forEach(n => n.classList.remove('drop-before', 'drop-after'));
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.max(t.scrollHeight, 46) + 'px'; }

/* ============================================================
   操作
   ============================================================ */
function commit(fn) { fn(); render(); saveState(); }

function addItem() {
  const parsed = parseInput(el.input.value);
  if (!parsed) { el.input.focus(); return; }
  const item = {
    id: uid(), text: parsed.text, note: '', subs: [], done: false, star: parsed.star,
    color: draftColor, tags: parsed.tags, remindAt: null,
    createdAt: Date.now(), doneAt: null, _new: true,
  };
  commit(() => { state.items.unshift(item); });
  el.input.value = ''; autoHeight();
  el.listWrap.scrollTop = 0;
  el.input.focus();
  if (IS_ELECTRON) window.api.notify('记下了', parsed.text.length > 30 ? parsed.text.slice(0, 30) + '…' : parsed.text);
}

function toggleDone(id) {
  const i = state.items.find(x => x.id === id);
  if (!i) return;
  i.done = !i.done;
  i.doneAt = i.done ? Date.now() : null;
  if (i.done) i.open = false;
  commit(() => {});
}
function toggleStar(id) { const i = state.items.find(x => x.id === id); if (i) { i.star = !i.star; commit(() => {}); } }
function toggleOpen(id) {
  const i = state.items.find(x => x.id === id);
  if (!i) return;
  i.open = !i.open;
  const node = document.querySelector(`.item[data-id="${id}"]`);
  if (node) node.classList.toggle('open', !!i.open);
  saveState();
  setTimeout(fitWindow, 340);
}

function removeItem(id) {
  const idx = state.items.findIndex(x => x.id === id);
  if (idx < 0) return;
  const snap = state.items[idx];
  commit(() => { state.items.splice(idx, 1); });
  toast('已删除 · 点这里撤销', 4000, () => {
    commit(() => { state.items.splice(Math.min(idx, state.items.length), 0, snap); });
  });
}

function reorder(fromId, toId, after) {
  const from = state.items.findIndex(x => x.id === fromId);
  if (from < 0) return;
  const [moved] = state.items.splice(from, 1);
  let to = state.items.findIndex(x => x.id === toId);
  if (to < 0) to = state.items.length - 1;
  state.items.splice(after ? to + 1 : to, 0, moved);
  render(); saveState();
}

/* 子任务 */
function subAdd(id, text) {
  const i = state.items.find(x => x.id === id);
  if (!i) return;
  i.subs.push({ id: uid(), text, done: false });
  render(); saveState();
  const node = document.querySelector(`.item[data-id="${id}"] .sub-input`);
  if (node) { node.hidden = false; node.focus(); }
}
function subToggle(id, sid) {
  const i = state.items.find(x => x.id === id);
  const s = i?.subs.find(x => x.id === sid);
  if (s) { s.done = !s.done; commit(() => {}); }
}
function subRemove(id, sid) {
  const i = state.items.find(x => x.id === id);
  if (!i) return;
  i.subs = i.subs.filter(x => x.id !== sid);
  commit(() => {});
}
function startSubEdit(id, sid, node) {
  const i = state.items.find(x => x.id === id);
  const s = i?.subs.find(x => x.id === sid);
  if (!s) return;
  const original = node.textContent;
  node.contentEditable = 'true'; node.focus();
  document.getSelection().selectAllChildren(node);
  const finish = save => {
    node.contentEditable = 'false';
    const next = node.textContent.trim();
    if (save && next) s.text = next;
    node.textContent = (save && next) ? next : original;
    render(); saveState();
  };
  node.addEventListener('blur', () => finish(true), { once: true });
  node.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  }, { once: true });
}

/* 内联编辑标题 */
function startEdit(id, p) {
  const original = p.textContent;
  p.contentEditable = 'true'; p.spellcheck = false; p.focus();
  document.getSelection().selectAllChildren(p);
  const finish = save => {
    p.contentEditable = 'false';
    const next = p.textContent.trim();
    if (save && next && next !== original) {
      const i = state.items.find(x => x.id === id);
      if (i) { i.text = next; saveState(); }
    }
    p.textContent = (save && next) ? next : original;
    render();
  };
  p.addEventListener('blur', () => finish(true), { once: true });
  p.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  }, { once: true });
}

/* 归档 */
function runArchive() {
  const after = Number(state.settings.archiveAfter) * 60000;
  if (!after) return;
  const now = Date.now();
  const due = state.items.filter(i => i.done && i.doneAt && now - i.doneAt > after);
  if (!due.length) return;
  due.forEach(i => { i.open = false; state.archived.unshift(i); });
  state.items = state.items.filter(i => !(i.done && i.doneAt && now - i.doneAt > after));
  render(); saveState();
}
function openArchive() {
  el.archiveCount.textContent = `(${state.archived.length})`;
  el.archiveList.innerHTML = state.archived.map(i => {
    const c = COLORS[i.color] || COLORS.dai;
    return `<li class="item is-done" data-id="${i.id}" style="--item-color:${c.css}">
      <div class="item-body">
        <p class="item-text">${esc(i.text)}</p>
        <div class="item-meta"><span>${fmtAge(i.doneAt || i.createdAt)}完成</span></div>
      </div>
      <div class="item-acts archive-acts" style="opacity:1">
        <button class="act" data-act="restore" title="放回列表">${ICON.expand}</button>
        <button class="act del" data-act="purge" title="彻底删除">${ICON.trash}</button>
      </div></li>`;
  }).join('');
  el.archiveList.querySelectorAll('.item').forEach(n => {
    n.querySelector('[data-act="restore"]').addEventListener('click', () => {
      const idx = state.archived.findIndex(x => x.id === n.dataset.id);
      if (idx < 0) return;
      const [it] = state.archived.splice(idx, 1);
      it.done = true; it.doneAt = Date.now();
      state.items.push(it);
      render(); saveState(); openArchive();
    });
    n.querySelector('[data-act="purge"]').addEventListener('click', () => {
      state.archived = state.archived.filter(x => x.id !== n.dataset.id);
      render(); saveState(); openArchive();
    });
  });
  MOTION.show(el.archiveSheet);
  MOTION.hide(el.sheet);
}

/* ============================================================
   提醒
   ============================================================ */
function openRemind(id) {
  remindTargetId = id;
  const item = state.items.find(x => x.id === id);
  const now = new Date();
  const opts = [
    { label: '1 小时后', t: Date.now() + 3600e3 },
    { label: '今晚 20:00', t: at(20, 0, 0) },
    { label: '明早 9:00',  t: at(9, 0, 1) },
    { label: '明天 20:00', t: at(20, 0, 1) },
    { label: '一周后',     t: at(now.getHours(), now.getMinutes(), 7) },
  ];
  el.remindChips.innerHTML = opts.map(o => `<button class="chip" data-t="${o.t}">${o.label}</button>`).join('');
  el.remindInput.value = item?.remindAt ? toLocalInput(item.remindAt) : '';
  MOTION.show(el.remindSheet);
  MOTION.hide(el.sheet);
  el.remindChips.querySelectorAll('.chip').forEach(c => {
    c.addEventListener('click', () => setRemind(Number(c.dataset.t)));
  });
}
function at(h, m, plusDays) {
  const d = new Date();
  d.setDate(d.getDate() + plusDays); d.setHours(h, m, 0, 0);
  return d.getTime();
}
function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function setRemind(ts) {
  const i = state.items.find(x => x.id === remindTargetId);
  if (!i) return;
  i.remindAt = ts;
  commit(() => {});
  MOTION.hide(el.remindSheet);
  toast(`提醒已设 · ${fmtRemind(ts)}`);
}

/* ============================================================
   Toast
   ============================================================ */
let toastTimer = null;
function toast(msg, ms = 2600, onUndo) {
  clearTimeout(toastTimer);
  el.toast.textContent = msg;
  MOTION.show(el.toast);
  if (onUndo) {
    el.toast.style.pointerEvents = 'auto'; el.toast.style.cursor = 'pointer';
    el.toast.onclick = () => { MOTION.hide(el.toast); el.toast.onclick = null; onUndo(); };
  } else {
    el.toast.style.pointerEvents = 'none'; el.toast.onclick = null;
  }
  toastTimer = setTimeout(() => { MOTION.hide(el.toast); }, ms);
}

/* ============================================================
   输入区
   ============================================================ */
function autoHeight() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 132) + 'px';
}

COLOR_ORDER.forEach(k => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.dataset.color = k;
  b.title = COLORS[k].label;
  b.style.setProperty('--sw', COLORS[k].css);
  b.addEventListener('click', () => {
    draftColor = k; state.settings.draftColor = k;
    render(); saveState(); el.input.focus();
  });
  el.swatches.appendChild(b);
});

el.input.addEventListener('input', autoHeight);
el.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addItem(); }
  if (e.key === 'Escape') { el.input.value = ''; autoHeight(); el.input.blur(); }
});
el.input.addEventListener('focus', () => tellBusy(true));
el.input.addEventListener('blur', () => tellBusy(false));

function tellBusy(on) { if (IS_ELECTRON) window.api.setBusy(!!on); }

el.card.addEventListener('mousedown', e => {
  if (e.target.closest('button, input, textarea, .item-text, .sheet, [contenteditable]')) return;
  setTimeout(() => el.input.focus(), 0);
});

/* ============================================================
   设置
   ============================================================ */
el.menuBtn.addEventListener('click', e => {
  e.stopPropagation();
  MOTION.hide(el.remindSheet); MOTION.hide(el.archiveSheet);
  MOTION.toggle(el.sheet);
});
document.addEventListener('click', e => {
  if (MOTION.isOpen(el.sheet) && !e.target.closest('#sheet') && !e.target.closest('#menuBtn')) MOTION.hide(el.sheet);
  if (MOTION.isOpen(el.remindSheet) && !e.target.closest('#remindSheet')) MOTION.hide(el.remindSheet);
  if (MOTION.isOpen(el.archiveSheet) && !e.target.closest('#archiveSheet') && !e.target.closest('#archiveBtn')) MOTION.hide(el.archiveSheet);
});

/* ---------- 皮肤网格（UI 在下方，SKINS 清单定义在文件顶部） ---------- */
if (el.skinGrid && !el.skinGrid.children.length) {
  el.skinGrid.innerHTML = S_SKIN.map(sk => `
    <button class="skin-chip" data-skin="${sk.id}" title="${(sk.hint || sk.label).replace(/"/g, '&quot;')}">
      <span class="skin-sw" style="background:${chipGrad(sk)}" aria-hidden="true"></span>
      <span class="skin-name">${sk.label}</span>
    </button>`).join('');
  el.skinGrid.addEventListener('click', e => {
    const b = e.target.closest('.skin-chip');
    if (!b) return;
    applySkin(b.dataset.skin);
  });
}
function syncSkinGrid(cur) {
  if (!el.skinGrid) return;
  [...el.skinGrid.querySelectorAll('.skin-chip')].forEach(b => {
    b.classList.toggle('is-on', b.dataset.skin === cur);
  });
}
function applySkin(id) {
  const sk = S_SKIN.find(x => x.id === id);
  state.settings.skin = sk ? sk.id : 'rice';
  renderTransitioned(); saveState();
  if (IS_ELECTRON) { window.api.setTheme(state.settings.skin); pushShared(); }
  toast(`皮肤：${sk ? sk.label : '宣纸'}`);
}

// 系统里到底装没装这套字体：用画布量宽度对比，比 document.fonts.check 可靠
const FONT_FAMILIES = {
  kai:  ['KaiTi', 'STKaiti', '楷体', 'Kaiti SC', 'KaiTi_GB2312'],
  /* 行楷：首选华文行楷（本机已装），方正行楷次之；瘦金体留在链尾兜底 */
  xing: ['STXingkai', '华文行楷', 'FZYingKai', 'FZXingKai', '方正行楷', '行楷'],
  li:   ['LiSu', 'STLiti', '华文隶书', '隶书', 'FZLanTi'],
  fang: ['FangSong', 'STFangsong', '华文仿宋', '仿宋', '仿宋_GB2312'],
};
const FONT_LABEL = {
  kai: '楷体', xing: '行楷', li: '隶书', fang: '仿宋',
  jin: '行楷',   // 旧值「瘦金」已并入行楷
};
/* canonical 字体值：主进程 / 计划页 / 悬浮窗三方通用 */
const FONT_KEYS = ['kai', 'xing', 'li', 'fang'];
function canonFontKey(f) {
  if (f === 'jin') return 'xing';          // 历史数据迁移
  return FONT_KEYS.indexOf(f) >= 0 ? f : 'sans';
}
function hasFont(fam) {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    const t = '桌边备忘 abc 永';
    ctx.font = '72px monospace';
    const base = ctx.measureText(t).width;
    ctx.font = `72px "${fam}", monospace`;
    return Math.abs(ctx.measureText(t).width - base) > 0.5;
  } catch (e) { return false; }
}
function fontReady(key) {
  return (FONT_FAMILIES[key] || []).some(hasFont);
}

el.fontSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  const key = b.dataset.font;
  state.settings.font = key;
  render(); saveState();
  if (IS_ELECTRON) pushShared();
  if (key === 'sans') { toast('回到默认黑体'); return; }
  const name = FONT_LABEL[key] || '该字体';
  if (fontReady(key)) { toast(`换成${name}`); return; }
  // 没装就如实说，别让人以为点了没用
  toast(`系统里没找到${name}，已回退到默认黑体`);
}));

el.edgeSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  state.settings.edge = b.dataset.edge;
  render(); saveState();
  if (IS_ELECTRON) window.api.setEdge(b.dataset.edge);
  toast(`已贴到${b.dataset.edge === 'right' ? '右' : '左'}边`);
}));

el.archiveSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  state.settings.archiveAfter = Number(b.dataset.min);
  render(); saveState();
  toast(state.settings.archiveAfter ? `完成后 ${state.settings.archiveAfter} 分钟自动归档` : '改为手动归档');
}));

/* 拖动时只刷质感变量（不动列表、不落盘），松手再保存一次。
   原来每动一格就整表重渲染，Slider 拖起来又卡又看不出变化。 */
function bindRange(node, key, withReadout) {
  const apply = () => {
    state.settings[key] = Number(node.value);
    applyTexture();
    if (withReadout) textureReadout();
  };
  node.addEventListener('input', apply);
  node.addEventListener('change', () => { apply(); saveState(); });   // 松手才落盘
}
bindRange(el.idleRange, 'idle');
bindRange(el.blurRange, 'blur', true);
bindRange(el.alphaRange, 'alpha', true);
bindRange(el.grainRange, 'grain', true);

el.pinSw.addEventListener('click', () => {
  state.settings.pin = !state.settings.pin;
  render(); saveState();
  if (IS_ELECTRON) window.api.setPin(state.settings.pin);
});

el.lockSw.addEventListener('click', () => {
  state.settings.lock = !state.settings.lock;
  render(); saveState();
  if (IS_ELECTRON) window.api.setLock(state.settings.lock);
  toast(state.settings.lock ? '已常驻展开' : '松开，鼠标离开会贴回边缘');
});
el.lockBtn.addEventListener('click', () => el.lockSw.click());

el.stealthSw.addEventListener('click', () => {
  state.settings.stealth = !state.settings.stealth;
  render(); saveState();
  if (IS_ELECTRON) window.api.setStealth(state.settings.stealth);
  toast(state.settings.stealth ? '全屏时会自动隐身' : '全屏时不再隐身');
});

el.bootSw.addEventListener('click', async () => {
  if (!IS_ELECTRON) { toast('开机启动只在桌面版可用'); return; }
  const next = !state.settings.bootLaunch;
  const ok = await window.api.setBootLaunch(next);
  state.settings.bootLaunch = ok;
  render(); saveState();
  toast(ok ? '已设为开机启动' : '已取消开机启动');
});

el.motionSw.addEventListener('click', () => {
  // 点一下就在"明确开 / 明确关"之间切换，覆盖系统设置
  state.settings.motion = MOTION.isEnabled() ? false : true;
  MOTION.setPref(state.settings.motion);
  if (IS_ELECTRON) window.api.setMotion(state.settings.motion);
  render(); saveState();
  toast(state.settings.motion ? '过渡动效已开' : '过渡动效已关，切换变回即时');
});

el.exportBtn.addEventListener('click', async () => {
  const txt = JSON.stringify(state, null, 2);
  if (IS_ELECTRON) {
    const p = await window.api.exportBackup(txt);
    toast(p ? '已存到桌面「桌边备份」' : '导出失败');
  } else {
    const blob = new Blob([txt], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `deskmemo-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }
});

el.quitBtn.addEventListener('click', () => {
  if (IS_ELECTRON) window.api.quit();
  else toast('网页版直接关标签页就行');
});

el.clearDone.addEventListener('click', () => {
  const n = state.items.filter(i => i.done).length;
  if (!n) return;
  const snap = state.items.filter(i => i.done);
  commit(() => { snap.forEach(i => state.archived.unshift(i)); state.items = state.items.filter(i => !i.done); });
  toast(`${n} 条已收进归档 · 点这里撤销`, 5000, () => {
    commit(() => { snap.forEach(i => { state.archived = state.archived.filter(x => x.id !== i.id); state.items.push(i); }); });
  });
});

el.archiveBtn.addEventListener('click', () => openArchive());
el.archiveClose.addEventListener('click', () => { MOTION.hide(el.archiveSheet); });
el.archiveClear.addEventListener('click', () => {
  if (!state.archived.length) return;
  const n = state.archived.length;
  const snap = state.archived.slice();
  commit(() => { state.archived = []; });
  MOTION.hide(el.archiveSheet);
  toast(`清空 ${n} 条归档 · 点这里撤销`, 5000, () => commit(() => { state.archived = snap; }));
});

el.doneHead.addEventListener('click', () => { el.doneZone.classList.toggle('open'); setTimeout(fitWindow, 340); });
el.remindSet.addEventListener('click', () => { if (el.remindInput.value) setRemind(new Date(el.remindInput.value).getTime()); });
el.remindClear.addEventListener('click', () => {
  const i = state.items.find(x => x.id === remindTargetId);
  if (i) { i.remindAt = null; commit(() => {}); }
  MOTION.hide(el.remindSheet);
});

/* ============================================================
   形态（由主进程驱动）
   ============================================================ */
function applyMode(m) {
  mode = m;
  document.body.dataset.mode = m;
  if (m === 'collapsed') {
    // 非完整态下 MOTION.ok() 为 false，会立即隐藏，不会留下动画中间态
    MOTION.hide(el.sheet); MOTION.hide(el.remindSheet); MOTION.hide(el.archiveSheet);
    document.body.classList.remove('idle');
  }
  if (m !== 'full') document.body.classList.remove('idle');
  setTimeout(fitWindow, 40);
  if (m === 'full') { scheduleIdle(); el.input.focus(); }
}
if (IS_ELECTRON) {
  window.api.onMode(applyMode);
  window.api.onSync((type, v) => {
    if (type === 'lock') state.settings.lock = !!v;
    if (type === 'edge') state.settings.edge = v;
    if (type === 'motion') state.settings.motion = !!v;
    syncControls();
    document.body.dataset.edge = state.settings.edge;
  });
  window.api.onArchive(() => openArchive());

  /* 周计划页入口：悬浮框就是打开主页面的常驻按钮 */
  window.api.sharedSet = window.api.sharedSet || (() => {});
  window.api.onPlanSummary(s => paintPlanTip(s));
  el.planBtn.addEventListener('click', () => window.api.openPlan());
  (async () => { try { paintPlanTip(await window.api.planSummary()); } catch (e) {} })();

  /* 今日页：首次拉一次，之后主进程推 */
  if (window.api.todayView) window.api.todayView().then(paintToday).catch(() => {});
  if (window.api.onToday) window.api.onToday(v => paintToday(v));

  /* 主题/字体由主进程统一下发：计划页改了，这里跟着变 */
  window.api.onShared(s => {
    let changed = false;
    if (s.skin && s.skin !== state.settings.skin) { state.settings.skin = s.skin; changed = true; }
    const want = canonFontKey(s.font);
    if (want !== (state.settings.font || 'sans')) { state.settings.font = want; changed = true; }
    if (changed) { render(); syncControls(); }   // 不再回写，避免两个窗口互相推来推去
  });
}

/* 把当前外观推给另一端，保证视觉一致 */
function pushShared() {
  if (!IS_ELECTRON || !window.api.sharedSet) return;
  window.api.sharedSet({ skin: state.settings.skin, font: state.settings.font });
}

/* 底部那条「今日安排」摘要 */
function paintPlanTip(s) {
  if (!s || !el.planTip) return;
  el.planTip.textContent = s.todayCount
    ? `今日 ${s.todayCount} 项${s.next ? ' · ' + s.next.slice(0, 8) : ''}`
    : (s.todoCount ? `待办 ${s.todoCount} 条` : '周计划');
}

// 预览态点一下，直接展开到完整态（点标签栏不算：那里有放大按钮）
el.card.addEventListener('click', (e) => {
  if (mode === 'peek' && IS_ELECTRON && !e.target.closest('.tabs')) window.api.requestFull();
});

/* ============================================================
   侧边栏：标签切换 / 悬浮条 / 今日页
   ============================================================ */
el.tabs.addEventListener('click', e => {
  const b = e.target.closest('.tab');
  if (b) setTab(b.dataset.tab);
});
el.barAdd.addEventListener('click', quickAdd);
el.barOpen.addEventListener('click', () => { if (IS_ELECTRON) window.api.openPlan(); });
el.expandBtn.addEventListener('click', () => { if (IS_ELECTRON) window.api.openPlan(); });

el.todayAdd.addEventListener('click', addTodayTodo);
el.todayInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTodayTodo(); });
el.todayInput.addEventListener('focus', () => tellBusy(true));
el.todayInput.addEventListener('blur', () => tellBusy(false));
el.todayPlanList.addEventListener('click', onTodayClick);
el.todayTodoList.addEventListener('click', onTodayClick);

let fitRaf = null;
function fitWindow() {
  if (!IS_ELECTRON) return;
  if (mode === 'collapsed') return;   // 收起态由主进程定高（48×COLLAPSED_H），勿被卡片内容高度撑回整页
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => {
    try { window.api.fit(el.card.getBoundingClientRect().height); } catch (e) {}
  });
}

/* 闲置淡化 */
let idleTimer = null;
function scheduleIdle() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (state.settings.idle >= 100) return;
    if (el.card.matches(':hover') || el.card.contains(document.activeElement)) return;
    if (state.settings.lock) return;
    document.body.classList.add('idle');
  }, 4000);
}
['pointermove', 'pointerdown', 'keydown', 'wheel', 'focusin'].forEach(ev => {
  window.addEventListener(ev, scheduleIdle, { passive: true });
});

/* ============================================================
   提醒轮询
   ============================================================ */
function checkReminders() {
  const now = Date.now();
  let dirty = false;
  state.items.forEach(i => {
    if (!i.done && i.remindAt && !i._fired && i.remindAt <= now) {
      i._fired = true; dirty = true;
      if (IS_ELECTRON) window.api.notify(i.star ? '重要提醒' : '到点了', i.text);
      else if (Notification.permission === 'granted') new Notification('桌边提醒', { body: i.text });
    }
    if (i.done) i._fired = false;
  });
  if (dirty) saveState();
}

/* ============================================================
   启动
   ============================================================ */
async function boot() {
  const loaded = await loadState();
  if (loaded) {
    // 设置永远要应用：原来只在"有备忘"时才合并，一条备忘都没写过的
    // 情况下，不透明度/毛玻璃/噪点重启后会被打回默认值。
    Object.assign(state.settings, loaded.settings || {});
    draftColor = state.settings.draftColor || 'dai';
    if (loaded.items?.length || loaded.archived?.length) {
      state.items = loaded.items || [];
      state.archived = loaded.archived || [];
    }
  }
  dockTab = state.settings.dockTab === 'notes' ? 'notes' : 'today';
  saveState();
  render();
  autoHeight();
  scheduleIdle();
  MOTION.setPref(state.settings.motion);
  if (IS_ELECTRON) {
    await window.api.setPin(state.settings.pin);
    window.api.setTheme(state.settings.skin);
    window.api.setEdge(state.settings.edge || 'right');
    window.api.setLock(!!state.settings.lock);
    window.api.setStealth(!!state.settings.stealth);
    window.api.signalReady();
  }
  setInterval(checkReminders, 15000);
  setInterval(runArchive, 30000);
  setTimeout(checkReminders, 1200);
  setTimeout(runArchive, 3000);
  if (!IS_ELECTRON) el.input.focus(); // Electron 下不自动聚焦：聚焦会上报 busy，卡片就缩不回去了
  window.addEventListener('blur', () => tellBusy(false));
}

boot();
