/* 拖拽专项自检：像素 → 时间换算 / 吸附粒度 / 落点与显示一致性
   用法：electron.exe tools/dragtest.js
   结果：data/drag.json                                                     */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const PLAN_URL = 'file:///' + path.join(__dirname, '..', 'app', 'plan', 'index.html').replace(/\\/g, '/');
const URL = PLAN_URL;
const OUT = path.join(__dirname, '..', 'data', 'drag.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 在页面里跑：每组用例 = 把卡片拖到某个像素位置，读回落到的 startMin */
const CASES = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const pe = (type, x, y, target) => (target || window).dispatchEvent(new PointerEvent(type, {
    bubbles: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse'
  }));
  const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const out = [];

  /* 复位：清掉历史数据，只留一张已知卡片，固定行高 44 / 起始 06:00 */
  state.items = []; state.todos = []; state.filterTags = [];
  state.settings.startHour = 6; state.settings.endHour = 24;
  state.settings.hourH = 44; state.settings.showEarly = false;
  state.cursor = iso(startOfWeek(new Date()));
  state.items.push({ id: 'dragcase', title: '拖拽用例', note: '',
    date: iso(parseDate(state.cursor)), startMin: 9 * 60, dur: 60,
    tags: [], color: 'dai', done: false, createdAt: Date.now() });
  save(true); render();
  await wait(200);

  async function dragTo(targetHour, opts) {
    opts = opts || {};
    if (opts.showEarly != null) { state.settings.showEarly = opts.showEarly; save(true); render(); await wait(150); }
    const H = +state.settings.hourH;
    const sH = state.settings.showEarly ? 0 : +state.settings.startHour;
    /* 真实操作里，用户会先把目标时段滚进视野再拖；这里照做，顺便避开边缘自动滚动 */
    const sc = document.querySelector('.grid-scroll');
    if (sc) sc.scrollTop = Math.max(0, (targetHour - sH) * H - sc.clientHeight / 2);
    await wait(60);
    const card = document.querySelector('.ev[data-id="dragcase"]');
    if (!card) return { targetHour, error: 'no-card' };
    const cr = card.getBoundingClientRect();
    const col = card.closest('.day-col');
    const colRect = col.getBoundingClientRect();
    const grabX = cr.left + cr.width / 2;
    const grabY = cr.top + 6;                       // 抓卡片顶部往下 6px（避开上边缘 resize 热区）
    const grabOff = grabY - cr.top;
    /* 卡片顶边对齐到 targetHour 那条线时，光标应在的位置 */
    const dropY = colRect.top + (targetHour - sH) * H + grabOff;
    pe('pointerdown', grabX, grabY, card);
    pe('pointermove', grabX, dropY - 12);
    pe('pointermove', grabX, dropY);
    pe('pointerup', grabX, dropY);
    await wait(220);
    const it = state.items.find(i => i.id === 'dragcase');
    /* 卡片渲染出来的顶边像素，用来核对"显示位置 == 落点" */
    const node = document.querySelector('.ev[data-id="dragcase"]');
    const expectTop = (it.startMin - sH * 60) / 60 * H;
    const realTop = node ? node.getBoundingClientRect().top - document.querySelector('.day-col').getBoundingClientRect().top : null;
    return {
      targetHour, want: fmt(targetHour * 60), got: fmt(it.startMin),
      startMin: it.startMin, ok: it.startMin === targetHour * 60,
      labelShown: node ? (node.querySelector('.ev-m') || {}).textContent || '' : '',
      topDelta: realTop == null ? null : Math.round((realTop - expectTop) * 10) / 10
    };
  }

  out.push({ group: '常规（06:00 起，30 分钟粒度）', early: false, rows: [] });
  for (const h of [6, 7, 9, 12, 18, 23]) out[0].rows.push(await dragTo(h));

  out.push({ group: '展开早间后（00:00 起）', early: true, rows: [] });
  for (const h of [0, 3, 6, 12]) out[1].rows.push(await dragTo(h, { showEarly: true }));

  /* 拉伸：拖下边缘两小时 */
  state.settings.showEarly = false; save(true); render(); await wait(150);
  const card = document.querySelector('.ev[data-id="dragcase"]');
  const hb = card.querySelector('.rz-b').getBoundingClientRect();
  pe('pointerdown', hb.left + hb.width / 2, hb.top + 4, card.querySelector('.rz-b'));
  pe('pointermove', hb.left + hb.width / 2, hb.top + 4 + 44 * 2);
  pe('pointerup', hb.left + hb.width / 2, hb.top + 4 + 44 * 2);
  await wait(220);
  const rz = state.items.find(i => i.id === 'dragcase');
  const resize = { dur: rz.dur, startMin: rz.startMin, ok: rz.dur === 180 };

  /* 收尾 */
  state.items = state.items.filter(i => i.id !== 'dragcase');
  save(true); render();
  return { cases: out, resize, snap: state.settings.snapMin, hourH: state.settings.hourH };
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
  const res = await win.webContents.executeJavaScript(CASES).catch(e => ({ error: String(e && e.stack || e) }));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ ts: Date.now(), res, errs }, null, 2));
  clearTimeout(watchdog);
  app.quit();
})();
