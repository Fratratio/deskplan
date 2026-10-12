/* 端到端自检：用本地 Electron 内核打开页面，模拟真实点击/输入，输出结果到 data/e2e.json */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

/* 页面地址按脚本自身位置推导，换台机器 clone 下来也能直接跑 */
const PLAN_URL = 'file:///' + path.join(__dirname, '..', 'app', 'plan', 'index.html').replace(/\\/g, '/');
const URL = process.env.E2E_URL || PLAN_URL;
const OUT = path.join(__dirname, '..', 'data', 'e2e.json');
const SHOT = path.join(__dirname, '..', 'data', 'e2e.png');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const STEP_A = `(async () => {
  const log = {};
  const \$ = s => document.querySelector(s);
  log.cols = document.querySelectorAll('.day-col').length;
  log.hours = document.querySelectorAll('.hour').length;
  log.evInit = document.querySelectorAll('.ev').length;
  log.weekendCols = document.querySelectorAll('.day-col.is-weekend').length;
  log.nowline = document.querySelectorAll('.nowline').length;
  log.range = document.getElementById('weekRange').textContent;

  // 1) 点击周三 10:00 附近的空格子
  const H = state.settings.hourH, sH = +state.settings.startHour;
  const col = document.querySelectorAll('.day-col')[2];
  const rect = col.getBoundingClientRect();
  const clientY = rect.top + (10 - sH) * H + 5;
  col.querySelectorAll('.cell')[10 - sH].dispatchEvent(new MouseEvent('click', {
    bubbles: true, clientX: rect.left + 30, clientY
  }));
  await new Promise(r => setTimeout(r, 150));
  log.editorOpen = !document.getElementById('editorModal').hidden;
  log.presetDate = document.getElementById('fDate').value;
  log.presetStart = document.getElementById('fStart').value;

  document.getElementById('fTitle').value = '端到端测试备忘';
  document.getElementById('fNote').value = '这是测试备注';
  document.getElementById('fTags').value = '测试 自动化';
  document.getElementById('edSave').click();
  await new Promise(r => setTimeout(r, 200));
  const a = state.items.find(i => i.title === '端到端测试备忘');
  log.itemsAfterAdd = state.items.length;
  log.added = a ? { date: a.date, startMin: a.startMin, dur: a.dur, tags: a.tags } : null;
  log.evAfter = document.querySelectorAll('.ev').length;
  log.lsBytes = (localStorage.getItem('weekplan.v1') || '').length;
  log.gridHasCard = !!document.querySelector('.ev');
  return log;
})()`;

const STEP_B = `(async () => {
  const log = {};
  const wait = ms => new Promise(r => setTimeout(r, ms));
  log.itemsAfterReload = state.items.length;
  log.persisted = !!state.items.find(i => i.title === '端到端测试备忘');

  // 2) 搜索
  const s = document.getElementById('search');
  s.value = '端到端'; s.dispatchEvent(new Event('input'));
  await wait(320);
  log.searchHits = document.querySelectorAll('#searchResults .res-item').length;
  document.querySelector('#searchResults .res-item').click();
  await wait(250);
  log.searchClosed = document.getElementById('searchResults').hidden;
  log.hitHighlighted = document.querySelectorAll('.ev.is-hit').length;

  // 3) 待办
  const ti = document.getElementById('todoInput');
  ti.value = '端到端待办 #测试';
  ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(200);
  const t = state.todos[state.todos.length - 1];
  log.todoCount = state.todos.length;
  log.todoLast = t ? { title: t.title, tags: t.tags } : null;
  log.todoRendered = document.querySelectorAll('#todoList .todo').length;

  // 4) 标签筛选（点击后 DOM 重建，需重新查询节点）
  let chip = [...document.querySelectorAll('.tagchip')].find(c => c.dataset.tag === '测试');
  log.chipFound = !!chip;
  chip.click(); await wait(200);
  log.filterTags = state.filterTags.slice();
  log.dimmed = document.querySelectorAll('.ev.is-dim').length;
  log.visible = document.querySelectorAll('.ev:not(.is-dim)').length;
  chip = [...document.querySelectorAll('.tagchip')].find(c => c.dataset.tag === '测试');
  chip.click(); await wait(150);
  log.filterCleared = state.filterTags.length === 0;

  // 5) 周切换 + 复制上周（先切到空周再复制，才有可复制的内容）
  const before = document.getElementById('weekRange').textContent;
  document.getElementById('nextWeek').click(); await wait(200);
  log.weekChanged = document.getElementById('weekRange').textContent !== before;
  log.evNextWeek = document.querySelectorAll('.ev').length;
  const n0 = state.items.length;
  document.getElementById('copyLast').click(); await wait(250);
  log.copyAdded = state.items.length - n0;
  state.items.splice(n0); save(true); render(); await wait(150);
  document.getElementById('thisWeek').click(); await wait(150);

  // 6) 详情 + 编辑 + 删除
  const ev = [...document.querySelectorAll('.ev')].find(e => e.textContent.includes('端到端测试备忘'));
  ev.click(); await wait(200);
  log.detailOpen = !document.getElementById('detailModal').hidden;
  log.detailTitle = document.getElementById('dTitle').textContent;
  log.detailMeta = document.getElementById('dMeta').textContent;
  document.getElementById('dEdit').click(); await wait(200);
  log.editPrefilled = document.getElementById('fTitle').value;
  document.getElementById('fTitle').value = '端到端已改标题';
  document.getElementById('edSave').click(); await wait(200);
  log.renamed = !!state.items.find(i => i.title === '端到端已改标题');
  const ev2 = [...document.querySelectorAll('.ev')].find(e => e.textContent.includes('端到端已改标题'));
  ev2.click(); await wait(200);
  document.getElementById('dDelete').click(); await wait(250);
  log.itemsAfterDelete = state.items.length;
  log.toastShown = !document.getElementById('toast').hidden;

  // 7) 清理测试痕迹，让收尾截图是干净状态
  state.items = state.items.filter(i => !String(i.title).startsWith('端到端'));
  state.todos = state.todos.filter(t => !String(t.title).startsWith('端到端'));
  state.filterTags = [];
  save(true); render(); await wait(300);
  log.finalItems = state.items.length;
  log.finalTodos = state.todos.length;
  return log;
})()`;

const STEP_C = `(async () => {
  const log = {};
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const H = state.settings.hourH, sH = +state.settings.startHour;
  const pe = (type, x, y, target) => (target || window).dispatchEvent(new PointerEvent(type, {
    bubbles: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse'
  }));

  // 1) 拖卡片下边缘改时长
  const card = [...document.querySelectorAll('.ev')].find(e => e.textContent.includes('点我可以查看'));
  const before = state.items.find(i => i.id === card.dataset.id);
  log.resizeBefore = { startMin: before.startMin, dur: before.dur };
  const hb = card.querySelector('.rz-b').getBoundingClientRect();
  pe('pointerdown', hb.left + hb.width / 2, hb.top + 4, card.querySelector('.rz-b'));
  pe('pointermove', hb.left + hb.width / 2, hb.top + 4 + H * 2);
  pe('pointerup', hb.left + hb.width / 2, hb.top + 4 + H * 2);
  await wait(250);
  const after = state.items.find(i => i.id === card.dataset.id);
  log.resizeAfter = { startMin: after.startMin, dur: after.dur };
  // 注意：before / after 是同一个对象引用，必须用快照值比较
  log.resizeWorked = log.resizeAfter.dur === log.resizeBefore.dur + 120
                  && log.resizeAfter.startMin === log.resizeBefore.startMin;

  // 2) 拖上边缘改开始时间（时长相应收缩）
  const card2 = [...document.querySelectorAll('.ev')].find(e => e.textContent.includes('点我可以查看'));
  const ht = card2.querySelector('.rz-t').getBoundingClientRect();
  pe('pointerdown', ht.left + ht.width / 2, ht.top + 4, card2.querySelector('.rz-t'));
  pe('pointermove', ht.left + ht.width / 2, ht.top + 4 + H);
  pe('pointerup', ht.left + ht.width / 2, ht.top + 4 + H);
  await wait(250);
  const after2 = state.items.find(i => i.id === card2.dataset.id);
  log.resizeTopWorked = after2.startMin === log.resizeAfter.startMin + 60
                     && (after2.startMin + after2.dur) === (log.resizeAfter.startMin + log.resizeAfter.dur);

  // 3) 待办拖进网格排期
  const ti = document.getElementById('todoInput');
  ti.value = '拖拽排期测试';
  ti.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await wait(200);
  const todoRow = [...document.querySelectorAll('#todoList .todo')].find(r => r.textContent.includes('拖拽排期测试'));
  const rr = todoRow.getBoundingClientRect();
  pe('pointerdown', rr.left + 40, rr.top + 10, todoRow);
  const col = document.querySelectorAll('.day-col')[4];
  const cr = col.getBoundingClientRect();
  const dropY = cr.top + (11 - sH) * H + 5;
  pe('pointermove', cr.left + 40, dropY);
  await wait(60);
  log.ghostShown = !!document.querySelector('.dragghost');
  pe('pointerup', cr.left + 40, dropY);
  await wait(250);
  log.dropOpenedEditor = !document.getElementById('editorModal').hidden;
  log.dropPrefilled = document.getElementById('fTitle').value;
  document.getElementById('edSave').click();
  await wait(250);
  const made = state.items.find(i => i.title === '拖拽排期测试');
  log.droppedItem = made ? { date: made.date, startMin: made.startMin } : null;
  log.expectedDate = col.dataset.date;
  log.todoRemoved = !state.todos.find(t => t.title === '拖拽排期测试');

  // 4) 统计面板
  log.statRows = document.querySelectorAll('#statPanel .sp-row').length;
  log.statFoot = (document.querySelector('#statPanel .sp-foot') || {}).textContent || '';
  log.statHasBar = !!document.querySelector('#statPanel .sp-bar b');

  // 5) 快捷键 N 新建
  document.activeElement.blur();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  await wait(200);
  log.keyNOpened = !document.getElementById('editorModal').hidden;
  document.getElementById('edCancel').click();
  await wait(150);

  // 6) 清理
  state.items = state.items.filter(i => String(i.title) !== '拖拽排期测试');
  state.items.forEach(i => { if (String(i.title).includes('点我可以查看')) { i.startMin = 540; i.dur = 60; } });
  save(true); render(); await wait(300);
  log.finalItems = state.items.length;
  return log;
})()`;

(async () => {
  // 本机有 MITM 代理，Electron 会把 localhost 也走代理导致卡死，这里强制直连
  app.commandLine.appendSwitch('no-proxy-server');
  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
  // 无头自检不需要 GPU，禁用后避免 GPU 缓存访问被拒导致 capturePage / 渲染间歇性挂起
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
  // 看门狗：无论步骤是否卡住，最多 90 秒后强制写出结果并退出，避免自检进程残留占锁
  const watchdog = setTimeout(() => {
    try { fs.writeFileSync(OUT, JSON.stringify({ fatal: 'watchdog-timeout', note: 'self-check exceeded 90s' }, null, 2)); } catch (e) {}
    process.exit(1);
  }, 90000);
  const trace = m => { try { fs.appendFileSync(OUT + '.trace', m + '\n'); } catch (e) {} };
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); } catch (e) {}
  trace('start');
  await app.whenReady();
  trace('ready');
  const win = new BrowserWindow({ show: false, width: 1360, height: 900, backgroundColor: '#F4F2EE' });
  try { await win.webContents.session.setProxy({ proxyRules: 'direct://' }); } catch (e) { trace('setProxy skip: ' + e); }
  const errs = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errs.push(String(message)); });
  win.webContents.on('did-fail-load', (_e, code, desc) => errs.push('load-fail ' + code + ' ' + desc));

  trace('loadURL');
  const loaded = win.loadURL(URL).catch(e => errs.push('loadURL: ' + e));
  await Promise.race([loaded, sleep(8000)]);
  trace('loaded');
  await sleep(1200);
  /* 复位数据：清掉本地存储并重载，保证种子数据在——
     这样不管之前跑过哪个探针（它们会把 items 清空），本脚本都和执行顺序无关 */
  await win.webContents.executeJavaScript('localStorage.clear(); location.reload();').catch(e => errs.push('reset: ' + e));
  await sleep(1500);
  trace('stepA');
  const a = await win.webContents.executeJavaScript(STEP_A).catch(e => ({ error: String(e) }));
  trace('stepA done');
  await sleep(400);
  try { win.reload(); } catch (e) { errs.push('reload: ' + e); }
  trace('reloaded');
  await sleep(1200);
  trace('stepB');
  const b = await win.webContents.executeJavaScript(STEP_B).catch(e => ({ error: String(e) }));
  trace('stepB done');
  await sleep(400);
  const c = await win.webContents.executeJavaScript(STEP_C).catch(e => ({ error: String(e) }));
  trace('stepC done');
  await sleep(400);

  let shot = 'skipped';
  try {
    const img = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, img.toPNG());
    shot = 'ok';
  } catch (e) { shot = String(e); }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ url: URL, stepA: a, stepB: b, stepC: c, consoleErrors: errs, screenshot: shot }, null, 2));
  clearTimeout(watchdog);
  app.quit();
})();
