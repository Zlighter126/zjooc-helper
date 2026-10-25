/* ZJOOC 批量看课助手 —— 后台调度
 * 一个"扫描标签页"先读出全部章节，然后按并发数批量开标签页，
 * 每个标签页播放一个视频，播完（进度 100%）自动关闭并开下一个。
 */
const LIST_URL = 'https://www.zjooc.cn/ucenter/student/course/build/list';
const KEY = 'zjm_state';
const WATCH = 'zjm-watch';

let S = null;

const K = (id) => String(id);

async function load() {
  if (S) return S;
  const r = await chrome.storage.session.get(KEY);
  S = r[KEY] || null;
  return S;
}
async function save() {
  if (S) await chrome.storage.session.set({ [KEY]: S });
}
function blank(cfg) {
  return {
    running: true,
    cid: cfg.cid,
    rate: cfg.rate || 2,
    volume: cfg.volume || 0.02,
    concurrency: Math.max(1, Math.min(76, cfg.concurrency || 6)),
    queue: [],
    total: 0,
    done: 0,
    failed: 0,
    active: 0,
    scanning: true,
    scanTabId: null,
    scanAt: Date.now(),
    scanRetries: 0,
    tabs: {},
    retries: {},
    log: [],
    startedAt: Date.now(),
  };
}
function log(m) {
  S.log.push(new Date().toLocaleTimeString() + ' ' + m);
  if (S.log.length > 200) S.log = S.log.slice(-200);
}

function cfgFor(chapterId) {
  return { cid: S.cid, chapterId, rate: S.rate, volume: S.volume };
}

async function assign(tabId, chapterId, scan) {
  const msg = { type: 'assign', cfg: scan ? { cid: S.cid, scan: true } : cfgFor(chapterId) };
  try { await chrome.tabs.sendMessage(tabId, msg); } catch (e) {
    log('标签页通信失败: ' + e.message);
  }
}

async function spawnOne() {
  if (!S || !S.running) return;
  if (S.active >= S.concurrency) return;
  if (!S.queue.length) return;
  S.active++;
  await save();
  const t = await chrome.tabs.create({ url: LIST_URL, active: false });
  S.tabs[K(t.id)] = { state: 'waiting', chapterId: null };
  await save();
}

async function start(cfg) {
  if (S && S.running) return { error: '已经在运行中' };
  S = blank(cfg);
  await save();
  chrome.alarms.create(WATCH, { periodInMinutes: 0.5 });
  const t = await chrome.tabs.create({ url: LIST_URL, active: false });
  S.scanTabId = K(t.id);
  S.tabs[K(t.id)] = { state: 'waiting', scan: true };
  S.active = 1;
  await save();
  return { ok: true, scanTab: t.id };
}

async function stop() {
  if (!S) return { ok: true };
  S.running = false;
  chrome.alarms.clear(WATCH);
  for (const id of Object.keys(S.tabs)) {
    try { await chrome.tabs.remove(Number(id)); } catch (e) { /* ignore */ }
  }
  S.tabs = {};
  S.active = 0;
  await save();
  return { ok: true };
}

function finishIfDone() {
  if (!S || !S.running) return;
  if (S.scanning) return;          // 章节还没扫描出来，绝不算“完成”
  if (S.total === 0) return;
  if (S.queue.length === 0 && S.active === 0) {
    S.running = false;
    chrome.alarms.clear(WATCH);
    log('全部完成');
  }
}

/* 空转补救：没有活动页签时，按当前阶段重新开工 */
async function recoverIfIdle() {
  if (!S || !S.running || S.active > 0) return;
  if (S.scanning) {
    const t = await chrome.tabs.create({ url: LIST_URL, active: false });
    S.scanTabId = K(t.id);
    S.tabs[K(t.id)] = { state: 'waiting', scan: true };
    S.active = 1;
    S.scanAt = Date.now();
    await save();
  } else if (S.queue.length) {
    await spawnOne();
  }
}

/* 看门狗：扫描卡住 / 有空闲并发 时自动补救 */
async function watchdog() {
  await load();
  if (!S || !S.running) { chrome.alarms.clear(WATCH); return; }
  if (S.scanning && Date.now() - (S.scanAt || 0) > 90000) {
    S.scanRetries = (S.scanRetries || 0) + 1;
    log('扫描超时（第 ' + S.scanRetries + ' 次），重开扫描页');
    const oldTabs = Object.keys(S.tabs);
    S.tabs = {};
    S.active = 0;
    for (const id of oldTabs) {
      try { await chrome.tabs.remove(Number(id)); } catch (e) { /* ignore */ }
    }
    S.scanAt = Date.now();
    if (S.scanRetries > 3) {
      S.running = false;
      log('扫描连续失败，已停止。请确认：1) 已登录 2) 课程ID正确 3) Chrome 版本足够新');
      chrome.alarms.clear(WATCH);
      await save();
      return;
    }
    const t = await chrome.tabs.create({ url: LIST_URL, active: false });
    S.scanTabId = K(t.id);
    S.tabs[K(t.id)] = { state: 'waiting', scan: true };
    S.active = 1;
  } else if (!S.scanning && S.queue.length && S.active < S.concurrency) {
    while (S.active < S.concurrency && S.queue.length) await spawnOne();
  }
  finishIfDone();
  await save();
}

async function onReady(sender, msg) {
  if (!sender || !sender.tab || sender.tab.id == null) return;
  const tabId = K(sender.tab.id);
  if (!S || !S.running) return;
  let info = S.tabs[tabId];
  if (info && info.state === 'waiting') {
    log('页签就绪 ' + tabId + ' ' + ((msg && msg.path) || ''));
  }

  // SW 重启 / 状态丢失时，把未知标签页收养进来，避免任务卡死
  if (!info) {
    if (S.scanning && (!S.scanTabId || !S.tabs[S.scanTabId])) {
      S.scanTabId = tabId;
      info = S.tabs[tabId] = { state: 'waiting', scan: true };
      S.active = Math.max(S.active, 1);
    } else {
      info = S.tabs[tabId] = { state: 'waiting', chapterId: null };
      S.active = Math.max(S.active, 1);
    }
    await save();
  }
  if (info.state !== 'waiting') return;

  if (info.scan && S.scanning) {
    info.state = 'scanning';
    S.scanAt = Date.now();
    await save();
    log('开始扫描 ' + tabId);
    await assign(sender.tab.id, null, true);
    return;
  }

  // 页面刷新 / 标签页被丢弃后重新加载：继续原来的章节，而不是领新任务
  if (info.chapterId) {
    info.state = 'playing';
    log('恢复播放 ' + info.chapterId + '（页面刷新）');
    await save();
    await assign(sender.tab.id, info.chapterId, false);
    return;
  }

  const chapterId = S.queue.shift();
  if (!chapterId) {
    // 还没有章节清单：把这个页签转成扫描页，而不是直接关掉/判定完成
    if (S.scanning) {
      log('诊断：无清单（scan=' + info.scan + ' scanning=' + S.scanning + '）→ 转为扫描页 ' + tabId);
      info.scan = true;
      info.state = 'scanning';
      S.scanTabId = tabId;
      S.scanAt = Date.now();
      await save();
      await assign(sender.tab.id, null, true);
      return;
    }
    delete S.tabs[tabId];
    S.active = Math.max(0, S.active - 1);
    await save();
    try { await chrome.tabs.remove(Number(tabId)); } catch (e) { /* ignore */ }
    await recoverIfIdle();
    finishIfDone();
    return;
  }
  info.state = 'playing';
  info.chapterId = chapterId;
  await save();
  await assign(sender.tab.id, chapterId, false);
}

async function onChapters(sender, chapters) {
  if (!sender || !sender.tab || sender.tab.id == null) return;
  const tabId = K(sender.tab.id);
  if (!S || !S.running) return;
  if (!S.scanning) return;

  const list = (chapters || []).filter((c) => c.ls !== 2);
  S.queue = list.map((c) => c.id);
  S.total = S.queue.length;
  S.scanning = false;
  const info = S.tabs[tabId];
  if (info) info.scan = false;
  log('共 ' + S.total + ' 个待看视频');

  // 扫描标签页直接转为第一个播放任务
  if (S.queue.length) {
    const first = S.queue.shift();
    if (info) { info.state = 'playing'; info.chapterId = first; }
    await save();
    await assign(sender.tab.id, first, false);
  } else {
    // 一个待看的都没有：多半是课程 ID 不对/已全部完成
    log('没有未完成的视频（可能课程 ID 不对，或本课已全部看完），已停止');
    S.running = false;
    chrome.alarms.clear(WATCH);
    const oldTabs = Object.keys(S.tabs);
    S.tabs = {};
    S.active = 0;
    await save();
    for (const id of oldTabs) {
      try { await chrome.tabs.remove(Number(id)); } catch (e) { /* ignore */ }
    }
    return;
  }
  await save();

  while (S.active < S.concurrency && S.queue.length) await spawnOne();
}

async function onDone(sender, msg) {
  if (!sender || !sender.tab || sender.tab.id == null) return;
  const tabId = K(sender.tab.id);
  if (!S) return;
  const info = S.tabs[tabId] || {};
  if (msg.percent >= 0) S.done++; else S.failed++;
  log('完成 ' + (info.chapterId || '') + ' → ' + msg.percent + '%');
  delete S.tabs[tabId];
  S.active = Math.max(0, S.active - 1);
  await save();
  try { await chrome.tabs.remove(Number(tabId)); } catch (e) { /* ignore */ }
  await spawnOne();
  finishIfDone();
  await save();
}

async function onError(sender, msg) {
  if (!sender || !sender.tab || sender.tab.id == null) return;
  const tabId = K(sender.tab.id);
  if (!S) return;
  const info = S.tabs[tabId] || {};
  S.failed++;

  // 登录失效 / 浏览器禁止有声自动播放：直接终止整个任务，避免无意义地反复重试
  if (/登录|声音/.test(msg.message || '')) {
    log('任务停止：' + msg.message);
    S.running = false;
    chrome.alarms.clear(WATCH);
    const oldTabs = Object.keys(S.tabs);
    S.tabs = {};
    S.active = 0;
    await save();
    for (const id of oldTabs) {
      try { await chrome.tabs.remove(Number(id)); } catch (e) { /* ignore */ }
    }
    return;
  }

  log('失败 ' + (info.chapterId || '') + ': ' + msg.message);
  // 每章最多重试一次
  const ch = info.chapterId;
  if (ch) {
    S.retries = S.retries || {};
    if (!S.retries[ch]) { S.retries[ch] = 1; S.queue.push(ch); }
  } else if (S.scanning) {
    // 扫描页出错：重置扫描标记，让下一个标签页重新扫描
    S.scanning = true;
    S.scanTabId = null;
    S.scanAt = Date.now();
  }
  delete S.tabs[tabId];
  S.active = Math.max(0, S.active - 1);
  await save();
  try { await chrome.tabs.remove(Number(tabId)); } catch (e) { /* ignore */ }
  await spawnOne();
  await recoverIfIdle();
  finishIfDone();
  await save();
}

/* 页面刷新 / 标签页被浏览器回收后重新加载：标记回 waiting，等它再次就绪时恢复同一章节 */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info || info.status !== 'loading') return;
  (async () => {
    await load();
    if (!S || !S.running) return;
    const key = K(tabId);
    const t = S.tabs[key];
    if (!t) return;

    // 站点打开新页签时会先跳一次 background.zjooc.cn（SSO 中转），几秒后才回到正常页面。
    // 所以这里先等 3.5 秒，再看“最终”地址：仍停在登录域才算掉登录。
    await new Promise((r) => setTimeout(r, 3500));
    let u = '';
    try { const tab = await chrome.tabs.get(Number(tabId)); u = (tab && tab.url) || ''; } catch (e) { return; }
    if (/gxptLogin|background\.zjooc\.cn/i.test(u)) {
      log('任务停止：登录已失效（被重定向到登录页），请重新登录后再开始');
      S.running = false;
      chrome.alarms.clear(WATCH);
      const oldTabs = Object.keys(S.tabs);
      S.tabs = {};
      S.active = 0;
      await save();
      for (const id of oldTabs) {
        try { await chrome.tabs.remove(Number(id)); } catch (e) { /* ignore */ }
      }
      return;
    }

    if (t.state === 'waiting') return;
    t.recover = (t.recover || 0) + 1;
    if (t.recover > 8) {
      log('页签反复刷新，已放弃 ' + tabId);
      if (t.chapterId) {
        S.retries = S.retries || {};
        if (!S.retries[t.chapterId]) {
          S.retries[t.chapterId] = 1;
          S.queue.unshift(t.chapterId);
        } else {
          S.failed++;
          log('章节多次卡住，跳过 ' + t.chapterId);
        }
      }
      delete S.tabs[key];
      S.active = Math.max(0, S.active - 1);
      await save();
      try { await chrome.tabs.remove(tabId); } catch (e) { /* ignore */ }
      await spawnOne();
      await recoverIfIdle();
      finishIfDone();
      await save();
      return;
    }
    t.state = 'waiting';
    await save();
  })().catch(() => {});
});

/* 标签页被关闭：回收并把它没看完的章节放回队列 */
chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await load();
    if (!S || !S.running) return;
    const key = K(tabId);
    const t = S.tabs[key];
    if (!t) return;
    log('页签被关闭 ' + key + '（state=' + t.state + '）');
    delete S.tabs[key];
    S.active = Math.max(0, S.active - 1);
    if (t.chapterId && t.state === 'playing') S.queue.unshift(t.chapterId);
    await save();
    await spawnOne();
    await recoverIfIdle();
    finishIfDone();
    await save();
  })().catch(() => {});
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a && a.name === WATCH) watchdog().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await load();
    if (msg && msg.type === 'start') return sendResponse(await start(msg.cfg));
    if (msg && msg.type === 'stop') return sendResponse(await stop());
    if (msg && msg.type === 'status') {
      await load();
      return sendResponse(S ? {
        running: S.running, cid: S.cid, total: S.total, done: S.done,
        failed: S.failed, active: S.active, queue: S.queue.length,
        concurrency: S.concurrency, rate: S.rate, scanning: S.scanning,
        scanAt: S.scanAt, log: S.log.slice(-8),
      } : { running: false });
    }
    if (msg && msg.type === 'ready') { await onReady(sender, msg); return sendResponse({ ok: true }); }
    if (msg && msg.type === 'notice') { if (S) log(msg.message); await save(); return sendResponse({ ok: true }); }
    if (msg && msg.type === 'chapters') { await onChapters(sender, msg.chapters); return sendResponse({ ok: true }); }
    if (msg && msg.type === 'done') { await onDone(sender, msg); return sendResponse({ ok: true }); }
    if (msg && msg.type === 'error') { await onError(sender, msg); return sendResponse({ ok: true }); }
    return sendResponse({ ok: false });
  })().catch((e) => { try { sendResponse({ error: String(e) }); } catch (x) { /* ignore */ } });
  return true;
});
