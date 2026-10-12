const fs=require('fs'), path=require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.join(__dirname,'..','data','fontdiag2.json');

async function main() {
  app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();
  ipcMain.handle('load', () => ({ v:3, settings:{ theme:'rice', font:'kai' }, items:[{id:'1',text:'周计划备忘 abc',note:'',subs:[],done:false,color:'dai',tags:[],star:false,createdAt:Date.now(),doneAt:null}], archived:[] }));
  ipcMain.on('save', ()=>{});
  ['renderer-ready','fit','set-theme','set-edge','set-lock','set-stealth','set-motion','set-busy','notify'].forEach(c=>ipcMain.on(c,()=>{}));
  ipcMain.handle('set-pin',()=>true);
  ipcMain.handle('plan-summary',()=>({todayCount:0,next:'',todoCount:0}));
  ipcMain.handle('today:view',()=>({todayStr:'',items:[],todos:[],doneCount:0,pending:0,minutes:0}));

  const win = new BrowserWindow({ width: 600, height: 700, show: false,
    webPreferences: { preload: path.join(__dirname,'..','app','preload-widget.js'), contextIsolation:true, nodeIntegration:false } });
  win.loadFile(path.join(__dirname,'..','app','widget','index.html'));
  await sleep(2500);

  const res = await win.webContents.executeJavaScript(`(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    const sample = '周计划备忘 abc 永';
    const w = f => { ctx.font = '40px ' + f; return Math.round(ctx.measureText(sample).width*100)/100; };
    const out = {};
    // 逐个把 body[data-font] 设上，量 .item-text 的计算字体
    for (const f of ['sans','kai','xing','li','fang']) {
      document.body.dataset.font = f;
      const node = document.querySelector('.item-text');
      const cs = getComputedStyle(node);
      out[f] = { family: cs.fontFamily.slice(0,90), width: w(cs.fontFamily) };
    }
    out.cssVar = {};
    for (const f of ['sans','kai','xing','li','fang']) {
      document.body.dataset.font = f;
      out.cssVar[f] = getComputedStyle(document.body).getPropertyValue('--font-content').trim().slice(0,80);
    }
    out.fontsCheck = {};
    ['KaiTi','STKaiti','楷体','Kaiti SC','STXingkai','华文行楷','STLiti','华文隶书','STFangsong','华文仿宋','SimSun','宋体','Microsoft YaHei','Segoe UI'].forEach(nm => {
      try { out.fontsCheck[nm] = document.fonts.check('40px "' + nm + '"'); } catch(e){ out.fontsCheck[nm]='err'; }
    });
    return out;
  })()`);

  fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
  app.quit();
}
main().catch(e => { try{fs.writeFileSync(OUT, JSON.stringify({fatal:String(e&&e.stack||e)}));}catch(_){} app.quit(); });
