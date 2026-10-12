/* 字体体检：在真实 Electron 里量四套中文字体到底有没有落上。
   document.fonts.check 对系统字体经常撒谎，所以用画布量同一串字的宽度：
   宽度和 monospace 基线不一样，就说明这个字体名真的解析到了。 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const OUT = path.join(__dirname, '..', 'data', 'font.json');
const PNG = path.join(__dirname, '..', 'data', 'font-xing.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FAMILIES = {
  kai:  ['KaiTi', 'STKaiti', '楷体', 'KaiTi_GB2312'],
  xing: ['STXingkai', '华文行楷', 'FZYingKai', 'FZXingKai', '方正行楷', '行楷'],
  li:   ['LiSu', 'STLiti', '华文隶书', '隶书', 'FZLanTi'],
  fang: ['FangSong', 'STFangsong', '华文仿宋', '仿宋', '仿宋_GB2312'],
};

(async () => {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('no-proxy-server');
  await app.whenReady();

  const STORE = path.join(__dirname, '..', 'data', 'store.json');
  let served = false;
  ipcMain.on('plan:read', e => {
    if (!served) {
      served = true;
      try { e.returnValue = JSON.stringify(JSON.parse(fs.readFileSync(STORE, 'utf8')).plan || null); }
      catch (_) { e.returnValue = null; }
    } else e.returnValue = null;
  });
  ipcMain.on('plan:write', e => { e.returnValue = true; });

  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'app', 'preload-plan.js') },
  });
  win.loadFile(path.join(__dirname, '..', 'app', 'plan', 'index.html'));
  await sleep(2500);

  const res = await win.webContents.executeJavaScript(`(() => {
    const fams = ${JSON.stringify(FAMILIES)};
    const ctx = document.createElement('canvas').getContext('2d');
    const t = '桌边备忘 abc 永';
    ctx.font = '72px monospace';
    const base = ctx.measureText(t).width;
    const hit = fam => { ctx.font = '72px "' + fam + '", monospace';
      return Math.abs(ctx.measureText(t).width - base) > 0.5; };

    const out = {};
    for (const k of Object.keys(fams)) {
      out[k] = { names: fams[k], installed: fams[k].filter(hit) };
    }

    // 逐个把字体挂到 html[data-font] 上，量真实 DOM 里备忘正文的渲染宽度
    const probe = document.createElement('span');
    probe.textContent = '把备忘录开发完成';
    probe.style.cssText = 'position:fixed;left:-9999px;font-size:24px;white-space:nowrap';
    document.body.appendChild(probe);
    const applied = {};
    document.documentElement.dataset.font = 'default';
    applied.default = Math.round(probe.getBoundingClientRect().width);
    for (const k of Object.keys(fams)) {
      document.documentElement.dataset.font = k;
      const famVar = getComputedStyle(document.documentElement).getPropertyValue('--font-content');
      probe.style.fontFamily = 'var(--font-content)';
      applied[k] = Math.round(probe.getBoundingClientRect().width);
      applied[k + ':stack'] = famVar.trim().slice(0, 60);
    }
    probe.remove();
    return { installed: out, applied };
  })()`);

  // 用首选字体（行楷）截一张图
  await win.webContents.executeJavaScript(`document.documentElement.dataset.font = 'xing'`);
  await sleep(500);
  win.show();
  await sleep(800);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(PNG, img.toPNG());
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2));

  console.log(JSON.stringify(res, null, 2));
  setTimeout(() => app.quit(), 300);
})();
