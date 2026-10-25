/* ZJOOC 批量看课助手 —— 桥接（ISOLATED world）：页面脚本 <-> 后台 */
(function () {
  'use strict';

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__zjm !== 1 || d.dir !== 'up') return;
    try { chrome.runtime.sendMessage(d.msg); } catch (err) { /* SW 未就绪时忽略 */ }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || (msg.type !== 'assign' && msg.type !== 'stop')) return;
    window.postMessage({ __zjm: 1, dir: 'down', msg }, location.origin);
  });

  /* 兜底：若浏览器不支持 manifest 的 world:"MAIN"（Chrome < 111），
     页面脚本没有执行，则以 <script> 方式注入一次。 */
  setTimeout(() => {
    if (document.documentElement.getAttribute('data-zjm-page') === '1') return;
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('page.js');
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* ignore */ }
  }, 600);
})();
