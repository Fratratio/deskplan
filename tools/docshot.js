/* README 展示图批量实拍（DP_DOCSHOT=<输出目录>）
   给 GitHub 仓库的 README 准备成品图：日历主界面、设置弹层、六套皮肤、悬浮窗。
   数据走 DP_DATA_DIR 指定的副本，不碰真实 store.json。
   用法：electron.exe tools/docshot.js
   输出：<输出目录>/plan-<皮肤>.png / settings.png / widget-<皮肤>.png / docshot.json */
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const S = require(path.join(__dirname, '..', 'app', 'shared', 'store-schema.js'));

const ROOT = path.join(__dirname, '..');
const OUT = process.env.DP_DOCSHOT;
const DATA = process.env.DP_DATA_DIR
  ? path.join(process.env.DP_DATA_DIR, 'store.json')
  : path.join(ROOT, 'data', 'store.json');
/* 本地日期，不要用 toISOString() —— 那是 UTC，东八区在早上 8 点前会退到昨天，
   拍出来的「今日」列和真实当天对不上 */
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const DAY = today();

const wait = ms => new Promise(r => setTimeout(r, ms));
let cache = null;

app.disableHardwareAcceleration();

function stub() {
  for (const n of ['save', 'renderer-ready', 'set-theme', 'notify', 'fit', 'set-edge',
    'set-lock', 'set-stealth', 'set-motion', 'set-busy', 'request-full', 'open-plan',
    'widget:focus', 'widget:show', 'widget:toggle', 'plan:show', 'plan:park', 'app:quit',
    'quit', 'hide']) ipcMain.on(n, () => {});
  for (const n of ['set-pin', 'set-boot']) ipcMain.handle(n, () => true);
  ipcMain.handle('load', () => S.widgetView(cache));
  ipcMain.handle('plan-summary', () => S.planSummary(cache, DAY));
  ipcMain.handle('today:view', () => S.todayView(cache, DAY));
  ipcMain.handle('today:act', () => S.todayView(cache, DAY));
  ipcMain.handle('export', () => '');
  ipcMain.on('plan:read', e => { e.returnValue = JSON.stringify(S.planView(cache)); });
  ipcMain.on('plan:write', (e, t) => {
    try { S.mergePlan(cache, JSON.parse(String(t || '{}'))); e.returnValue = true; }
    catch (x) { e.returnValue = false; }
  });
  ipcMain.on('shared:set', (_e, p) => {
    if (!p) return;
    if (p.skin) cache.shared.skin = S.canonSkin(p.skin);
    if (p.font) cache.shared.font = S.canonFont(p.font);
  });
}

/* 关过渡 + 等两次 rAF，否则 capturePage 会拿到上一帧（隐藏/半透明窗口尤其明显） */
async function shoot(w, file) {
  try {
    await w.webContents.executeJavaScript(
      'void (()=>{const s=document.createElement("style");' +
      's.id="__ns";s.textContent="*,*::before{transition:none!important;animation:none!important}";' +
      'document.head.appendChild(s);void document.body.offsetHeight;})()'
    );
    await w.webContents.executeJavaScript(
      'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))'
    );
    await wait(300);
    fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
    await w.webContents.executeJavaScript('document.getElementById("__ns")?.remove()');
    return true;
  } catch (e) { return false; }
}

/* 两处都要打：skins.css 同时写了 :root / html[data-skin] / body[data-skin]
   三个作用域，日历把属性挂在 <html> 上，悬浮窗挂在 <body> 上，
   只设其中一处，另一边拍出来全是同一个皮肤。 */
async function setSkin(w, skin) {
  await w.webContents.executeJavaScript(
    `document.documentElement.dataset.skin=${JSON.stringify(skin)};` +
    `document.body.dataset.skin=${JSON.stringify(skin)};void 0`);
  await wait(420);
}

app.whenReady().then(async () => {
  cache = S.read(DATA);
  cache.shared = cache.shared || {};
  cache.shared.skin = S.canonSkin(cache.shared.skin || 'rice');
  cache.shared.font = S.canonFont(cache.shared.font || 'kai');
  stub();
  fs.mkdirSync(OUT, { recursive: true });

  const info = { ts: Date.now(), data: DATA, shots: [], skins: [] };

  /* ---------- 悬浮窗：expanded 形态 × 三套皮肤 ----------
     排在日历前面拍，且拍完不 destroy：透明无边框窗口在后创建的 BrowserWindow
     上会 ERR_FAILED（合成器已经为日历那一路占住了），两个并存反而最接近真实运行。 */
  const wid = new BrowserWindow({
    show: true, width: 360, height: 620, frame: false, transparent: true,
    resizable: false, skipTaskbar: true, hasShadow: true,
    backgroundColor: '#00000000',
    title: '桌边 DeskPlan · 悬浮窗',
    webPreferences: { preload: path.join(ROOT, 'app', 'preload-widget.js'), contextIsolation: true },
  });
  try {
    /* 用 pathToFileURL，别手拼 file:/// + 反斜杠 —— 混合分隔符在某些
       Electron 版本上会直接 ERR_FAILED，主文档都加载不出来 */
    await wid.loadURL(url.pathToFileURL(path.join(ROOT, 'app', 'widget', 'index.html')).href);
    await wait(2400);
    await wid.webContents.executeJavaScript(
      `document.body.dataset.mode='expanded';void document.body.offsetHeight`);
    await wait(600);
    for (const skin of ['rice', 'sakura', 'nebula']) {
      await setSkin(wid, skin);
      info.shots.push({ name: `widget-${skin}`, ok: await shoot(wid, path.join(OUT, `widget-${skin}.png`)) });
    }
  } catch (e) {
    info.fatalWidget = String((e && e.stack) || e).slice(0, 500);
  }

  /* ---------- 日历主界面：逐套皮肤 ---------- */
  const plan = new BrowserWindow({
    show: true, width: 1280, height: 860, skipTaskbar: false,
    title: '桌边 DeskPlan · 周计划',
    backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(ROOT, 'app', 'preload-plan.js'), contextIsolation: true },
  });
  try {
    await plan.loadURL(url.pathToFileURL(path.join(ROOT, 'app', 'plan', 'index.html')).href);
    await wait(2800);
    /* 网格默认停在 00:00，一屏全是空白小时行，卡片全挤在底部。
       手动滚到第一条日程附近再拍。 */
    await plan.webContents.executeJavaScript(`(()=>{
      const sc=document.querySelector('.grid-scroll');
      const first=document.querySelector('.ev');
      if(sc) sc.scrollTop = first ? Math.max(0, first.offsetTop - 120) : 0;
      void 0})()`);
    await wait(700);
    for (const skin of ['rice', 'mist', 'sakura', 'dusk', 'nebula', 'forge']) {
      await setSkin(plan, skin);
      const file = path.join(OUT, `plan-${skin}.png`);
      info.shots.push({ name: `plan-${skin}`, ok: await shoot(plan, file) });
    }
    /* 设置弹层（皮肤色板 + 字体分段），用宣纸底最耐看 */
    await setSkin(plan, 'rice');
    await plan.webContents.executeJavaScript(`document.getElementById('openSettings').click();void 0`);
    await wait(1100);
    info.shots.push({ name: 'settings', ok: await shoot(plan, path.join(OUT, 'settings.png')) });
    info.settings = JSON.parse(await plan.webContents.executeJavaScript(`JSON.stringify({
      modalOpen: !document.getElementById('settingsModal').hidden,
      chips: document.querySelectorAll('#skinGrid .skin-chip').length,
      fontBtns: document.querySelectorAll('#fontSeg button').length
    })`));
  } catch (e) {
    info.fatalPlan = String((e && e.stack) || e).slice(0, 500);
  }

  try { fs.writeFileSync(path.join(OUT, 'docshot.json'), JSON.stringify(info, null, 2)); } catch (e) {}
  console.log('DOCSHOT DONE', JSON.stringify(info.shots));
  app.quit();
});