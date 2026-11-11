/* Steam 喜加一助手 — 弹窗逻辑 */

const $ = (id) => document.getElementById(id);

const STATUS_TEXT = {
  claimed: '已入库',
  owned: '已拥有',
  failed: '失败',
  need_base: '需本体',
  region_locked: '区域限制',
  error: '请求异常',
  pending: '待领取'
};

let state = { running: false };

/* ------------------------------------------------------------------ */

async function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (res) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(res);
    });
  });
}

function fmtTime(ts) {
  if (!ts) return '尚未运行';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `上次运行 ${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function renderLogin(loggedIn, running) {
  const el = $('loginBadge');
  el.className = 'badge';
  if (running) {
    el.textContent = '运行中';
    el.classList.add('idle');
  } else if (loggedIn) {
    el.textContent = '已登录';
  } else {
    el.textContent = '未登录';
    el.classList.add('error');
  }
}

function renderProgress(progress, running) {
  const wrap = $('progressWrap');
  if (!running) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  $('progressText').textContent = (progress && progress.text) || '准备中…';

  const fill = $('barFill');
  if (progress && progress.phase === 'search') fill.style.width = '25%';
  else if (progress && progress.phase === 'library') fill.style.width = '45%';
  else fill.style.width = '70%';
}

function renderReport(report) {
  const summary = $('summary');
  const list = $('list');
  list.innerHTML = '';

  if (!report) {
    summary.classList.add('hidden');
    list.innerHTML = '<li class="empty">尚未扫描，点击「扫描限免」开始</li>';
    return;
  }

  if (report.error && !(report.claimed || []).length && !(report.candidates || []).length) {
    summary.classList.add('hidden');
    list.innerHTML = `<li class="empty">${escapeHtml(report.error)}</li>`;
    return;
  }

  summary.classList.remove('hidden');
  summary.innerHTML = `
    <span>新增入库 <b>${(report.claimed || []).length}</b></span>
    <span>待领 <b>${(report.candidates || []).length - (report.claimed || []).length}</b></span>
    <span>已拥有 <b>${(report.alreadyOwned || []).length}</b></span>
  `;

  const rows = [];

  for (const it of report.claimed || []) {
    rows.push({ cls: 'claimed', name: it.title, tag: STATUS_TEXT.claimed });
  }
  for (const it of report.candidates || []) {
    if ((report.claimed || []).some((c) => c.appid === it.appid)) continue;
    rows.push({ cls: 'pending', name: it.title, tag: STATUS_TEXT.pending });
  }
  for (const it of report.failed || []) {
    rows.push({ cls: 'failed', name: it.title, tag: it.message || STATUS_TEXT[it.status] || '失败' });
  }
  for (const it of report.alreadyOwned || []) {
    rows.push({ cls: 'owned', name: it.title, tag: STATUS_TEXT.owned });
  }

  if (!rows.length) {
    list.innerHTML = '<li class="empty">当前没有可领取的限免条目</li>';
    return;
  }

  for (const r of rows) {
    const li = document.createElement('li');
    li.className = r.cls;
    li.innerHTML = `
      <i class="dot"></i>
      <span class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
      <span class="tag">${escapeHtml(r.tag)}</span>
    `;
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

/* ------------------------------------------------------------------ */
/* 刷新                                                                */
/* ------------------------------------------------------------------ */

async function refresh() {
  const res = await send('GET_STATE');
  if (!res) return;

  state.running = !!res.running;
  $('autoClaim').checked = !!res.settings.autoClaim;
  $('scanBtn').disabled = state.running;
  $('stopBtn').disabled = !state.running;
  $('lastRun').textContent = fmtTime(res.lastRunAt);

  renderProgress(res.progress, res.running);
  renderReport(res.lastReport);

  // 登录态由页面侧判定，这里用报告兜底
  const loggedIn = res.lastReport ? res.lastReport.loggedIn !== false : true;
  renderLogin(loggedIn, res.running);
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

$('scanBtn').addEventListener('click', async () => {
  $('scanBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('progressWrap').classList.remove('hidden');
  $('progressText').textContent = '正在启动…';
  await send('START_SCAN');
  pollUntilDone();
});

$('stopBtn').addEventListener('click', async () => {
  await send('CANCEL_SCAN');
});

$('autoClaim').addEventListener('change', async (e) => {
  await send('SAVE_SETTINGS', { patch: { autoClaim: e.target.checked } });
});

$('optionsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

/* 扫描期间轮询进度 */
let pollTimer = null;

function pollUntilDone() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await refresh();
    if (!state.running) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 1000);
}

/* 后台推送的进度变化 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.progress) {
    renderProgress(changes.progress.newValue, true);
  }
});

/* 启动 */
refresh();
pollUntilDone();
