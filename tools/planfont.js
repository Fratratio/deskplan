/* 验证周计划页：切四种字体，正文 .ev-t.mf 的计算字体是否真的跟着变 */
const fs=require('fs'), path=require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname,'..','data','planfont.json');
async function main() {
  app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();
  const STORE = path.join(__dirname,'..','data','store.json');
  let served=false;
  ipcMain.on('plan:read', e => { if(!served){served=true; try{e.returnValue=JSON.stringify(JSON.parse(fs.readFileSync(STORE,'utf8')).plan||null);}catch(_){e.returnValue=null;}} else e.returnValue=null; });
  ipcMain.on('plan:write', e => { e.returnValue=true; });
  const win = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { preload: path.join(__dirname,'..','app','preload-plan.js'), contextIsolation:true } });
  win.loadFile(path.join(__dirname,'..','app','plan','index.html'));
  await sleep(2600);
  await win.webContents.executeJavaScript(`(()=>{const st=document.createElement('style');st.textContent='*,*::before,*::after{transition:none!important}';document.head.appendChild(st);})()`);
  const r = await win.webContents.executeJavaScript(`(() => {
    // 跳到有卡片的周
    const it = state.items.find(i => i.title === '吃饭');
    if (it) { state.cursor = it.date; render(); }
    const ctx = document.createElement('canvas').getContext('2d');
    const sample = '吃饭 永 abc';
    const w = f => { ctx.font='40px '+f; return Math.round(ctx.measureText(sample).width*100)/100; };
    const out = {};
    for (const f of ['kai','xing','li','fang','default']) {
      document.documentElement.dataset.font = f;
      const node = document.querySelector('.ev-t.mf');
      const cs = getComputedStyle(node);
      out[f] = { family: cs.fontFamily.slice(0,70), width: w(cs.fontFamily) };
    }
    return out;
  })()`);
  fs.writeFileSync(OUT, JSON.stringify(r, null, 2));
  app.quit();
}
main().catch(e => { try{fs.writeFileSync(OUT, JSON.stringify({fatal:String(e&&e.stack||e)}));}catch(_){} app.quit(); });
