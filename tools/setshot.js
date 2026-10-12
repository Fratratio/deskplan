/* 设置弹层实拍（DP_SETSHOT=<输出前缀>）
   验证「皮肤和字体能在日历主界面里直接打开和修改」这条要求的视觉效果：
   弹层打开后色板网格、字体分段、选中态是否都正常渲染。
   截屏前必须先注入 transition:none 并等两次 rAF —— capturePage 在
   隐藏/半透明窗口里会拿到上一帧，2026-10-12 那次六套皮肤截图全部错位一格，
   就是栽在这里。 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'app', 'shared', 'store-schema.js'));

const ROOT = path.join(__dirname, '..');
const PREFIX = process.env.DP_SETSHOT;
const DATA = path.join(ROOT, 'data', 'store.json');

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
  ipcMain.handle('plan-summary', () => S.planSummary(cache, '2026-10-12'));
  ipcMain.handle('today:view', () => S.todayView(cache, '2026-10-12'));
  ipcMain.handle('today:act', () => S.todayView(cache, '2026-10-12'));
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

/* 关掉过渡 + 等两次 rAF，确保拍到的是当前帧 */
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
    await wait(320);
    fs.writeFileSync(file, (await w.webContents.capturePage()).toPNG());
    await w.webContents.executeJavaScript('document.getElementById("__ns")?.remove()');
    return true;
  } catch (e) { return false; }
}

app.whenReady().then(async () => {
  cache = S.read(DATA);
  cache.shared = cache.shared || {};
  cache.shared.skin = S.canonSkin(cache.shared.skin);
  stub();

  const win = new BrowserWindow({
    show: true, width: 1280, height: 900, skipTaskbar: false,
    title: '桌边 DeskPlan · 周计划',
    webPreferences: { preload: path.join(ROOT, 'app', 'preload-plan.js'), contextIsolation: true },
  });
  const info = { ts: Date.now(), shots: [] };

  try {
    await win.loadFile(path.join(ROOT, 'app', 'plan', 'index.html'));
    await wait(2600);
    info.shots.push({ name: 'plan-main', ok: await shoot(win, PREFIX + '-main.png') });

    /* 打开设置弹层 */
    await win.webContents.executeJavaScript(`document.getElementById('openSettings').click(); void 0`);
    await wait(900);
    info.shots.push({ name: 'settings', ok: await shoot(win, PREFIX + '-settings.png') });

    /* 量一下网格布局，确认是三列且没溢出 */
    const layout = await win.webContents.executeJavaScript(`JSON.stringify({
      modalOpen: !document.getElementById('settingsModal').hidden,
      cols: getComputedStyle(document.getElementById('skinGrid')).gridTemplateColumns,
      chips: document.querySelectorAll('#skinGrid .skin-chip').length,
      chipW: (document.querySelector('.skin-chip')||{}).offsetWidth || 0,
      fontBtns: document.querySelectorAll('#fontSeg button').length,
      fontW: (document.querySelector('#fontSeg button')||{}).offsetWidth || 0,
      skinOn: (document.querySelector('#skinGrid .skin-chip.is-on')||{dataset:{}}).dataset.skin||'',
      fontOn: (document.querySelector('#fontSeg button.is-on')||{dataset:{}}).dataset.font||'',
      modalW: document.querySelector('.modal-card').offsetWidth
    })`);
    info.layout = JSON.parse(layout);

    /* 点第二套皮肤，看是否即时生效 */
    await win.webContents.executeJavaScript(
      `document.querySelector('#skinGrid .skin-chip[data-skin="sakura"]').click(); void 0`);
    await wait(1000);
    info.afterSakura = await win.webContents.executeJavaScript(`JSON.stringify({
      skin: document.documentElement.dataset.skin,
      on: (document.querySelector('#skinGrid .skin-chip.is-on')||{dataset:{}}).dataset.skin||''
    })`);
    info.afterSakura = JSON.parse(info.afterSakura);
    info.shots.push({ name: 'settings-sakura', ok: await shoot(win, PREFIX + '-settings-sakura.png') });

    /* 关掉弹层拍主界面，看皮肤是否真的铺上去了 */
    await win.webContents.executeJavaScript(`document.querySelector('[data-close]').click(); void 0`);
    await wait(700);
    info.shots.push({ name: 'plan-sakura', ok: await shoot(win, PREFIX + '-plan-sakura.png') });

    /* 切星野 */
    await win.webContents.executeJavaScript(
      `document.getElementById('openSettings').click(); void 0`);
    await wait(500);
    await win.webContents.executeJavaScript(
      `document.querySelector('#skinGrid .skin-chip[data-skin="nebula"]').click(); void 0`);
    await wait(1000);
    await win.webContents.executeJavaScript(`document.querySelector('[data-close]').click(); void 0`);
    await wait(700);
    info.shots.push({ name: 'plan-nebula', ok: await shoot(win, PREFIX + '-plan-nebula.png') });
    info.afterNebula = await win.webContents.executeJavaScript(`document.documentElement.dataset.skin`);
  } catch (e) {
    info.fatal = String((e && e.stack) || e).slice(0, 500);
  } finally {
    try { cache.shared.skin = 'rice'; S.write(DATA, cache); } catch (e) {}
  }

  try { fs.writeFileSync(PREFIX + '.json', JSON.stringify(info, null, 2)); } catch (e) {}
  app.quit();
});