/* 右侧面板统计探针：新增 / 编辑 / 删除事件后，统计卡片是否跟着变 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const PLAN_URL = 'file:///' + path.join(__dirname, '..', 'app', 'plan', 'index.html').replace(/\\/g, '/');
const URL = PLAN_URL;
const OUT = path.join(__dirname, '..', 'data', 'panel.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROBE = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const txt = s => (document.querySelector(s) || {}).textContent || '';
  const snap = () => ({
    topStats: txt('#stats'),
    statFoot: txt('#statPanel .sp-foot'),
    statRows: document.querySelectorAll('#statPanel .sp-row').length,
    donut: (document.querySelector('#statPanel .donut-t') || {}).textContent || '',
    ovTiles: [...document.querySelectorAll('#overviewPanel .ov-tile')].map(t => t.textContent.trim()),
    ovNext: txt('#overviewPanel .ov-s'),
  });

  state.items = []; state.todos = []; state.filterTags = [];
  state.settings.startHour = 6; state.settings.endHour = 24;
  state.cursor = iso(startOfWeek(new Date()));
  save(true); render(); await wait(200);
  const out = { emptyState: snap() };

  /* 1. 新增一条今天的计划 */
  state.items.push({ id: 'p1', title: '探针计划一', note: '', date: iso(new Date()),
    startMin: 10 * 60, dur: 60, tags: ['工作'], color: 'dai', done: false, createdAt: Date.now() });
  save(true); render(); await wait(220);
  out.afterAdd = snap();

  /* 2. 再新增一条，并标记一条完成 */
  state.items.push({ id: 'p2', title: '探针计划二', note: '', date: iso(new Date()),
    startMin: 14 * 60, dur: 90, tags: ['生活'], color: 'tai', done: false, createdAt: Date.now() });
  save(true); render(); await wait(220);
  out.afterAdd2 = snap();
  state.items.find(i => i.id === 'p1').done = true; save(true); render(); await wait(220);
  out.afterDone = snap();

  /* 3. 删除全部 */
  state.items = []; save(true); render(); await wait(220);
  out.afterDelete = snap();

  /* 4. 走真实 UI：点网格空白处新建 */
  const H = state.settings.hourH, sH = +state.settings.startHour;
  const col = document.querySelectorAll('.day-col')[3];
  const rect = col.getBoundingClientRect();
  col.querySelectorAll('.cell')[11 - sH].dispatchEvent(new MouseEvent('click', {
    bubbles: true, clientX: rect.left + 30, clientY: rect.top + (11 - sH) * H + 5 }));
  await wait(200);
  document.getElementById('fTitle').value = 'UI 新建的探针';
  document.getElementById('edSave').click();
  await wait(250);
  out.afterUiAdd = snap();
  out.uiAdded = state.items.filter(i => i.title === 'UI 新建的探针').map(i => ({ date: i.date, startMin: i.startMin }));

  state.items = []; save(true); render();
  return out;
})()`;

(async () => {
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  const watchdog = setTimeout(() => {
    try { fs.writeFileSync(OUT, JSON.stringify({ fatal: 'watchdog-timeout' }, null, 2)); } catch (e) {}
    process.exit(1);
  }, 90000);
  const errs = [];
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1360, height: 900, backgroundColor: '#F4F2EE' });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errs.push(String(message)); });
  try { await win.webContents.session.setProxy({ proxyRules: 'direct://' }); } catch (e) {}
  await Promise.race([win.loadURL(URL).catch(e => errs.push('loadURL: ' + e)), sleep(8000)]);
  await sleep(1200);
  const res = await win.webContents.executeJavaScript(PROBE).catch(e => ({ error: String(e && e.stack || e) }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ ts: Date.now(), res, errs }, null, 2));
  clearTimeout(watchdog);
  app.quit();
})();
