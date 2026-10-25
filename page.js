/* ZJOOC 批量看课助手 —— 页面脚本（MAIN world）
 * 负责：绕过"切到后台自动暂停"、调用站点自身的播放器上报接口、检测完成。
 */
(function () {
  'use strict';
  if (window.__ZJM__) return;
  document.documentElement.setAttribute('data-zjm-page', '1');

  const Z = (window.__ZJM__ = {
    armed: false,     // true 时伪造"页面可见"
    stop: false,
    video: null,
    busy: false,
    chapterId: null,
  });

  /* ---------------- 1. 可见性 / 焦点 伪装 ---------------- */
  const realHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  const realVis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  try {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get() { return Z.armed ? false : realHidden.get.call(document); },
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get() { return Z.armed ? 'visible' : realVis.get.call(document); },
    });
  } catch (e) { /* ignore */ }

  ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide'].forEach((t) => {
    window.addEventListener(t, (e) => { if (Z.armed) e.stopImmediatePropagation(); }, true);
    document.addEventListener(t, (e) => { if (Z.armed) e.stopImmediatePropagation(); }, true);
  });

  /* ---------------- 2. 与 bridge 通信 ---------------- */
  const up = (msg) => window.postMessage({ __zjm: 1, dir: 'up', msg }, location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__zjm !== 1 || d.dir !== 'down') return;
    const m = d.msg || {};
    if (m.type === 'stop') { Z.stop = true; return; }
    if (m.type === 'assign') {
      if (Z.busy) return;
      Z.busy = true;
      run(m.cfg)
        .catch((err) => up({ type: 'error', message: String((err && err.message) || err) }))
        .finally(() => { Z.busy = false; });
    }
  });

  // 告知后台"本标签页就绪"（bridge 可能尚未挂载，重试几次）
  let hello = 0;
  const helloTimer = setInterval(() => { up({ type: 'ready', path: location.pathname }); if (++hello > 40) clearInterval(helloTimer); }, 1000);
  up({ type: 'ready', path: location.pathname });

  /* ---------------- 3. 工具 ---------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 20000, step = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) { /* ignore */ }
      await sleep(step);
    }
    return null;
  }

  function appVM() {
    const el = document.querySelector('#app');
    return el && el.__vue__;
  }

  /* 是否已掉登录（页面出现“请登录 / 立即登录”） */
  function isLoggedOut() {
    const t = (document.body && document.body.innerText) || '';
    return /请登录|立即登录/.test(t) && !/退出/.test(t);
  }

  function vmByName(name) {
    let found = null;
    const walk = (vm) => {
      if (!vm || found) return;
      if (vm.$options && vm.$options.name === name) { found = vm; return; }
      (vm.$children || []).forEach(walk);
    };
    const root = appVM();
    if (root) walk(root);
    return found;
  }

  function flatten(list) {
    const out = [];
    (list || []).forEach((ch) => {
      (ch.children || []).forEach((sec) => {
        (sec.children || []).forEach((leaf) => {
          if (leaf && leaf.id && leaf.resourceType === 1) {
            out.push({
              id: leaf.id,
              name: String(leaf.name || '').trim(),
              dur: leaf.vedioTimeLength || leaf.vedioDuration || 0,
              ls: leaf.learnStatus,
            });
          }
        });
      });
    });
    return out;
  }

  /* ---------------- 4. 主流程 ---------------- */
  async function run(cfg) {
    Z.armed = true;
    Z.stop = false;

    const cid = cfg.cid;
    const base = '/ucenter/student/course/study/' + cid;

    const app = await waitFor(appVM, 25000);
    if (!app) throw new Error('站点应用未加载完成');

    /* --- 扫描任务：只需要章节列表 --- */
    if (cfg.scan) {
      if (location.pathname !== base + '/plan') {
        app.$router.push(base + '/plan').catch(() => {});
        const ok = await waitFor(() => location.pathname.startsWith(base), 20000);
        if (!ok) throw new Error(isLoggedOut() ? '登录已失效，请重新登录后再点开始' : '无法进入课程页面');
      }
      const plan = await waitFor(() => vmByName('plan'), 30000);
      if (!plan) throw new Error(isLoggedOut() ? '登录已失效，请重新登录后再点开始' : '未找到章节组件');
      const chapters = await waitFor(() => {
        const l = plan.planDataList;
        return l && l.length ? flatten(l) : null;
      }, 30000);
      if (!chapters || !chapters.length) throw new Error('章节列表为空');
      up({ type: 'chapters', chapters });
      return;                     // 等待后台再分配具体视频
    }

    /* --- 播放任务 --- */
    const chapterId = cfg.chapterId;
    Z.chapterId = chapterId;
    const target = base + '/plan/detail/' + chapterId;

    if (location.pathname !== target) {
      // 必须先回 /plan 让播放器组件卸载，再进目标视频，
      // 否则 detail→detail 时组件被复用，不会加载新视频。
      app.$router.push(base + '/plan').catch(() => {});
      const ok = await waitFor(() => location.pathname === base + '/plan', 15000);
      if (!ok && isLoggedOut()) throw new Error('登录已失效，请重新登录后再点开始');
      app.$router.push(target).catch(() => {});
    }

    const v = await waitFor(() => {
      const el = document.querySelector('video');
      return el && el.readyState >= 1 ? el : (el || null);
    }, 45000, 500);
    if (!v) throw new Error('视频加载超时');
    Z.video = v;

    v.volume = cfg.volume || 0.02;
    v.playbackRate = cfg.rate || 2;
    v.muted = false;              // 必须有声，否则 Chrome 会暂停后台静音视频
    v.play().catch(() => {});

    // 浏览器若禁止有声自动播放：后台标签页会被挂起，任务没有意义，直接报错停下
    await sleep(1500);
    if (v.paused && v.readyState >= 2) {
      throw new Error('浏览器禁止有声自动播放：请点地址栏左侧的站点设置，把「声音」改成“允许”（或 chrome://settings/content/sound 里添加 www.zjooc.cn），刷新后重新开始');
    }
    Z.soundOK = true;

    const detail = await waitFor(() => vmByName('detail'), 30000);
    if (!detail) throw new Error('未找到播放器组件');

    await playToEnd(detail, v, cfg);
  }

  /* 用站点自身的上报接口记录进度（读取的是视频真实播放位置） */
  function report(detail, chapterId, cid, time, duration, forceFull) {
    let p = duration > 0 ? Math.round((time / duration) * 100) : 0;
    if (p >= 95) p = 100;
    if (forceFull) p = 100;
    if (p <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 8000);
      try {
        detail.Service.get(
          '/learningmonitor/api/learning/monitor/videoPlaying',
          { chapterId, courseId: cid, playTime: Math.ceil(time), percent: p },
          (r) => { clearTimeout(t); resolve(!!(r && r.success)); }
        );
      } catch (e) { clearTimeout(t); resolve(false); }
    });
  }

  async function playToEnd(detail, v, cfg) {
    const rate = cfg.rate || 2;
    const cid = location.pathname.split('/')[5];
    const chapterId = cfg.chapterId;
    let lastTime = -1;
    let stallSince = Date.now();
    // 以服务端已有进度为下限，刷新后即使从 0 重播，也不会把进度“报回去”
    let lastSent = Math.max(-1, (detail.progressInfo && detail.progressInfo.percent) || -1);
    let lastAt = 0;
    let revives = 0;

    while (!Z.stop) {
      await sleep(2000);

      const el = document.querySelector('video');
      if (!el) continue;

      if (Math.abs(el.playbackRate - rate) > 0.05) el.playbackRate = rate;
      if (el.paused && !el.ended && el.readyState >= 2) {
        try { await el.play(); } catch (e) {
          if (!el.muted) { el.muted = true; try { await el.play(); } catch (e2) { /* ignore */ } }
        }
      }

      if (el.currentTime > lastTime + 0.5) {
        lastTime = el.currentTime;
        stallSince = Date.now();
        revives = 0;
      } else if (Date.now() - stallSince > 20000) {
        // 20 秒没有前进：先尝试重启播放，连续两次无效就整页刷新（站点偶发卡死）
        stallSince = Date.now();
        revives++;
        if (revives >= 2) {
          up({ type: 'notice', message: '播放卡住，自动刷新重试 ' + chapterId });
          setTimeout(() => location.reload(), 300);
          return;
        }
        try {
          if (el.currentTime < (el.duration || 0) - 2) {
            el.playbackRate = rate;
            await el.play();
          }
        } catch (e) { /* ignore */ }
      }

      const dur = el.duration;
      if (!dur || dur < 1) continue;

      // 每 ~15 秒上报一次（后台标签页计时器会被限流，间隔会自动拉长）
      if (Date.now() - lastAt > 15000) {
        const p = Math.min(100, Math.round((el.currentTime / dur) * 100));
        if (p > lastSent) {
          lastSent = p;
          lastAt = Date.now();
          await report(detail, chapterId, cid, el.currentTime, dur, false);
        }
      }

      const ratio = el.currentTime / dur;
      if (ratio >= 0.955 || el.ended || (dur - el.currentTime) < 3) {
        await finish(detail, chapterId, cid, el.currentTime, dur);
        return;
      }
    }
  }

  function getPercent(detail, chapterId, cid) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(-1), 6000);
      try {
        detail.Service.get(
          '/jxxt/api/course/courseStudent/videoProgress',
          { chapterId, courseId: cid },
          (r) => { clearTimeout(t); resolve(r && r.data ? r.data.percent : -1); }
        );
      } catch (e) { clearTimeout(t); resolve(-1); }
    });
  }

  async function finish(detail, chapterId, cid, time, dur) {
    try { detail.sendCurrentTime(1); } catch (e) { /* ignore */ }
    await report(detail, chapterId, cid, time, dur, true);

    let pct = -1;
    for (let i = 0; i < 6; i++) {
      await sleep(2500);
      pct = await getPercent(detail, chapterId, location.pathname.split('/')[5]);
      if (pct >= 99) break;
    }
    up({ type: 'done', chapterId, percent: pct });
  }

  /* 供调试 */
  Z.debug = { run, vmByName, flatten, getPercent };
})();
