/* 悬浮窗「质感」三项体检：不透明度 / 毛玻璃 / 纸张噪点
   在真实 Electron 透明窗口里跑，模拟拖动滑块，读渲染后的真实计算样式。
   窗口必须可见并等过渡走完，否则读到的是 background/backdrop-filter 的起始值。 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const STORE = path.join(__dirname, '..', 'data', 'store.json');

(async () => {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();

  let root = null;
  try { root = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) {}
  let served = false;
  ipcMain.handle('load', () => {
    if (!served) {
      served = true;
      return { v: 3, settings: Object.assign({}, root && root.settings), items: (root && root.notes && root.notes.items) || [], archived: [] };
    }
    return null;
  });
  let lastSaved = null;
  ipcMain.on('save', (_e, s) => { lastSaved = s; });   // 只记内存，不落盘，保护真实数据
  ipcMain.on('renderer-ready', () => {});
  ipcMain.on('fit', () => {});
  ['set-theme', 'set-edge', 'set-lock', 'set-stealth', 'set-motion', 'set-busy', 'notify'].forEach(c => ipcMain.on(c, () => {}));
  ipcMain.handle('set-pin', () => true);
  ipcMain.handle('plan-summary', () => ({ todayCount: 0, next: '', todoCount: 0 }));
  ipcMain.handle('today:view', () => ({ todayStr: '', items: [], todos: [], doneCount: 0, pending: 0, minutes: 0 }));

  const win = new BrowserWindow({
    width: 360, height: 620, show: true, frame: false, transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, '..', 'app', 'preload-widget.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, '..', 'app', 'widget', 'index.html'));
  await sleep(2500);

  /* .card 上有 transition: background .2s / backdrop-filter .2s，
     隐藏窗口不出帧时读到的一直是过渡起始值。这里先把过渡全关掉，
     读到的就是目标值——只影响量测，不影响真实交互（真实交互要的就是那段过渡）。 */
  await win.webContents.executeJavaScript(`(() => {
    const st = document.createElement('style');
    st.id = 'probe-noanim';
    st.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
    document.head.appendChild(st);
  })()`);
  await sleep(300);

  const set = (vals) => win.webContents.executeJavaScript(`(() => {
    const put = (id, v) => { const n = document.getElementById(id); n.value = String(v); n.dispatchEvent(new Event('input', { bubbles: true })); };
    put('alphaRange', ${vals.alpha}); put('blurRange', ${vals.blur}); put('grainRange', ${vals.grain});
  })()`);

  const read = () => win.webContents.executeJavaScript(`(() => {
    const rs = getComputedStyle(document.documentElement);
    const card = document.querySelector('.card');
    const cs = getComputedStyle(card);
    const after = getComputedStyle(card, '::after');
    const val = id => (document.getElementById(id) || {}).textContent;
    return {
      state:  { alpha: state.settings.alpha, blur: state.settings.blur, grain: state.settings.grain },
      varOnCard: { bgA: getComputedStyle(card).getPropertyValue('--bg-a').trim(),
                   blur: getComputedStyle(card).getPropertyValue('--blur').trim(),
                   grain: getComputedStyle(card).getPropertyValue('--grain').trim() },
      rendered: { cardBg: cs.backgroundColor, backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
                  grainOpacity: after.opacity },
      readout: { blur: val('blurVal'), alpha: val('alphaVal'), grain: val('grainVal') },
      blurOffAttr: document.documentElement.dataset.blurOff,
    };
  })()`);

  const cases = {};
  cases['启动默认']      = await read();
  const run = async (name, v) => { await set(v); await sleep(500); cases[name] = await read(); };
  await run('alpha=100(全不透)', { alpha: 100, blur: 26, grain: 35 });
  await run('alpha=20(近全透)',  { alpha: 20,  blur: 26, grain: 35 });
  await run('blur=0(关)',        { alpha: 90,  blur: 0,  grain: 35 });
  await run('blur=44(最强)',     { alpha: 90,  blur: 44, grain: 35 });
  await run('grain=0(关)',       { alpha: 90,  blur: 26, grain: 0 });
  await run('grain=100(最强)',   { alpha: 90,  blur: 26, grain: 100 });
  await run('三项同时：透+模糊+噪点', { alpha: 35, blur: 44, grain: 80 });

  /* ---- 持久化：松手 → 主进程收到的存档；再按这份存档重载，看是否生效 ---- */
  const persist = {};
  await win.webContents.executeJavaScript(`(() => {
    const put = (id, v) => { const n = document.getElementById(id); n.value = String(v); n.dispatchEvent(new Event('input', { bubbles: true })); };
    put('alphaRange', 30); put('blurRange', 10); put('grainRange', 60);
    ['alphaRange', 'blurRange', 'grainRange'].forEach(id =>
      document.getElementById(id).dispatchEvent(new Event('change', { bubbles: true })));   // 松手
  })()`);
  await sleep(600);
  persist.savedSettings = lastSaved && lastSaved.settings
    ? { alpha: lastSaved.settings.alpha, blur: lastSaved.settings.blur, grain: lastSaved.settings.grain }
    : null;

  // 用这份存档当"重启后读到的配置"再加载一次
  served = false;
  const saved = persist.savedSettings;
  ipcMain.removeHandler('load');
  ipcMain.handle('load', () => ({
    v: 3,
    settings: Object.assign({}, root && root.settings, saved),
    items: [],                    // 关键：一条备忘都没有，验证"设置不再依赖备忘是否存在"
    archived: [],
  }));
  win.loadFile(path.join(__dirname, '..', 'app', 'widget', 'index.html'));
  await sleep(2500);
  await win.webContents.executeJavaScript(`(() => {
    const st = document.createElement('style');
    st.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
    document.head.appendChild(st);
  })()`);
  await sleep(300);
  persist.afterReload = await read();
  persist.persistOk = !!saved
    && persist.afterReload.state.alpha === saved.alpha
    && persist.afterReload.state.blur === saved.blur
    && persist.afterReload.state.grain === saved.grain
    && /0\.3\)$/.test(persist.afterReload.rendered.cardBg)
    && /blur\(10px\)/.test(persist.afterReload.rendered.backdrop)
    && persist.afterReload.rendered.grainOpacity === '0.06';

  /* 收尾截一张：把三项拉到一个能看出效果的组合（半透 + 强模糊 + 中等噪点） */
  await set({ alpha: 45, blur: 40, grain: 70 });
  await sleep(400);
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '..', 'data', 'widget-texture.png'), img.toPNG());
  } catch (e) {}

  // 判定
  const g = n => cases[n];
  const verdict = {
    alphaChanges:       g('alpha=100(全不透)').rendered.cardBg !== g('alpha=20(近全透)').rendered.cardBg,
    // alpha=1 时 Chromium 把 rgba(...,1) 归一成 rgb(...)（不再带 alpha 通道）
    alphaFullIsOpaque:  !/^rgba\(/.test(g('alpha=100(全不透)').rendered.cardBg)
                        || /,\s*1\)$/.test(g('alpha=100(全不透)').rendered.cardBg),
    alphaLowIsClear:    /0\.2\)$/.test(g('alpha=20(近全透)').rendered.cardBg),
    blurOffWorks:       g('blur=0(关)').rendered.backdrop === 'none',
    blurOnWorks:        /blur\(44px\)/.test(g('blur=44(最强)').rendered.backdrop),
    grainOffWorks:      g('grain=0(关)').rendered.grainOpacity === '0',
    grainOnWorks:       parseFloat(g('grain=100(最强)').rendered.grainOpacity) > 0.05,
    bothTogether:       /0\.35\)$/.test(g('三项同时：透+模糊+噪点').rendered.cardBg)
                        && /blur\(44px\)/.test(g('三项同时：透+模糊+噪点').rendered.backdrop)
                        && parseFloat(g('三项同时：透+模糊+噪点').rendered.grainOpacity) > 0.05,
  };
  verdict.persistOk = persist.persistOk;
  const out = { cases, persist, verdict, OK: Object.values(verdict).every(Boolean) };
  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'widgetprobe.json'), JSON.stringify(out, null, 2));
  setTimeout(() => app.quit(), 300);
})();
