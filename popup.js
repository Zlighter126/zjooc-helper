/* ZJOOC 批量看课助手 —— popup */
const $ = (id) => document.getElementById(id);
let stickyMsg = '';

function parseCid(url) {
  const m = String(url || '').match(/\/course\/study\/([0-9a-f]{20,})/i);
  return m ? m[1] : '';
}

async function refreshStatus() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  const el = $('status');
  if (!s || !s.running) {
    const tail = s && s.log && s.log.length ? '\n— ' + s.log.slice(-4).join('\n— ') : '';
    el.textContent = (s && s.total
      ? `已结束：完成 ${s.done}/${s.total}，失败 ${s.failed}`
      : '未运行') + tail;
    $('start').disabled = false;
    $('stop').disabled = true;
    return;
  }
  if (s.total === 0) {
    const sec = Math.round((Date.now() - (s.scanAt || Date.now())) / 1000);
    const tail = s.log && s.log.length ? '— ' + s.log.slice(-4).join('\n— ') : '';
    el.textContent =
      `正在扫描章节…（${sec}s）\n` +
      `播放中 ${s.active} / 并发 ${s.concurrency}  倍速 ${s.rate}x\n` +
      (stickyMsg || tail || '若长时间不变，请确认课程 ID 正确、已登录该课程');
    $('start').disabled = true;
    $('stop').disabled = false;
    return;
  }
  el.textContent =
    `运行中 ${s.done}/${s.total}  失败 ${s.failed}\n` +
    `播放中 ${s.active} / 并发 ${s.concurrency}  队列 ${s.queue}  倍速 ${s.rate}x\n` +
    (stickyMsg || (s.log && s.log.length ? '— ' + s.log.slice(-3).join('\n— ') : ''));
  $('start').disabled = true;
  $('stop').disabled = false;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const cidFromTab = parseCid(tab && tab.url);
  const saved = await chrome.storage.local.get(['cid', 'concurrency', 'rate']);
  $('cid').value = cidFromTab || saved.cid || '';
  if (saved.concurrency) $('concurrency').value = saved.concurrency;
  if (saved.rate) $('rate').value = saved.rate;

  refreshStatus();
  setInterval(refreshStatus, 1000);
}

$('start').addEventListener('click', async () => {
  const cid = $('cid').value.trim();
  if (!cid) {
    stickyMsg = '请先填写课程 ID（在课程学习页地址栏 /course/study/ 后面那串）';
    $('status').textContent = stickyMsg;
    return;
  }
  stickyMsg = '';
  const concurrency = Math.max(1, Math.min(76, parseInt($('concurrency').value, 10) || 6));
  const rate = Math.max(1, Math.min(16, parseFloat($('rate').value) || 2));
  await chrome.storage.local.set({ cid, concurrency, rate });
  const r = await chrome.runtime.sendMessage({ type: 'start', cfg: { cid, concurrency, rate, volume: 0.02 } });
  if (r && r.error) stickyMsg = r.error;
  refreshStatus();
});

$('stop').addEventListener('click', async () => {
  stickyMsg = '';
  await chrome.runtime.sendMessage({ type: 'stop' });
  refreshStatus();
});

init();
