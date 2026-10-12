const fs = require('fs'); const path = require('path');
const { app, BrowserWindow } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();
  const win = new BrowserWindow({ width: 1100, height: 900, show: false, backgroundColor: '#F4F2EE' });
  await win.loadFile(path.join(__dirname, '..', 'docs', '字体与配色样张.html'));
  await sleep(1200);
  const r = await win.webContents.executeJavaScript(`(() => ({
    duskHex: ['dai','tai','ou','tong','zhu'].map(k => getComputedStyle(document.querySelector('.dusk-box')).getPropertyValue('--'+k).trim()),
    duskBg: [].map.call(document.querySelectorAll('#swDusk .sw'), el => getComputedStyle(el).backgroundColor),
    duskInk: getComputedStyle(document.querySelector('#swDusk .sw b')).color,
    lightBg: [].map.call(document.querySelectorAll('#swLight .sw'), el => getComputedStyle(el).backgroundColor),
  }))()`);
  console.log(JSON.stringify(r, null, 2));
  setTimeout(() => app.quit(), 300);
})();
