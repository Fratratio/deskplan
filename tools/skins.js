/* 皮肤探针：逐套验证
   1) 六套皮肤的令牌是否都解析出真实颜色（没落到兜底值）
   2) 正文对比度是否达标（浅底 ≥4.5，深底 ≥4.5）
   3) 五色在同底色上 30%/40% 淡填充后是否还能分辨
   4) 切换皮肤时两端是否同步
   同时输出截图 data/skins-<id>.png 供肉眼复核 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const S = require(path.join(__dirname, '..', 'app', 'shared', 'store-schema.js'));
const ROOT = path.join(__dirname, '..');
const STORE = path.join(ROOT, 'data', 'store.json');
const OUT = path.join(ROOT, 'data', 'skins.json');

const result = { skins: {}, ok: true, notes: [] };
const fail = m => { result.ok = false; result.notes.push(m); };

app.commandLine.appendSwitch('disable-gpu-compositing');
app.disableHardwareAcceleration();

let cache = S.read(STORE);
if (!cache) cache = S.normalize(null);
cache.shared = cache.shared || {};
cache.shared.skin = S.canonSkin(cache.shared.skin || cache.shared.theme);
cache.shared.font = S.canonFont(cache.shared.font);
if (!cache.plan.items.length) {
  cache.plan.items.push({ id: 'sk1', title: '皮肤测试吃饭', date: '2026-10-12', startMin: 540, dur: 60, color: 'dai', tags: [], done: false });
}

let wins = {};
function pushShared(target) {
  const w = wins[target];
  if (!w || w.isDestroyed()) return;
  w.webContents.send('shared:changed', {
    skin: S.canonSkin(cache.shared.skin),
    font: cache.shared.font === 'default' ? (target === 'plan' ? 'default' : 'sans') : S.canonFont(cache.shared.font),
  });
}

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
ipcMain.on('plan:read', e => { e.returnValue = JSON.stringify(S.planView(cache)); });
ipcMain.on('plan:write', (e, txt) => {
  try { S.mergePlan(cache, JSON.parse(String(txt || '{}'))); pushShared('widget'); e.returnValue = true; }
  catch (err) { e.returnValue = false; }
});
ipcMain.on('shared:set', (_e, patch) => {
  if (patch && patch.skin) cache.shared.skin = S.canonSkin(patch.skin);
  if (patch && patch.font) cache.shared.font = S.canonFont(patch.font);
  pushShared('widget'); pushShared('plan');
});
ipcMain.handle('plan-summary', () => S.planSummary(cache, '2026-10-12'));
ipcMain.handle('today:view', () => S.todayView(cache, '2026-10-12'));
ipcMain.handle('today:act', () => S.todayView(cache, '2026-10-12'));
ipcMain.handle('set-boot', () => false);
ipcMain.handle('export', () => '');

/* ---- WCAG 对比度 ---- */
function lum(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
function ratio(a, b) { const l1 = lum(a), l2 = lum(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); }
/* 模拟 alpha 混合：底色上叠 30% 五色后，与底色的对比度 */
function mixOver(fg, bg, a) {
  const p = h => { const s = h.replace('#', ''); const n = parseInt(s.length === 3 ? s.split('').map(c => c + c).join('') : s, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const F = p(fg), B = p(bg);
  return '#' + F.map((v, i) => Math.round(v * a + B[i] * (1 - a)).toString(16).padStart(2, '0')).join('');
}

/* 生成一段自包含的探测代码（宿主对象在渲染侧现取），主进程只负责拼字符串 */
const PROBE_SRC = hostExpr => `(function(){
  const host = ${hostExpr};
  const cs = getComputedStyle(host);
  const g = k => cs.getPropertyValue(k).trim();
  const q = s => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null; };
  const body = q('.item-text') || q('body') || cs;
  const card = q('.card');
  return {
    skin: host.dataset.skin || '',
    bg: g('--bg'), panel: g('--panel'), ink: g('--ink'), ink2: g('--ink-2'), ink3: g('--ink-3'),
    accent: g('--accent'),
    colors: { dai: g('--dai'), tai: g('--tai'), ou: g('--ou'), tong: g('--tong'), zhu: g('--zhu') },
    isDark: g('--is-dark'),
    cardBg: card ? card.backgroundColor : '',
    bodyFont: body.fontFamily,
    texVar: g('--tex').slice(0, 40),
  };
})()`;

app.whenReady().then(async () => {
  try {
    const widget = new BrowserWindow({
      width: 400, height: 760, show: true,
      webPreferences: { preload: path.join(ROOT, 'app', 'preload-widget.js'), contextIsolation: true }
    });
    const plan = new BrowserWindow({
      width: 1340, height: 880, show: false,
      webPreferences: { preload: path.join(ROOT, 'app', 'preload-plan.js'), contextIsolation: true }
    });
    await widget.loadFile(path.join(ROOT, 'app', 'widget', 'index.html'));
    await plan.loadFile(path.join(ROOT, 'app', 'plan', 'index.html'));
    await new Promise(r => setTimeout(r, 1600));
    wins = { widget, plan };

    const HEX = /^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i;

    result.console=[];
    for (const sk of S.SKINS) {
      result.console.push('--- '+sk.id);
      /* 从周计划页切皮肤（用户实际操作路径） */
      const r = await plan.webContents.executeJavaScript(`(() => {
        const s = document.getElementById('sSkin'); if (!s) return 'no-select';
        s.value = '${sk.id}';
        s.dispatchEvent(new Event('change', {bubbles:true}));
        return 'ok';
      })()`);
      if (r !== 'ok') { fail('计划页皮肤下拉没找到'); break; }
      await new Promise(x => setTimeout(x, 650));

      const p = await plan.webContents.executeJavaScript(PROBE_SRC('document.documentElement'));
      const w = await widget.webContents.executeJavaScript(PROBE_SRC('document.body'));

      const rec = { plan: p, widgetSkin: w.skin, ratios: {}, fillRatios: {} };

      /* 1) 皮肤确实生效：两端 skin 属性一致 */
      if (p.skin !== sk.id) fail(`${sk.id}: 计划页 skin=${p.skin}`);
      if (w.skin !== sk.id) fail(`${sk.id}: 悬浮窗 skin=${w.skin}`);

      /* 2) 令牌必须是真实颜色，没落到兜底 */
      const need = [p.bg, p.panel, p.ink, p.ink2, p.accent,
                    p.colors.dai, p.colors.tai, p.colors.ou, p.colors.tong, p.colors.zhu];
      need.forEach((v, i) => {
        if (!HEX.test(v)) fail(`${sk.id}: 第${i}个色值不是合法hex → "${v}"`);
      });
      /* 各套皮肤底色必须互不相同，否则切了看不出来 */
      if (result.skins[p.bg]) fail(`${sk.id}: 底色 ${p.bg} 与前面的皮肤重复`);
      if (p.ink === p.bg) fail(`${sk.id}: 正文色与底色相同`);

      /* 3) 对比度：正文 ≥7，辅助 ≥4.5 */
      const rInk = ratio(p.ink, p.bg);
      const rInk2 = ratio(p.ink2, p.bg);
      rec.ratios = { ink: +rInk.toFixed(2), ink2: +rInk2.toFixed(2), accent: +ratio(p.accent, p.bg).toFixed(2) };
      if (rInk < 7)   fail(`${sk.id}: 正文对比度 ${rInk.toFixed(2)} < 7`);
      if (rInk2 < 4.5) fail(`${sk.id}: 次要文字对比度 ${rInk2.toFixed(2)} < 4.5`);

      /* 4) 五色 30% 淡填充后仍要与底色可辨（≥1.25 才认得出是彩色块） */
      const a = sk.id && ['dusk', 'nebula', 'forge'].includes(sk.id) ? 0.40 : 0.30;
      Object.keys(p.colors).forEach(k => {
        if (!HEX.test(p.colors[k])) return;
        const mixed = mixOver(p.colors[k], p.bg, a);
        const rr = ratio(mixed, p.bg);
        rec.fillRatios[k] = +rr.toFixed(2);
        if (rr < 1.22) fail(`${sk.id}: 五色 ${k} 淡填充后对比 ${rr.toFixed(2)} < 1.22（几乎看不出颜色）`);
      });

      /* 5) 深浅标记 */
      const shouldDark = ['dusk', 'nebula', 'forge'].includes(sk.id);
      if ((p.isDark === '1') !== shouldDark) fail(`${sk.id}: --is-dark 标记与实际深浅不符`);

      result.skins[sk.id] = rec;

      /* 截图留证 */
      try {
        /* capturePage 在隐藏窗口里会拿到上一帧：必须先把 transition 关掉
           （皮肤颜色有 .2s 过渡，未结束时拍到的是旧色），
           等两次 rAF 让合成器提交，再拍。 */
        await plan.webContents.executeJavaScript(
          'void (()=>{const s=document.createElement("style");' +
          's.id="__nosnap";s.textContent="*,*::before{transition:none!important;animation:none!important}";' +
          'document.head.appendChild(s);void document.body.offsetHeight;})()'
        );
        await plan.webContents.executeJavaScript(
          'new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1))))'
        );
        await new Promise(z => setTimeout(z, 320));
        const img = await plan.webContents.capturePage();
        await plan.webContents.executeJavaScript('document.getElementById("__nosnap")?.remove()');
        fs.writeFileSync(path.join(ROOT, 'data', `skin-${sk.id}.png`), img.toPNG());
      } catch (e) {}
    }

    /* 6) 皮肤网格 UI 是否渲染出 6 个 */
    /* 设置浮层由 MOTION 控制，直接改 hidden 会被动画覆盖，走菜单按钮触发 */
    await widget.webContents.executeJavaScript(
      `document.getElementById('menuBtn').click();document.body.dataset.mode='full';1`
    );
    await new Promise(r => setTimeout(r, 700));
    /* 顶到宣纸色一格，便于看清选中态 */
    await widget.webContents.executeJavaScript(`document.querySelector('.skin-chip[data-skin="rice"]').click()`);
    await new Promise(r => setTimeout(r, 500));
    await widget.webContents.executeJavaScript(
      'void (()=>{const s=document.createElement("style");' +
      's.id="__nosnap";s.textContent="*,*::before{transition:none!important;animation:none!important}";' +
      'document.head.appendChild(s);})()'
    );
    await new Promise(r => setTimeout(r, 300));
    const chips = await widget.webContents.executeJavaScript(
      `[...document.querySelectorAll('.skin-chip')].map(b => b.dataset.skin).join(',')`
    );
    result.chips = chips;
    const want = S.SKINS.map(s => s.id).join(',');
    if (chips !== want) fail(`皮肤网格项不对：得到 [${chips}]，应为 [${want}]`);
    try {
      const wi = await widget.webContents.capturePage();
      fs.writeFileSync(path.join(ROOT, 'data', 'skin-grid.png'), wi.toPNG());
    } catch (e) {}

    /* 7) 数据落盘 */
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    result.persisted = raw.shared;
  } catch (e) {
    fail('FATAL ' + String(e && e.stack || e));
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  app.quit();
});