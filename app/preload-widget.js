/* 悬浮小方框的 preload：沿用原来的全部通道，另加「打开周计划」相关几条 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  ready: true,

  load:        () => ipcRenderer.invoke('load'),
  save:        (s) => ipcRenderer.send('save', s),

  notify:      (title, body) => ipcRenderer.send('notify', title, body),
  fit:         (h) => ipcRenderer.send('fit', h),

  setTheme:    (t) => ipcRenderer.send('set-theme', t),
  setPin:      (b) => ipcRenderer.invoke('set-pin', b),

  // 形态与贴边
  setEdge:     (e) => ipcRenderer.send('set-edge', e),
  setLock:     (b) => ipcRenderer.send('set-lock', !!b),
  setStealth:  (b) => ipcRenderer.send('set-stealth', !!b),
  setMotion:   (b) => ipcRenderer.send('set-motion', !!b),
  setBusy:     (b) => ipcRenderer.send('set-busy', !!b),
  onMode:      (cb) => { ipcRenderer.on('mode', (_e, m) => cb(m)); },
  requestFull: () => ipcRenderer.send('request-full'),
  onSync:      (cb) => {
    ipcRenderer.on('sync-lock', (_e, b) => cb('lock', b));
    ipcRenderer.on('sync-edge', (_e, e) => cb('edge', e));
    ipcRenderer.on('sync-motion', (_e, b) => cb('motion', b));
  },
  onArchive:   (cb) => { ipcRenderer.on('open-archive', () => cb()); },
  signalReady: () => ipcRenderer.send('renderer-ready'),

  setBootLaunch: (b) => ipcRenderer.invoke('set-boot', b),
  exportBackup:  (txt) => ipcRenderer.invoke('export', txt),

  quit:        () => ipcRenderer.send('quit'),
  hide:        () => ipcRenderer.send('hide'),

  /* ---- 与周计划页打通的部分 ---- */
  openPlan:      () => ipcRenderer.send('open-plan'),
  planSummary:   () => ipcRenderer.invoke('plan-summary'),
  onPlanSummary: (cb) => { ipcRenderer.on('plan:summary', (_e, s) => cb(s)); },

  /* 「今日」页：读视图 / 提交改动 / 订阅变化 / 跳到完整窗口 */
  todayView:    () => ipcRenderer.invoke('today:view'),
  todayAct:     (act) => ipcRenderer.invoke('today:act', act),
  onToday:      (cb) => { ipcRenderer.on('today:changed', (_e, v) => cb(v)); },
  gotoPlan:     (payload) => ipcRenderer.send('plan:goto', payload || {}),
  sharedSet:     (patch) => ipcRenderer.send('shared:set', patch),
  onShared:      (cb) => { ipcRenderer.on('shared:changed', (_e, s) => cb(s)); },
});
