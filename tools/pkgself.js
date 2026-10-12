/* 打包产物自检（DP_PKGSELF=<输出路径>）
   用真正的打包版可执行文件跑一遍，验的是「装完能不能用」，不是开发态。
   做法：spawn win-unpacked 下的 exe → 等它起来 → 再开一个探针窗口，
   通过 app 侧读不到目标进程，所以改用 IPC 落盘 + 进程存活判定。

   更直接的办法（这里用的这个）：直接 require 打包版的 asar 里那份 main.js 不现实
   （它会自己跑 whenReady）。所以退一步：让打包版自己写证据文件。
   main.js 在 DP_WINSELF 下会落盘 winself.json，那份就是打包版的自证。 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.DP_PKGSELF;
const EXE = path.join(ROOT, 'release', 'win-unpacked', '桌边 DeskPlan.exe');
const wait = ms => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const res = { ts: Date.now(), notes: [] };
  const note = s => { res.notes.push(s); try { fs.writeFileSync(OUT, JSON.stringify(res, null, 2)); } catch (e) {} };

  /* 单实例锁会拦着（真实实例可能在跑），这里不能抢 */
  res.exeExists = fs.existsSync(EXE);
  res.exeSize = res.exeExists ? fs.statSync(EXE).size : 0;
  note(`打包版 exe 存在=${res.exeExists} 大小=${(res.exeSize / 1048576).toFixed(1)}MB`);

  const selfReport = path.join(ROOT, 'data', 'winself.json');
  try { fs.unlinkSync(selfReport); } catch (e) {}

  /* 杀掉可能残留的实例，确保这次启动是干净的 */
  await new Promise(r => {
    const p = spawn('taskkill', ['/F', '/IM', '桌边 DeskPlan.exe'], { windowsHide: true });
    p.on('close', r); p.on('error', r);
  });
  await wait(1500);

  /* 用 DP_WINSELF 启动打包版：它会跑真实主进程并落盘八项断言 */
  const child = spawn(EXE, [], {
    env: Object.assign({}, process.env, {
      DP_WINSELF: selfReport,
      ELECTRON_ENABLE_LOGGING: '1',
    }),
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  note('已启动打包版，等待自检报告…');

  /* 等报告落盘（最多 60 秒） */
  let got = null;
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    if (fs.existsSync(selfReport)) {
      try {
        const j = JSON.parse(fs.readFileSync(selfReport, 'utf8'));
        if (j && typeof j.ok === 'boolean') { got = j; break; }
      } catch (e) {}
    }
  }

  if (!got) {
    res.pkgReport = null;
    note('打包版没写出自检报告');
  } else {
    res.pkgReport = got;
    note('打包版自检 ok=' + got.ok);
    (got.notes || []).forEach(n => note('  ' + n));
    if (got.fatal) note('  FATAL: ' + String(got.fatal).slice(0, 200));
  }

  res.ok = res.exeExists && !!got && got.ok === true;
  note('总判定 ok=' + res.ok);
  try { fs.writeFileSync(OUT, JSON.stringify(res, null, 2)); } catch (e) {}
  app.quit();
});