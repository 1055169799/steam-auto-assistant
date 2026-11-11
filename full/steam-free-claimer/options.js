/* Steam 喜加一助手 — 设置页逻辑 */

const $ = (id) => document.getElementById(id);

function send(type, payload) {
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

async function load() {
  const res = await send('GET_STATE');
  if (!res) return;
  const s = res.settings;

  $('autoClaim').checked = !!s.autoClaim;
  $('dailyScan').checked = !!s.dailyScan;
  $('dailyHour').value = s.dailyHour;
  $('minDelay').value = Math.round((s.minDelay || 3000) / 1000);
  $('maxDelay').value = Math.round((s.maxDelay || 9000) / 1000);
  $('blacklist').value = (s.blacklist || []).join('\n');
}

async function save() {
  let minDelay = Math.max(1, Number($('minDelay').value) || 3) * 1000;
  let maxDelay = Math.max(1, Number($('maxDelay').value) || 9) * 1000;
  if (maxDelay < minDelay) [minDelay, maxDelay] = [maxDelay, minDelay];

  let hour = Number($('dailyHour').value);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) hour = 10;

  const blacklist = $('blacklist')
    .value.split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  await send('SAVE_SETTINGS', {
    patch: {
      autoClaim: $('autoClaim').checked,
      dailyScan: $('dailyScan').checked,
      dailyHour: hour,
      minDelay,
      maxDelay,
      blacklist
    }
  });

  const tip = $('savedTip');
  tip.classList.add('show');
  setTimeout(() => tip.classList.remove('show'), 1600);
}

$('saveBtn').addEventListener('click', save);

load();
