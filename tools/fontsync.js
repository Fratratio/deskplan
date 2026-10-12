/* 验证：字体切换是否两端同步（周计划页 .mf / 悬浮窗今日页 .ttitle） */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'app', 'shared', 'store-schema.js'));
const ROOT = path.join(__dirname, '..');
const STORE = path.join(ROOT, 'data', 'store.json');
const OUT = path.join(ROOT, 'data', 'fontsync.json');

const result = { fonts: {}, ok: true, notes: [] };
const fail = m => { result.ok = false; result.notes.push(m); };

app.commandLine.appendSwitch('disable-gpu-compositing');
app.disableHardwareAcceleration();

/* 用真实主进程逻辑（store-schema）当数据源，模拟用户在计划页改字体 */
let cache = S.read ? S.read(STORE) : null;
if (!cache) {
  cache = JSON.parse(fs.readFileSync(STORE, 'utf8'));
}
cache.shared = cache.shared || {};
cache.shared.skin = S.canonSkin(cache.shared.skin || cache.shared.theme);
cache.shared.font = cache.shared.font || 'default';

/* 保证两边都有正文可量 */
if (!cache.plan.items) cache.plan.items = [];
cache.plan.items.push({
  id: 'synctest01', title: '字体同步测试ABC', date: '2026-10-12',
  startMin: 540, endMin: 600, dur: 60, color: 'dai', tags: [], done: false
});
cache.notes = cache.notes || { items: [], archived: [] };
if (!cache.notes.items.length) {
  cache.notes.items.push({ id: 'syncnote1', text: '字体同步测试ABC', note: '', done: false, createdAt: Date.now() });
}

let pushLog = [];
let wins = {};
/* 复刻 app/main.js 的 pushShared：把 shared:changed 真正发给两个窗口 */
function pushShared(target) {
  pushLog.push({ target, font: cache.shared.font, skin: cache.shared.skin });
  const w = wins[target];
  if (!w || w.isDestroyed()) return;
  w.webContents.send('shared:changed', {
    skin: S.canonSkin(cache.shared.skin),
    font: cache.shared.font === 'default' ? (target === 'plan' ? 'default' : 'sans') : S.canonFont(cache.shared.font),
  });
}

/* --- 主进程侧接口（与 app/main.js 语义一致） --- */
ipcMain.on('save', (e, s) => { S.mergeWidget(cache, s); pushShared('plan'); });
ipcMain.on('renderer-ready', () => {});
ipcMain.on('fit', () => {});
ipcMain.on('set-theme', () => {});
ipcMain.on('notify', () => {});
ipcMain.on('hide', () => {});
ipcMain.on('quit', () => app.quit());
ipcMain.on('set-pin', () => {});
ipcMain.on('set-edge', () => {});
ipcMain.on('set-lock', () => {});
ipcMain.on('set-stealth', () => {});
ipcMain.on('set-motion', () => {});
ipcMain.on('set-busy', () => {});
ipcMain.on('request-full', () => {});
ipcMain.on('open-plan', () => {});
ipcMain.on('widget:focus', () => {});
ipcMain.on('plan:read', (e) => {
  e.returnValue = JSON.stringify(S.planView(cache));
});
ipcMain.on('plan:write', (e, txt) => {
  try { S.mergePlan(cache, JSON.parse(String(txt || '{}'))); pushShared('widget'); e.returnValue = true; }
  catch (err) { e.returnValue = false; }
});
ipcMain.on('shared:set', (_e, patch) => {
  if (patch && patch.skin) cache.shared.skin = S.canonSkin(patch.skin);
  if (patch && patch.font) cache.shared.font = S.canonFont(patch.font);
  pushShared('widget');   // 推给悬浮窗
  pushShared('plan');
});
ipcMain.handle('plan-summary', () => S.planSummary(cache, '2026-10-12'));
ipcMain.handle('today:view', () => S.todayView(cache, '2026-10-12'));
ipcMain.handle('today:act', () => S.todayView(cache, '2026-10-12'));
ipcMain.handle('set-boot', () => false);
ipcMain.handle('export', () => '');

const FONTS = ['kai', 'xing', 'li', 'fang'];
const EXPECT = {
  kai: /KaiTi|STKaiti|楷体|Kaiti/i,
  xing: /STXingkai|华文行楷|行楷/i,
  li: /LiSu|STLiti|华文隶书|隶书/i,
  fang: /FangSong|STFangsong|仿宋/i,
};

app.whenReady().then(async () => {
  try {
    const widget = new BrowserWindow({
      width: 380, height: 560, show: false,
      webPreferences: { preload: path.join(ROOT, 'app', 'preload-widget.js'), contextIsolation: true }
    });
    const plan = new BrowserWindow({
      width: 1280, height: 860, show: false,
      webPreferences: { preload: path.join(ROOT, 'app', 'preload-plan.js'), contextIsolation: true }
    });
    await widget.loadFile(path.join(ROOT, 'app', 'widget', 'index.html'));
    await plan.loadFile(path.join(ROOT, 'app', 'plan', 'index.html'));
    await new Promise(r => setTimeout(r, 1600));
    wins = { widget, plan };

    const probeWidget = () => widget.webContents.executeJavaScript(`(() => {
      const g = s => { const e=document.querySelector(s); return e?getComputedStyle(e).fontFamily:'<none>'; };
      return {
        attr: document.body.dataset.font || '',
        today: g('.ttitle'),
        item: g('.item-text'),
        varContent: getComputedStyle(document.body).getPropertyValue('--font-content').trim(),
      };
    })()`);

    for (const f of FONTS) {
      /* 用户实际路径：在周计划页切字体 */
      const r = await plan.webContents.executeJavaScript(`(() => {
        const s = document.getElementById('sFont'); if (!s) return 'no-sFont';
        s.value = '${f}'; s.dispatchEvent(new Event('change', {bubbles:true})); return 'ok';
      })()`);
      if (r !== 'ok') { fail(`计划页找不到字体下拉框（${r}）`); break; }

      await new Promise(r2 => setTimeout(r2, 700));

      /* 主进程收到后应转给悬浮窗 */
      const w = await probeWidget();
      const p = await plan.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('.mf')||document.body).fontFamily`
      );
      const re = EXPECT[f];
      result.fonts[f] = { pushes: pushLog.slice(-2), widgetAttr: w.attr, widgetToday: w.today, widgetItem: w.item, planFont: p };

      if (w.attr !== f) fail(`${f}: 悬浮窗 body[data-font]=${w.attr}（应为 ${f}）`);
      if (!re.test(w.today)) fail(`${f}: 悬浮窗今日条目字体未变 → ${w.today}`);
      if (!re.test(w.item))  fail(`${f}: 悬浮窗备忘正文字体未变 → ${w.item}`);
      if (!re.test(p))      fail(`${f}: 计划页正文字体未变 → ${p}`);
    }

    /* 反向：悬浮窗里改字体，计划页要跟上 */
    await widget.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.seg [data-font="li"]'); if (!b) return 'no-btn';
      b.click(); return 'ok';
    })()`);
    await new Promise(r2 => setTimeout(r2, 700));
    const p2 = await plan.webContents.executeJavaScript(
      `document.documentElement.dataset.font + '|' + getComputedStyle(document.querySelector('.mf')||document.body).fontFamily`
    );
    result.reverse = p2;
    if (!/^li\|/.test(p2)) fail(`反向同步失败：计划页 → ${p2}`);
  } catch (e) {
    fail('FATAL ' + String(e && e.stack || e));
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  app.quit();
});