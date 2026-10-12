/* ============================================================
   共享存储桥接（运行在周计划页面里，早于 app.js 执行）
   ------------------------------------------------------------
   周计划页原本把整份 state 存在 localStorage 的 'weekplan.v1' 键里。
   这里只拦截这一个键：读 → 向主进程要；写 → 交给主进程落盘。
   于是 app.js 一行都不用改，数据却已经进了统一的那份 JSON。
   浏览器模式（没有 window.api）下自动跳过，继续用原生 localStorage。
   ============================================================ */
(function () {
  var KEY = 'weekplan.v1';
  try {
    if (!window.api || typeof window.api.planRead !== 'function') return;

    var proto = Object.getPrototypeOf(window.localStorage);
    if (!proto) return;

    var origGet = proto.getItem, origSet = proto.setItem, origRemove = proto.removeItem;

    proto.getItem = function (k) {
      if (k === KEY) { try { return window.api.planRead(); } catch (e) { return null; } }
      return origGet.call(this, k);
    };
    proto.setItem = function (k, v) {
      if (k === KEY) { try { window.api.planWrite(String(v)); } catch (e) {} return; }
      return origSet.call(this, k, v);
    };
    proto.removeItem = function (k) {
      if (k === KEY) { try { window.api.planWrite(''); } catch (e) {} return; }
      return origRemove.call(this, k);
    };

    window.__planBridge = true;
  } catch (e) {
    window.__planBridgeError = String(e);
  }
})();
