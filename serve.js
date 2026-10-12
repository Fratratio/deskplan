/* ============================================================
   浏览器模式静态服务器： node serve.js  →  http://localhost:8777
   ------------------------------------------------------------
   只在"不想启动桌面版、想用浏览器或手机访问"时使用。
   '/                       → 周计划主页面
   '/app/widget/index.html' → 悬浮小方框（浏览器里也能预览）
   注意：浏览器模式下数据在浏览器 localStorage 里，
        与桌面版 data/store.json 不是同一份；
        桌面版才两个界面共用一份数据。
   ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT) || 8777;
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let p = decodeURIComponent(url.parse(req.url).pathname);
  if (p === '/' || p === '/index.html') p = '/app/plan/index.html';
  const fp = path.join(ROOT, path.normalize(p));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log('周计划主页面 → http://localhost:' + PORT);
  console.log('悬浮小方框预览 → http://localhost:' + PORT + '/app/widget/index.html');
});
