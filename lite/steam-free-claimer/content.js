/**
 * Steam 喜加一助手 — 页面内执行器
 *
 * 注入到 store.steampowered.com，所有请求都在页面同源上下文发出，
 * 天然携带登录 Cookie 与 g_sessionID，规避了扩展后台跨域取 Cookie 的兼容问题。
 */
(function () {
  'use strict';

  if (window.__steamFreeHelperInjected) return;
  window.__steamFreeHelperInjected = true;

  const STORE = 'https://store.steampowered.com';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  let cancelled = false;
  let running = false;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                            */
  /* ------------------------------------------------------------------ */

  function getSessionId() {
    if (typeof window.g_sessionID === 'string' && window.g_sessionID) {
      return window.g_sessionID;
    }
    const m = document.cookie.match(/(?:^|;\s*)sessionid=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /**
   * 同步兜底判据（仅在无法发出网络请求时使用）。
   * 注意：新版商店页已不再内联 g_steamID、已移除 #account_pulldown，
   * 且 CEF 中 steamLoginSecure 为 httpOnly，JS 读不到 cookie，
   * 因此这三条单独使用会把已登录误判为未登录，正式判定请用 probeLogin()。
   */
  function isLoggedIn() {
    return (
      /steamLoginSecure=/.test(document.cookie) ||
      /g_steamID\s*=\s*"[1-9]/.test(document.documentElement.innerHTML) ||
      !!document.querySelector('#account_pulldown')
    );
  }

  /**
   * 异步登录态探针：请求 dynamicstore/userdata/（同源、自带登录 cookie）。
   * - 已登录：返回 JSON 且 rgOwnedApps 为数组 → loggedIn=true（via: 'network'）
   * - 未登录：该接口回落登录页 HTML，JSON 解析失败或字段不符 → loggedIn=false（via: 'none'）
   * - 请求异常/非 2xx（无法完成检测）：回退同步 DOM/Cookie 判据，命中即视为已登录（via: 'dom'），
   *   否则 loggedIn=false 且 via: 'unknown'，供调用方区分「确实未登录」与「检测失败」。
   */
  async function probeLogin() {
    let domHit = false;
    try {
      domHit = isLoggedIn();
    } catch (e) {
      domHit = false;
    }

    let verdict = 'unknown'; /* 'yes' | 'no' | 'unknown' */
    try {
      const res = await fetch(`${STORE}/dynamicstore/userdata/`, {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (res && res.ok) {
        let data = null;
        try {
          data = await res.json();
        } catch (e) {
          data = null; /* 登录页 HTML → 解析失败 */
        }
        verdict = data && Array.isArray(data.rgOwnedApps) ? 'yes' : 'no';
      }
    } catch (e) {
      verdict = 'unknown';
    }

    if (verdict === 'yes') return { loggedIn: true, via: 'network' };
    if (verdict === 'no') return { loggedIn: false, via: 'none' };
    if (domHit) return { loggedIn: true, via: 'dom' };
    return { loggedIn: false, via: 'unknown' };
  }

  function progress(phase, text, extra) {
    try {
      chrome.runtime.sendMessage(
        Object.assign({ type: 'SCAN_PROGRESS', progress: { phase, text, at: Date.now() } }, extra || {})
      );
    } catch (e) {
      /* popup 未打开时忽略 */
    }
    // 同步到页面内悬浮面板（挂钩由文件末尾的 UI 模块赋值，未就绪时为 null）
    if (__sfhPanelProgress) __sfhPanelProgress(phase, text);
  }

  /* ------------------------------------------------------------------ */
  /* 1. 检索当前所有 100% 折扣条目                                        */
  /* ------------------------------------------------------------------ */

  function parseResultsHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    doc.querySelectorAll('a[data-ds-appid], a[data-ds-packageid]').forEach((a) => {
      const rawApp = a.getAttribute('data-ds-appid') || '';
      const rawPkg = a.getAttribute('data-ds-packageid') || '';
      const titleEl = a.querySelector('.title');
      const name = titleEl ? titleEl.textContent.trim() : '';
      const discountEl = a.querySelector('.discount_pct');
      const discount = discountEl ? discountEl.textContent.trim() : '';

      out.push({
        appid: rawApp ? rawApp.split(',')[0].trim() : null,
        packageid: rawPkg ? rawPkg.trim() : null,
        title: name,
        discount,
        href: a.getAttribute('href') || ''
      });
    });
    return out;
  }

  async function searchPromotions() {
    const collected = new Map();

    for (let page = 0; page < 6; page++) {
      if (cancelled) break;

      const start = page * 100;
      const url =
        `${STORE}/search/results/?query=&start=${start}&count=100` +
        `&maxprice=free&specials=1&infinite=1&json=1&cc=cn&l=schinese`;

      let data = null;
      try {
        const res = await fetch(url, { credentials: 'include' });
        data = await res.json();
      } catch (e) {
        break;
      }

      const html = data && data.results_html ? data.results_html : '';
      if (!html) break;

      for (const item of parseResultsHtml(html)) {
        const key = item.appid || item.packageid;
        if (!key) continue;
        if (!collected.has(key)) collected.set(key, item);
      }

      const total = Number(data.total_count) || 0;
      progress('search', `检索商店折扣页 ${start + 100} / ${total}…`);

      if (start + 100 >= total) break;
      await sleep(rand(700, 1400));
    }

    return [...collected.values()];
  }

  /* ------------------------------------------------------------------ */
  /* 2. 读取当前账号的游戏库                                             */
  /* ------------------------------------------------------------------ */

  async function fetchOwnedAppIds() {
    try {
      const res = await fetch(`${STORE}/dynamicstore/userdata/`, { credentials: 'include' });
      const j = await res.json();
      return new Set((j.rgOwnedApps || []).map(String));
    } catch (e) {
      return new Set();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 3. 解析某个 app 下真正可领取的 subid                                */
  /*                                                                     */
  /* 关键：同一个 app 下面往往同时挂着「限时免费促销包」和「付费包」，     */
  /* 例如 Hunting Simulator 3 就同时有 1782986（限免，0 元）和            */
  /* 1633607（付费，22 元）。必须先按 is_free_license + 价格筛出零元包，   */
  /* 否则会对着付费包发请求，误触发购买流程。                             */
  /* ------------------------------------------------------------------ */

  const PROMO_RE = /Limited Free Promotional Package/i;

  function stripTags(s) {
    return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  async function resolveClaimableSubs(appid) {
    try {
      const res = await fetch(
        `${STORE}/api/appdetails/?appids=${appid}&filters=packages&cc=cn&l=schinese`,
        { credentials: 'include' }
      );
      const j = await res.json();
      const node = j[appid];
      if (!node || !node.success || !node.data) return [];

      const subs = [];
      for (const group of node.data.package_groups || []) {
        for (const s of group.subs || []) {
          subs.push({
            subid: String(s.packageid),
            isFree: s.is_free_license === true,
            cents: Number(s.price_in_cents_with_discount),
            text: stripTags(s.option_text)
          });
        }
      }

      // 只保留「免费许可 + 折算价 0 元」的包，付费包在这一步就被剔除
      const zeroFree = subs.filter((s) => s.isFree && s.cents === 0);
      if (!zeroFree.length) return [];

      // 优先精确命中限时促销包；名称格式变化时退回零元包集合
      const promo = zeroFree.filter((s) => PROMO_RE.test(s.text));
      return (promo.length ? promo : zeroFree).map((s) => s.subid);
    } catch (e) {
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /* 3.5 领取前预判：DLC 是否依赖尚未拥有的本体                            */
  /*                                                                     */
  /* 需要基础游戏的 DLC，直接请求 addfreelicense 时 Steam 通常只回落一张   */
  /* 标题为「站点错误」的通用错误页，正文不含基础游戏相关关键词，          */
  /* classifyClaimHtml 无从识别，结果是白白浪费一次请求、原因还被记成      */
  /* failed。因此先查 appdetails 的 fullgame 字段：                       */
  /*   · fullgame 存在且本体不在已拥有集合 → 直接判为需本体，不发领取请求  */
  /*   · fullgame 存在但本体已拥有         → 照常领取                     */
  /*   · 无 fullgame 字段                  → 独立游戏，照常领取            */
  /*   · 请求失败 / 结构异常               → 返回 ok:false，调用方退回原流程 */
  /* ------------------------------------------------------------------ */

  async function resolveBaseGame(appid) {
    try {
      const res = await fetch(
        `${STORE}/api/appdetails/?appids=${appid}&filters=basic,fullgame&cc=cn&l=schinese`,
        { credentials: 'include' }
      );
      if (res && res.ok === false) return { ok: false };
      const j = await res.json();
      const node = j && j[appid];
      if (!node || !node.success || !node.data) return { ok: false };

      const fg = node.data.fullgame;
      if (!fg || fg.appid === undefined || fg.appid === null || fg.appid === '') {
        return { ok: true, baseAppid: null, baseName: '' };
      }
      return {
        ok: true,
        baseAppid: String(fg.appid),
        baseName: stripTags(fg.name || '') || 'App ' + String(fg.appid)
      };
    } catch (e) {
      /* 预判只是优化：拿不到信息就交回原有「先请求、再按响应分类」的流程 */
      return { ok: false };
    }
  }

  /* ------------------------------------------------------------------ */
  /* 4. 领取（等价于商店页的「添加到账户」按钮）                          */
  /*                                                                     */
  /* 失败诊断：addfreelicense 在多种情况下不返回 JSON，而是回落成整页     */
  /* HTML（302 重定向到错误页 / 需先拥有本体 / 登录态失效 / 尚未开售）。   */
  /* 早期实现把 HTML 前 160 字符直接贴到面板上，用户只看到              */
  /* `<!DOCTYPE html…` 无法判断原因。现在统一折算成可读文案：            */
  /*   · need_base      需先拥有本体                                     */
  /*   · not_logged_in  登录状态失效                                     */
  /*   · unavailable    暂不可领取                                       */
  /*   · failed         其它未识别的失败                                 */
  /* 原始响应片段截断后只进 report.debug，不在面板展示。                 */
  /* ------------------------------------------------------------------ */

  const CLAIM_SNIPPET_LIMIT = 600;

  /* 按 <title> 提取页面标题（剔除标签、压缩空白、限长） */
  function extractHtmlTitle(html) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
    if (!m) return '';
    let t = '';
    try {
      t = stripTags(m[1]);
    } catch (e) {
      t = String(m[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return t.slice(0, 120);
  }

  /* 关键词规则：命中顺序即优先级 */
  const CLAIM_HTML_RULES = [
    { status: 'need_base', label: '需先拥有本体', re: /基础游戏|base\s*game|需要先拥有|需要先购买|本体/i },
    { status: 'not_logged_in', label: '登录状态失效', re: /登录|登入|sign\s*in|login/i },
    { status: 'unavailable', label: '暂不可领取', re: /即将推出|not\s*yet\s*available|coming\s*soon/i }
  ];

  /**
   * 把回落成 HTML 的响应归类。
   * 标题命中的可信度高于正文：整页 HTML 的导航栏几乎都带「登录」字样，
   * 只看正文容易把「需本体」等页面误判成未登录，因此先扫标题再扫正文。
   * @returns {{status:string,label:string,title:string,hit:string}}
   */
  function classifyClaimHtml(html) {
    const title = extractHtmlTitle(html);
    let body = '';
    try {
      body = stripTags(String(html || '')).slice(0, 4000);
    } catch (e) {
      body = String(html || '').slice(0, 4000);
    }

    for (let i = 0; i < CLAIM_HTML_RULES.length; i++) {
      const r = CLAIM_HTML_RULES[i];
      if (r.re.test(title)) {
        return { status: r.status, label: r.label, title, hit: 'title' };
      }
    }
    for (let i = 0; i < CLAIM_HTML_RULES.length; i++) {
      const r = CLAIM_HTML_RULES[i];
      if (r.re.test(body)) {
        return { status: r.status, label: r.label, title, hit: 'body' };
      }
    }
    return { status: 'failed', label: '', title, hit: 'none' };
  }

  /* 面板展示文案：「HTTP 302（重定向）→ 需先拥有本体：页面标题」 */
  function claimFailMessage(res, cls) {
    const status = res && typeof res.status === 'number' ? res.status : 0;
    let head = 'HTTP ' + status;
    if (res && res.redirected) head += '（重定向）';

    const title = cls && cls.title ? cls.title : '';
    const label = cls && cls.label ? cls.label : '';
    let tail = title;
    if (label) tail = title ? label + '：' + title : label;
    if (!tail) tail = '响应不是 JSON';

    return head + ' → ' + tail;
  }

  /* 原始响应留档：只进 report.debug 备查，不在面板展示 */
  function claimFailDebug(subid, res, text, cls) {
    let contentType = '';
    try {
      if (res && res.headers && typeof res.headers.get === 'function') {
        contentType = String(res.headers.get('content-type') || '');
      }
    } catch (e) {
      contentType = '';
    }
    return {
      subid: String(subid),
      at: Date.now(),
      httpStatus: res && typeof res.status === 'number' ? res.status : null,
      httpStatusText: res && res.statusText ? String(res.statusText) : '',
      redirected: !!(res && res.redirected),
      finalUrl: res && res.url ? String(res.url) : '',
      contentType: contentType,
      pageTitle: cls && cls.title ? cls.title : '',
      category: cls && cls.status ? cls.status : 'failed',
      bodySnippet: String(text || '').slice(0, CLAIM_SNIPPET_LIMIT)
    };
  }

  async function claimPackage(subid, sessionId) {
    const body = new URLSearchParams({
      action: 'add_to_cart',
      sessionid: sessionId
    }).toString();

    let res, text;
    try {
      res = await fetch(`${STORE}/freelicense/addfreelicense/${subid}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01'
        },
        body
      });
      text = await res.text();
    } catch (e) {
      return { subid, status: 'failed', message: '网络异常：' + String(e), debug: null };
    }

    let j = null;
    try {
      j = JSON.parse(text);
    } catch (e) {
      j = null;
    }

    if (!j || typeof j !== 'object') {
      /* 响应不是 JSON：归类并折算可读文案，原始片段只进 debug */
      const cls = classifyClaimHtml(text);
      return {
        subid,
        status: cls.status,
        message: claimFailMessage(res, cls),
        debug: claimFailDebug(subid, res, text, cls)
      };
    }

    const detail = j.purchase_result_detail;
    const ok = j.success === true || j.success === 1;

    if (ok && (detail === 0 || detail === undefined || detail === null)) {
      return { subid, status: 'claimed' };
    }
    if (detail === 9) {
      return { subid, status: 'owned' };
    }
    if (detail === 24) {
      return { subid, status: 'need_base', message: '需要先拥有本体' };
    }
    if (detail === 15) {
      return { subid, status: 'region_locked', message: '区域限制' };
    }
    if (detail === 53 || detail === 34) {
      return { subid, status: 'owned' };
    }
    return {
      subid,
      status: 'failed',
      detail,
      message: j.message || j.error || ''
    };
  }

  /* ------------------------------------------------------------------ */
  /* 5. 主流程                                                           */
  /* ------------------------------------------------------------------ */

  async function runScan(options) {
    const opts = Object.assign(
      { autoClaim: false, blacklist: [], minDelay: 3000, maxDelay: 9000 },
      options || {}
    );

    const report = {
      startedAt: Date.now(),
      finishedAt: null,
      dryRun: !opts.autoClaim,
      loggedIn: false,
      loginVia: null,
      totalScanned: 0,
      candidates: [],
      claimed: [],
      alreadyOwned: [],
      skipped: [],
      failed: [],
      needBase: [],
      debug: [],
      error: null
    };

    /* --- 5.0 登录态判定（异步网络探针，失败才回退 DOM/Cookie） --- */
    progress('login', '正在确认登录状态…');
    const login = await probeLogin();
    report.loggedIn = !!login.loggedIn;
    report.loginVia = login.via;

    if (!report.loggedIn) {
      report.error =
        login.via === 'unknown'
          ? '登录状态检测失败：无法访问 Steam 接口，请确认网络可用后刷新页面重试。'
          : '未检测到 Steam 登录状态，请先在客户端内打开商店页面并登录。';
      report.finishedAt = Date.now();
      return report;
    }

    const sessionId = getSessionId();
    if (!sessionId) {
      report.error = '未能读取 sessionid，请刷新商店页面后重试。';
      report.finishedAt = Date.now();
      return report;
    }

    /* --- 5.1 检索 --- */
    progress('search', '正在检索商店 100% 折扣条目…');
    const items = await searchPromotions();
    report.totalScanned = items.length;

    if (!items.length) {
      report.error = '当前没有检索到限时免费条目。';
      report.finishedAt = Date.now();
      return report;
    }

    /* --- 5.2 读取库 --- */
    progress('library', '正在读取你的游戏库…');
    const owned = await fetchOwnedAppIds();

    const blacklist = new Set((opts.blacklist || []).map(String));

    /* --- 5.3 逐个处理 --- */
    for (let i = 0; i < items.length; i++) {
      if (cancelled) {
        report.error = '用户已中止。';
        break;
      }

      const item = items[i];
      const label = item.title || `App ${item.appid || item.packageid}`;
      progress('claim', `处理中 ${i + 1} / ${items.length}：${label}`);

      if (item.appid && blacklist.has(item.appid)) {
        report.skipped.push({ ...item, reason: '黑名单' });
        continue;
      }
      if (item.appid && owned.has(item.appid)) {
        report.alreadyOwned.push({ ...item, reason: '库中已有' });
        continue;
      }

      /* 解析真正可领取的 subid */
      let subids = [];
      if (item.packageid) {
        subids = [item.packageid];
      } else if (item.appid) {
        subids = await resolveClaimableSubs(item.appid);
        await sleep(rand(400, 900));
      }

      if (!subids.length) {
        report.skipped.push({ ...item, reason: '未找到零元可领取的 package' });
        continue;
      }

      /* 领取前预判：DLC 依赖的是尚未拥有的本体时，直接归入「需本体」，
         不再对它发 addfreelicense（那种请求只会换回一张无信息量的错误页）。
         预判请求失败则完全退回原有流程，不影响领取。 */
      let preBase = null;
      if (item.appid) {
        const baseInfo = await resolveBaseGame(item.appid);
        if (baseInfo.ok) await sleep(rand(150, 400));
        if (baseInfo.ok && baseInfo.baseAppid && !owned.has(String(baseInfo.baseAppid))) {
          preBase = baseInfo;
        }
      }

      if (preBase) {
        report.needBase.push({
          appid: item.appid,
          title: label,
          subid: subids[0],
          subids,
          href: item.href,
          status: 'need_base',
          precheck: true,
          baseAppid: preBase.baseAppid,
          baseName: preBase.baseName,
          message: '需本体：' + preBase.baseName,
          at: Date.now()
        });
        continue;
      }

      report.candidates.push({
        appid: item.appid,
        title: label,
        subids,
        href: item.href
      });

      if (!opts.autoClaim) {
        continue;
      }

      /* 逐个 subid 尝试领取，成功即止 */
      let result = null;
      for (const subid of subids) {
        if (cancelled) break;
        result = await claimPackage(subid, sessionId);
        if (result.status === 'claimed') break;
        if (result.status === 'region_locked' || result.status === 'need_base') break;
        await sleep(rand(800, 1500));
      }

      if (!result) continue;

      const record = { appid: item.appid, title: label, subid: result.subid, message: result.message || '', at: Date.now() };

      if (result.status === 'claimed') {
        report.claimed.push(record);
        owned.add(String(item.appid));
      } else if (result.status === 'owned') {
        report.alreadyOwned.push({ ...record, reason: '库中已有' });
      } else if (result.status === 'need_base') {
        /* 「需先拥有本体」是常态提示而非失败，单独归类 */
        report.needBase.push({ ...record, status: result.status, detail: result.detail });
      } else {
        report.failed.push({ ...record, status: result.status, detail: result.detail });
      }

      /* 原始响应片段只进 debug 备查，不在面板展示 */
      if (result.debug) {
        report.debug.push(Object.assign({ appid: item.appid, title: label }, result.debug));
      }

      /* 节奏控制，避免高频请求 */
      await sleep(rand(opts.minDelay, opts.maxDelay));
    }

    report.finishedAt = Date.now();
    return report;
  }

  /* ------------------------------------------------------------------ */
  /* 消息入口                                                            */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'RUN_SCAN') {
      if (running) {
        sendResponse({ ok: false, error: '已有任务在执行中' });
        return false;
      }
      running = true;
      cancelled = false;

      runScan(msg.options)
        .then((report) => {
          running = false;
          try {
            chrome.runtime.sendMessage({ type: 'SCAN_DONE', report });
          } catch (e) {
            /* ignore */
          }
          sendResponse({ ok: true, report });
        })
        .catch((err) => {
          running = false;
          const report = {
            startedAt: Date.now(),
            finishedAt: Date.now(),
            error: '执行异常：' + String(err),
            claimed: [],
            alreadyOwned: [],
            skipped: [],
            failed: [],
            needBase: [],
            debug: [],
            candidates: []
          };
          try {
            chrome.runtime.sendMessage({ type: 'SCAN_DONE', report });
          } catch (e) {
            /* ignore */
          }
          sendResponse({ ok: false, error: String(err), report });
        });

      return true; // 异步响应
    }

    if (msg.type === 'CANCEL_SCAN') {
      cancelled = true;
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'PING') {
      sendResponse({ ok: true, loggedIn: isLoggedIn(), running });
      return false;
    }
  });

  /* ================================================================== */
  /* 6. 页面内悬浮面板（替代 Steam CEF 中无法打开的扩展 popup）           */
  /*                                                                     */
  /* Steam 客户端内置浏览器（CEF 126）没有扩展图标 / 拼图菜单，           */
  /* chrome-extension:// 导航被拒且会触发崩溃，popup 与 options 无法访问。 */
  /* 因此把操作界面直接用 Shadow DOM 注入到 store.steampowered.com 页面： */
  /*   · 右下角悬浮球「喜+1」，可拖动，点击展开 / 折叠面板               */
  /*   · 面板按钮直接调用本文件的 runScan() 与 cancelled 变量，           */
  /*     不走 chrome.runtime 消息链路，不依赖 background.js 与 popup      */
  /*   · 已有 progress() 的输出通过 __sfhPanelProgress 同步到面板进度行   */
  /* 全部样式写在内联 style 字符串中，不新增任何外部文件与依赖。           */
  /* 说明：本章只做 UI 呈现与流程驱动，不触碰检索 / 解析 / 领取逻辑。      */
  /* ================================================================== */

  var __sfhPanelProgress = null;

  var SFH_SETTINGS_KEY = 'steam-free-helper:settings';
  var SFH_BALL_SIZE = 54;

  var sfhState = {
    ready: false,
    open: false,
    busy: false,
    autoClaim: false,
    x: 0,
    y: 0
  };

  var sfhEls = {};

  var SFH_CSS = `
    :host { all: initial; }
    .sfh-ball, .sfh-panel, .sfh-panel * { box-sizing: border-box; }

    .sfh-ball {
      position: fixed;
      left: 0;
      top: 0;
      width: 54px;
      height: 54px;
      margin: -27px 0 0 -27px;
      border-radius: 50%;
      background: radial-gradient(circle at 32% 26%, #4c6b22 0%, #2a475e 55%, #16202d 100%);
      border: 1px solid rgba(164, 208, 7, 0.55);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
      color: #dbe6ef;
      font: 700 13px/52px 'Motiva Sans', Arial, 'Microsoft YaHei', sans-serif;
      text-align: center;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      pointer-events: auto;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      z-index: 2;
    }
    .sfh-ball:hover { transform: scale(1.06); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.6); }
    .sfh-ball:active { cursor: grabbing; }
    .sfh-ball[data-running='1'] { border-color: #66c0f4; animation: sfh-pulse 1.4s ease-in-out infinite; }
    @keyframes sfh-pulse {
      0%, 100% { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55), 0 0 0 0 rgba(102, 192, 244, 0.5); }
      50% { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55), 0 0 0 9px rgba(102, 192, 244, 0); }
    }

    .sfh-panel {
      position: fixed;
      left: 0;
      top: 0;
      width: 350px;
      max-height: 68vh;
      display: none;
      flex-direction: column;
      background: #16202d;
      border: 1px solid #2a475e;
      border-radius: 10px;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.65);
      color: #c6d4df;
      font: 13px/1.45 'Motiva Sans', Arial, 'Microsoft YaHei', sans-serif;
      overflow: hidden;
      pointer-events: auto;
      z-index: 1;
    }
    .sfh-panel[data-open='1'] { display: flex; }

    .sfh-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 9px 10px 9px 12px;
      background: linear-gradient(90deg, #2a475e 0%, #1b2838 100%);
      border-bottom: 1px solid #2a475e;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
    }
    .sfh-head:active { cursor: grabbing; }
    .sfh-title { font-weight: 700; font-size: 13.5px; color: #ffffff; letter-spacing: 0.2px; }
    .sfh-head-right { display: flex; align-items: center; }
    .sfh-tag { font-size: 11px; color: #8f98a0; margin-right: 8px; }
    .sfh-collapse {
      border: 0;
      background: transparent;
      color: #8f98a0;
      font: 12px/1 'Motiva Sans', Arial, 'Microsoft YaHei', sans-serif;
      padding: 4px 6px;
      border-radius: 4px;
      cursor: pointer;
    }
    .sfh-collapse:hover { color: #ffffff; background: rgba(255, 255, 255, 0.1); }

    .sfh-body { padding: 10px 12px 12px; overflow-y: auto; }

    .sfh-row { margin-bottom: 8px; }
    .sfh-status { font-size: 12px; color: #8f98a0; }
    .sfh-status b { font-weight: 600; }
    .sfh-ok { color: #a4d007; }
    .sfh-warn { color: #e0a21b; }
    .sfh-bad { color: #d94126; }

    .sfh-actions { display: flex; }
    .sfh-btn {
      flex: 1;
      padding: 7px 0;
      border: 0;
      border-radius: 4px;
      color: #ffffff;
      font: 600 12.5px/1.2 'Motiva Sans', Arial, 'Microsoft YaHei', sans-serif;
      cursor: pointer;
    }
    .sfh-btn + .sfh-btn { margin-left: 8px; }
    .sfh-scan { background: linear-gradient(180deg, #75b022 0%, #588a1b 100%); }
    .sfh-scan:hover:not(:disabled) { background: linear-gradient(180deg, #8ed629 0%, #6aa51f 100%); }
    .sfh-stop { background: linear-gradient(180deg, #a53d3d 0%, #7a2a2a 100%); }
    .sfh-stop:hover:not(:disabled) { background: linear-gradient(180deg, #c14a4a 0%, #8f3232 100%); }
    .sfh-btn:disabled { opacity: 0.42; cursor: not-allowed; }

    .sfh-check {
      display: flex;
      align-items: center;
      font-size: 12.5px;
      color: #c6d4df;
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
    }
    .sfh-check input {
      width: 14px;
      height: 14px;
      margin: 0 7px 0 0;
      accent-color: #75b022;
      cursor: pointer;
    }

    .sfh-progress {
      min-height: 17px;
      margin: 2px 0 8px;
      font-size: 12px;
      color: #8f98a0;
      word-break: break-all;
    }

    .sfh-stats { display: flex; }
    .sfh-stat {
      flex: 1;
      padding: 6px 0;
      text-align: center;
      background: #0e1621;
      border: 1px solid #223a4d;
      border-radius: 5px;
    }
    .sfh-stat + .sfh-stat { margin-left: 6px; }
    .sfh-stat .sfh-num { display: block; font-size: 16px; font-weight: 700; line-height: 1.15; color: #c6d4df; }
    .sfh-stat .sfh-lab { display: block; font-size: 10.5px; color: #7f8b96; white-space: nowrap; }
    .sfh-stat[data-k='claimed'] .sfh-num { color: #a4d007; }
    .sfh-stat[data-k='alreadyOwned'] .sfh-num { color: #66c0f4; }
    .sfh-stat[data-k='candidates'] .sfh-num { color: #e0a21b; }
    .sfh-stat[data-k='needBase'] .sfh-num { color: #c7a24a; }
    .sfh-stat[data-k='failed'] .sfh-num { color: #d94126; }

    .sfh-details { margin-top: 2px; }
    .sfh-sec { margin-top: 8px; }
    .sfh-sec-head {
      padding-bottom: 3px;
      margin-bottom: 4px;
      border-bottom: 1px solid #223a4d;
      font-size: 11.5px;
      color: #8f98a0;
    }
    .sfh-item {
      display: flex;
      align-items: baseline;
      padding: 4px 6px;
      border-radius: 4px;
      color: #c6d4df;
      font-size: 12px;
      text-decoration: none;
      cursor: pointer;
    }
    .sfh-item:hover { background: rgba(102, 192, 244, 0.14); color: #ffffff; }
    .sfh-item .sfh-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sfh-item .sfh-note {
      flex: 0 0 auto;
      max-width: 104px;
      margin-left: 8px;
      font-size: 10.5px;
      color: #7f8b96;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* 失败 / 需本体的诊断文案较长：允许多行显示，避免被截成看不懂的残句 */
    .sfh-item-diag { align-items: flex-start; }
    .sfh-item-diag .sfh-name { padding-top: 1px; }
    .sfh-item-diag .sfh-note {
      max-width: 186px;
      white-space: normal;
      word-break: break-word;
      line-height: 1.35;
      text-align: right;
    }
    .sfh-empty { padding: 2px 0 2px 6px; font-size: 11.5px; color: #5f6b76; }
  `;

  var SFH_SECTIONS = [
    { key: 'claimed', label: '已领取', num: 'nClaimed' },
    { key: 'alreadyOwned', label: '库中已有', num: 'nOwned' },
    { key: 'candidates', label: '可领取', num: 'nCandidates' },
    { key: 'needBase', label: '需本体', num: 'nNeedBase' },
    { key: 'failed', label: '失败', num: 'nFailed' }
  ];

  /* ---------------------- 设置持久化（localStorage） ---------------------- */

  function sfhLoadSettings() {
    var s = { autoClaim: false, open: false, x: 0, y: 0, hasPos: false };
    try {
      var raw = window.localStorage.getItem(SFH_SETTINGS_KEY);
      if (!raw) return s;
      var j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        s.autoClaim = j.autoClaim === true;
        s.open = j.open === true;
        if (j.pos && typeof j.pos.x === 'number' && typeof j.pos.y === 'number' &&
            isFinite(j.pos.x) && isFinite(j.pos.y)) {
          s.x = j.pos.x;
          s.y = j.pos.y;
          s.hasPos = true;
        }
      }
    } catch (e) {
      /* localStorage 被禁用时退回默认值 */
    }
    return s;
  }

  function sfhSaveSettings() {
    try {
      window.localStorage.setItem(
        SFH_SETTINGS_KEY,
        JSON.stringify({
          autoClaim: !!sfhState.autoClaim,
          open: !!sfhState.open,
          pos: { x: Math.round(sfhState.x), y: Math.round(sfhState.y) }
        })
      );
    } catch (e) {
      /* 写入失败不影响功能 */
    }
  }

  /* ---------------------- 位置计算（视口钳制） ---------------------- */

  function sfhViewport() {
    var vw = window.innerWidth || document.documentElement.clientWidth || 1200;
    var vh = window.innerHeight || document.documentElement.clientHeight || 800;
    return { vw: vw, vh: vh };
  }

  function sfhClamp(x, y) {
    var v = sfhViewport();
    var half = SFH_BALL_SIZE / 2;
    var minX = half + 4;
    var minY = half + 4;
    var maxX = Math.max(minX, v.vw - half - 4);
    var maxY = Math.max(minY, v.vh - half - 4);
    return {
      x: Math.min(Math.max(x, minX), maxX),
      y: Math.min(Math.max(y, minY), maxY)
    };
  }

  function sfhApplyPos() {
    var ball = sfhEls.ball;
    var panel = sfhEls.panel;
    if (!ball || !panel) return;

    var p = sfhClamp(sfhState.x, sfhState.y);
    sfhState.x = p.x;
    sfhState.y = p.y;
    ball.style.left = p.x + 'px';
    ball.style.top = p.y + 'px';

    if (!sfhState.open) return;

    var v = sfhViewport();
    var half = SFH_BALL_SIZE / 2;
    var pw = panel.offsetWidth || 350;
    var ph = panel.offsetHeight || 420;

    /* 面板右边缘与悬浮球右侧对齐，底边落在悬浮球上方 */
    var left = p.x + half - pw;
    var top = p.y - half - 10 - ph;
    if (top < 8) top = p.y + half + 10;

    var maxLeft = Math.max(8, v.vw - pw - 8);
    var maxTop = Math.max(8, v.vh - ph - 8);
    left = Math.min(Math.max(left, 8), maxLeft);
    top = Math.min(Math.max(top, 8), maxTop);

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  /* ---------------------- 拖拽（悬浮球 / 面板标题栏共用） ---------------------- */

  function sfhAttachDrag(handle, onClick) {
    if (!handle) return;

    var dragging = false;
    var moved = false;
    var startX = 0;
    var startY = 0;
    var baseX = 0;
    var baseY = 0;

    function onMove(e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      e.preventDefault();
      var p = sfhClamp(baseX + dx, baseY + dy);
      sfhState.x = p.x;
      sfhState.y = p.y;
      sfhApplyPos();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      if (moved) {
        sfhSaveSettings();
      } else if (typeof onClick === 'function') {
        onClick();
      }
    }

    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      baseX = sfhState.x;
      baseY = sfhState.y;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
  }

  /* ---------------------- 面板状态与渲染 ---------------------- */

  function sfhSetProgress(text, cls) {
    var el = sfhEls.progress;
    if (!el) return;
    el.textContent = text || '';
    el.className = 'sfh-progress' + (cls ? ' sfh-' + cls : '');
  }

  function sfhSetLoginLabel(ok, via) {
    var el = sfhEls.login;
    if (!el) return;
    el.textContent = ok ? '已登录' : via === 'unknown' ? '登录状态未知' : '未登录';
    el.className = ok ? 'sfh-ok' : 'sfh-warn';
  }

  async function sfhRefreshLogin(silent) {
    if (!sfhEls.login) return false;
    var r = null;
    try {
      r = await probeLogin();
    } catch (e) {
      r = { loggedIn: false, via: 'unknown' };
    }
    sfhSetLoginLabel(!!r.loggedIn, r.via);
    if (!r.loggedIn && !silent) {
      sfhSetProgress(
        r.via === 'unknown'
          ? '登录状态检测失败（接口无响应），请确认网络后重试。'
          : '未检测到登录状态，请先在客户端内登录 Steam 商店。',
        'warn'
      );
    }
    return !!r.loggedIn;
  }

  function sfhSetBusy(busy) {
    sfhState.busy = !!busy;
    if (sfhEls.scan) sfhEls.scan.disabled = !!busy;
    if (sfhEls.stop) sfhEls.stop.disabled = !busy;
    if (sfhEls.auto) sfhEls.auto.disabled = !!busy;
    if (sfhEls.ball) sfhEls.ball.setAttribute('data-running', busy ? '1' : '0');
    if (sfhEls.tag) sfhEls.tag.textContent = busy ? '扫描中' : '就绪';
  }

  function sfhResetResults() {
    SFH_SECTIONS.forEach(function (sec) {
      var n = sfhEls[sec.num];
      if (n) n.textContent = '0';
    });
    if (sfhEls.details) sfhEls.details.innerHTML = '';
  }

  function sfhStoreUrl(item) {
    var href = item && item.href ? String(item.href) : '';
    if (/^https?:\/\//i.test(href)) return href;
    if (href.charAt(0) === '/') return STORE + href;
    if (item && item.appid) return STORE + '/app/' + encodeURIComponent(String(item.appid)) + '/';
    return STORE + '/';
  }

  /* 明细行的标识串：app/4693960 · sub 1782986，便于人工核对与排查 */
  function sfhIdNote(item) {
    if (!item) return '';
    var parts = [];
    if (item.appid !== undefined && item.appid !== null && item.appid !== '') {
      parts.push('app/' + item.appid);
    }
    var sub = '';
    if (item.subid !== undefined && item.subid !== null && item.subid !== '') {
      sub = String(item.subid);
    } else if (item.subids && item.subids.length) {
      sub = item.subids.join('/');
    }
    if (sub) parts.push('sub ' + sub);
    return parts.join(' · ');
  }

  function sfhItemNote(item, kind) {
    if (!item) return '';
    var ids = sfhIdNote(item);
    function joinIds(text) {
      if (!text) return ids;
      return ids ? ids + ' · ' + text : text;
    }

    if (kind === 'claimed') return ids;
    if (kind === 'alreadyOwned') return joinIds(item.reason || '库中已有');
    if (kind === 'candidates') return ids;
    if (kind === 'failed' || kind === 'needBase') {
      /* 只显示归类后的可读文案，绝不回显 HTML 原文 */
      if (item.message) return joinIds(item.message);
      if (item.detail !== undefined && item.detail !== null) return joinIds('失败：detail ' + item.detail);
      return joinIds(kind === 'needBase' ? '需先拥有本体' : '失败');
    }
    return ids;
  }

  function sfhBuildItem(item, kind) {
    var a = document.createElement('a');
    a.className = 'sfh-item';
    a.setAttribute('href', sfhStoreUrl(item));
    a.setAttribute('title', '在商店中打开：' + (item.title || item.appid || ''));

    var name = document.createElement('span');
    name.className = 'sfh-name';
    name.textContent = item.title || ('App ' + (item.appid || item.packageid || '?'));

    var noteText = sfhItemNote(item, kind);
    var note = document.createElement('span');
    note.className = 'sfh-note';
    note.textContent = noteText;
    /* 诊断文案较长：允许换行，并给出完整内容的悬停提示 */
    if (kind === 'failed' || kind === 'needBase') {
      a.className = 'sfh-item sfh-item-diag';
      note.setAttribute('title', noteText);
      a.setAttribute('title', noteText + '｜在商店中打开：' + (item.title || item.appid || ''));
    }

    a.appendChild(name);
    if (noteText) a.appendChild(note);

    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var url = a.getAttribute('href');
      var win = null;
      try {
        win = window.open(url, '_blank', 'noopener');
      } catch (err) {
        win = null;
      }
      if (!win) {
        if (sfhState.busy) {
          sfhSetProgress('扫描进行中，暂不跳转，请稍后再点击明细。', 'warn');
          return;
        }
        try {
          window.location.href = url;
        } catch (err2) {
          /* ignore */
        }
      }
    });

    return a;
  }

  function sfhRenderReport(report) {
    report = report || {};
    var wrap = sfhEls.details;
    if (!wrap) return;

    wrap.innerHTML = '';

    /* 仅渲染层去重：已成功领取的 app 不再在「可领取」段重复出现（不改变 runScan 原始数据） */
    var sfhClaimedAppids = {};
    (Array.isArray(report.claimed) ? report.claimed : []).forEach(function (it) {
      if (it && it.appid != null) sfhClaimedAppids[String(it.appid)] = true;
    });
    function sfhListFor(key) {
      var raw = Array.isArray(report[key]) ? report[key] : [];
      if (key !== 'candidates') return raw;
      return raw.filter(function (it) {
        return !(it && it.appid != null && sfhClaimedAppids[String(it.appid)]);
      });
    }

    SFH_SECTIONS.forEach(function (sec) {
      var list = sfhListFor(sec.key);
      var numEl = sfhEls[sec.num];
      if (numEl) numEl.textContent = String(list.length);

      var box = document.createElement('div');
      box.className = 'sfh-sec';

      var head = document.createElement('div');
      head.className = 'sfh-sec-head';
      head.textContent = sec.label + '（' + list.length + '）';
      box.appendChild(head);

      if (!list.length) {
        var empty = document.createElement('div');
        empty.className = 'sfh-empty';
        empty.textContent = '暂无';
        box.appendChild(empty);
      } else {
        list.forEach(function (item) {
          box.appendChild(sfhBuildItem(item || {}, sec.key));
        });
      }

      wrap.appendChild(box);
    });

    if (report.error) {
      sfhSetProgress(report.error, 'bad');
      if (sfhEls.tag) sfhEls.tag.textContent = '异常';
      /* 明细填满后面板变高，重新钳制位置，避免底部超出视口被裁切 */
      sfhApplyPos();
      return;
    }

    var skipped = Array.isArray(report.skipped) ? report.skipped.length : 0;
    var summary =
      '扫描完成：共检索 ' + (report.totalScanned || 0) + ' 项' + (skipped ? '，跳过 ' + skipped + ' 项' : '');
    if (sfhState.autoClaim) {
      summary += '，已领取 ' + (Array.isArray(report.claimed) ? report.claimed.length : 0) + ' 款';
      var nBase = Array.isArray(report.needBase) ? report.needBase.length : 0;
      if (nBase) summary += '，' + nBase + ' 款需先拥有本体';
    } else {
      summary += '（未勾选自动领取，仅试运行）';
    }
    sfhSetProgress(summary, 'ok');
    if (sfhEls.tag) sfhEls.tag.textContent = '完成';
    /* 明细填满后面板变高，重新钳制位置，避免底部超出视口被裁切 */
    sfhApplyPos();
  }

  /* ---------------------- 面板展开 / 折叠 ---------------------- */

  function sfhSetOpen(open) {
    sfhState.open = !!open;
    var panel = sfhEls.panel;
    if (!panel) return;
    panel.setAttribute('data-open', sfhState.open ? '1' : '0');
    if (sfhState.open) {
      sfhRefreshLogin(true);
      sfhApplyPos();
    }
    sfhSaveSettings();
  }

  function sfhToggle() {
    sfhSetOpen(!sfhState.open);
  }

  /* ---------------------- 扫描流程（复用 runScan / cancelled） ---------------------- */

  async function sfhStartScan() {
    if (sfhState.busy) return;
    if (running) {
      sfhSetProgress('已有任务在执行中，请先中止或等待完成。', 'warn');
      return;
    }

    /* 复用既有状态位：与 background 消息链路的 RUN_SCAN 互斥 */
    running = true;
    cancelled = false;

    sfhSetBusy(true);
    sfhResetResults();
    sfhSetProgress('准备开始…', '');

    var report = null;
    var err = null;
    try {
      report = await runScan({ autoClaim: !!sfhState.autoClaim });
    } catch (e) {
      err = e;
    }

    running = false;
    sfhSetBusy(false);

    if (err) {
      sfhSetProgress('执行异常：' + String(err), 'bad');
      if (sfhEls.tag) sfhEls.tag.textContent = '异常';
      return;
    }

    sfhRenderReport(report);
    /* 扫描结果里已带登录态结论，直接复用，避免重复发探针请求 */
    if (report && report.loginVia) sfhSetLoginLabel(!!report.loggedIn, report.loginVia);
    else sfhRefreshLogin(true);
  }

  function sfhAbort() {
    if (!sfhState.busy) return;
    cancelled = true;
    sfhSetProgress('已请求中止，等待当前请求收尾…', 'warn');
  }

  /* progress() 的同步出口：把已有进度文案显示到面板进度行 */
  __sfhPanelProgress = function (phase, text) {
    if (!sfhEls.progress) return;
    sfhSetProgress(text || '', '');
  };

  /* ---------------------- DOM 构建与事件绑定 ---------------------- */

  function sfhBuildDom() {
    var host = document.createElement('div');
    host.id = 'steam-free-helper-root';
    host.setAttribute('data-steam-free-helper', '1');
    host.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';

    var root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = SFH_CSS;

    var ball = document.createElement('div');
    ball.className = 'sfh-ball';
    ball.setAttribute('role', 'button');
    ball.setAttribute('tabindex', '0');
    ball.setAttribute('title', 'Steam 喜加一：点击展开 / 折叠，可拖动');
    ball.setAttribute('data-running', '0');
    ball.textContent = '喜+1';

    var panel = document.createElement('div');
    panel.className = 'sfh-panel';
    panel.setAttribute('data-open', '0');
    panel.innerHTML =
      '<div class="sfh-head" data-role="head">' +
      '<span class="sfh-title">Steam 喜加一</span>' +
      '<span class="sfh-head-right">' +
      '<span class="sfh-tag" data-role="tag">就绪</span>' +
      '<button type="button" class="sfh-collapse" data-role="collapse">收起</button>' +
      '</span>' +
      '</div>' +
      '<div class="sfh-body">' +
      '<div class="sfh-row sfh-status">登录状态：<b data-role="login">检测中…</b></div>' +
      '<div class="sfh-row sfh-actions">' +
      '<button type="button" class="sfh-btn sfh-scan" data-role="scan">扫描限免</button>' +
      '<button type="button" class="sfh-btn sfh-stop" data-role="stop" disabled>中止</button>' +
      '</div>' +
      '<label class="sfh-row sfh-check">' +
      '<input type="checkbox" data-role="auto"><span>自动领取</span>' +
      '</label>' +
      '<div class="sfh-progress" data-role="progress">就绪</div>' +
      '<div class="sfh-stats">' +
      '<div class="sfh-stat" data-k="claimed">' +
      '<span class="sfh-num" data-role="claimed-num">0</span><span class="sfh-lab">已领取</span></div>' +
      '<div class="sfh-stat" data-k="alreadyOwned">' +
      '<span class="sfh-num" data-role="alreadyOwned-num">0</span><span class="sfh-lab">库中已有</span></div>' +
      '<div class="sfh-stat" data-k="candidates">' +
      '<span class="sfh-num" data-role="candidates-num">0</span><span class="sfh-lab">可领取</span></div>' +
      '<div class="sfh-stat" data-k="needBase">' +
      '<span class="sfh-num" data-role="needBase-num">0</span><span class="sfh-lab">需本体</span></div>' +
      '<div class="sfh-stat" data-k="failed">' +
      '<span class="sfh-num" data-role="failed-num">0</span><span class="sfh-lab">失败</span></div>' +
      '</div>' +
      '<div class="sfh-details" data-role="details"></div>' +
      '</div>';

    root.appendChild(style);
    root.appendChild(panel);
    root.appendChild(ball);

    var q = function (role) {
      return root.querySelector('[data-role="' + role + '"]');
    };

    sfhEls = {
      host: host,
      root: root,
      ball: ball,
      panel: panel,
      head: q('head'),
      collapse: q('collapse'),
      tag: q('tag'),
      login: q('login'),
      scan: q('scan'),
      stop: q('stop'),
      auto: q('auto'),
      progress: q('progress'),
      details: q('details'),
      nClaimed: q('claimed-num'),
      nOwned: q('alreadyOwned-num'),
      nCandidates: q('candidates-num'),
      nNeedBase: q('needBase-num'),
      nFailed: q('failed-num')
    };

    var target = document.body || document.documentElement;
    target.appendChild(host);

    /* 拖拽：悬浮球（点击 = 展开 / 折叠），面板标题栏（仅移动） */
    sfhAttachDrag(sfhEls.ball, sfhToggle);
    sfhAttachDrag(sfhEls.head, null);

    sfhEls.collapse.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      sfhSetOpen(false);
    });

    sfhEls.scan.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      sfhStartScan();
    });

    sfhEls.stop.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      sfhAbort();
    });

    sfhEls.auto.addEventListener('change', function () {
      sfhState.autoClaim = !!sfhEls.auto.checked;
      sfhSaveSettings();
    });

    /* 键盘可及性：悬浮球回车 / 空格切换面板 */
    ball.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        sfhToggle();
      }
    });

    /* Shadow DOM 内部交互不再冒泡到 Steam 页面脚本 */
    ['mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'keydown', 'keyup', 'contextmenu'].forEach(
      function (type) {
        panel.addEventListener(type, function (e) {
          e.stopPropagation();
        });
        ball.addEventListener(type, function (e) {
          e.stopPropagation();
        });
      }
    );

    return host;
  }

  function sfhInit() {
    if (sfhState.ready) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', sfhInit, { once: true });
      return;
    }
    if (sfhEls.host) return;

    try {
      sfhBuildDom();
    } catch (e) {
      /* 极端环境下（如 shadow DOM 不可用）静默放弃，不影响页面原有功能 */
      return;
    }

    sfhState.ready = true;

    var s = sfhLoadSettings();
    sfhState.autoClaim = s.autoClaim;
    if (sfhEls.auto) sfhEls.auto.checked = s.autoClaim;

    if (s.hasPos) {
      sfhState.x = s.x;
      sfhState.y = s.y;
    } else {
      var v = sfhViewport();
      sfhState.x = v.vw - 42;
      sfhState.y = v.vh - 96;
    }

    sfhApplyPos();
    sfhRefreshLogin(true);
    sfhSetProgress('点击「扫描限免」开始检索', '');
    if (s.open) sfhSetOpen(true);

    window.addEventListener('resize', function () {
      sfhApplyPos();
    });
  }

  sfhInit();
})();
