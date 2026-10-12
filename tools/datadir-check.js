/* 验证 main.js 的数据目录候选链（不需要 GUI，纯 fs 逻辑）
   用法：node tools/datadir-check.js            # 在项目里跑
   验的是：项目根 data/ 可写 → 选中它；不可写 → 落到 userData。 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function pickDir(candidates) {
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      const probe = path.join(dir, '.wtest');
      fs.writeFileSync(probe, '1');
      fs.unlinkSync(probe);
      return dir;
    } catch (e) { /* 不可写就试下一个 */ }
  }
  return null;
}

/* 场景一：正常情况 —— 前面那个候选不存在（mkdir 会现场创建，所以要用
   一个「确定为文件」的位置来占位），应当落到项目根 data/ */
const A = path.join(os.tmpdir(), 'dp-case-a', 'data');
const A_blocker = path.join(os.tmpdir(), 'dp-case-a-blocker');
fs.rmSync(path.join(os.tmpdir(), 'dp-case-a'), { recursive: true, force: true });
fs.rmSync(A_blocker, { recursive: true, force: true });
fs.writeFileSync(A_blocker, 'not a dir');     // 占位，mkdirSync 必然抛错
const r1 = pickDir([A_blocker, A]);
console.log('case1 期望命中 data/ :', r1 === A, '->', r1);

/* 场景二：模拟不可写 ——用一个文件占住 data/ 的位置，mkdirSync 会失败 */
const blocker = path.join(os.tmpdir(), 'dp-case-b', 'data');
fs.rmSync(path.join(os.tmpdir(), 'dp-case-b'), { recursive: true, force: true });
fs.mkdirSync(path.dirname(blocker), { recursive: true });
fs.writeFileSync(blocker, 'not a dir');   // 占位成普通文件
const fallback = path.join(os.tmpdir(), 'dp-case-b-fallback');
const r2 = pickDir([blocker, fallback]);
console.log('case2 期望跳过落到备份 :', r2 === fallback, '->', r2);

/* 场景三：全部不可写 → 返回 null，调用方兜底 userData */
const r3 = pickDir([blocker]);
console.log('case3 期望 null（交给 userData 兜底）:', r3 === null, '->', r3);

/* 场景四：候选链顺序 —— 环境变量优先级最高 */
const C = path.join(os.tmpdir(), 'dp-case-c');
const D = path.join(os.tmpdir(), 'dp-case-d');
fs.rmSync(C, { recursive: true, force: true });
fs.rmSync(D, { recursive: true, force: true });
const r4 = pickDir([C, D]);
console.log('case4 期望命中首个候选 :', r4 === C, '->', r4);

[path.join(os.tmpdir(), 'dp-case-a'), path.join(os.tmpdir(), 'dp-case-b'),
 path.join(os.tmpdir(), 'dp-case-b-fallback'), C, D].forEach(d => fs.rmSync(d, { recursive: true, force: true }));