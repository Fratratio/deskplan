/* 周计划主页面的 preload
   配合 app/shared/bridge.js：把页面的 localStorage 读写接到统一数据源。
   浏览器模式下不会有 window.api，bridge 自动跳过，页面照常独立运行。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ready: true,

  planRead:  () => ipcRenderer.sendSync('plan:read'),
  planWrite: (txt) => ipcRenderer.sendSync('plan:write', txt),

  /* ---- 日历 ↔ 悬浮窗 互调 ----
     show 只负责把对方叫出来，toggle 负责来回切。改造前这里只有一个
     openWidget()（发widget:focus），渲染端从来没调用过，两窗口因此
     只能靠托盘菜单单方面切换。浏览器模式下整个 api 是 undefined，
     所以调用点必须做typeof 判断。 */
  showWidget:   () => ipcRenderer.send('widget:show'),
  toggleWidget: () => ipcRenderer.send('widget:toggle'),
  showPlan:     () => ipcRenderer.send('plan:show'),
  parkPlan:     () => ipcRenderer.send('plan:park'),
  appQuit:      () => ipcRenderer.send('app:quit'),

  sharedSet: (patch) => ipcRenderer.send('shared:set', patch),
  onShared:  (cb) => { ipcRenderer.on('shared:changed', (_e, s) => cb(s)); },

  onPlanExternal: (cb) => { ipcRenderer.on('plan:external', () => cb()); },
  onGoto:        (cb) => { ipcRenderer.on('plan:goto', (_e, p) => cb(p)); },
});