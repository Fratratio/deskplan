/* 诊断：切字体到底有没有落到正文。分别测计划页(.mf)与悬浮窗(.item-text)。 */
const fs=require('fs'), path=require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function probeCSS(name, loadOpts, sel, fontAttrSetter) {
  return new Promise(async (resolve) => {
    const win = new BrowserWindow({ width: 1200, height: 800, show: false,
      webPreferences: loadOpts.webPreferences });
    win.loadFile(loadOpts.file);
    await sleep(2400);
    const r = await win.webContents.executeJavaScript(`(async () => {
      const out = { name: ${JSON.stringify(name)} };
      const ctx = document.createElement('canvas').getContext('2d');
      const sample = '周计划备忘录 abc 永';
      const w = f => { ctx.font = '40px ' + f; return Math.round(ctx.measureText(sample).width*100)/100; };
      for (const f of ['kai','xing','li','fang','default']) {
        ${fontAttrSetter('f')};
        const node = document.querySelector(${JSON.stringify(sel)});
        if (!node) { out[f] = { err: 'no node' }; continue; }
        const cs = getComputedStyle(node);
        out[f] = {
          family: cs.fontFamily.slice(0, 120),
          width: w(cs.fontFamily),
        };
      }
      // 单点确认各字体家族名在本机是否真的可用
      out.avail = {};
      ['KaiTi','STKaiti','楷体','STXingkai','华文行楷','STLiti','华文隶书','STFangsong','华文仿宋','SimSun','宋体','Microsoft YaHei'].forEach(nm => {
        try { out.avail[nm] = document.fonts.check('40px "' + nm + '"'); } catch(e){ out.avail[nm] = 'err'; }
      });
      return out;
    })()`);
    win.destroy();
    resolve(r);
  });
}

(async () => {
  app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();
  const STORE = path.join(__dirname,'..','data','store.json');
  let served=false;
  ipcMain.on('plan:read', e => { if(!served){served=true; try{e.returnValue=JSON.stringify(JSON.parse(fs.readFileSync(STORE,'utf8')).plan||null);}catch(_){e.returnValue=null;}} else e.returnValue=null; });
  ipcMain.on('plan:write', e => { e.returnValue=true; });
  ipcMain.handle('load', () => ({ v:3, settings:{ theme:'rice', font:'kai' }, items:[{id:'1',text:'周计划备忘录 abc',note:'',subs:[],done:false,color:'dai',tags:[],star:false,createdAt:Date.now(),doneAt:null}], archived:[] }));
  ipcMain.on('save', ()=>{});
  ['renderer-ready','fit','set-theme','set-edge','set-lock','set-stealth','set-motion','set-busy','notify'].forEach(c=>ipcMain.on(c,()=>{}));
  ipcMain.handle('set-pin',()=>true);
  ipcMain.handle('plan-summary',()=>({todayCount:0,next:'',todoCount:0}));
  ipcMain.handle('today:view',()=>({todayStr:'',items:[],todos:[],doneCount:0,pending:0,minutes:0}));

  const plan = await probeCSS('plan(.mf)', {
    file: path.join(__dirname,'..','app','plan','index.html'),
    webPreferences: { preload: path.join(__dirname,'..','app','preload-plan.js'), contextIsolation:true }
  }, '.ev-t.mf', f => `document.documentElement.dataset.font = ${f}; void 0;`);

  const widget = await probeCSS('widget(.item-text)', {
    file: path.join(__dirname,'..','app','widget','index.html'),
    webPreferences: { preload: path.join(__dirname,'..','app','preload-widget.js'), contextIsolation:true }
  }, '.item-text', f => `document.body.dataset.font = ${f}; void 0;`);

  console.log(JSON.stringify({ plan, widget }, null, 1));
  setTimeout(()=>app.quit(),300);
})();
