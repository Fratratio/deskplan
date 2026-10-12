/* ============================================================
   桌边 · DeskPlan  —— 统一主进程
   两个窗口，一份数据源：
     win     悬浮小方框（贴边常驻，默认入口）
     planWin 周计划主页面（地图式时间网格 + 表格 + 待办）
   数据层集中在 app/shared/store-schema.js，两个窗口各读写自己那格。
   ============================================================ */
const _electronMod = require('electron');

/* 自愈：某些终端、IDE、脚本工具会把 ELECTRON_RUN_AS_NODE=1 塞进进程环境。
   这个变量一存在，require('electron') 返回的就是一串路径而不是模块对象，
   app 等 API 全部为 undefined，进程会在第一行就崩掉，窗口根本来不及创建，
   外部看起来就是"双击图标毫无反应"。
   这里检测出来之后，清掉这个变量、用干净环境重启自身（不需要任何 electron API）。 */
if (!_electronMod || !_electronMod.app) {
  const _env = Object.assign({}, process.env);
  delete _env.ELECTRON_RUN_AS_NODE;
  require('child_process').spawn(process.execPath, process.argv.slice(1), {
    env: _env, detached: true, stdio: 'ignore', cwd: process.cwd(),
  }).unref();
  process.exit(0);
}

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, Notification, screen, globalShortcut } = _electronMod;
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const S = require('./shared/store-schema');

/* ---------- 常量 ---------- */
const APP_NAME = '桌边 · DeskPlan';
/* 三档形态：collapsed 是贴边那条窄悬浮条（要能放下"今日待办 + 快速新增"），
   peek 是扫一眼的小视图，full 是完整侧边栏 */
const MODE_W = { collapsed: 48, peek: 240, full: 360 };
const COLLAPSED_H = 296;       // 悬浮条高度

const T_WAKE = 74;             // collapsed → peek（悬浮条有 48px 宽，判定放宽一点）
const T_LEAVE_PEEK = 275;      // peek → collapsed
const T_LEAVE_FULL = MODE_W.full + 60;
const RETRACT_MS = 340;
const GRACE_MS = 6000;
const BLUR_DOCK_MS = 3000;     // 周计划窗口失焦多久后收起成悬浮条

/* ---------- 数据目录 ----------
   候选顺序：环境变量 DP_DATA_DIR → 项目根的 data/ → 系统 userData/data。
   项目根的 data/ 优先，是为了开发态和免安装版把数据放在看得见的地方；
   打包装到 Program Files 之类不可写的位置时自动落到 userData，不会崩。
   ⚠️ 别再写死 D:\ 开头的绝对路径，换台机器 clone 下来就是死路。 */
const DATA_CANDIDATES = [
  process.env.DP_DATA_DIR,
  path.join(__dirname, '..', 'data'),
  path.join(app.getPath('userData'), 'data'),
].filter(Boolean);

/* 老版本（apps/deskmemo）的数据目录，只在首次运行时读一次做迁移 */
const LEGACY_DIR = path.join(__dirname, '..', '..', 'deskmemo', 'data');

function pickDir() {
  for (const dir of DATA_CANDIDATES) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      const probe = path.join(dir, '.wtest');
      fs.writeFileSync(probe, '1');
      fs.unlinkSync(probe);
      return dir;
    } catch (e) { /* 不可写就试下一个 */ }
  }
  const fb = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(fb, { recursive: true });
  return fb;
}
let DATA_DIR = '';
let DATA_FILE = '';

if (process.platform === 'win32') app.setAppUserModelId('workbuddy.deskplan');

/* 任务栏上的名称与窗口标题分开：任务栏/Dock 显示前者（APP_NAME），
   窗口标题用于「任务栏悬停预览」和 Alt+Tab，两处都必须是应用名而不是
   「周计划备忘录」这类内部叫法，否则用户看到的图标旁边写着一串网页标题。 */
app.setName('桌边 DeskPlan');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

/* ---------- 运行时状态 ---------- */
let win = null;        // 悬浮窗
let planWin = null;    // 周计划主窗口
let tray = null;
let cache = null;

let mode = 'full';
let edge = 'right';
let lock = false;
let stealth = true;
let busy = false;
let uiReady = false;
let fullscreen = false;
let forceUntil = 0;
let autoDock = false;          // 失焦自动收起：默认关掉（见 README 的说明）
let blurTimer = null;          // 失焦收起的倒计时
let retractTimer = null;
let collapseTimer = null;
let lastPos = { x: -1, y: -1 };
let stillSince = Date.now();
const startTime = Date.now();

/* ============================================================
   悬浮窗
   ============================================================ */
function workArea() { return screen.getPrimaryDisplay().workArea; }

function createWindow() {
  const area = workArea();
  let x, y;
  if (cache?.settings?.x != null && cache?.settings?.y != null) {
    x = cache.settings.x; y = cache.settings.y;
  } else {
    x = area.x + area.width - MODE_W.full - 26;
    y = area.y + 26;
  }
  const h = Math.min(620, area.height - 80);

  const iconPath = path.join(__dirname, '..', 'assets', 'app.ico');
  const icon = fs.existsSync(iconPath) ? iconPath : undefined;

  /* 两个窗口都进任务栏（改造前都是 skipTaskbar: true，任务栏空空如也）。
   标题带后缀是为了让任务栏悬停预览和 Alt+Tab 能分辨是哪一个。
   ⚠️ 关键：页面里的 <title> 会覆盖这里的 title —— Electron 在页面 load 完成后
   用文档标题刷新窗口标题，而任务栏文字与任务视图用的正是窗口标题。
   所以 app/plan/index.html 与 app/widget/index.html 的 <title> 也必须是应用名，
   改那两个文件时别把名字改回去，否则任务栏上会显示「周计划备忘录」。 */
win = new BrowserWindow({
    x, y, width: MODE_W.full, height: h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    hasShadow: true,
    skipTaskbar: false,         // 常驻后台要有任务栏入口，用户能随时点回来
    alwaysOnTop: cache?.settings?.pin !== false,
    title: APP_NAME + ' · 悬浮窗',
    icon,
    // 默认隐藏：悬浮小方框只在收起/最小化后才出现；自检时需要可见
    show: !!(process.env.DM_SHOT || process.env.DM_SELFTEST || process.env.DP_DOCK),
    webPreferences: {
      preload: path.join(__dirname, 'preload-widget.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, 'widget', 'index.html'));
  win.setMenuBarVisibility(false);

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 && DATA_DIR) {
      try { fs.appendFileSync(path.join(DATA_DIR, 'console.log'), `${message} (${sourceId}:${line})\n`); } catch (err) {}
    }
  });

  win.on('moved', () => {
    if (!win) return;
    const [px, py] = win.getPosition();
    cache.settings = cache.settings || {};
    cache.settings.x = px;
    cache.settings.y = py;
    S.write(DATA_FILE, cache);
  });

  win.on('closed', () => { win = null; });
  win.on('blur', () => { busy = false; });

  // 自检钩子（DM_SHOT / DM_MODE / DM_VERIFY / DM_SELFTEST）
  win.webContents.on('did-finish-load', async () => {
    if (!process.env.DM_SHOT && !process.env.DM_VERIFY && !process.env.DM_SELFTEST) return;
    if (process.env.DM_SHOT) {
      await new Promise(r => setTimeout(r, 1200));
      if (process.env.DM_MODE) { setMode(process.env.DM_MODE); await new Promise(r => setTimeout(r, 1000)); }
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.DM_SHOT, img.toPNG());
        const ds = await win.webContents.executeJavaScript(
          'JSON.stringify({ mode: document.body.dataset.mode, h: document.querySelector(".card").getBoundingClientRect().height })'
        ).catch(() => '?');
        fs.writeFileSync(process.env.DM_SHOT + '.log', String(ds));
      } catch (e) {}
    }
    if (process.env.DM_SELFTEST) await runWidgetSelfTest();
    if (process.env.DM_VERIFY) {
      await new Promise(r => setTimeout(r, 9000));
      try {
        fs.writeFileSync(process.env.DM_VERIFY, JSON.stringify({ mode, edge, busy, size: win.getSize(), pos: win.getPosition() }));
      } catch (e) {}
    }
  });
}

async function runWidgetSelfTest() {
  await new Promise(r => setTimeout(r, 1500));
  try {
    const res = await win.webContents.executeJavaScript(`(async () => {
      const log = [], errs = [];
      const wait = ms => new Promise(r => setTimeout(r, ms));
      window.addEventListener('error', e => errs.push(String(e.message)));
      try {
        log.push('bridge-isolated=' + (typeof window.openPlan));
        // 侧边栏默认停在「今日」，备忘列表隐藏时 FLIP 量不到矩形，先切回备忘标签再测；
        // 动效只在完整态跑（贴边态省合成开销），所以还要请求回到完整态
        const notesTab = document.querySelector('.tab[data-tab="notes"]');
        if (notesTab) { notesTab.click(); await wait(250); }
        log.push('tab=' + document.body.dataset.tab);
        if (window.api && window.api.requestFull) { window.api.requestFull(); await wait(600); }
        log.push('mode=' + (document.body.dataset.mode || 'full'));
        const before = state.items.length;
        el.input.value = '自测条目 #自测';
        addItem(); await wait(80);
        log.push('add=' + state.items.length);
        log.push('anims-after-add=' + document.getAnimations().length);
        const it = state.items.find(i => i.text.indexOf('自测条目') === 0);
        const id = it.id;
        toggleDone(id); await wait(400);
        log.push('done=' + state.items.filter(i => i.done).length);
        toggleDone(id); await wait(320);
        const row = document.querySelector('#list .item');
        const wasOpen = row.classList.contains('open');
        row.querySelector('.item-text').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await wait(80);
        log.push('dblclick-toggles=' + (wasOpen !== row.classList.contains('open')));
        log.push('plan-entry=' + !!document.getElementById('planBtn'));
        removeItem(id); await wait(60);
        log.push('remove=' + state.items.length);
        log.push('ghost-live=' + document.querySelectorAll('.motion-ghost').length);
        await wait(900);
        log.push('ghost-cleaned=' + document.querySelectorAll('.motion-ghost').length);
        log.push('net-zero=' + (state.items.length === before));
      } catch (e) { errs.push(String(e && e.stack || e)); }
      return JSON.stringify({ log, errs });
    })()`, true);
    fs.writeFileSync(process.env.DM_SELFTEST, res);
  } catch (e) {
    fs.writeFileSync(process.env.DM_SELFTEST, JSON.stringify({ fatal: String(e) }));
  }
}

/* ---------- 尺寸与形态 ---------- */
function resize(w, h) {
  if (!win) return;
  const [cw, ch] = win.getSize();
  const nw = w || cw;
  const nh = h || ch;
  const b = workArea();
  const [, y0] = win.getPosition();
  // 高度变化（尤其是收成悬浮条）后别让窗口跑出工作区
  const y = Math.max(b.y, Math.min(y0, b.y + b.height - nh));
  const x = edge === 'right' ? b.x + b.width - nw : b.x;
  win.setResizable(true);
  win.setBounds({ x, y, width: nw, height: nh });
  win.setResizable(false);
}

function setMode(m) {
  if (!win || m === mode) return;
  mode = m;
  if (m === 'collapsed') {
    win.webContents.send('mode', 'collapsed');
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => resize(MODE_W.collapsed, COLLAPSED_H), 340);
  } else {
    clearTimeout(collapseTimer);
    resize(MODE_W[m]);
    win.webContents.send('mode', m);
  }
}

function edgeDistance() {
  const p = screen.getCursorScreenPoint();
  const b = workArea();
  return edge === 'right' ? (b.x + b.width) - p.x : p.x - b.x;
}
function mouseInsideVertically() {
  const p = screen.getCursorScreenPoint();
  const b = workArea();
  return p.y >= b.y - 60 && p.y <= b.y + b.height + 60;
}

let freezeTick = false;        // 自检期间冻结形态自动切换，保证断言可复现

function tick() {
  if (freezeTick) return;
  if (!win || !uiReady || !cache) return;
  if (Date.now() - startTime < GRACE_MS) return;
  if (lock) { setMode('full'); return; }
  if (stealth && fullscreen) { setMode('collapsed'); return; }
  if (Date.now() < forceUntil) { setMode('full'); return; }
  if (busy) { setMode('full'); return; }
  // 周计划窗口开着并且有焦点时，悬浮窗别抢戏，安静贴边
  if (planWin && !planWin.isDestroyed() && planWin.isFocused()) { setMode('collapsed'); return; }

  const dist = edgeDistance();
  const p = screen.getCursorScreenPoint();
  const moved = Math.abs(p.x - lastPos.x) + Math.abs(p.y - lastPos.y);
  if (moved > 6) { stillSince = Date.now(); lastPos = { x: p.x, y: p.y }; }

  let want = mode;
  if (mode === 'collapsed') {
    if (dist <= T_WAKE && mouseInsideVertically()) want = 'peek';
  } else if (mode === 'peek') {
    const still = Date.now() - stillSince > 620;
    if (dist <= MODE_W.peek && still) want = 'full';
    else if (dist > T_LEAVE_PEEK) want = 'collapsed';
  } else if (mode === 'full') {
    if (dist > T_LEAVE_FULL) want = 'collapsed';
  }

  if (want === mode) { clearTimeout(retractTimer); retractTimer = null; return; }
  if (want === 'collapsed') {
    if (!retractTimer) retractTimer = setTimeout(() => { retractTimer = null; setMode('collapsed'); }, RETRACT_MS);
    return;
  }
  clearTimeout(retractTimer); retractTimer = null;
  setMode(want);
}

/* ============================================================
   周计划主窗口
   ============================================================ */
/* 计划页窗口底色：必须与 skins.css 里该皮肤的 --bg 一致，
   否则窗口边框会露出 CSS 之外的另一圈颜色。*/
const SKIN_BG = { rice: '#F4F2EE', mist: '#EDF2EE', sakura: '#F6EFF3', dusk: '#171A1F', nebula: '#14162A', forge: '#1C1815' };
function planBg() { return SKIN_BG[S.canonSkin(cache?.shared?.skin)] || '#F4F2EE'; }

function createPlanWindow() {
  /* 窗口还在（最小化中）就复用，不要重建：
     重建会让页面重新加载，滚动位置、当前选中的卡片、搜索词全丢，
     用户感受就是「切一下就闪一下」。 */
  if (planWin && !planWin.isDestroyed()) return planWin;

  const b = cache?.ui?.planBounds;
  const area = workArea();
  const w = Math.min(b?.width || 1280, area.width);
  const h = Math.min(b?.height || 880, area.height);

  const iconPath = path.join(__dirname, '..', 'assets', 'app.ico');
  const icon = fs.existsSync(iconPath) ? iconPath : undefined;

  planWin = new BrowserWindow({
    x: b?.x, y: b?.y, width: w, height: h,
    minWidth: 720, minHeight: 520,
    backgroundColor: planBg(),
    autoHideMenuBar: true,
    skipTaskbar: false,         // 日历是主界面，必须占一个任务栏位置
    title: APP_NAME,
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload-plan.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  planWin.setMenuBarVisibility(false);
  planWin.loadFile(path.join(__dirname, 'plan', 'index.html'));

  planWin.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 && DATA_DIR) {
      try { fs.appendFileSync(path.join(DATA_DIR, 'console.log'), `[plan] ${message} (${sourceId}:${line})\n`); } catch (err) {}
    }
  });

  /* 关掉/最小化日历 ≠ 退出应用，也 ≠ 收起悬浮窗。
     改造前：close 被 preventDefault 后走 dockPlan()，把日历 hide 掉、强制悬浮窗收成窄条；
     改造后：日历只是最小化（任务栏按钮还在，点一下就回来），悬浮窗完全不受影响。
     hide() 会让窗口从任务栏消失，用户就没有「随时点回来」的入口了，所以一律用 minimize。 */
  const parkPlan = () => {
    if (!planWin || planWin.isDestroyed()) return;
    if (planWin.isVisible() && !planWin.isMinimized()) {
      cache.ui = cache.ui || {};
      cache.ui.planBounds = { ...planWin.getBounds(), maximized: planWin.isMaximized() };
      S.write(DATA_FILE, cache);
    }
    if (!planWin.isMinimized()) planWin.minimize();
  };

  planWin.on('close', (e) => {
    if (app.isQuitting) return;             // 真退出时放行
    e.preventDefault();
    parkPlan();
  });

  /* 记位置：关闭和最小化都要存，否则下次打开窗口跑到上次的位置上很难看 */
  const rememberBounds = () => {
    if (!planWin || planWin.isDestroyed() || !cache) return;
    cache.ui = cache.ui || {};
    cache.ui.planBounds = { ...planWin.getBounds(), maximized: planWin.isMaximized() };
    S.write(DATA_FILE, cache);
  };
  planWin.on('resized', rememberBounds);
  planWin.on('moved', rememberBounds);
  planWin.on('maximize', rememberBounds);
  planWin.on('unmaximize', rememberBounds);
  planWin.on('closed', () => { planWin = null; cancelDock(); });

  /* 失焦自动收起：默认关闭。
     开着的时候用 minimize 而不是 hide，任务栏入口不能消失。 */
  planWin.on('blur', () => { if (autoDock) scheduleDock(); });
  planWin.on('focus', () => cancelDock());

  return planWin;
}

/* 悬浮窗收回侧边栏（任务栏条目保留） */
function dockWidget() {
  if (win && !win.isDestroyed()) {
    mode = 'collapsed';
    win.webContents.send('mode', 'collapsed');
    clearTimeout(collapseTimer);
    resize(MODE_W.collapsed, COLLAPSED_H);
    if (!win.isVisible()) win.show();
  }
}

/* 日历收起时顺手把悬浮窗放出来——仅在日历主动 park 时调用，
   悬浮窗自己展开时绝不碰日历（改造前 dockPlan 两者互斥，用户抱怨「像两个东西」） */
function dockPlan() {
  cancelDock();
  if (planWin && !planWin.isDestroyed()) {
    if (planWin.isVisible() && !planWin.isMinimized()) {
      cache.ui = cache.ui || {};
      cache.ui.planBounds = { ...planWin.getBounds(), maximized: planWin.isMaximized() };
      S.write(DATA_FILE, cache);
    }
    if (!planWin.isMinimized()) planWin.minimize();
  }
  dockWidget();
}

function scheduleDock() {
  cancelDock();
  if (!autoDock) return;
  blurTimer = setTimeout(() => { blurTimer = null; dockPlan(); }, BLUR_DOCK_MS);
}
function cancelDock() {
  if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
}

/* 打开/唤起日历：从最小化恢复时不重建窗口，直接 restore，
   这样页面状态（滚动位置、选中卡片）都还在，切换才「流畅自然」 */
function openPlan() {
  cancelDock();
  const w = createPlanWindow();
  try {
    if (w.isMinimized()) w.restore();
    else if (cache?.ui?.planBounds?.maximized) w.maximize();
  } catch (e) {}
  w.show();
  w.focus();
  // 日历在前台时悬浮窗安静贴边，不抢戏（只改宽度，不隐藏、不关闭）
  if (win && !win.isDestroyed()) setMode('collapsed');
  if (win && !win.isDestroyed()) w.webContents.once('did-finish-load', () => pushPlanSummary());
  return w;
}

/* ============================================================
   跨窗口同步
   ============================================================ */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pushPlanSummary() {
  if (!win || win.isDestroyed() || !cache) return;
  win.webContents.send('plan:summary', S.planSummary(cache, todayStr()));
}

/* 侧边栏「今日」页的数据：谁改了数据都重新推一次 */
function pushToday() {
  if (!win || win.isDestroyed() || !cache) return;
  win.webContents.send('today:changed', S.todayView(cache, todayStr()));
}

/* 侧边栏改了数据 → 周计划页按当前磁盘内容整份重载 */
function notifyPlanChanged() {
  if (!planWin || planWin.isDestroyed()) return;
  planWin.webContents.send('plan:external');
}

const lastSharedPush = { widget: '', plan: '' };
function pushShared(target) {
  if (!cache) return;
  const payload = JSON.stringify({ skin: cache.shared.skin, font: cache.shared.font });
  const key = target;
  const winRef = target === 'plan' ? planWin : win;
  if (!winRef || winRef.isDestroyed()) return;
  if (lastSharedPush[key] === payload) return;
  lastSharedPush[key] = payload;
  /* 皮肤两端同名，直接透传；只有字体的本地叫法不同 */
  const local = {
    skin: S.canonSkin(cache.shared.skin),
    font: cache.shared.font === 'default'
      ? (target === 'plan' ? 'default' : 'sans')
      : S.canonFont(cache.shared.font),
  };
  winRef.webContents.send('shared:changed', local);
}

function saveNow() { S.write(DATA_FILE, cache); }

/* ---------- 全屏检测（Windows） ---------- */
function startFullscreenWatch() {
  const script = path.join(__dirname, '..', 'tools', 'fullscreen-watch.ps1');
  if (!fs.existsSync(script)) return;
  let ps;
  try {
    ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { return; }
  ps.stdout.on('data', d => {
    const s = String(d).trim();
    if (!s) return;
    fullscreen = s.indexOf('1') >= 0;
  });
  ps.on('exit', () => { fullscreen = false; });
  app.on('will-quit', () => { try { ps.kill(); } catch (e) {} });
}

/* ============================================================
   托盘
   ============================================================ */
function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let img;
  try { img = nativeImage.createFromPath(iconPath); } catch (e) {}
  if (!img || img.isEmpty()) img = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJ0lEQVR42u3PMQEAAAgDoO+f' +
    'jhw8hCgAAAAAAAAAAAAAAAAAAAAAAADgLwUgAAGY2R0pAAAAAElFTkSuQmCC');
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip(APP_NAME + ' —— 常驻后台，点此唤起周计划');
  refreshTray();
  // 点托盘 = 唤起 / 收起日历（原来不管状态一律 openPlan，来回点没用）
  tray.on('click', () => { trayTogglePlan(); });
  /* 双击托盘一定打开日历，不做 toggle：用户双击的意图很明确是要「打开」，
     误toggle 掉的体验比多一次点击糟糕得多。 */
  tray.on('double-click', () => { openPlan(); });
}

function refreshTray() {
  if (!tray) return;
  const planUp = !!(planWin && !planWin.isDestroyed() && planWin.isVisible() && !planWin.isMinimized());
  const menu = Menu.buildFromTemplate([
    { label: planUp ? '唤起周计划' : '打开周计划', click: () => openPlan() },
    { label: '显示悬浮小方框', click: () => showAndHold() },
    { label: '收起悬浮小方框', click: () => dockWidget() },
    { type: 'separator' },
    { label: '失焦 3 秒自动收起', type: 'checkbox', checked: autoDock, click: (mi) => {
        autoDock = !!mi.checked; cache.settings.autoDock = autoDock; saveNow(); refreshTray();
      } },
    { type: 'separator' },
    { label: '常驻展开', type: 'checkbox', checked: lock, click: (mi) => {
        lock = mi.checked; cache.settings.lock = lock; saveNow(); refreshTray();
        if (win) win.webContents.send('sync-lock', lock);
      } },
    { label: '贴右边', type: 'checkbox', checked: edge === 'right', click: () => setEdge('right') },
    { label: '贴左边', type: 'checkbox', checked: edge === 'left', click: () => setEdge('left') },
    { label: '常驻最前', type: 'checkbox', checked: cache?.settings?.pin !== false, click: (mi) => setPinState(mi.checked) },
    { label: '过渡动效', type: 'checkbox', checked: cache?.settings?.motion !== false, click: (mi) => {
        cache.settings.motion = mi.checked; saveNow();
        if (win) win.webContents.send('sync-motion', mi.checked);
        refreshTray();
      } },
    { label: '全屏时隐身', type: 'checkbox', checked: stealth, click: (mi) => { stealth = mi.checked; cache.settings.stealth = stealth; saveNow(); refreshTray(); } },
    { label: '开机启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (mi) => { app.setLoginItemSettings({ openAtLogin: mi.checked }); } },
    { type: 'separator' },
    { label: '打开归档', click: () => { showAndHold(); setTimeout(() => win?.webContents.send('open-archive'), 300); } },
    { label: '打开数据目录', click: () => shell.openPath(DATA_DIR) },
    { type: 'separator' },
    { label: '退出桌边', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

/* 托盘点一下：日历在前景就收起来，不在就唤回来。 */
function trayTogglePlan() {
  if (planWin && !planWin.isDestroyed() && planWin.isVisible() && !planWin.isMinimized() && planWin.isFocused()) {
    dockPlan();
  } else {
    openPlan();
  }
}

function showAndHold() {
  if (!win) { createWindow(); }
  if (!win || win.isDestroyed()) return;
  /* 悬浮窗只是「亮出来」，绝不碰日历：改造前这里隐含地会把日历收走，
     用户感受是两个窗口互相排斥。日历在前台时，悬浮窗靠边站即可。 */
  if (win.isVisible() && win.getSize()[0] === MODE_W.full) { win.focus(); return; }
  win.show();
  forceUntil = Date.now() + 4000;
  setMode('full');
  win.focus();
  refreshTray();
}

function setEdge(e) {
  edge = e;
  cache.settings.edge = e;
  saveNow();
  if (win) {
    const b = workArea();
    const [, y] = win.getPosition();
    const x = e === 'right' ? b.x + b.width - win.getSize()[0] : b.x;
    win.setResizable(true);
    win.setBounds({ x, y, width: win.getSize()[0], height: win.getSize()[1] });
    win.setResizable(false);
    win.webContents.send('sync-edge', e);
  }
  refreshTray();
}

function setPinState(on) {
  if (win) win.setAlwaysOnTop(!!on, 'floating');
  cache.settings.pin = !!on;
  saveNow();
  refreshTray();
}

/* ============================================================
   IPC
   ============================================================ */

/* ---- 悬浮窗：沿用原有的 load / save 语义 ---- */
ipcMain.handle('load', () => S.widgetView(cache || S.defaultRoot()));

ipcMain.on('save', (_e, s) => {
  if (!cache) return;
  S.mergeWidget(cache, s);
  saveNow();
  pushShared('plan');
});

ipcMain.on('renderer-ready', () => {
  uiReady = true;
  edge = cache?.settings?.edge || 'right';
  lock = !!cache?.settings?.lock;
  stealth = cache?.settings?.stealth !== false;
  autoDock = cache?.settings?.autoDock !== false;
  stillSince = Date.now();
  if (lock) setMode('full');
  pushPlanSummary();
  lastSharedPush.widget = JSON.stringify({ skin: cache?.shared?.skin, font: cache?.shared?.font });
  // 重发当前形态：渲染进程在加载完成前可能已漏收初始 mode 消息，这里补一次，
  // 否则折叠态下悬浮条透明、且被 fit 撑成整页内容高度（收起后的"小方框"会变成长竖条）。
  if (win && !win.isDestroyed()) {
    win.webContents.send('mode', mode);
    if (mode === 'collapsed') resize(MODE_W.collapsed, COLLAPSED_H);
  }
});

ipcMain.handle('plan-summary', () => S.planSummary(cache, todayStr()));
ipcMain.on('open-plan', () => openPlan());

ipcMain.on('notify', (_e, title, body) => {
  if (!Notification.isSupported()) return;
  new Notification({ title, body }).show();
});

ipcMain.on('fit', (_e, h) => {
  if (!win) return;
  const area = workArea();
  const next = Math.round(Math.max(110, Math.min(Number(h) + 8, area.height - 80)));
  if (Math.abs(next - win.getSize()[1]) > 2) resize(null, next);
});

/* 皮肤是纯 CSS（data-skin），这里绝不能给悬浮窗 setBackgroundColor：
   透明窗口会整块失去透明性。悬浮窗由 CSS 自己画底。
   计划页是有边框的正常窗口，切皮肤时要同步它的原生底色，
   否则窗口边缘会露出一圈 CSS 之外的旧颜色。 */
ipcMain.on('set-theme', (_e, skin) => {
  const id = S.canonSkin(skin);
  if (cache) { cache.shared.skin = id; saveNow(); }
  if (planWin && !planWin.isDestroyed()) {
    try { planWin.setBackgroundColor(SKIN_BG[id] || '#F4F2EE'); } catch (err) { /* 窗口已销毁，忽略 */ }
  }
});
ipcMain.handle('set-pin', (_e, b) => { setPinState(!!b); return true; });
ipcMain.on('set-edge', (_e, e) => setEdge(e));
ipcMain.on('set-lock', (_e, b) => { lock = !!b; refreshTray(); if (lock) setMode('full'); });
ipcMain.on('set-stealth', (_e, b) => { stealth = !!b; refreshTray(); });
ipcMain.on('set-motion', (_e, b) => { cache.settings.motion = !!b; saveNow(); if (win) win.webContents.send('sync-motion', !!b); });
ipcMain.on('set-busy', (_e, b) => { busy = !!b; });
ipcMain.on('request-full', () => { forceUntil = Date.now() + 2500; setMode('full'); });

ipcMain.handle('set-boot', (_e, b) => {
  app.setLoginItemSettings({ openAtLogin: !!b });
  refreshTray();
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('export', async (_e, txt) => {
  try {
    const dir = path.join(app.getPath('desktop'), '桌边备份');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `deskplan-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(p, txt, 'utf8');
    return p;
  } catch (e) { return ''; }
});

ipcMain.on('quit', () => { app.isQuitting = true; app.quit(); });
ipcMain.on('hide', () => { if (win) win.hide(); });

/* ---- 日历 ↔ 悬浮窗：互相调用，但不互相取代 ----
   日历点「悬浮小方框」→ 只把悬浮窗叫出来，日历原样留在前台；
   悬浮窗点「打开周计划」→ 只把日历叫出来，悬浮窗留在原地。
   两边都不再隐式关闭对方。 */
ipcMain.on('widget:show', () => { showAndHold(); });
ipcMain.on('widget:toggle', () => {
  if (win && !win.isDestroyed() && win.isVisible() && win.getSize()[0] === MODE_W.full) dockWidget();
  else showAndHold();
});
ipcMain.on('plan:show', () => { openPlan(); });
/* 日历主动收起来：只收日历，不牵动悬浮窗 */
ipcMain.on('plan:park', () => {
  cancelDock();
  if (planWin && !planWin.isDestroyed()) {
    cache.ui = cache.ui || {};
    cache.ui.planBounds = { ...planWin.getBounds(), maximized: planWin.isMaximized() };
    S.write(DATA_FILE, cache);
    if (!planWin.isMinimized()) planWin.minimize();
  }
  refreshTray();
});
/* 任务栏点「关闭窗口」时也不能把整个应用带走 */
ipcMain.on('app:quit', () => { app.isQuitting = true; app.quit(); });

/* ---- 周计划页：同步读写自己的那一格 ---- */
ipcMain.on('plan:read', (e) => {
  e.returnValue = (cache.plan.items.length || cache.plan.todos.length || cache.ui.planSeeded)
    ? JSON.stringify(S.planView(cache))
    : null;   // 首次运行返回 null，让页面自己生成示例数据
});

ipcMain.on('plan:write', (e, txt) => {
  try {
    const obj = JSON.parse(String(txt || '{}'));
    S.mergePlan(cache, obj);
    cache.ui.planSeeded = true;
    saveNow();
    pushPlanSummary();
    pushToday();               // 计划页改了，侧边栏的「今日」跟着变
    pushShared('widget');
    e.returnValue = true;
  } catch (err) {
    e.returnValue = false;
  }
});

/* ---- 侧边栏「今日」页：只读视图 + 一组原子改动 ---- */
ipcMain.handle('today:view', () => (cache ? S.todayView(cache, todayStr()) : null));

ipcMain.handle('today:act', (_e, act) => {
  if (!cache) return null;
  const v = S.todayAct(cache, act, todayStr());
  if (!v) return null;
  cache.ui.planSeeded = true;
  saveNow();
  pushPlanSummary();
  pushToday();
  notifyPlanChanged();
  return v;
});

/* 侧边栏点某一条 → 打开完整窗口并跳过去 */
ipcMain.on('plan:goto', (_e, payload) => {
  const w = openPlan();
  const send = () => { if (!w.isDestroyed()) w.webContents.send('plan:goto', payload || {}); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
});

/* 悬浮窗自请求「把我保持在完整态」（点窗口、拖窗口时用） */
ipcMain.on('widget:focus', () => showAndHold());

/* ---- 外观：任一端改了主题/字体，另一端立刻跟上 ---- */
ipcMain.on('shared:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  if (patch.skin) cache.shared.skin = S.canonSkin(patch.skin);
  if (patch.font) cache.shared.font = S.canonFont(patch.font);
  saveNow();
  lastSharedPush.widget = ''; lastSharedPush.plan = '';
  pushShared('widget');
  pushShared('plan');
  refreshTray();
});

/* ============================================================
   双形态自检（DP_DOCK=<输出路径>）
   逐条验证这一轮改造：悬浮条尺寸与内容、备忘/今日双标签、
   侧边栏新增落到同一份数据并被计划页接管、面板折叠、早间细线、
   卡片按标签着色、环形进度条、失焦 3 秒自动收起。
   ============================================================ */
async function runDockVerify() {
  const out = process.env.DP_DOCK;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const res = { ts: Date.now() };
  const D = win;                                  // 侧边栏（悬浮窗）
  const dj = js => D.webContents.executeJavaScript(js, true);
  let testTodoId = null;

  try {
    freezeTick = true;
    await wait(1800);

    /* 1. 收起成贴边窄悬浮条 */
    setMode('collapsed');
    await wait(900);
    res.barSize = D.getSize();
    res.barOk = res.barSize[0] === MODE_W.collapsed;
    res.barOpacity = await dj(`getComputedStyle(document.getElementById('bar')).opacity`);
    res.barNum = await dj(`document.getElementById('barNum').textContent`);
    res.barHasAdd = await dj(`!!document.getElementById('barAdd')`);
    res.barHasOpen = await dj(`!!document.getElementById('barOpen')`);
    if (process.env.DP_SHOT) {
      try { fs.writeFileSync(path.join(DATA_DIR, 'dock-bar.png'), (await D.webContents.capturePage()).toPNG()); } catch (e) {}
    }

    /* 2. 展开：顶部两个标签，备忘 / 今日 互斥显示 */
    setMode('full');
    await wait(700);
    res.tabs = await dj(`[...document.querySelectorAll('.tab')].map(b => b.textContent.trim())`);
    res.defaultTab = await dj(`document.body.dataset.tab`);
    await dj(`document.querySelector('.tab[data-tab="notes"]').click(); void 0;`);
    await wait(300);
    res.notesTab = await dj(`JSON.stringify({ tab: document.body.dataset.tab,
      notes: !document.getElementById('paneNotes').hidden,
      today: !document.getElementById('paneToday').hidden })`);
    await dj(`document.querySelector('.tab[data-tab="today"]').click(); void 0;`);
    await wait(300);
    res.todayTab = await dj(`JSON.stringify({ tab: document.body.dataset.tab,
      notes: !document.getElementById('paneNotes').hidden,
      today: !document.getElementById('paneToday').hidden })`);
    if (process.env.DP_SHOT) {
      try { fs.writeFileSync(path.join(DATA_DIR, 'dock-today.png'), (await D.webContents.capturePage()).toPNG()); } catch (e) {}
    }

    /* 3. 今日页快速新增 → 写进同一份 store.json */
    const rows0 = await dj(`document.querySelectorAll('#todayTodoList .trow').length`);
    const rows1 = await dj(`(async () => {
      const i = document.getElementById('todayInput');
      i.value = '自检待办 #自检';
      document.getElementById('todayAdd').click();
      await new Promise(r => setTimeout(r, 600));
      return document.querySelectorAll('#todayTodoList .trow').length;
    })()`);
    res.todoRows = [rows0, rows1];
    await wait(600);
    let disk = S.read(DATA_FILE);
    const tt = disk.plan.todos.find(t => String(t.title || '').indexOf('自检待办') === 0);
    testTodoId = tt ? tt.id : null;
    res.todoOnDisk = !!tt;

    /* 4. 完整窗口：打开后能看到侧边栏刚加的那条（外部改动同步） */
    openPlan();
    await wait(2600);
    const P = planWin;
    const pj = js => P.webContents.executeJavaScript(js, true);
    res.planOpen = !!(P && !P.isDestroyed() && P.isVisible());
    res.planSeesTodo = await pj(`state.todos.some(t => String(t.title || '').indexOf('自检待办') === 0)`);

    /* 5. 右侧面板折叠：收起后网格占满宽度 */
    await pj(`document.getElementById('sideToggle').click(); void 0;`);
    await wait(300);
    res.sideCollapsed = await pj(`JSON.stringify({
      side: document.body.dataset.side,
      body: getComputedStyle(document.querySelector('.side-body')).display,
      cols: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns })`);
    await pj(`document.getElementById('sideMini').click(); void 0;`);
    await wait(300);
    res.sideExpanded = await pj(`JSON.stringify({
      side: document.body.dataset.side,
      body: getComputedStyle(document.querySelector('.side-body')).display })`);

    /* 6. 早间时段：先归到折叠态，再点开量行数。
       之前直接量，若上次运行把 showEarly 留成了 true，这一步会误报。 */
    res.earlyExists = await pj(`!!document.querySelector('.grid-early')`);
    await pj(`if (state.settings.showEarly) { state.settings.showEarly = false; save(true); render(); } void 0;`);
    await wait(400);
    const h0 = await pj(`document.querySelectorAll('.hour').length`);
    await pj(`document.querySelector('.grid-early').click(); void 0;`);
    await wait(400);
    const h1 = await pj(`document.querySelectorAll('.hour').length`);
    res.earlyHours = [h0, h1];
    res.earlyExpanded = h1 > h0;
    await pj(`document.querySelector('.grid-early').click(); void 0;`);
    await wait(300);

    /* 7. 卡片按标签着色 + 迷你环形进度条 */
    res.cardStyle = await pj(`(() => {
      const e = document.querySelector('.ev');
      if (!e) return 'no-ev';
      const s = getComputedStyle(e);
      return s.borderLeftWidth + ' ' + s.borderLeftColor + ' | ' + s.backgroundColor;
    })()`);
    res.donut = await pj(`JSON.stringify({
      svg: !!document.querySelector('#statPanel .donut'),
      segs: document.querySelectorAll('#statPanel .donut circle').length,
      label: (document.querySelector('#statPanel .donut-t') || {}).textContent || '' })`);
    if (process.env.DP_SHOT) {
      try { fs.writeFileSync(path.join(DATA_DIR, 'dock-plan.png'), (await P.webContents.capturePage()).toPNG()); } catch (e) {}
    }

    /* 8. 失焦 3 秒自动收起：焦点给侧边栏，计划窗口应当自己藏起来 */
    res.planVisibleBefore = P.isVisible();
    if (P.isVisible()) { D.show(); D.focus(); }
    await wait(3800);
    res.planVisibleAfterBlur = P.isVisible();
    res.dockStillVisible = D.isVisible();

    res.ok = res.barOk && res.barOpacity === '1' && res.barHasAdd && res.barHasOpen
          && res.todoRows[1] === res.todoRows[0] + 1 && res.todoOnDisk
          && res.planOpen && res.planSeesTodo
          && JSON.parse(res.sideCollapsed).side === '0'
          && JSON.parse(res.sideExpanded).side === '1'
          && res.earlyExists && res.earlyExpanded
          && JSON.parse(res.donut).svg
          && res.planVisibleBefore === true && res.planVisibleAfterBlur === false;
  } catch (e) {
    res.fatal = String((e && e.stack) || e);
  } finally {
    /* 清理自检数据 */
    try {
      if (testTodoId) {
        cache.plan.todos = (cache.plan.todos || []).filter(t => t.id !== testTodoId);
        saveNow(); pushToday(); notifyPlanChanged();
      }
    } catch (e) {}
    freezeTick = false;
  }
  try { fs.writeFileSync(out, JSON.stringify(res, null, 2)); } catch (e) {}
}

/* ============================================================
   启动
   ============================================================ */
function loadOrMigrate() {
  DATA_DIR = pickDir();
  DATA_FILE = path.join(DATA_DIR, 'store.json');

  let legacy = null;
  if (!fs.existsSync(DATA_FILE)) {
    const old = path.join(LEGACY_DIR, 'memo.json');
    if (fs.existsSync(old)) {
      try { legacy = JSON.parse(fs.readFileSync(old, 'utf8')); } catch (e) { legacy = null; }
    }
  }
  cache = legacy ? S.normalize(legacy) : S.read(DATA_FILE);
  if (legacy) {
    cache.migratedFrom = 'deskmemo/data/memo.json';
    S.write(DATA_FILE, cache);
  }

  // 旧周计划网页版的备份：放到 data/plan.import.json 就会自动并入
  const imp = path.join(DATA_DIR, 'plan.import.json');
  if (fs.existsSync(imp)) {
    try {
      const raw = JSON.parse(fs.readFileSync(imp, 'utf8'));
      if (Array.isArray(raw.items) || Array.isArray(raw.todos)) {
        S.mergePlan(cache, raw);
        cache.ui.planSeeded = true;
        S.write(DATA_FILE, cache);
      }
      fs.renameSync(imp, imp.replace('.json', '.imported.json'));
    } catch (e) {}
  }
}

/* ============================================================
   桌面化自检（DP_WINSELF=<输出路径>）
   这一轮改造的核心验收，全部跑真实代码路径（不另起窗口、不打桩）：
     1. 两个窗口都在任务栏、窗口标题是应用名
     2. 关掉日历 → 应用不退出，日历变最小化（同窗口、页面状态不丢）
     3. 从任务栏恢复 → 同一窗口不重建
     4. 日历里呼出小方框 → 日历不被关、不被最小化（两者互不排斥）
     5. 日历里改皮肤 / 字体 → 悬浮窗同步
     6. 日历主界面的设置弹层里有皮肤色板 + 字体分段
   ============================================================ */
async function runWindowSelfTest() {
  const out = process.env.DP_WINSELF;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const res = { ts: Date.now(), notes: [], steps: [] };
  const save = () => { try { fs.writeFileSync(out, JSON.stringify(res, null, 2)); } catch (e) {} };
  const note = s => { res.notes.push(s); save(); };
  /* 软执行器：单步失败只记录不中断，否则第一处抛错就看不到后面的结论 */
  const j = async (w, code) => {
    try { return await w.webContents.executeJavaScript(code, true); }
    catch (e) { res.steps.push(String((e && e.message) || e).slice(0, 200)); return null; }
  };
  const skinBackup = cache.shared.skin;
  const fontBackup = cache.shared.font;

  try {
    freezeTick = true;                 // 冻结自动形态切换，保证断言可复现
    await wait(2600);

    /* 1. 任务栏：窗口身份 + 标题
       （skipTaskbar 是创建参数，Electron 没有读取接口，只能验标题与窗口数） */
    res.win1 = {
      count: BrowserWindow.getAllWindows().length,
      planTitle: planWin ? planWin.getTitle() : '',
      widgetTitle: win ? win.getTitle() : '',
    };
    res.win1.planOk = res.win1.planTitle.indexOf('DeskPlan') >= 0
                   && res.win1.planTitle.indexOf('周计划备忘录') < 0;
    res.win1.widgetOk = res.win1.widgetTitle.indexOf('DeskPlan') >= 0
                     && res.win1.widgetTitle.indexOf('悬浮窗') >= 0;
    note(`窗口数=${res.win1.count} 日历标题「${res.win1.planTitle}」小方框标题「${res.win1.widgetTitle}」`);

    /* 2. 关掉日历 → 应变最小化而不是被销毁 */
    const planId = planWin ? planWin.id : null;
    const mark = 'winSelftest-' + Date.now();
    await j(planWin, `document.getElementById('search').value = ${JSON.stringify(mark)}; void 0`);
    const P = planWin;
    P.close();
    await wait(1100);
    res.closeBehaviour = {
      alive: !P.isDestroyed(),
      isMinimized: P.isDestroyed() ? null : P.isMinimized(),
      sameWindowId: P.isDestroyed() ? false : P.id === planId,
      searchKept: P.isDestroyed() ? null : await j(P, `document.getElementById('search').value`),
      widgetAlive: !!(win && !win.isDestroyed()),
      widgetVisible: !!(win && !win.isDestroyed() && win.isVisible()),
      appAlive: BrowserWindow.getAllWindows().length > 0,
    };
    note(`关闭日历后 → 最小化=${res.closeBehaviour.isMinimized} 同窗口=${res.closeBehaviour.sameWindowId}` +
         ` 搜索框保留=${res.closeBehaviour.searchKept === mark} 应用存活=${res.closeBehaviour.appAlive}`);

    /* 3. 从任务栏恢复：openPlan 应restore 而不是新建 */
    openPlan();
    await wait(1200);
    res.restoreBehaviour = {
      sameWindowId: !P.isDestroyed() && P.id === planId,
      notMinimized: !P.isDestroyed() && !P.isMinimized(),
      visible: !P.isDestroyed() && P.isVisible(),
      searchStillThere: P.isDestroyed() ? null : await j(P, `document.getElementById('search').value`),
    };
    note(`恢复后→ 同窗口=${res.restoreBehaviour.sameWindowId}` +
         ` 已取消最小化=${res.restoreBehaviour.notMinimized}` +
         ` 搜索框仍在=${res.restoreBehaviour.searchStillThere === mark}`);

    /* 4. 日历里呼出小方框：日历不能被关、不能被最小化 */
    await j(P, `document.getElementById('toggleWidget').click(); void 0`);
    await wait(1300);
    res.widgetFromPlan = {
      planAlive: !P.isDestroyed(),
      planNotMinimized: !P.isDestroyed() && !P.isMinimized(),
      planVisible: !P.isDestroyed() && P.isVisible(),
      widgetVisible: !!(win && !win.isDestroyed() && win.isVisible()),
      widgetWidth: win && !win.isDestroyed() ? win.getSize()[0] : null,
    };
    note(`小方框呼出后 → 日历仍可见=${res.widgetFromPlan.planVisible}` +
         ` 未最小化=${res.widgetFromPlan.planNotMinimized}` +
         ` 小方框宽度=${res.widgetFromPlan.widgetWidth}`);

    /* 5. 日历里改皮肤 → 悬浮窗同步 */
    const sBefore = await j(win, `document.body.dataset.skin`);
    await j(P, `document.querySelector('#skinGrid .skin-chip[data-skin="nebula"]').click(); void 0`);
    await wait(1400);
    res.skinSync = {
      widgetBefore: sBefore,
      widgetAfter: await j(win, `document.body.dataset.skin`),
      planAfter: await j(P, `document.documentElement.dataset.skin`),
      disk: cache.shared.skin,
    };
    res.skinSync.ok = res.skinSync.widgetAfter === 'nebula'
                   && res.skinSync.planAfter === 'nebula'
                   && res.skinSync.disk === 'nebula';
    note(`日历切星野 → 悬浮窗=${res.skinSync.widgetAfter} 日历=${res.skinSync.planAfter} 落盘=${res.skinSync.disk}`);

    /* 6. 日历里改字体 */
    await j(P, `document.querySelector('#fontSeg button[data-font="li"]').click(); void 0`);
    await wait(1200);
    res.fontSync = {
      plan: await j(P, `getComputedStyle(document.querySelector('.mf')||document.body).fontFamily`),
      widget: await j(win, `getComputedStyle(document.querySelector('.mf')||document.body).fontFamily`),
      disk: cache.shared.font,
    };
    note(`字体 → 日历=${String(res.fontSync.plan).slice(0, 26)} ` +
         `小方框=${String(res.fontSync.widget).slice(0, 26)} 落盘=${res.fontSync.disk}`);

    /* 7. 日历主界面的设置 UI */
    await j(P, `document.getElementById('openSettings').click(); void 0`);
    await wait(800);
    const uiRaw = await j(P, `JSON.stringify({
      skinChips: document.querySelectorAll('#skinGrid .skin-chip').length,
      fontBtns: document.querySelectorAll('#fontSeg button').length,
      topbarBtn: !!document.getElementById('toggleWidget'),
      skinOn: (document.querySelector('#skinGrid .skin-chip.is-on')||{dataset:{}}).dataset.skin || '',
      fontOn: (document.querySelector('#fontSeg button.is-on')||{dataset:{}}).dataset.font || '',
      modalOpen: !document.getElementById('settingsModal').hidden,
      swatches: [...document.querySelectorAll('#skinGrid .skin-sw')].map(e => e.style.background).filter(Boolean).length
    })`);
    res.planSettingsUi = uiRaw ? JSON.parse(uiRaw) : {};
    note(`日历设置 → 色板=${res.planSettingsUi.skinChips} 字体按钮=${res.planSettingsUi.fontBtns}` +
         ` 弹层打开=${res.planSettingsUi.modalOpen} 色板有底色=${res.planSettingsUi.swatches}/6` +
         ` 选中皮肤=${res.planSettingsUi.skinOn} 选中字体=${res.planSettingsUi.fontOn}`);

    /* 8. 主进程静态断言：只查代码，不匹配注释。
      注意断言字符串本身就在 main.js 里，直接写 'planWin.hide()' 会匹配到自己这行，
      所以用拼接把关键片段拆开，避免自指。 */
    const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const HIDE = 'planWin' + '.hide' + '()';
    const MIN  = 'planWin' + '.minimize' + '()';
    res.mainChecks = {
      windowAllClosed: codeOnly.indexOf("app.on('window-all-closed'") >= 0,
      autoDockDefaultOff: /let autoDock = false/.test(codeOnly),
      planMinimizeNotHide: codeOnly.indexOf(MIN) >= 0 && codeOnly.indexOf(HIDE) < 0,
      secondInstance: codeOnly.indexOf("app.on('second-instance'") >= 0,
      setName: codeOnly.indexOf('app.setName(') >= 0,
      skipTaskbarAllOff: (codeOnly.match(/skipTaskbar:\s*true/g) || []).length === 0,
      bothIpcWay: codeOnly.indexOf("ipcMain.on('widget:show'") >= 0
               && codeOnly.indexOf("ipcMain.on('plan:show'") >= 0,
    };
    note('主进程检查 → ' + JSON.stringify(res.mainChecks));

    const cb = res.closeBehaviour, rb = res.restoreBehaviour, wf = res.widgetFromPlan,
          ui = res.planSettingsUi, mc = res.mainChecks;
    res.ok = res.win1.count >= 2 && res.win1.planOk && res.win1.widgetOk
      && cb.isMinimized === true && cb.sameWindowId && cb.searchKept === mark
      && cb.widgetAlive === true && cb.appAlive === true
      && rb.sameWindowId === true && rb.notMinimized === true && rb.visible === true
      && rb.searchStillThere === mark
      && wf.planAlive === true && wf.planNotMinimized === true && wf.widgetVisible === true
      && res.skinSync.ok === true
      && ui.skinChips === 6 && ui.fontBtns === 5 && ui.topbarBtn === true
      && ui.modalOpen === true && ui.swatches === 6
      && Object.values(mc).every(Boolean);
  } catch (e) {
    res.fatal = String((e && e.stack) || e).slice(0, 700);
  } finally {
    /* 还原外观，别把测试皮肤留给用户 */
    try {
      cache.shared.skin = skinBackup;
      cache.shared.font = fontBackup;
      saveNow();
      pushShared('widget'); pushShared('plan');
    } catch (e) {}
    freezeTick = false;
  }
  save();
}

/* ============================================================
   集成自检（DP_VERIFY=<输出路径>）
   验证"两个窗口共用一份数据源"这条主线：
   悬浮窗里打开周计划 → 页面写数据 → 落到同一个 JSON → 悬浮窗摘要更新 → 刷新仍在
   ============================================================ */
async function runIntegrationVerify() {
  const out = process.env.DP_VERIFY;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const res = { ts: Date.now() };
  try {
    openPlan();
    await wait(2500);
    const pw = planWin;
    res.bridgeActive = await pw.webContents.executeJavaScript('!!window.__planBridge');
    res.bridgeError = await pw.webContents.executeJavaScript('String(window.__planBridgeError || "")');
    res.items0 = await pw.webContents.executeJavaScript('state.items.length');

    const added = await pw.webContents.executeJavaScript(`(function () {
      state.items.push({
        id: 'verify' + Date.now(),
        title: '集成自检：合并后的数据落点',
        note: '由 tools 自检写入，会自动清理',
        date: state.cursor, startMin: 8 * 60, dur: 60,
        tags: ['自检'], color: 'dai', done: false, createdAt: Date.now()
      });
      save(true);
      return state.items.length;
    })()`);
    res.items1 = added;
    await wait(700);

    let disk = S.read(DATA_FILE);
    res.diskPlanItems = disk.plan.items.length;
    res.persisted = disk.plan.items.some(i => String(i.title || '').indexOf('集成自检') === 0);
    res.notesShared = Array.isArray(disk.notes.items) ? disk.notes.items.length : -1;
    res.shared = disk.shared;

    await wait(700);
    res.widgetTip = await win.webContents.executeJavaScript('document.getElementById("planTip").textContent');

    await pw.reload();
    await wait(2200);
    res.itemsAfterReload = await pw.webContents.executeJavaScript('state.items.length');

    if (process.env.DP_SHOT) {
      try {
        fs.writeFileSync(process.env.DP_SHOT, (await pw.webContents.capturePage()).toPNG());
      } catch (e) {}
    }
    disk = S.read(DATA_FILE);
    res.diskAfterReload = disk.plan.items.length;

    await pw.webContents.executeJavaScript(
      `state.items = state.items.filter(i => String(i.title || '').indexOf('集成自检') !== 0); save(true); void 0;`
    );
    await wait(600);
    res.diskFinal = S.read(DATA_FILE).plan.items.length;

    res.ok = res.bridgeActive && res.persisted &&
             res.itemsAfterReload === added &&
             res.diskFinal === res.items0;
  } catch (e) {
    res.fatal = String(e && e.stack || e);
  }
  try { fs.writeFileSync(out, JSON.stringify(res, null, 2)); } catch (e) {}
}

app.whenReady().then(() => {
  loadOrMigrate();
  createWindow();      // 悬浮小方框：常驻但默认隐藏，仅在收起/最小化后才出现
  /* 自检需要两个窗口都真实可见：隐藏窗口的 close / minimize 语义和前台时不一样，
     而且 hide 着的窗口在任务栏上根本看不到，测不出「窗口没被销毁」这件事。 */
  if (process.env.DP_WINSELF && win && !win.isDestroyed()) win.show();
  createTray();
  startFullscreenWatch();

  setInterval(tick, 70);

  /* 默认直接进入日历（主界面）；重复双击图标只把日历叫到前台 */
  openPlan();
  app.on('second-instance', () => { openPlan(); });

  globalShortcut.register('Control+Shift+Space', () => {
    if (!win || win.isDestroyed()) return;
    win.show();
    forceUntil = Date.now() + 8000;
    setMode('full');
    win.focus();
    win.webContents.executeJavaScript('document.getElementById("input").focus(); void 0').catch(() => {});
  });
  globalShortcut.register('Control+Shift+W', () => {
    if (planWin && !planWin.isDestroyed() && planWin.isVisible() && !planWin.isMinimized()) planWin.focus();
    else openPlan();
  });
  globalShortcut.register('Control+Shift+H', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible() && win.getSize()[0] === MODE_W.full) dockWidget();
    else showAndHold();
  });

  if (process.env.DP_VERIFY) setTimeout(runIntegrationVerify, 2600);
  if (process.env.DP_DOCK) setTimeout(runDockVerify, 2200);
  if (process.env.DP_WINSELF) setTimeout(runWindowSelfTest, 2400);
});

/* ---- 常驻后台：不因为「窗口都没了」就自己退出 ----
   Electron 的默认行为是所有窗口关闭即 app.quit()。桌边是常驻工具，
   用户把日历和悬浮窗都收起来之后还指望它继续跑（全局快捷键、托盘、
   开机自启都要有主进程活着）。这里显式接管。
   macOS 本来就是常驻；Windows/Linux 下改成「只剩托盘」，不退出。 */
app.on('window-all-closed', () => {
  if (app.isQuitting) return;
  if (process.platform === 'darwin') return;
  // 不退出。托盘 + 快捷键仍然可用；再次双击图标走 second-instance 唤起日历。
});

/* macOS：点 Dock 图标时若一个窗口都没有，把日历叫回来 */
app.on('activate', () => {
  if (!planWin || planWin.isDestroyed()) openPlan();
  else if (planWin.isMinimized()) { planWin.restore(); planWin.show(); }
});
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });
