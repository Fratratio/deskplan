/* 布局体检：按真实窗口尺寸打开计划页，量各区块的实际像素位置。
   目的：确认网格把剩余高度吃满、底部没有死空白，且状态栏正常渲染。 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen, ipcMain } = require('electron');

const OUT = path.join(__dirname, '..', 'data', 'layout.json');
const PNG = path.join(__dirname, '..', 'data', 'layout.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
  // 禁 GPU，避免 capturePage 间歇性挂起（与 e2e.js 同款加固）
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();

  // 取主显示器可用高度，模拟用户日常窗口大小
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const W = 1300, H = Math.min(886, wa.height);
  // 挂上 plan:read/write 的桩，preload 里的 sendSync 否则会永久阻塞
  const STORE = path.join(__dirname, '..', 'data', 'store.json');
  let served = false;
  ipcMain.on('plan:read', e => {
    if (!served) {
      served = true;
      try { e.returnValue = JSON.stringify(JSON.parse(fs.readFileSync(STORE, 'utf8')).plan || null); }
      catch (_) { e.returnValue = null; }
    } else e.returnValue = null;   // 第二次起交给页面 localStorage，避免覆盖真实数据
  });
  ipcMain.on('plan:write', e => { e.returnValue = true; });   // 只应答不落盘，保护真实数据

  const win = new BrowserWindow({
    width: W, height: H, show: true, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '..', 'app', 'preload-plan.js') },
  });
  win.loadFile(path.join(__dirname, '..', 'app', 'plan', 'index.html'));
  await sleep(2500);

  const px = await win.webContents.executeJavaScript(`(() => {
    const r = s => { const el = document.querySelector(s); if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height), w: Math.round(b.width) }; };
    const inview = s => { const el = document.querySelector(s); return el ? el.textContent.trim().replace(/\\s+/g, ' ') : null; };
    return {
      winH: window.innerHeight,
      bodyH: Math.round(document.body.getBoundingClientRect().height),
      topbar: r('.topbar'),
      layout: r('.layout'),
      planPane: r('.plan-pane'),
      gridScroll: r('.grid-scroll'),
      statusBar: r('.statusbar'),
      side: r('.side'),
      overview: r('#overviewPanel'),
      sbToday: inview('#sbToday'),
      sbWeek: inview('#sbWeek'),
      sbNext: inview('#sbNext'),
      sbHint: inview('.sb-hint'),
      gridScrollable: (() => { const g = document.querySelector('.grid-scroll'); return g ? g.scrollHeight > g.clientHeight + 2 : null; })(),
      docScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
      stateDebug: (() => { try { return { items: state.items.map(i => i.date + ' ' + i.title), cursor: state.cursor, week: weekDates().map(iso) }; } catch (e) { return String(e); } })(),
    };
  })()`);

  const gapBelowStatus = px.winH - px.statusBar.bottom;
  // 侧栏底应与状态栏底齐平（同一行基线），才是真正的"右下无缺口"
  const res = {
    ...px,
    gapBelowStatusBar: gapBelowStatus,
    sideStatusBarAlign: px.side.bottom === px.statusBar.bottom,
    overviewSitsAtBottom: px.overview ? Math.abs(px.overview.bottom - (px.side.bottom - 12)) <= 14 : null,
    VERDICT: {
      noPageScroll: !px.docScrollable,
      gridFillsHeight: px.gridScroll.bottom >= px.planPane.bottom - px.statusBar.h - 20,
      statusBarVisible: !!px.sbToday && !!px.sbWeek && !!px.sbNext,
      noBlankStrip: gapBelowStatus <= 16,
      noRightBottomGap: px.side.bottom === px.statusBar.bottom,
    },
  };
  res.ok = Object.values(res.VERDICT).every(Boolean);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(PNG, img.toPNG());
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
  setTimeout(() => app.quit(), 300);
})();
