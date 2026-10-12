/* 确认：--bg-a 在 html 上改了，但 .card 到底继承自谁 */
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('no-sandbox');
  await app.whenReady();
  ipcMain.handle('load', () => null);
  ipcMain.on('save', () => {});
  const win = new BrowserWindow({ width: 360, height: 620, show: false, frame: false, transparent: true,
    webPreferences: { preload: path.join(__dirname, '..', 'app', 'preload-widget.js'), contextIsolation: true } });
  win.loadFile(path.join(__dirname, '..', 'app', 'widget', 'index.html'));
  await sleep(2000);
  const r = await win.webContents.executeJavaScript(`(() => {
    const html = document.documentElement, body = document.body, card = document.querySelector('.card');
    document.documentElement.style.setProperty('--bg-a', '0.45');
    document.documentElement.style.setProperty('--blur', '0px');
    return {
      bodyDatasetTheme: body.dataset.theme,
      varOnHtml: getComputedStyle(html).getPropertyValue('--bg-a').trim(),
      varOnBody: getComputedStyle(body).getPropertyValue('--bg-a').trim(),
      varOnCard: getComputedStyle(card).getPropertyValue('--bg-a').trim(),
      cardBg:   getComputedStyle(card).backgroundColor,
      blurOnCard: getComputedStyle(card).getPropertyValue('--blur').trim(),
      cardBackdrop: getComputedStyle(card).backdropFilter,
      // 对照组：把同样的值写到 body 上
    };
  })()`);
  console.log('--- 只改 html 上：'); console.log(JSON.stringify(r, null, 1));
  const r2 = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.card');
    document.body.style.setProperty('--bg-a', '0.45');
    document.body.style.setProperty('--blur', '0px');
    return { varOnCard: getComputedStyle(card).getPropertyValue('--bg-a').trim(),
             cardBg: getComputedStyle(card).backgroundColor,
             cardBackdrop: getComputedStyle(card).backdropFilter };
  })()`);
  console.log('--- 改到 body 上：'); console.log(JSON.stringify(r2, null, 1));
  setTimeout(() => app.quit(), 300);
})();
