/**
 * Steam 自动助手 — 页面内执行器
 *
 * 注入两个 origin：
 *   1) store.steampowered.com 商店页——限免检索 / 领取的全部请求都在页面同源上下文发出，
 *      天然携带登录 Cookie 与 g_sessionID，规避了扩展后台跨域取 Cookie 的兼容问题；
 *   2) steamloopback.host Steam 客户端「库」页面——库视图是 CEF 内嵌网页（路由
 *      /library/home、/library/app/<appid>，切页不重新加载文档），这里只提供悬浮面板
 *      与「自动启动」页签（走 127.0.0.1:17380，与页面 origin 无关）；「喜加一」受
 *      同源限制无法在库页面发请求，因此给出提示并引导一键打开商店页。
 */
(function () {
  'use strict';

  if (window.__steamFreeHelperInjected) return;
  window.__steamFreeHelperInjected = true;

  const STORE = 'https://store.steampowered.com';
  const STORE_HOST = 'store.steampowered.com';
  const LIBRARY_HOST = 'steamloopback.host';

  /* 挂载判据与默认位置相关的固定参数
     注意：视口尺寸与 visibilityState 在 CEF 的库页面里并不可靠（data: 主文档常读到 0x0 或 hidden），
     因此它们不再单独充当挂载闸门，只作为「确证看不见」的辅助条件。 */
  const SFH_MIN_VIEW = 200; /* 视口尺寸参考值，仅用于兜底判断与默认位置估算 */
  const SFH_VISIBLE_TIMEOUT = 3000; /* 等待就绪的最长时间，超时后强制挂载一次（宁多挂不漏挂） */
  const SFH_SHELL_MIN_AREA = 400; /* body 渲染面积小于该值视为「无渲染内容」 */
  const SFH_SHELL_MIN_NODES = 2; /* body 直接子节点数不超过该值视为「无渲染内容」 */
  const SFH_SHELL_PROBE_DELAY = 1200; /* 挂载后自检延时（先挂后判） */
  const SFH_SHELL_CONFIRM_CHECKS = 3; /* 连续几次「确证无渲染内容」才允许判壳页/移除悬浮球 */
  const SFH_SHELL_RECHECK_GAP = 1000; /* 上述连续确认的间隔（毫秒） */
  const SFH_DEFAULT_RIGHT_GAP = 24; /* 默认位置：距视口右边缘 */
  const SFH_DEFAULT_BOTTOM_GAP = 88; /* 默认位置：距视口底部（让开 Steam 底部栏） */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  let cancelled = false;
  let running = false;

  /* ------------------------------------------------------------------ */
  /* 页面环境判定：商店网页 / Steam 客户端库页面                          */
  /*                                                                     */
  /* 库视图是 CEF 内嵌网页，origin 为 https://steamloopback.host，        */
  /* 路由 /library/home 与 /library/app/<appid>，切页不重新加载文档，     */
  /* 地址栏与刷新能力被 Steam 隐藏。                                     */
  /* ------------------------------------------------------------------ */

  /* 返回 'store'（商店网页） / 'library'（客户端库页面） / 'other' */
  function sfhPageEnv() {
    let h = '';
    try {
      h = String(window.location.hostname || '');
    } catch (e) {
      h = '';
    }
    if (h === STORE_HOST || /(^|\.)steampowered\.com$/i.test(h)) return 'store';
    if (h === LIBRARY_HOST) return 'library';
    return 'other';
  }

  function sfhIsStorePage() {
    return sfhPageEnv() === 'store';
  }

  function sfhIsLibraryPage() {
    return sfhPageEnv() === 'library';
  }

  /* ------------------------------------------------------------------ */
  /* 可见文档判据                                                        */
  /*                                                                     */
  /* Steam 每个 CEF 视图里除了用户看得见的页面，还有一个隐藏的            */
  /* steamloopback.host 壳页（SharedJSContext，路径 /index.html），      */
  /* 它同样会被 content_scripts 注入。若不识别它就会出现第二个悬浮球，   */
  /* 且那个球的文档环境恒为 library，面板在任何页面都误判成「库页面」。  */
  /* 目标：任何时刻全局只有一个用户看得见的球。                          */
  /* ------------------------------------------------------------------ */

  /* body 的渲染尺寸与子节点数：隐藏壳页的 body 是空壳，库页面的 body 里有 Steam 渲染出来的库 UI。
     这条结构性判据不依赖 visibilityState 与视口尺寸，在 CEF 的 data: 主文档下依然稳定可读。 */
  function sfhBodyRect() {
    var b = document.body;
    if (!b) return { w: 0, h: 0, area: 0, children: 0 };
    var w = 0;
    var h = 0;
    try {
      var r = b.getBoundingClientRect ? b.getBoundingClientRect() : null;
      if (r) {
        w = Number(r.width) || 0;
        h = Number(r.height) || 0;
      }
    } catch (e) {
      /* ignore */
    }
    if (!(w > 0)) w = Number(b.offsetWidth) || 0;
    if (!(h > 0)) h = Number(b.offsetHeight) || 0;
    w = Math.max(w, Number(b.scrollWidth) || 0);
    h = Math.max(h, Number(b.scrollHeight) || 0);
    var children = 0;
    try {
      children = b.children ? b.children.length : 0;
    } catch (e) {
      children = 0;
    }
    return { w: w, h: h, area: w > 0 && h > 0 ? w * h : 0, children: children };
  }

  /* body 里是否有实际渲染内容（即用户真能看见的页面） */
  function sfhHasRenderableContent() {
    if (!document.body) return false;
    var b = sfhBodyRect();
    if (b.area >= SFH_SHELL_MIN_AREA) return true;
    if (b.children > SFH_SHELL_MIN_NODES) return true;
    return false;
  }

  /* 文档可视尺寸：内层窗口尺寸、根元素尺寸与 body 渲染尺寸取较大值。
     库页面的 data: 主文档常把 innerWidth/innerHeight 与 clientWidth/clientHeight 读成 0，
     但真正的库 UI 在 body 里，所以把 body 尺寸也纳入计算，避免视口被误判成 0x0。 */
  function sfhDocSize() {
    var de = document.documentElement || {};
    var iw = Number(window.innerWidth) || 0;
    var ih = Number(window.innerHeight) || 0;
    var cw = Number(de.clientWidth) || 0;
    var ch = Number(de.clientHeight) || 0;
    var b = sfhBodyRect();
    return { w: Math.max(iw, cw, b.w), h: Math.max(ih, ch, b.h) };
  }

  function sfhHostname() {
    try {
      return String(window.location.hostname || '');
    } catch (e) {
      return '';
    }
  }

  function sfhPathname() {
    try {
      return String(window.location.pathname || '');
    } catch (e) {
      return '';
    }
  }

  function sfhDocTitle() {
    try {
      return String(document.title || '');
    } catch (e) {
      return '';
    }
  }

  /* body 里是否存在任何可交互元素（链接、按钮、输入、媒体、可聚焦节点）。
     壳页没有任何可交互元素；库页面的 body 里有整片库 UI，必然能命中。 */
  function sfhHasInteractiveNode() {
    if (!document.body) return false;
    try {
      var sel =
        'a[href],button,input,select,textarea,img,canvas,video,audio,svg,' +
        '[role="button"],[role="link"],[tabindex],[onclick]';
      var hits = document.body.querySelectorAll(sel);
      return !!(hits && hits.length > 0);
    } catch (e) {
      return false;
    }
  }

  /* 是否为 data: 文档。Steam 客户端库视图的主文档是 data: 文档，
     它的视口尺寸与 visibilityState 在 CEF 下完全不可读（常读成 0x0 + hidden），
     不能据此判定它「看不见」；库 UI 实际渲染在同 origin 的 SharedJSContext 文档里。 */
  function sfhIsDataDoc() {
    try {
      return String(window.location.protocol || '').toLowerCase() === 'data:';
    } catch (e) {
      return false;
    }
  }

  /* 隐藏壳页识别：steamloopback.host + 路径 / 或 /index.html。
     2.1.4 起**不再按标题**（含 SharedJSContext）短路：实测 Steam 库界面的 UI 正是渲染在
     steamloopback.host/index.html 这个标题含 SharedJSContext 的文档里，按标题判死会把
     唯一能显示悬浮球的文档排除（2.1.3 库页面 0 个球的直接原因）。
     现在只用一条结构性判据——「body 确实没有任何渲染内容」：
     渲染面积极小（或为 0）且直接子节点极少且找不到任何可交互元素，三条同时成立才算壳页。
     只要 body 有渲染内容，一律视为可见文档并挂载。 */
  function sfhIsHiddenShell() {
    if (sfhHostname() !== LIBRARY_HOST) return false;
    var p = sfhPathname();
    if (!(p === '/' || /^\/index\.html?$/i.test(p))) return false;
    if (!document.body) return false; /* body 还没出来：不确定，不算壳页 */
    var b = sfhBodyRect();
    if (b.area >= SFH_SHELL_MIN_AREA) return false; /* 有渲染面积 → 不是壳页 */
    if (b.children > SFH_SHELL_MIN_NODES) return false; /* 子节点不止一两个 → 不是壳页 */
    if (sfhHasInteractiveNode()) return false; /* 有可交互元素 → 不是壳页 */
    return true;
  }

  /* 确证「看不见」：body 无渲染内容 + 视口尺寸异常 + 文档隐藏，三条同时成立才认定。
     任一条不成立即视为不确定，按可见页面处理（宁可多挂一个球，也不让用户没有入口）。 */
  function sfhConfirmUnrendered() {
    if (sfhHasRenderableContent()) return false;
    var s = sfhDocSize();
    var tiny = s.w < SFH_MIN_VIEW || s.h < SFH_MIN_VIEW;
    if (!tiny) return false;
    try {
      if (document.visibilityState === 'hidden' || document.hidden === true) return true;
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  /* 当前文档此刻是否可挂载（决定是否挂载悬浮球）。
     判据优先级：库页面 body 有渲染内容 → 直接可挂；确证看不见 → 才等待；其余不确定 → 一律可挂。 */
  function sfhIsDocVisible() {
    if (sfhIsHiddenShell()) return false;
    if (sfhHasRenderableContent()) return true;
    return !sfhConfirmUnrendered();
  }

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

    /* --- 5.0 环境闸门：库页面 origin 为 steamloopback.host，跨域取不到商店登录态 --- */
    if (!sfhIsStorePage()) {
      report.error =
        '当前不在商店页面（Steam 库页面无法跨域查询限免）。请点面板里的「打开商店页」，在商店页内再扫描。';
      report.finishedAt = Date.now();
      return report;
    }

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
      /* 库页面（steamloopback.host）无法同源访问商店，直接回绝，避免静默失败 */
      if (!sfhIsStorePage()) {
        sendResponse({ ok: false, error: '当前页面不是商店页（Steam 库页面无法跨域查询限免），请到商店页再扫描。' });
        return false;
      }
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
    tab: 'claim',
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

    /* ---------- 顶部页签 ---------- */
    .sfh-tabs {
      display: flex;
      flex: 0 0 auto;
      padding: 0 8px;
      background: #101822;
      border-bottom: 1px solid #2a475e;
    }
    .sfh-tab {
      flex: 1;
      padding: 8px 0 7px;
      border: 0;
      border-bottom: 2px solid transparent;
      background: transparent;
      color: #8f98a0;
      font: 600 12.5px/1.2 'Motiva Sans', Arial, 'Microsoft YaHei', sans-serif;
      cursor: pointer;
    }
    .sfh-tab:hover { color: #c6d4df; }
    .sfh-tab[data-active='1'] { color: #ffffff; border-bottom-color: #66c0f4; }
    .sfh-pane { display: none; }
    .sfh-pane[data-active='1'] { display: block; }

    /* ---------- 自动启动页签 ---------- */
    .sfh-retry {
      margin-left: 7px;
      padding: 1px 8px;
      border: 1px solid #2a475e;
      border-radius: 4px;
      background: #1b2838;
      color: #c6d4df;
      font: 11.5px/1.5 'Motiva Sans', Arial, 'Microsoft YaHei', sans-serif;
      cursor: pointer;
    }
    .sfh-retry:hover { border-color: #66c0f4; color: #ffffff; }
    .sfh-retry[data-show='0'] { display: none; }
    .sfh-auto-hint {
      margin: 0 0 8px;
      font-size: 11.5px;
      line-height: 1.45;
      color: #7f8b96;
      word-break: break-all;
    }
    .sfh-auto-hint[data-bad='1'] { color: #e0a21b; }

    .sfh-filter {
      width: 100%;
      margin-bottom: 6px;
      padding: 5px 7px;
      border: 1px solid #2a475e;
      border-radius: 4px;
      background: #0e1621;
      color: #c6d4df;
      font: 12px/1.4 'Motiva Sans', Arial, 'Microsoft YaHei', sans-serif;
    }
    .sfh-filter:focus { outline: none; border-color: #66c0f4; }
    .sfh-filter::placeholder { color: #5f6b76; }

    .sfh-games {
      max-height: 186px;
      overflow-y: auto;
      border: 1px solid #223a4d;
      border-radius: 5px;
      background: #0e1621;
    }
    .sfh-game {
      display: flex;
      align-items: flex-start;
      padding: 5px 7px;
      border-bottom: 1px solid rgba(34, 58, 77, 0.75);
      cursor: pointer;
    }
    .sfh-game:last-child { border-bottom: 0; }
    .sfh-game:hover { background: rgba(102, 192, 244, 0.1); }
    .sfh-game input {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      margin: 2px 7px 0 0;
      accent-color: #75b022;
      cursor: pointer;
    }
    .sfh-game-main { flex: 1; min-width: 0; }
    .sfh-game-line { display: flex; align-items: center; }
    .sfh-game-name {
      flex: 1;
      min-width: 0;
      font-size: 12.5px;
      color: #c6d4df;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sfh-src {
      flex: 0 0 auto;
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 3px;
      font-size: 10px;
      line-height: 15px;
      white-space: nowrap;
    }
    .sfh-src[data-src='steam'] { background: rgba(102, 192, 244, 0.18); color: #66c0f4; }
    .sfh-src[data-src='shortcut'] { background: rgba(224, 162, 27, 0.18); color: #e0a21b; }
    .sfh-src[data-src='custom'] { background: rgba(164, 208, 7, 0.18); color: #a4d007; }
    .sfh-game-sub {
      margin-top: 1px;
      font-size: 10.5px;
      color: #5f6b76;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sfh-games-empty { padding: 9px 8px; font-size: 11.5px; color: #5f6b76; text-align: center; }

    .sfh-cfg {
      margin: 8px 0 6px;
      padding: 7px 8px 8px;
      border: 1px solid #223a4d;
      border-radius: 5px;
      background: #0e1621;
    }
    .sfh-cfg-row {
      display: flex;
      align-items: center;
      margin-top: 6px;
      font-size: 12px;
      color: #c6d4df;
    }
    .sfh-cfg-row > span { flex: 1; }
    .sfh-num-input {
      width: 58px;
      padding: 3px 6px;
      border: 1px solid #2a475e;
      border-radius: 4px;
      background: #16202d;
      color: #c6d4df;
      font: 12px/1.3 'Motiva Sans', Arial, 'Microsoft YaHei', sans-serif;
      text-align: center;
    }
    .sfh-num-input:focus { outline: none; border-color: #66c0f4; }
    .sfh-unit { flex: 0 0 auto; margin-left: 5px; font-size: 11.5px; color: #7f8b96; }
    .sfh-neutral { background: linear-gradient(180deg, #417a9b 0%, #2a475e 100%); }
    .sfh-neutral:hover:not(:disabled) { background: linear-gradient(180deg, #4f93b8 0%, #35607d 100%); }
    .sfh-launch { background: linear-gradient(180deg, #66c0f4 0%, #417a9b 100%); color: #0e1621; }
    .sfh-launch:hover:not(:disabled) { background: linear-gradient(180deg, #8ed3ff 0%, #4f93b8 100%); }
    .sfh-auto-msg {
      min-height: 16px;
      margin-top: 7px;
      font-size: 11.5px;
      line-height: 1.4;
      color: #8f98a0;
      word-break: break-all;
    }

    /* 库页面下「喜加一」不可用提示（只在非商店页显示） */
    .sfh-scope {
      margin: 0 0 9px;
      padding: 8px 9px 9px;
      border: 1px solid rgba(224, 162, 27, 0.42);
      border-radius: 5px;
      background: rgba(224, 162, 27, 0.1);
    }
    .sfh-scope[data-show='0'] { display: none; }
    .sfh-scope-txt {
      font-size: 11.5px;
      line-height: 1.55;
      color: #e0a21b;
      word-break: break-all;
    }
    .sfh-open-store {
      display: block;
      width: 100%;
      margin-top: 8px;
      background: linear-gradient(180deg, #417a9b 0%, #2a475e 100%);
    }
    .sfh-open-store:hover:not(:disabled) { background: linear-gradient(180deg, #4f93b8 0%, #35607d 100%); }
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
    var s = { autoClaim: false, open: false, tab: 'claim', x: 0, y: 0, hasPos: false };
    try {
      var raw = window.localStorage.getItem(SFH_SETTINGS_KEY);
      if (!raw) return s;
      var j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        s.autoClaim = j.autoClaim === true;
        s.open = j.open === true;
        s.tab = j.tab === 'auto' ? 'auto' : 'claim';
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
          tab: sfhState.tab === 'auto' ? 'auto' : 'claim',
          pos: { x: Math.round(sfhState.x), y: Math.round(sfhState.y) }
        })
      );
    } catch (e) {
      /* 写入失败不影响功能 */
    }
  }

  /* ---------------------- 位置计算（视口钳制） ---------------------- */

  function sfhViewport() {
    var s = sfhDocSize();
    var vw = s.w;
    var vh = s.h;
    /* 隐藏壳页 / 文档刚创建时会读到 0 尺寸。这里退回一个可用兜底视口，
       否则钳制结果会落到左上角 (31,31)，正好压住 Steam 顶栏菜单区。 */
    if (!(vw >= SFH_MIN_VIEW)) vw = 1200;
    if (!(vh >= SFH_MIN_VIEW)) vh = 800;
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

  /* 默认位置：右下角。库页面与商店页共用同一套算法，保证两处默认位置一致，
     底部留 SFH_DEFAULT_BOTTOM_GAP 让开 Steam 底部栏，右侧留 24px 不贴边。 */
  function sfhDefaultPos() {
    var v = sfhViewport();
    var half = SFH_BALL_SIZE / 2;
    return sfhClamp(v.vw - half - SFH_DEFAULT_RIGHT_GAP, v.vh - half - SFH_DEFAULT_BOTTOM_GAP);
  }

  /* 位置兜底（仅在初始化 / 视口变化 / 从异常状态恢复时调用，拖拽过程不受影响）：
     · 坐标非法 → 回落默认右下角
     · 坐标被钳到左上死角（典型是隐藏文档算出的 (31,31)）→ 回落默认右下角
     · 其余情况保留原位置（含用户拖拽后保存的位置） */
  function sfhSanitizePos() {
    var half = SFH_BALL_SIZE / 2;
    var x = Number(sfhState.x);
    var y = Number(sfhState.y);
    var d = null;
    if (!isFinite(x) || !isFinite(y)) {
      d = sfhDefaultPos();
      sfhState.x = d.x;
      sfhState.y = d.y;
      return;
    }
    var p = sfhClamp(x, y);
    var minGap = half + 4;
    if (p.x <= minGap + 2 && p.y <= minGap + 2) {
      var def = sfhDefaultPos();
      p = { x: def.x, y: def.y };
    }
    sfhState.x = p.x;
    sfhState.y = p.y;
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
    /* 库页面无法同源访问商店登录态：直接给出范围提示，不发无效请求 */
    if (!sfhIsStorePage()) {
      sfhEls.login.textContent = '需在商店页';
      sfhEls.login.className = 'sfh-warn';
      return false;
    }
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
    var store = sfhIsStorePage();
    if (sfhEls.scan) sfhEls.scan.disabled = !!busy || !store;
    if (sfhEls.stop) sfhEls.stop.disabled = !busy;
    if (sfhEls.auto) sfhEls.auto.disabled = !!busy || !store;
    if (sfhEls.ball) sfhEls.ball.setAttribute('data-running', busy ? '1' : '0');
    if (sfhEls.tag) sfhEls.tag.textContent = busy ? '扫描中' : store ? '就绪' : '库页面';
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

  /* ---------------------- 页面范围适配（商店页 / 库页面） ---------------------- */

  /* 库页面下「喜加一」受同源限制：显示提示条并禁用扫描；「自动启动」页签不受影响 */
  function sfhApplyScope() {
    var store = sfhIsStorePage();
    if (sfhEls.scopeClaim) sfhEls.scopeClaim.setAttribute('data-show', store ? '0' : '1');
    if (sfhEls.scan) {
      sfhEls.scan.disabled = !!sfhState.busy || !store;
      sfhEls.scan.textContent = store ? '扫描限免' : '需在商店页扫描';
    }
    if (sfhEls.auto) sfhEls.auto.disabled = !!sfhState.busy || !store;
    if (sfhEls.tag && !sfhState.busy) sfhEls.tag.textContent = store ? '就绪' : '库页面';
    return store;
  }

  /* 打开商店页，三级降级：
     ① 本地助手 POST /api/open-store：走 ShellExecute 的 steam://open/url，
        Steam 客户端 CEF 里 chrome.tabs.create / window.open 都不生效，只有它能真正唤起商店页；
     ② background 的 OPEN_STORE 新标签页（普通 Chrome 环境可用）；
     ③ 页面内 window.open，最后退回文字提示。
     库视图里直接改 location 会跳出库界面，故始终不做同页跳转。 */
  function sfhOpenStorePage(url) {
    var target = url || STORE + '/';
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (viaHelper) {
        if (done) return;
        done = true;
        resolve(!!viaHelper);
        if (!viaHelper) {
          sfhSetProgress('正在尝试打开商店页…', '');
          sfhOpenStoreViaTab(target);
        }
      };
      try {
        if (typeof sfhHelperFetch !== 'function') {
          finish(false);
          return;
        }
        sfhHelperFetch('/api/open-store', { method: 'POST', body: { url: target } })
          .then(function (r) {
            if (r && r.ok) {
              sfhSetProgress('已请求 Steam 打开商店页；若未自动跳转，请从 Steam 顶部菜单进入商店。', 'ok');
              finish(true);
              return;
            }
            finish(false);
          })
          .catch(function () {
            finish(false);
          });
      } catch (e) {
        finish(false);
      }
    });
  }

  /* 次级方案：交给 background 新开标签页（普通 Chrome 生效，CEF 内通常无反应） */
  function sfhOpenStoreViaTab(target) {
    var sent = false;
    try {
      if (window.chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        chrome.runtime.sendMessage({ type: 'OPEN_STORE', url: target }, function (resp) {
          var err = null;
          try {
            err = chrome.runtime.lastError;
          } catch (e) {
            err = null;
          }
          if (!err && resp && resp.ok) {
            sfhSetProgress('已在新标签页打开商店页；如未跳转请手动访问。', 'ok');
            return;
          }
          sfhOpenStoreFallback(target);
        });
        sent = true;
      }
    } catch (e) {
      sent = false;
    }
    if (!sent) sfhOpenStoreFallback(target);
  }

  function sfhOpenStoreFallback(target) {
    try {
      var w = window.open(target, '_blank', 'noopener');
      if (w) {
        sfhSetProgress('已在新窗口打开商店页；如未跳转请手动访问。', 'ok');
        return;
      }
    } catch (e) {
      /* ignore */
    }
    sfhSetProgress('未能自动打开商店页，请手动访问：' + target, 'warn');
  }

  /* ---------------------- 面板展开 / 折叠 ---------------------- */

  function sfhSetOpen(open) {
    sfhState.open = !!open;
    var panel = sfhEls.panel;
    if (!panel) return;
    panel.setAttribute('data-open', sfhState.open ? '1' : '0');
    if (sfhState.open) {
      sfhRefreshLogin(true);
      /* 页签停在「自动启动」时补一次连接探测；失败只影响本页签状态行 */
      if (sfhState.tab === 'auto') sfhAutoRefresh(false);
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
    if (!sfhIsStorePage()) {
      sfhSetProgress('当前在 Steam 库页面，无法跨域查询限免。请点上方「打开商店页」，在商店页内再扫描。', 'warn');
      if (sfhEls.tag) sfhEls.tag.textContent = '库页面';
      return;
    }
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

  /* ================================================================== */
  /* 6.1 「自动启动」页签：与本地助手 http://127.0.0.1:17380 通信         */
  /*                                                                     */
  /* 设计约束（与「喜加一」页签严格解耦）：                                 */
  /*   · 只用 fetch 直连本地助手，不经过 background.js                    */
  /*   · 所有异常在内部消化，绝不向外抛；助手离线时只更新本页签状态行，   */
  /*     不影响扫描 / 领取流程                                             */
  /*   · 只在本页签激活时才发起网络请求，避免无意义的本地探测             */
  /* ================================================================== */

  var SFH_HELPER_BASE = 'http://127.0.0.1:17380';
  var SFH_HELPER_TIMEOUT = 4500;

  var sfhAutoState = {
    connected: false,
    loading: false,
    games: [],
    filter: ''
  };

  /* 统一的本地助手请求封装：超时中断、异常向上抛给调用方统一处理 */
  async function sfhHelperFetch(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    var timer = null;
    try {
      if (typeof AbortController === 'function') {
        var ctrl = new AbortController();
        init.signal = ctrl.signal;
        timer = setTimeout(function () {
          try {
            ctrl.abort();
          } catch (e) {
            /* ignore */
          }
        }, SFH_HELPER_TIMEOUT);
      }
      var res = await window.fetch(SFH_HELPER_BASE + path, init);
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '0'));
      var text = await res.text();
      if (!text) return {};
      return JSON.parse(text);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function sfhAutoMsg(text, cls) {
    var el = sfhEls.autoMsg;
    if (!el) return;
    el.textContent = text || '';
    el.className = 'sfh-auto-msg' + (cls ? ' sfh-' + cls : '');
  }

  function sfhAutoSetConnected(ok) {
    sfhAutoState.connected = !!ok;
    if (sfhEls.helperState) {
      sfhEls.helperState.textContent = ok ? '已连接' : '未连接';
      sfhEls.helperState.className = ok ? 'sfh-ok' : 'sfh-bad';
    }
    if (sfhEls.helperHint) {
      sfhEls.helperHint.textContent = ok
        ? '本地助手运行中（127.0.0.1:17380）。勾选游戏后点「保存」即可。'
        : '本地助手未连接。请先运行本地助手：双击 helper\\start-helper.vbs';
      sfhEls.helperHint.setAttribute('data-bad', ok ? '0' : '1');
    }
    if (sfhEls.helperRetry) sfhEls.helperRetry.setAttribute('data-show', ok ? '0' : '1');
  }

  function sfhAutoFmtTime(ts) {
    var n = Number(ts);
    if (!n || n <= 0 || !isFinite(n)) return '从未游玩';
    var d;
    try {
      d = new Date(n * 1000);
    } catch (e) {
      return '从未游玩';
    }
    if (!d || isNaN(d.getTime())) return '从未游玩';
    function pad(v) {
      return v < 10 ? '0' + v : String(v);
    }
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    );
  }

  function sfhAutoSourceLabel(src) {
    if (src === 'steam') return 'Steam';
    if (src === 'shortcut') return '非Steam';
    return '自定义';
  }

  function sfhAutoRenderGames() {
    var box = sfhEls.gameList;
    if (!box) return;

    box.innerHTML = '';

    var kw = (sfhAutoState.filter || '').toLowerCase();
    var list = sfhAutoState.games.filter(function (g) {
      if (!kw) return true;
      return String(g && g.name ? g.name : '').toLowerCase().indexOf(kw) >= 0;
    });

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'sfh-games-empty';
      empty.textContent = sfhAutoState.games.length
        ? '没有匹配的游戏'
        : '游戏列表为空，点「重新扫描」试试';
      box.appendChild(empty);
      return;
    }

    list.forEach(function (g) {
      var row = document.createElement('label');
      row.className = 'sfh-game';
      row.setAttribute('data-id', String(g.id));

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-role', 'game-check');
      cb.checked = !!g.selected;
      cb.addEventListener('change', function () {
        sfhAutoToggle(g, cb);
      });

      var main = document.createElement('div');
      main.className = 'sfh-game-main';

      var line = document.createElement('div');
      line.className = 'sfh-game-line';

      var nameEl = document.createElement('span');
      nameEl.className = 'sfh-game-name';
      nameEl.textContent = g.name || g.id;
      nameEl.setAttribute('title', g.name || g.id);

      var srcEl = document.createElement('span');
      srcEl.className = 'sfh-src';
      srcEl.setAttribute('data-src', g.source === 'steam' || g.source === 'shortcut' ? g.source : 'custom');
      srcEl.textContent = sfhAutoSourceLabel(g.source);

      line.appendChild(nameEl);
      line.appendChild(srcEl);

      var sub = document.createElement('div');
      sub.className = 'sfh-game-sub';
      var idText = g.source === 'steam' ? 'appid ' + (g.appid || '-') : (g.exePath || '未设置路径');
      sub.textContent = idText + ' · 最后游玩 ' + sfhAutoFmtTime(g.lastPlayed);
      sub.setAttribute('title', sub.textContent);

      main.appendChild(line);
      main.appendChild(sub);
      row.appendChild(cb);
      row.appendChild(main);
      box.appendChild(row);
    });
  }

  function sfhAutoApplyConfig(cfg) {
    cfg = cfg || {};
    if (sfhEls.autoStart) sfhEls.autoStart.checked = !!cfg.autoStartEnabled;
    if (sfhEls.delay) {
      sfhEls.delay.value = String(cfg.delaySeconds != null ? cfg.delaySeconds : 15);
    }
    if (sfhEls.interval) {
      sfhEls.interval.value = String(cfg.intervalSeconds != null ? cfg.intervalSeconds : 10);
    }
  }

  function sfhAutoApplyGames(games) {
    sfhAutoState.games = Array.isArray(games) ? games : [];
    sfhAutoRenderGames();
  }

  function sfhAutoSelectedCount() {
    return sfhAutoState.games.filter(function (x) {
      return !!x.selected;
    }).length;
  }

  /* 连接助手：ping → config → games；任一步失败即判定未连接 */
  async function sfhAutoRefresh(manual) {
    if (sfhAutoState.loading) return;
    sfhAutoState.loading = true;
    if (manual) sfhAutoMsg('正在连接本地助手…', '');
    try {
      var ping = await sfhHelperFetch('/api/ping');
      sfhAutoSetConnected(true);
      var cfg = await sfhHelperFetch('/api/config');
      sfhAutoApplyConfig(cfg);
      var games = await sfhHelperFetch('/api/games');
      sfhAutoApplyGames(games);
      sfhAutoMsg(
        '已连接本地助手（v' + (ping && ping.version ? ping.version : '?') + '）。共 ' +
          sfhAutoState.games.length + ' 款游戏，已勾选 ' + sfhAutoSelectedCount() + ' 款。',
        'ok'
      );
    } catch (e) {
      sfhAutoSetConnected(false);
      sfhAutoState.games = [];
      sfhAutoRenderGames();
      sfhAutoMsg('本地助手未连接：' + (e && e.message ? e.message : String(e)), 'bad');
    } finally {
      sfhAutoState.loading = false;
    }
  }

  /* 勾选 / 取消勾选：立即写入助手配置，失败回滚界面 */
  async function sfhAutoToggle(game, cb) {
    if (!game) return;
    var want = !!cb.checked;
    try {
      var r = await sfhHelperFetch('/api/selection', {
        method: 'POST',
        body: { id: game.id, selected: want }
      });
      var ids = r && Array.isArray(r.selectedIds) ? r.selectedIds : null;
      if (ids) {
        sfhAutoState.games.forEach(function (x) {
          x.selected = ids.indexOf(x.id) >= 0;
        });
      } else {
        game.selected = want;
      }
      sfhAutoSetConnected(true);
      sfhAutoMsg(
        (want ? '已勾选：' : '已取消：') + (game.name || game.id) +
          '（共勾选 ' + sfhAutoSelectedCount() + ' 款）',
        'ok'
      );
      sfhAutoRenderGames();
    } catch (e) {
      cb.checked = !want;
      game.selected = !want;
      sfhAutoSetConnected(false);
      sfhAutoMsg('勾选失败：本地助手未响应，请确认 helper 正在运行。', 'bad');
    }
  }

  async function sfhAutoSave() {
    var enabled = !!(sfhEls.autoStart && sfhEls.autoStart.checked);
    var delay = parseInt(sfhEls.delay ? sfhEls.delay.value : '', 10);
    if (!isFinite(delay) || delay < 0) delay = 15;
    var interval = parseInt(sfhEls.interval ? sfhEls.interval.value : '', 10);
    if (!isFinite(interval) || interval < 1) interval = 10;
    try {
      var r = await sfhHelperFetch('/api/config', {
        method: 'POST',
        body: { autoStartEnabled: enabled, delaySeconds: delay, intervalSeconds: interval }
      });
      sfhAutoApplyConfig(
        r && r.ok
          ? r
          : { autoStartEnabled: enabled, delaySeconds: delay, intervalSeconds: interval }
      );
      sfhAutoSetConnected(true);
      sfhAutoMsg(
        '已保存：自动运行' + (enabled ? '开启' : '关闭') + '，延迟 ' + delay +
          ' 秒，间隔 ' + interval + ' 秒，已勾选 ' + sfhAutoSelectedCount() + ' 款游戏。',
        'ok'
      );
    } catch (e) {
      sfhAutoSetConnected(false);
      sfhAutoMsg('保存失败：本地助手未响应，配置未写入。', 'bad');
    }
  }

  async function sfhAutoLaunch() {
    try {
      var r = await sfhHelperFetch('/api/launch', { method: 'POST', body: {} });
      sfhAutoSetConnected(true);
      var results = r && Array.isArray(r.results) ? r.results : [];
      if (!results.length) {
        sfhAutoMsg('没有勾选的游戏，请先勾选并保存。', 'warn');
        return;
      }
      var okCount = results.filter(function (x) {
        return !!x && x.ok === true;
      }).length;
      var bad = results.length - okCount;
      sfhAutoMsg(
        '已启动 ' + okCount + ' 款' +
          (bad ? '，' + bad + ' 款启动失败（详见 helper\\helper.log）' : '') + '。',
        bad ? 'warn' : 'ok'
      );
    } catch (e) {
      sfhAutoSetConnected(false);
      sfhAutoMsg('启动失败：本地助手未响应。', 'bad');
    }
  }

  async function sfhAutoRescan() {
    sfhAutoMsg('正在重新扫描游戏库…', '');
    try {
      var r = await sfhHelperFetch('/api/rescan', { method: 'POST', body: {} });
      sfhAutoSetConnected(true);
      sfhAutoApplyGames(r && Array.isArray(r.games) ? r.games : []);
      sfhAutoMsg('扫描完成，共 ' + sfhAutoState.games.length + ' 款游戏。', 'ok');
    } catch (e) {
      sfhAutoSetConnected(false);
      sfhAutoMsg('重新扫描失败：本地助手未响应。', 'bad');
    }
  }

  /* 页签切换：两个页签互不干扰（不中止正在进行的扫描，也不重置其状态） */
  function sfhSetTab(tab) {
    var t = tab === 'auto' ? 'auto' : 'claim';
    sfhState.tab = t;

    if (sfhEls.tabClaim) sfhEls.tabClaim.setAttribute('data-active', t === 'claim' ? '1' : '0');
    if (sfhEls.tabAuto) sfhEls.tabAuto.setAttribute('data-active', t === 'auto' ? '1' : '0');
    if (sfhEls.paneClaim) sfhEls.paneClaim.setAttribute('data-active', t === 'claim' ? '1' : '0');
    if (sfhEls.paneAuto) sfhEls.paneAuto.setAttribute('data-active', t === 'auto' ? '1' : '0');

    if (t === 'auto' && sfhState.open) sfhAutoRefresh(false);

    sfhApplyPos();
    sfhSaveSettings();
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
    ball.setAttribute('title', 'Steam 自动助手：点击展开 / 折叠，可拖动');
    ball.setAttribute('data-running', '0');
    ball.textContent = '助手';

    var panel = document.createElement('div');
    panel.className = 'sfh-panel';
    panel.setAttribute('data-open', '0');
    panel.innerHTML =
      '<div class="sfh-head" data-role="head">' +
      '<span class="sfh-title">Steam 自动助手</span>' +
      '<span class="sfh-head-right">' +
      '<span class="sfh-tag" data-role="tag">就绪</span>' +
      '<button type="button" class="sfh-collapse" data-role="collapse">收起</button>' +
      '</span>' +
      '</div>' +
      '<div class="sfh-tabs" data-role="tabs">' +
      '<button type="button" class="sfh-tab" data-tab="claim" data-role="tab-claim" data-active="1">喜加一</button>' +
      '<button type="button" class="sfh-tab" data-tab="auto" data-role="tab-auto" data-active="0">自动启动</button>' +
      '</div>' +
      /* ---- 页签一：喜加一（原有界面与逻辑原样保留） ---- */
      '<div class="sfh-body sfh-pane" data-role="pane-claim" data-active="1">' +
      '<div class="sfh-scope" data-role="scope-claim" data-show="0">' +
      '<div class="sfh-scope-txt">当前在 Steam 库页面：限免查询与领取必须与商店同源，只能到商店页里进行。「自动启动」页签不受影响，可直接使用。</div>' +
      '<button type="button" class="sfh-btn sfh-open-store" data-role="open-store">打开商店页</button>' +
      '</div>' +
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
      '</div>' +
      /* ---- 页签二：自动启动（只与本地助手通信，与页签一互不干扰） ---- */
      '<div class="sfh-body sfh-pane sfh-auto" data-role="pane-auto" data-active="0">' +
      '<div class="sfh-row sfh-status">助手状态：<b data-role="helper-state">检测中…</b>' +
      '<button type="button" class="sfh-retry" data-role="helper-retry" data-show="0">重试</button>' +
      '</div>' +
      '<div class="sfh-auto-hint" data-role="helper-hint" data-bad="0">本地助手未连接。请先运行本地助手：双击 helper\\start-helper.vbs</div>' +
      '<input type="text" class="sfh-filter" data-role="game-filter" placeholder="按名称过滤游戏…">' +
      '<div class="sfh-games" data-role="game-list">' +
      '<div class="sfh-games-empty">尚未加载游戏列表</div>' +
      '</div>' +
      '<div class="sfh-cfg">' +
      '<label class="sfh-check">' +
      '<input type="checkbox" data-role="auto-start"><span>Steam 启动后自动运行勾选的游戏</span>' +
      '</label>' +
      '<div class="sfh-cfg-row"><span>启动延迟</span>' +
      '<input type="number" class="sfh-num-input" data-role="delay" min="0" max="600" step="1" value="15">' +
      '<span class="sfh-unit">秒</span></div>' +
      '<div class="sfh-cfg-row"><span>每个游戏间隔</span>' +
      '<input type="number" class="sfh-num-input" data-role="interval" min="1" max="600" step="1" value="10">' +
      '<span class="sfh-unit">秒</span></div>' +
      '</div>' +
      '<div class="sfh-row sfh-actions">' +
      '<button type="button" class="sfh-btn sfh-scan" data-role="save">保存</button>' +
      '<button type="button" class="sfh-btn sfh-neutral" data-role="rescan">重新扫描</button>' +
      '</div>' +
      '<div class="sfh-row sfh-actions">' +
      '<button type="button" class="sfh-btn sfh-launch" data-role="launch">立即启动勾选的游戏</button>' +
      '</div>' +
      '<div class="sfh-auto-msg" data-role="auto-msg">勾选游戏后点「保存」即可。</div>' +
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
      nFailed: q('failed-num'),
      /* 页签 */
      tabClaim: q('tab-claim'),
      tabAuto: q('tab-auto'),
      paneClaim: q('pane-claim'),
      paneAuto: q('pane-auto'),
      /* 页面范围提示（库页面下「喜加一」不可用的说明与跳转） */
      scopeClaim: q('scope-claim'),
      openStore: q('open-store'),
      /* 自动启动页签 */
      helperState: q('helper-state'),
      helperHint: q('helper-hint'),
      helperRetry: q('helper-retry'),
      gameFilter: q('game-filter'),
      gameList: q('game-list'),
      autoStart: q('auto-start'),
      delay: q('delay'),
      interval: q('interval'),
      save: q('save'),
      rescan: q('rescan'),
      launch: q('launch'),
      autoMsg: q('auto-msg')
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

    /* ---------- 页签切换 ---------- */
    sfhEls.tabClaim.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      sfhSetTab('claim');
    });

    sfhEls.tabAuto.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      sfhSetTab('auto');
    });

    /* ---------- 喜加一页签 ---------- */
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

    /* 库页面：一键打开商店页（优先本地助手，失败再降级到新标签页 / 文字提示） */
    if (sfhEls.openStore) {
      sfhEls.openStore.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        sfhSetProgress('正在请求打开商店页…', '');
        sfhOpenStorePage(STORE + '/');
      });
    }

    sfhEls.auto.addEventListener('change', function () {
      sfhState.autoClaim = !!sfhEls.auto.checked;
      sfhSaveSettings();
    });

    /* ---------- 自动启动页签 ---------- */
    sfhEls.helperRetry.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      sfhAutoRefresh(true);
    });

    sfhEls.gameFilter.addEventListener('input', function () {
      sfhAutoState.filter = sfhEls.gameFilter.value || '';
      sfhAutoRenderGames();
    });

    sfhEls.save.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      sfhAutoSave();
    });

    sfhEls.rescan.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      sfhAutoRescan();
    });

    sfhEls.launch.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      sfhAutoLaunch();
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

  /* ---------------------- SPA 路由适配（库视图切页不重新加载文档） ---------------------- */

  var __sfhLastHref = '';
  var __sfhLastEnv = '';

  /* 保证宿主节点始终挂在 body 上：SPA 切页若重建 body，这里把它补回去（单实例，不重复创建） */
  function sfhEnsureMounted() {
    if (!sfhEls.host) return;
    var target = document.body || document.documentElement;
    if (!target) return;
    if (sfhEls.host.parentNode === target && sfhEls.host.isConnected !== false) return;
    try {
      target.appendChild(sfhEls.host);
      sfhApplyPos();
    } catch (e) {
      /* ignore */
    }
  }

  /* 路由或页面环境变化时的轻量同步：只做范围判定与状态文案，不重建 DOM */
  function sfhSyncScope(force) {
    var href = '';
    try {
      href = String(window.location.href || '');
    } catch (e) {
      href = '';
    }
    var env = sfhPageEnv();
    var envChanged = env !== __sfhLastEnv;
    var changed = !!force || envChanged || href !== __sfhLastHref;
    __sfhLastHref = href;
    __sfhLastEnv = env;
    /* 无论是否变化都补挂一次，保证切页后宿主节点还在（幂等，不会重复创建） */
    sfhEnsureMounted();
    if (!changed || !sfhState.ready) return;

    var store = sfhApplyScope();
    /* 正在扫描时不动进度文案，避免覆盖扫描进度 */
    if (!sfhState.busy) {
      sfhSetProgress(
        store
          ? '点击「扫描限免」开始检索'
          : '库页面可用「自动启动」；「喜加一」请点上方按钮到商店页进行。',
        ''
      );
    }
    if (store) {
      if (envChanged) sfhRefreshLogin(true);
    } else if (sfhEls.login) {
      sfhEls.login.textContent = '需在商店页';
      sfhEls.login.className = 'sfh-warn';
    }
  }

  function sfhWatchRoute() {
    /* history 路由（pushState / replaceState） */
    ['pushState', 'replaceState'].forEach(function (name) {
      var orig = window.history && window.history[name];
      if (typeof orig !== 'function') return;
      window.history[name] = function () {
        var r = orig.apply(this, arguments);
        try {
          setTimeout(function () {
            sfhSyncScope(false);
          }, 0);
        } catch (e) {
          /* ignore */
        }
        return r;
      };
    });

    window.addEventListener('popstate', function () {
      sfhSyncScope(false);
    });
    window.addEventListener('hashchange', function () {
      sfhSyncScope(false);
    });

    /* Steam 库视图的路由可能由自有路由表驱动、不走 history，用低频轮询兜底 */
    setInterval(function () {
      sfhSyncScope(false);
    }, 1500);

    /* body 被 Steam 重建时自动补挂（只观察根节点，开销极小） */
    try {
      var mo = new MutationObserver(function () {
        sfhEnsureMounted();
      });
      mo.observe(document.documentElement, { childList: true });
    } catch (e) {
      /* ignore */
    }
  }

  /* 挂载闸门：只有能确证是隐藏壳页才永久放弃；判据不确定一律挂载。
     __sfhGiveUp     —— 永久放弃（仅隐藏壳页会置位，置位后不再尝试）
     __sfhForceMount —— 本次允许无视可见性判据强制挂载
     __sfhForced     —— 本文档已用过强制挂载（避免反复自检-重挂打转） */
  var __sfhGiveUp = false;
  var __sfhWaitTimer = null;
  var __sfhForceMount = false;
  var __sfhForced = false;

  /* 挂载后自检（先挂后判）：确证是隐藏壳页、或确证没有任何渲染内容，才把球移除。
     移除后不置 __sfhGiveUp，改为重新待命——文档真正可见时会再挂回来。 */
  function sfhDropHost() {
    try {
      if (sfhEls.host && sfhEls.host.parentNode) {
        sfhEls.host.parentNode.removeChild(sfhEls.host);
      }
    } catch (e) {
      /* ignore */
    }
    try {
      if (sfhEls.host && sfhEls.host.remove) sfhEls.host.remove();
    } catch (e) {
      /* ignore */
    }
    sfhEls.host = null;
    sfhState.ready = false;
  }

  /* 壳页判定走「连续确认」而不是一次判死：文档刚注入时 body 往往还没渲染完，
     一次判定就置 __sfhGiveUp 会把后来才渲染出库 UI 的 SharedJSContext 文档永久判死。
     连续 SFH_SHELL_CONFIRM_CHECKS 次确证无渲染内容才放弃；中途一旦出现渲染内容立即转为挂载。 */
  var __sfhShellChecks = 0;
  var __sfhShellTimer = null;

  function sfhStopShellProbe() {
    if (__sfhShellTimer) {
      clearInterval(__sfhShellTimer);
      __sfhShellTimer = null;
    }
  }

  function sfhShellGiveUpFlow() {
    if (__sfhGiveUp || sfhState.ready || __sfhShellTimer) return;
    __sfhShellChecks = 0;

    function probe() {
      if (__sfhGiveUp || sfhState.ready) {
        sfhStopShellProbe();
        return;
      }
      if (!sfhIsHiddenShell()) {
        /* 已有渲染内容（例如库 UI 渲染完成）→ 立刻转为挂载 */
        sfhStopShellProbe();
        __sfhShellChecks = 0;
        sfhInit();
        return;
      }
      __sfhShellChecks++;
      if (__sfhShellChecks >= SFH_SHELL_CONFIRM_CHECKS) {
        __sfhGiveUp = true;
        sfhStopShellProbe();
      }
    }

    __sfhShellTimer = setInterval(probe, SFH_SHELL_RECHECK_GAP);
    probe();
  }

  /* 挂载后自检（先挂后判）：只有「确证 body 无渲染内容」并且「连续观察到一段时间仍如此」
     才把球移除，绝不因为「body 空 + 尺寸读 0 + visibilityState hidden」单次成立就删球。
     原则：宁可多挂一个球，也不要出现完全没有球可用的情况。 */
  var __sfhEmptyChecks = 0;

  function sfhSelfCheck() {
    if (!sfhEls.host || !sfhState.ready) return;
    __sfhEmptyChecks = 0;
    sfhSelfCheckStep(0);
  }

  function sfhSelfCheckStep(round) {
    if (!sfhEls.host || !sfhState.ready) return;
    /* body 有渲染内容 → 这是可见文档（含库页面的 SharedJSContext 文档），永不删除 */
    if (sfhHasRenderableContent()) {
      __sfhEmptyChecks = 0;
      return;
    }
    /* data: 文档的尺寸与可见性不可读，不能据此判它看不见，直接保留球 */
    if (sfhIsDataDoc()) return;
    if (!sfhIsHiddenShell() && !sfhConfirmUnrendered()) {
      __sfhEmptyChecks = 0;
      return;
    }
    __sfhEmptyChecks = round + 1;
    if (__sfhEmptyChecks < SFH_SHELL_CONFIRM_CHECKS) {
      try {
        setTimeout(function () {
          sfhSelfCheckStep(round + 1);
        }, SFH_SHELL_RECHECK_GAP);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    /* 连续多次确证无渲染内容 → 才允许移除；壳页则同时永久放弃 */
    var shell = sfhIsHiddenShell();
    sfhDropHost();
    sfhStopShellProbe();
    __sfhEmptyChecks = 0;
    if (shell) {
      __sfhGiveUp = true;
      return;
    }
    __sfhForceMount = false;
    sfhWaitVisible();
  }

  /* 挂载后短延时自检两次，给 Steam 渲染库 UI 留出时间，避免抢跑误删 */
  function sfhScheduleSelfCheck() {
    var delays = [SFH_SHELL_PROBE_DELAY, SFH_SHELL_PROBE_DELAY * 2];
    for (var i = 0; i < delays.length; i++) {
      try {
        setTimeout(sfhSelfCheck, delays[i]);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /* 文档暂不可挂载时轮询等待（同时挂 visibilitychange / resize 事件加速）；
     一旦判据变为可挂载立即挂载；等满 SFH_VISIBLE_TIMEOUT 仍不可挂载则强制挂载一次。 */
  function sfhWaitVisible() {
    if (__sfhWaitTimer || sfhState.ready || __sfhGiveUp) return;
    var t0 = Date.now();

    function stop() {
      if (__sfhWaitTimer) {
        clearInterval(__sfhWaitTimer);
        __sfhWaitTimer = null;
      }
    }

    function tick() {
      if (sfhState.ready || __sfhGiveUp) {
        stop();
        return;
      }
      if (sfhIsHiddenShell()) {
        /* 不一次判死：交给连续确认流程，中途渲染出内容会自动转为挂载 */
        stop();
        sfhShellGiveUpFlow();
        return;
      }
      if (sfhIsDocVisible()) {
        stop();
        sfhInit();
        return;
      }
      /* 判据一直不确定：超时后强制挂载一次，先保证用户有入口。
         例外：无渲染内容的 data: 文档（Steam 库视图的主文档）不强制挂载——
         它的尺寸/可见性全部不可读，挂上去只会成为第二颗幽灵球。 */
      if (!__sfhForced && Date.now() - t0 > SFH_VISIBLE_TIMEOUT) {
        __sfhForced = true;
        if (sfhIsDataDoc() && !sfhHasRenderableContent()) return;
        __sfhForceMount = true;
        stop();
        sfhInit();
      }
    }

    __sfhWaitTimer = setInterval(tick, 400);
    try {
      document.addEventListener('visibilitychange', tick, true);
      window.addEventListener('resize', tick);
    } catch (e) {
      /* ignore */
    }
    tick();
  }

  function sfhInit() {
    if (sfhState.ready) return;
    if (__sfhGiveUp) return;
    /* Steam 的隐藏壳页（steamloopback.host/index.html 且 body 真的什么都没有）：不当场判死，
       走连续确认——库 UI 其实是渲染在同一个 SharedJSContext 文档里的，等它渲染出来就转挂载 */
    if (sfhIsHiddenShell()) {
      sfhShellGiveUpFlow();
      return;
    }
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', sfhInit, { once: true });
      return;
    }
    if (sfhEls.host) return;
    /* 先挂后判：判据不确定时也先挂上（宁可多挂一个球，也不让用户没有入口）。
       仅当「确证看不见」时才短暂等待，等满超时后仍会强制挂载一次。 */
    if (!sfhIsDocVisible() && !__sfhForceMount) {
      sfhWaitVisible();
      return;
    }

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
      /* 保留用户保存的位置，但先做一次合法性校验：
         被钳到左上死角（如隐藏文档算出的 (31,31)）时回落默认右下角 */
      sfhState.x = s.x;
      sfhState.y = s.y;
      sfhSanitizePos();
    } else {
      var d = sfhDefaultPos();
      sfhState.x = d.x;
      sfhState.y = d.y;
    }

    sfhApplyPos();
    sfhApplyScope();
    sfhRefreshLogin(true);
    sfhSetProgress(
      sfhIsStorePage()
        ? '点击「扫描限免」开始检索'
        : '库页面可用「自动启动」；「喜加一」请点上方按钮到商店页进行。',
      ''
    );
    if (s.open) sfhSetOpen(true);
    sfhSetTab(s.tab);

    /* 先挂后判的第二半：挂上之后才自检，确证无渲染才自我移除 */
    sfhScheduleSelfCheck();

    /* 视口尺寸变化：重新钳制到合法区域后再落位，避免球落到视口外或压住菜单 */
    function sfhOnViewportChange() {
      if (!sfhState.ready) {
        if (!__sfhGiveUp) sfhInit();
        return;
      }
      sfhSanitizePos();
      sfhApplyPos();
    }

    window.addEventListener('resize', sfhOnViewportChange);
    window.addEventListener('orientationchange', sfhOnViewportChange);

    /* 文档从隐藏恢复（如从隐藏壳页误判中恢复、窗口重新可见）：补挂 + 重新钳制 */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') return;
      sfhEnsureMounted();
      sfhSanitizePos();
      sfhApplyPos();
    });

    /* 库页面是 SPA：适配路由切换并保持单实例 */
    sfhWatchRoute();
    __sfhLastEnv = sfhPageEnv();
    try {
      __sfhLastHref = String(window.location.href || '');
    } catch (e) {
      __sfhLastHref = '';
    }
  }

  sfhInit();
})();
