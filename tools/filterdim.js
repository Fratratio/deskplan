/* 开着筛选时：卡片压暗到多少？状态栏有没有提示？清除按钮点得掉吗？ */
const fs=require('fs'), path=require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();
  const STORE = path.join(__dirname,'..','data','store.json');
  let served=false;
  ipcMain.on('plan:read', e => { if(!served){served=true; try{e.returnValue=JSON.stringify(JSON.parse(fs.readFileSync(STORE,'utf8')).plan||null);}catch(_){e.returnValue=null;}} else e.returnValue=null; });
  ipcMain.on('plan:write', e => { e.returnValue = true; });
  const win = new BrowserWindow({ width:1300, height:848, show:false,
    webPreferences:{ preload: path.join(__dirname,'..','app','preload-plan.js') } });
  win.loadFile(path.join(__dirname,'..','app','plan','index.html'));
  await sleep(2600);
  await win.webContents.executeJavaScript(`(()=>{const st=document.createElement('style');st.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.appendChild(st);})()`);
  const r = await win.webContents.executeJavaScript(`(() => {
    state.filterTags = ['自检']; render();
    const ev = document.querySelector('.ev');
    const before = { cls: ev?.className, opacity: ev ? getComputedStyle(ev).opacity : null,
                     statusBar: document.getElementById('sbNext')?.textContent.trim(),
                     clearBtn: !!document.getElementById('sbClearFilter'),
                     tagClear: !!document.querySelector('.tagchip.is-clear') };
    // 点状态栏里的"清除"
    document.getElementById('sbClearFilter')?.click();
    const ev2 = document.querySelector('.ev');
    const after = { cls: ev2?.className, opacity: ev2 ? getComputedStyle(ev2).opacity : null,
                    filterTags: state.filterTags, clearBtn: !!document.getElementById('sbClearFilter') };
    return { before, after };
  })()`);
  console.log(JSON.stringify(r, null, 1));
  setTimeout(() => app.quit(), 300);
})();
