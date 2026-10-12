/* 在样张页里逐个量：四套字体是否各自解析成功、色块底色是否真的变深了 */
const fs = require('fs'); const path = require('path');
const { app, BrowserWindow } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();
  const win = new BrowserWindow({ width: 1100, height: 900, show: false, backgroundColor: '#F4F2EE' });
  await win.loadFile(path.join(__dirname, '..', 'docs', '字体与配色样张.html'));
  await sleep(1200);
  const r = await win.webContents.executeJavaScript(`(() => {
    const out = { colors: {}, fonts: {} };
    // 五色：读 CSS 变量 + 量第一块卡片的真实底色
    ['dai','tai','ou','tong','zhu'].forEach(k => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--' + k).trim();
      const el = document.querySelector('#swLight .sw');
      out.colors[k] = v;
    });
    out.lightBg = [].map.call(document.querySelectorAll('#swLight .sw'), el => getComputedStyle(el).backgroundColor);
    out.duskBg  = [].map.call(document.querySelectorAll('#swDusk .sw'),  el => getComputedStyle(el).backgroundColor);
    out.panel   = getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
    // 字体：用含拉丁字符的串量宽度，拉丁字形各字体宽度不同
    const ctx = document.createElement('canvas').getContext('2d');
    const t = 'Memo 备 abc';
    const w = fam => { ctx.font = '40px ' + fam; return Math.round(ctx.measureText(t).width * 100) / 100; };
    const ui = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
    out.fonts['默认UI'] = w(ui);
    ['kai','xing','li','fang'].forEach(k => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--font-' + k).trim();
      out.fonts[k] = { width: w(v), stack: v.slice(0, 70) };
    });
    out.lightCardInk = getComputedStyle(document.querySelector('#swLight .sw b')).color;
    return out;
  })()`);
  console.log(JSON.stringify(r, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'verify-fonts.json'), JSON.stringify(r, null, 2));
  setTimeout(() => app.quit(), 300);
})();
