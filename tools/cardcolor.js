/* 卡片实际观感体检：从真实存档渲染计划页，读每张卡的计算底色与不透明度 */
const fs = require('fs'); const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();
  const STORE = path.join(__dirname, '..', 'data', 'store.json');
  let served = false;
  ipcMain.on('plan:read', e => {
    if (!served) { served = true;
      try { e.returnValue = JSON.stringify(JSON.parse(fs.readFileSync(STORE,'utf8')).plan || null); } catch(_) { e.returnValue = null; }
    } else e.returnValue = null;
  });
  ipcMain.on('plan:write', e => { e.returnValue = true; });
  const win = new BrowserWindow({ width: 1300, height: 848, show: false,
    webPreferences: { preload: path.join(__dirname,'..','app','preload-plan.js') } });
  win.loadFile(path.join(__dirname,'..','app','plan','index.html'));
  await sleep(2600);
  await win.webContents.executeJavaScript(`(() => {
    const st=document.createElement('style'); st.textContent='*,*::before,*::after{transition:none!important;animation:none!important}'; document.head.appendChild(st);
  })()`);
  await sleep(300);
  const r = await win.webContents.executeJavaScript(`(() => {
    // 跳到有卡片的那周
    const it = state.items[0];
    if (it && state.cursor !== it.date) { state.cursor = it.date; render(); }
    const cards = [...document.querySelectorAll('.ev')].map(el => {
      const cs = getComputedStyle(el);
      return { title: el.querySelector('.ev-t')?.textContent,
               cls: el.className, opacity: cs.opacity, bg: cs.backgroundColor,
               borderLeft: cs.borderLeftColor };
    });
    return { filterTags: state.filterTags, cursor: state.cursor,
             pageBg: getComputedStyle(document.querySelector('.grid-scroll')||document.body).backgroundColor,
             cards };
  })()`);
  console.log(JSON.stringify(r, null, 1));
  setTimeout(() => app.quit(), 300);
})();
