/* 设置面板排版体检：加了实时读数后，三行质感控件不能撑破 232px 的浮层 */
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();
  ipcMain.handle('load', () => ({ v:3, settings:{ theme:'rice', blur:28, alpha:90, grain:35 }, items:[], archived:[] }));
  ipcMain.on('save', () => {});
  ['renderer-ready','fit','set-theme','set-edge','set-lock','set-stealth','set-motion','set-busy','notify'].forEach(c=>ipcMain.on(c,()=>{}));
  ipcMain.handle('set-pin', () => true);
  ipcMain.handle('plan-summary', () => ({}));
  ipcMain.handle('today:view', () => ({ items:[], todos:[], doneCount:0, pending:0, minutes:0 }));
  const win = new BrowserWindow({ width: 360, height: 700, show: false, frame: false, transparent: true,
    webPreferences: { preload: path.join(__dirname,'..','app','preload-widget.js'), contextIsolation: true } });
  win.loadFile(path.join(__dirname,'..','app','widget','index.html'));
  await sleep(2200);
  const r = await win.webContents.executeJavaScript(`(() => {
    const sheet = document.getElementById('sheet');
    sheet.hidden = false;
    const rows = [...sheet.querySelectorAll('.sheet-row')].map(row => {
      const r = row.getBoundingClientRect();
      const kids = [...row.children].map(c => ({ tag: c.tagName.toLowerCase(), id: c.id, w: Math.round(c.getBoundingClientRect().width) }));
      return { label: row.querySelector('.sheet-label')?.textContent, w: Math.round(r.width), overflow: row.scrollWidth > row.clientWidth + 1, kids };
    });
    const sr = sheet.getBoundingClientRect();
    return { sheetW: Math.round(sr.width), sheetOverflow: sheet.scrollWidth > sheet.clientWidth + 1,
             textureRows: rows.filter(x => ['毛玻璃','不透明度','纸张噪点'].includes(x.label)),
             readouts: { blur: document.getElementById('blurVal').textContent,
                         alpha: document.getElementById('alphaVal').textContent,
                         grain: document.getElementById('grainVal').textContent } };
  })()`);
  console.log(JSON.stringify(r, null, 1));
  setTimeout(() => app.quit(), 300);
})();
