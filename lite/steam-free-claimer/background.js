/**
 * Steam 喜加一助手 — 后台调度
 *
 * 职责：查找/拉起商店标签页 → 向 content.js 下发扫描任务 → 持久化报告 → 每日定时。
 * 实际网络请求全部在 content.js（页面同源上下文）中完成。
 */

const STORE_ORIGIN = 'https://store.steampowered.com';

const DEFAULT_SETTINGS = {
  autoClaim: false,   // 默认关闭：只生成报告，不真正领取
  dailyScan: true,
  dailyHour: 10,
  minDelay: 3000,
  maxDelay: 9000,
  blacklist: []
};

const ALARM_DAILY = 'steam-free-daily-scan';

/* ------------------------------------------------------------------ */
/* 设置读写                                                            */
/* ------------------------------------------------------------------ */

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
}

async function saveSettings(patch) {
  const next = Object.assign(await getSettings(), patch);
  await chrome.storage.local.set({ settings: next });
  await scheduleDaily(next);
  return next;
}

/* ------------------------------------------------------------------ */
/* 定时任务                                                            */
/* ------------------------------------------------------------------ */

async function scheduleDaily(settings) {
  await chrome.alarms.clear(ALARM_DAILY);
  if (!settings.dailyScan) return;

  const now = new Date();
  const next = new Date();
  next.setHours(settings.dailyHour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  chrome.alarms.create(ALARM_DAILY, {
    when: next.getTime(),
    periodInMinutes: 60 * 24
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_DAILY) return;
  try {
    await runScan({ triggeredBy: 'alarm' });
  } catch (e) {
    console.warn('[喜加一] 定时扫描失败：', e);
  }
});

/* ------------------------------------------------------------------ */
/* 标签页管理                                                          */
/* ------------------------------------------------------------------ */

async function findStoreTab() {
  const tabs = await chrome.tabs.query({ url: STORE_ORIGIN + '/*' });
  if (!tabs.length) return null;
  return tabs.find((t) => t.status === 'complete') || tabs[0];
}

async function createStoreTab() {
  const tab = await chrome.tabs.create({ url: STORE_ORIGIN + '/', active: false });

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, 25000);
  });

  // 给 steamwebhelper 一点时间完成 cookie 与 JS 环境初始化
  await new Promise((r) => setTimeout(r, 1200));
  return tab;
}

async function ensureStoreTab() {
  const existing = await findStoreTab();
  if (existing) return { tab: existing, created: false };
  const tab = await createStoreTab();
  return { tab, created: true };
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // content script 尚未注入（常见于刚创建的标签页），手动补注入后重试
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 300));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

let running = false;

async function runScan({ triggeredBy = 'manual' } = {}) {
  if (running) {
    return { ok: false, error: '已有扫描任务在执行中' };
  }
  running = true;

  const settings = await getSettings();
  await chrome.storage.session.set({
    progress: { phase: 'start', text: '准备中…', at: Date.now() },
    running: true
  });

  let createdTabId = null;

  try {
    const { tab, created } = await ensureStoreTab();
    if (created) createdTabId = tab.id;

    const res = await sendToTab(tab.id, {
      type: 'RUN_SCAN',
      options: {
        autoClaim: settings.autoClaim,
        blacklist: settings.blacklist,
        minDelay: settings.minDelay,
        maxDelay: settings.maxDelay
      }
    });

    if (res && res.report) {
      await chrome.storage.local.set({
        lastReport: res.report,
        lastRunAt: Date.now(),
        lastTrigger: triggeredBy
      });
      await updateBadge(res.report);
    }

    return res || { ok: false, error: '无响应' };
  } catch (e) {
    const report = {
      startedAt: Date.now(),
      finishedAt: Date.now(),
      error: '任务失败：' + String(e),
      claimed: [],
      alreadyOwned: [],
      skipped: [],
      failed: [],
      candidates: []
    };
    await chrome.storage.local.set({ lastReport: report, lastRunAt: Date.now() });
    await updateBadge(report);
    return { ok: false, error: String(e), report };
  } finally {
    running = false;
    await chrome.storage.session.set({ running: false });
    if (createdTabId !== null) {
      chrome.tabs.remove(createdTabId).catch(() => {});
    }
  }
}

async function updateBadge(report) {
  try {
    if (!report) return;
    if (report.claimed && report.claimed.length) {
      await chrome.action.setBadgeText({ text: String(report.claimed.length) });
      await chrome.action.setBadgeBackgroundColor({ color: '#4c6b22' });
    } else if (report.candidates && report.candidates.length) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#c77e17' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'SCAN_PROGRESS') {
    chrome.storage.session.set({ progress: msg.progress });
    return false;
  }

  if (msg.type === 'SCAN_DONE') {
    chrome.storage.local.set({ lastReport: msg.report, lastRunAt: Date.now() });
    updateBadge(msg.report);
    return false;
  }

  if (msg.type === 'START_SCAN') {
    runScan({ triggeredBy: 'manual' }).then(sendResponse);
    return true;
  }

  if (msg.type === 'CANCEL_SCAN') {
    ensureStoreTab()
      .then(({ tab }) => sendToTab(tab.id, { type: 'CANCEL_SCAN' }))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'GET_STATE') {
    Promise.all([
      getSettings(),
      chrome.storage.local.get(['lastReport', 'lastRunAt']),
      chrome.storage.session.get(['progress', 'running'])
    ]).then(([settings, local, session]) => {
      sendResponse({
        settings,
        lastReport: local.lastReport || null,
        lastRunAt: local.lastRunAt || null,
        progress: session.progress || null,
        running: !!session.running
      });
    });
    return true;
  }

  if (msg.type === 'SAVE_SETTINGS') {
    saveSettings(msg.patch || {}).then((next) => sendResponse({ ok: true, settings: next }));
    return true;
  }

  if (msg.type === 'OPEN_STORE') {
    const url = msg.url || STORE_ORIGIN + '/';
    chrome.tabs.create({ url }).then((tab) => sendResponse({ ok: true, tabId: tab.id }));
    return true;
  }
});

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await scheduleDaily(settings);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await scheduleDaily(settings);
});
