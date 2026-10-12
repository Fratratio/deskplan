/* 样张截图：把 docs/字体与配色样张.html 渲染成 PNG，供人眼验收 */
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
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'specimen.png'), img.toPNG());
  console.log('saved data/specimen.png');
  setTimeout(() => app.quit(), 300);
})();
