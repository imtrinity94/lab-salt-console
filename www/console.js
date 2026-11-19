'use strict';
// console.js - client for the console service on the master (/console-api/, server/console_api.py): shared saved targets
// and jobs, presence, notifications, audit log, console schedules with Upcoming, dashboard metrics and the Activity Origin
// column. When the service is down, everything that talks straight to Salt keeps working and these parts say so.
const CAPI = '/console-api';
const SHARED = { targets: [], jobs: [], ver: { targets: 0, jobs: 0 }, presence: null, settings: null, ok: null };
const TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
let ctoken = sess.get('ctoken');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const when = t => t ? new Date(t * 1000).toLocaleString() : '';
function ago(t) {
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
}
const toLocalInput = t => { if (!t) return ''; const d = new Date(t * 1000), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
const fromLocalInput = v => v ? Math.floor(new Date(v).getTime() / 1000) : null;

async function capi(method, path, body) {
  if (DEMO) return demoCapi(method, path, body);
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (ctoken && path !== '/login') h['X-Auth-Token'] = ctoken;
  let r;
  try { r = await fetch(CAPI + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { SHARED.ok = false; throw new Error('The console service on the master cannot be reached.'); }
  if (r.status >= 502 && r.status <= 504) { SHARED.ok = false; throw new Error('The console service on the master is not running (HTTP ' + r.status + ').'); }
  let j = null;
  try { j = await r.json(); } catch (e) { /* no JSON body */ }
  if (r.status === 401 && path !== '/login') {
    if (ctoken) { logout(); throw new Error('Session expired. Log in again.'); }
    SHARED.ok = false;
    throw new Error('Not logged in to the console service. Log out and log in again.');
  }
  SHARED.ok = true;
  if (!r.ok) { const err = new Error((j && j.error) || 'The console service returned HTTP ' + r.status + '.'); err.status = r.status; throw err; }
  return j;
}
const svcNote = () => SHARED.ok === false ? '<div class="alert">The console service on the master is not reachable, so saved targets, saved jobs, schedules, presence history and notifications are unavailable. Everything that talks straight to Salt still works.</div>' : '';

// One login form signs in to both: salt-api returns a web session id, the console service returns a Salt eauth token.
(function () {
  const send = raw, out = logout;
  raw = async function (path, body) {
    const r = await send(path, body);
    if (path === '/login' && !DEMO) {
      try { ctoken = (await capi('POST', '/login', { username: body.username, password: body.password, eauth: body.eauth || 'pam' })).token; }
      catch (e) { ctoken = null; toast('Logged in to Salt, but not to the console service: ' + e.message, 'error'); }
      sess.set('ctoken', ctoken);
    }
    return r;
  };
  logout = function () {
    if (ctoken && !DEMO) fetch(CAPI + '/logout', { method: 'POST', headers: { 'X-Auth-Token': ctoken } }).catch(() => {});
    ctoken = null;
    sess.set('ctoken', null);
    return out();
  };
})();

// ---------- shared saved targets and jobs (replaces the per-browser lists) ----------
const baseGet = store.get, baseSet = store.set;
let pendingWrite = Promise.resolve();
async function loadShared() {
  const r = await Promise.all([capi('GET', '/shared/targets'), capi('GET', '/shared/jobs'), capi('GET', '/presence'), capi('GET', '/settings')]);
  SHARED.targets = r[0].items; SHARED.ver.targets = r[0].version;
  SHARED.jobs = r[1].items; SHARED.ver.jobs = r[1].version;
  SHARED.presence = r[2]; SHARED.settings = r[3];
}
function upgradeJob(j) {
  if (j.command) return j;
  const a = parseArgs(j.args), s = v => typeof v === 'string' ? v : JSON.stringify(v);
  return Object.assign({}, j, { command: 'salt', args: a.arg.map(s).concat(Object.keys(a.kwarg).map(k => k + '=' + s(a.kwarg[k]))).join('\n') });
}
function importLocal() {
  if (DEMO) return;
  ['targets', 'jobs'].forEach(k => {
    const mine = baseGet(k, []);
    if (!Array.isArray(mine) || !mine.length || baseGet('imported.' + k, false)) return;
    const have = SHARED[k].map(x => x.name), add = mine.filter(x => x && x.name && have.indexOf(x.name) < 0).map(x => k === 'jobs' ? upgradeJob(x) : x);
    baseSet('imported.' + k, true);
    if (add.length) { store.set(k, SHARED[k].concat(add)); toast(plural(add.length, k === 'jobs' ? 'saved job' : 'saved target') + ' from this browser moved to the master.'); }
  });
}
async function refreshShared() {
  try { await pendingWrite; } catch (e) { /* reported when it failed */ }
  if (!ctoken && !DEMO) { SHARED.ok = false; return; }
  try { await loadShared(); importLocal(); } catch (e) { /* pages show svcNote() */ }
}
store.get = (k, d) => (k === 'targets' || k === 'jobs') ? SHARED[k].map(x => Object.assign({}, x)) : baseGet(k, d);
store.set = (k, v) => {
  if (k !== 'targets' && k !== 'jobs') return baseSet(k, v);
  const items = v.map(x => Object.assign({}, x, k === 'jobs' && !x.id ? { id: uid() } : {}));
  SHARED[k] = items;
  pendingWrite = pendingWrite.catch(() => {}).then(async () => {
    try { const r = await capi('PUT', '/shared/' + k, { version: SHARED.ver[k], items: items }); SHARED.ver[k] = r.version; SHARED[k] = r.items; }
    catch (e) {
      toast(e.status === 409 ? 'The saved ' + k + ' were changed from another browser, so this change was not saved. The list was reloaded; please repeat the change.' : 'Could not save the ' + k + ': ' + e.message, 'error');
      try { await loadShared(); } catch (x) { /* already reported */ }
      route();
    }
  });
};

// Every page load first refreshes the shared lists and presence, so all browsers see the same data.
(function () {
  const base = route;
  window.removeEventListener('hashchange', base);
  route = async function () {
    bellOpen = false;
    if (token) { await refreshShared(); bellRefresh(); }
    return base();
  };
  window.addEventListener('hashchange', route);
})();
['targets', 'jobs'].forEach(n => { const base = routes[n]; routes[n] = async a => svcNote() + await base(a); });

async function jobOrigins(jids) {
  if (!jids.length) return {};
  try { return await capi('POST', '/origins', { jids: jids }); } catch (e) { return {}; }
}

// ---------- notifications ----------
const BELL_SVG = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M8 1.8a4 4 0 0 0-4 4v2.6L2.6 11h10.8L12 8.4V5.8a4 4 0 0 0-4-4z"/><path d="M6.4 12.8a1.7 1.7 0 0 0 3.2 0"/></svg>';
let NOTES = null, bellOpen = false;
function drawBell() {
  const slot = $('#bellSlot');
  if (!slot) return;
  if (!NOTES) { slot.innerHTML = ''; return; }
  const n = NOTES;
  const list = n.items.length ? n.items.map(x => `<button class="nitem${x.read ? '' : ' unread'}" data-act="noteopen" data-id="${x.id}" data-link="${esc(x.link || '')}"><span>${esc(x.text)}</span><small>${esc(ago(x.ts))}</small></button>`).join('') : '<div class="muted" style="padding:10px 14px">No notifications.</div>';
  slot.innerHTML = `<span class="rel"><button class="hb" data-act="bell" aria-haspopup="true" aria-label="Notifications${n.unread ? ', ' + n.unread + ' unread' : ''}">${BELL_SVG}${n.unread ? `<span class="bcount">${n.unread > 99 ? '99+' : n.unread}</span>` : ''}</button><div class="pop right notes" id="bellPop"${bellOpen ? '' : ' hidden'}><div class="nhead"><b>Notifications</b>${n.unread ? '<button class="link-act" data-act="notesread">MARK ALL READ</button>' : ''}</div>${list}</div></span>`;
}
async function bellRefresh() {
  if (!token || (!ctoken && !DEMO)) { NOTES = null; drawBell(); return; }
  try { NOTES = await capi('GET', '/notifications?limit=20'); } catch (e) { /* keep the last list */ }
  drawBell();
}
acts.bell = () => { bellOpen = !bellOpen; drawBell(); if (bellOpen) bellRefresh(); };
acts.notesread = async () => { NOTES = await capi('POST', '/notifications/read', { all: true }); drawBell(); };
acts.noteopen = async d => {
  bellOpen = false;
  try { NOTES = await capi('POST', '/notifications/read', { ids: [+d.id] }); } catch (e) { /* still open the link */ }
  drawBell();
  if (d.link) location.hash = d.link;
};
// Redrawing the bell detaches the clicked button, so the bell button itself is recognised by its own attribute.
document.addEventListener('click', e => { if (bellOpen && !e.target.closest('#bellSlot') && !e.target.closest('[data-act=bell]')) { bellOpen = false; drawBell(); } });
setInterval(() => { if (!document.hidden) bellRefresh(); }, 60000);

// ---------- dashboard metrics ----------
let lastMetrics = null;
function lineChart(m, series) {
  const W = 760, H = 190, L = 40, R = 14, T = 12, B = 26, n = series[0].values.length, vals = [0];
  series.forEach(s => s.values.forEach(v => { if (v != null) vals.push(v); }));
  const max = Math.max(1, Math.max.apply(null, vals));
  const x = i => L + i * (W - L - R) / Math.max(1, n - 1), y = v => T + (1 - v / max) * (H - T - B);
  const tm = i => new Date((m.start + i * m.step) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const path = s => { let d = '', pen = false; s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); pen = true; }); return d; };
  const dots = s => s.values.map((v, i) => v == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${s.color}"><title>${esc(s.name)}: ${v} (from ${tm(i)})</title></circle>`).join('');
  const grid = [0, 0.5, 1].map(f => { const v = Math.round(max * f); return `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e3e3e3"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#777">${v}</text>`; }).join('');
  const xt = [0, Math.floor((n - 1) / 2), n - 1].map(i => `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" font-size="11" fill="#777">${tm(i)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="${esc(series.map(s => s.name).join(', '))}">${grid}${xt}${series.map(s => `<path d="${path(s)}" fill="none" stroke="${s.color}" stroke-width="2"/>${dots(s)}`).join('')}</svg><div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}
// Stacked bars for counts per time bucket; drawn wide because it spans the full content width.
function barChart(m, series) {
  const W = 1560, H = 200, L = 40, R = 14, T = 12, B = 26, n = series[0].values.length;
  const tot = i => series.reduce((a, s) => a + (s.values[i] || 0), 0);
  let max = 1;
  for (let i = 0; i < n; i++) max = Math.max(max, tot(i));
  const bw = (W - L - R) / n, y = v => T + (1 - v / max) * (H - T - B);
  const tm = i => new Date((m.start + i * m.step) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let bars = '';
  for (let i = 0; i < n; i++) {
    let base = 0;
    series.forEach(s => {
      const v = s.values[i] || 0;
      if (!v) return;
      bars += `<rect x="${(L + i * bw + 2).toFixed(1)}" width="${Math.max(1, bw - 4).toFixed(1)}" y="${y(base + v).toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}" fill="${s.color}"><title>${esc(s.name)}: ${v} (from ${tm(i)})</title></rect>`;
      base += v;
    });
  }
  const ticks = max <= 1 ? [0, 1] : [0, Math.round(max / 2), max];
  const grid = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e3e3e3"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#777">${v}</text>`).join('');
  const xt = [0, Math.floor(n / 2), n - 1].map(i => `<text x="${(L + (i + 0.5) * bw).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" font-size="11" fill="#777">${tm(i)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="${esc(series.map(s => s.name).join(', '))} per time period">${grid}${bars}${xt}</svg><div class="legend">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}
const ccard = (title, body, right) => `<div class="card"><div class="card-h"><span>${title}</span><span>${right || ''}</span></div>${body}</div>`;
async function dashCharts() {
  const m = lastMetrics = await capi('GET', '/metrics?hours=' + store.get('dashHours', 12));
  const range = `LAST ${plural(m.hours, 'HOUR').toUpperCase()}`;
  const sel = `<label class="inl">Range: <select data-change="dashhours" aria-label="Range">${[1, 6, 12, 24].map(h => `<option value="${h}"${h === m.hours ? ' selected' : ''}>Last ${plural(h, 'hour')}</option>`).join('')}</select></label>`;
  return `<div class="bar"><h2 style="margin:0">System activity</h2><span class="spacer"></span>${sel}<button class="btn" data-act="dlmetrics" data-fmt="csv">Download CSV</button><button class="btn" data-act="dlmetrics" data-fmt="json">Download JSON</button></div>` +
    `<div class="cards2">${ccard('SALT EVENTS', lineChart(m, [{ name: 'Events on the master event bus', color: '#0072a3', values: m.events }]), range)}${ccard('MINION PRESENCE', lineChart(m, [{ name: 'Minions connected', color: '#5eb715', values: m.presence }]), range)}</div>` +
    ccard('JOBS', barChart(m, [{ name: 'Succeeded', color: '#5eb715', values: m.jobs.ok }, { name: 'Failed', color: '#e12200', values: m.jobs.failed }, { name: 'Missed returns', color: '#c27b00', values: m.jobs.missed }, { name: 'In progress', color: '#49afd9', values: m.jobs.running }]), range) +
    `<p class="muted">Each point covers ${Math.round(m.step / 60)} minutes and shows jobs by the time they started. Recorded by the console service${m.recordingSince ? ' since ' + esc(when(m.recordingSince)) : ''}; the console's own read calls are not counted as jobs.</p>`;
}
const baseDash = routes.dashboard;
routes.dashboard = async function (arg) {
  const top = await baseDash(arg);
  let charts;
  try { charts = await dashCharts(); } catch (e) { charts = `<div class="alert">${esc(e.message)}</div>`; }
  const i = top.indexOf('<h2>Recent activity</h2>');
  return i < 0 ? top + charts : top.slice(0, i) + charts + top.slice(i);
};
acts.dashhours = v => { store.set('dashHours', +v); route(); };
acts.dlmetrics = d => {
  const m = lastMetrics;
  if (!m) return;
  if (d.fmt === 'json') { download('metrics.json', JSON.stringify(m, null, 2)); return; }
  const rows = m.events.map((e, i) => [new Date((m.start + i * m.step) * 1000).toISOString(), e, m.presence[i] == null ? '' : m.presence[i], m.jobs.ok[i], m.jobs.failed[i], m.jobs.missed[i], m.jobs.running[i]].join(','));
  download('metrics.csv', ['bucketStart,events,minionsConnected,jobsSucceeded,jobsFailed,jobsMissedReturns,jobsInProgress'].concat(rows).join('\r\n'), 'text/csv');
};

// ---------- console schedules ----------
let SCHEDS = [];
const everyTxt = sec => sec % 86400 === 0 ? 'every ' + plural(sec / 86400, 'day') : sec % 3600 === 0 ? 'every ' + plural(sec / 3600, 'hour') : 'every ' + plural(Math.round(sec / 60), 'minute');
const schedWhen = s => s.type === 'recurring' ? everyTxt(s.every) + (s.start ? ', from ' + when(s.start) : '') + (s.end ? ', until ' + when(s.end) : '') : s.type === 'once' ? 'once, ' + when(s.at) : 'cron ' + s.cron + ' (' + s.tz + ')';
const schedHead = tab => '<h1>Schedules</h1>' + tabs([['#/schedules', 'Console schedules', tab === 'console'], ['#/schedules/minion', 'Minion schedules', tab === 'minion']]);
routes.schedules = async function (arg) {
  if (arg === 'minion') return schedHead('minion') + (await pgSchedules()).replace('<h1>Schedules</h1>', '');
  if (arg === 'new' || /^edit:/.test(arg || '')) return schedForm(arg === 'new' ? null : arg.slice(5));
  SCHEDS = (await capi('GET', '/schedules')).items;
  const last = s => s.lastError ? `<span class="pill bad" title="${esc(s.lastError)}">Not run</span> ${esc(when(s.lastRun))}` : s.lastJid ? `<a href="#/job/${esc(s.lastJid)}">${esc(when(s.lastRun))}</a>` : '';
  const next = s => !s.enabled ? '<span class="muted">disabled</span>' : s.nextRun ? esc(when(s.nextRun)) : '<span class="muted">no further runs</span>';
  return schedHead('console') + `<p class="muted">Run by the console service on the master. Times are shown in this browser's time zone (${esc(TZ)}). A schedule runs a saved job against the job's own target unless it sets one.</p><div class="bar"><a class="btn btn-primary" href="#/schedules/new">Create Schedule</a></div>` +
    table([
      { t: 'Name', f: s => `<a href="#/schedules/edit:${esc(s.id)}">${esc(s.name)}</a>` },
      { t: 'Job', f: s => s.jobName ? esc(s.jobName) + ' <span class="muted">(' + esc(s.jobFun) + ')</span>' : '<span class="pill bad">job deleted</span>' },
      { t: 'Target', f: s => esc(s.target) },
      { t: 'When', f: s => esc(schedWhen(s)) },
      { t: 'Next run', f: next, v: s => s.enabled && s.nextRun ? s.nextRun : 9e12 },
      { t: 'Last run', f: last, v: s => s.lastRun || 0 },
      { t: 'Enabled', f: s => s.enabled ? 'Yes' : 'No' }
    ], SCHEDS, 'No console schedules yet.', { key: 'scheds', menu: s => `<button data-act="schedrun" data-id="${esc(s.id)}">Run Now</button><button data-act="go" data-href="#/schedules/edit:${esc(s.id)}">Edit</button><button data-act="schedtoggle" data-id="${esc(s.id)}">${s.enabled ? 'Disable' : 'Enable'}</button><button data-act="scheddel" data-id="${esc(s.id)}">Delete</button>` });
};
async function schedForm(id) {
  if (id && !SCHEDS.some(x => x.id === id)) SCHEDS = (await capi('GET', '/schedules')).items;
  const s = id ? SCHEDS.find(x => x.id === id) : null;
  if (id && !s) return '<div class="alert">This schedule was not found. <a href="#/schedules">Back to Schedules</a></div>';
  const jobs = store.get('jobs', []), d = s || { type: 'recurring', every: 3600, enabled: true, tz: TZ, tgt: '', tt: '' };
  const unit = d.every && d.every % 86400 === 0 ? 86400 : d.every && d.every % 3600 === 0 ? 3600 : 60;
  const opt = (v, cur, label) => `<option value="${esc(v)}"${String(v) === String(cur == null ? '' : cur) ? ' selected' : ''}>${label}</option>`;
  const hid = t => d.type === t ? '' : ' hidden';
  return `<p class="crumb"><a href="#/schedules">Schedules</a> / ${s ? 'Edit Schedule' : 'Create Schedule'}</p><h1>${s ? esc(s.name) : 'Create Schedule'}</h1>` +
    (jobs.length ? '' : '<div class="note">A schedule runs a saved job. <a href="#/jobs/new">Create a job</a> first.</div>') +
    `<div id="schedForm" style="max-width:640px"><label>Name<input name="name" value="${esc(d.name || '')}"></label>` +
    `<label>Job<select name="jobId">${jobs.map(j => opt(j.id, d.jobId, esc(j.name) + ' (' + esc(j.fun) + ')')).join('')}</select></label>` +
    `<div class="row2"><label>Target type<select name="tt">${opt('', d.tt, "Job's own")}${['glob', 'list', 'grain', 'compound'].map(t => opt(t, d.tt, t)).join('')}</select></label><label>Target<input name="tgt" value="${esc(d.tgt || '')}" placeholder="empty = the job's own target"></label></div>` +
    `<label>Type<select name="type" data-change="schedtype">${opt('recurring', d.type, 'Recurring')}${opt('once', d.type, 'Once')}${opt('cron', d.type, 'Cron')}</select></label>` +
    `<div class="tf" data-tf="recurring"${hid('recurring')}><div class="row2"><label>Run every<input name="everyN" type="number" min="1" value="${esc(Math.round((d.every || 3600) / unit))}"></label><label>Unit<select name="everyU">${opt(60, unit, 'minutes')}${opt(3600, unit, 'hours')}${opt(86400, unit, 'days')}</select></label></div><div class="row2"><label>Start (optional)<input name="start" type="datetime-local" value="${toLocalInput(d.start)}"></label><label>End (optional)<input name="end" type="datetime-local" value="${toLocalInput(d.end)}"></label></div></div>` +
    `<div class="tf" data-tf="once"${hid('once')}><label>Run at<input name="at" type="datetime-local" value="${toLocalInput(d.at)}"></label></div>` +
    `<div class="tf" data-tf="cron"${hid('cron')}><label>Cron expression (minute hour day month weekday)<input name="cron" value="${esc(d.cron || '')}" placeholder="30 2 * * 1-5"></label></div>` +
    `<p class="muted">Time zone: ${esc(d.tz || TZ)}${s && s.tz !== TZ ? ' (stored with the schedule; this browser is in ' + esc(TZ) + ')' : ''}. Cron expressions are evaluated in this time zone; times are stored in UTC.</p>` +
    `<label class="chk"><input type="checkbox" name="enabled"${d.enabled ? ' checked' : ''}> Enabled</label>` +
    `<div class="bar"><button class="btn btn-primary" data-act="schedsave" data-id="${esc(id || '')}">Save</button><a class="btn" href="#/schedules">Cancel</a></div></div>`;
}
acts.schedtype = v => { $$('#schedForm .tf').forEach(el => { el.hidden = el.dataset.tf !== v; }); };
acts.schedsave = async d => {
  const f = $('#schedForm'), type = val(f, 'type'), old = d.id ? SCHEDS.find(x => x.id === d.id) : null;
  const b = { name: val(f, 'name'), jobId: val(f, 'jobId'), tt: val(f, 'tt'), tgt: val(f, 'tgt'), type: type, tz: old ? old.tz : TZ, enabled: $('[name=enabled]', f).checked };
  if (!b.tgt) b.tt = ''; else if (!b.tt) b.tt = 'glob';
  if (type === 'recurring') { b.every = Math.round(parseFloat(val(f, 'everyN')) * +val(f, 'everyU')); b.start = fromLocalInput(val(f, 'start')); b.end = fromLocalInput(val(f, 'end')); }
  else if (type === 'once') b.at = fromLocalInput(val(f, 'at'));
  else b.cron = val(f, 'cron');
  const r = d.id ? await capi('PUT', '/schedules/' + d.id, b) : await capi('POST', '/schedules', b);
  toast('Schedule ' + r.name + ' saved. ' + (r.nextRun ? 'Next run ' + when(r.nextRun) + '.' : 'No further runs.'));
  location.hash = '#/schedules';
};
acts.schedrun = async d => {
  const r = await capi('POST', '/schedules/' + d.id + '/run');
  toast('Job ' + r.jid + ' started' + (r.minions.length ? ' on ' + plural(r.minions.length, 'minion') : ' on the master') + '.');
  location.hash = '#/job/' + r.jid;
};
acts.schedtoggle = async d => {
  const s = SCHEDS.find(x => x.id === d.id);
  if (!s) return;
  await capi('PUT', '/schedules/' + d.id, Object.assign({}, s, { enabled: !s.enabled }));
  toast('Schedule ' + s.name + (s.enabled ? ' disabled.' : ' enabled.'));
  route();
};
acts.scheddel = d => {
  const s = SCHEDS.find(x => x.id === d.id);
  if (!s) return;
  modal('Delete Schedule', `<p>Delete schedule <b>${esc(s.name)}</b>? Jobs it already started are not affected.</p>`, [{ label: 'Delete', danger: true, fn: async () => { await capi('DELETE', '/schedules/' + d.id); toast('Schedule ' + s.name + ' deleted.'); route(); } }]);
};

// ---------- Activity: Upcoming ----------
addNav('Activity', '#/activity/upcoming', 'Upcoming');
const baseActivity = routes.activity;
routes.activity = async function (kind) {
  if (kind !== 'upcoming') return baseActivity(kind);
  const r = await capi('GET', '/upcoming?hours=168');
  return `<h1>Upcoming</h1><p class="muted">Runs of console schedules due in the next 7 days, in this browser's time zone. Schedules that live on the minions are listed under <a href="#/schedules/minion">Schedules, Minion schedules</a>.</p>` +
    table([
      { t: 'Time', f: x => esc(when(x.time)), v: x => x.time },
      { t: 'In', f: x => esc(inTxt(x.time)), v: x => x.time },
      { t: 'Schedule', f: x => `<a href="#/schedules/edit:${esc(x.scheduleId)}">${esc(x.schedule)}</a>` },
      { t: 'Job', f: x => x.job ? esc(x.job) : '<span class="pill bad">job deleted</span>' },
      { t: 'Function', f: x => esc(x.fun) },
      { t: 'Target', f: x => esc(x.target) }
    ], r.items, 'No schedule runs are due in the next 7 days.', { key: 'upcoming' });
};
function inTxt(t) {
  const s = Math.max(0, t - Date.now() / 1000);
  return s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? (s / 3600).toFixed(1) + ' h' : (s / 86400).toFixed(1) + ' days';
}

// ---------- Administration: Audit Log ----------
addNav('Administration', '#/audit', 'Audit Log');
let lastAudit = [];
routes.audit = async function () {
  lastAudit = (await capi('GET', '/audit?limit=1000')).items;
  return `<h1>Audit Log</h1><p class="muted">Recorded by the console service from the Salt event bus: jobs and runner / wheel calls with the Salt user that started them, plus changes made through the console service. The console's own read-only calls are left out. Entries are kept for 90 days.</p><div class="bar"><span class="spacer"></span><button class="btn" data-act="dlaudit">Download JSON</button></div>` +
    table([
      { t: 'Time', f: a => esc(when(a.ts)), v: a => a.ts },
      { t: 'User', f: a => esc(a.user) },
      { t: 'Kind', f: a => esc(a.kind) },
      { t: 'Action', f: a => esc(a.action) },
      { t: 'Target', f: a => esc(a.target) },
      { t: 'Detail', f: a => a.detail ? `<code>${esc(a.detail)}</code>` : '' },
      { t: 'JID', f: a => a.jid ? `<a href="#/job/${esc(a.jid)}">${esc(a.jid)}</a>` : '' }
    ], lastAudit, 'Nothing recorded yet.', { key: 'audit' });
};
acts.dlaudit = () => download('audit-log.json', JSON.stringify(lastAudit, null, 2));

// ---------- Compliance (not built yet) ----------
addNav(null, '#/compliance', 'Compliance', 'Config');
(function () { const a = $('.nav a[href="#/compliance"] .nl'); if (a) a.insertAdjacentHTML('beforeend', ' <span class="soon">Coming soon</span>'); })();
routes.compliance = async () => '<h1>Compliance <span class="soon big">Coming soon</span></h1><div class="note">Compliance is not part of this version. It is planned to assess minions against a library of lab checks (Salt states run in test mode), show Compliant / Not compliant / Not applicable / Error per check and minion, remediate failed checks and support exemptions. The checks will be written for this lab; licensed CIS and STIG benchmark content will not be included.</div>';

// ---------- Settings: Console Service ----------
addNav('Settings', '#/settings/service', 'Console Service');
const baseSettings = routes.settings;
routes.settings = async function (arg) {
  if (arg !== 'service') return baseSettings(arg);
  const t = tabs([['#/settings', 'User Preferences', false], ['#/settings/banner', 'Login Banner', false], ['#/settings/service', 'Console Service', true]]);
  const st = await capi('GET', '/status'), cfg = await capi('GET', '/settings');
  const rows = [['Version', st.version], ['Event bus', st.bus], ['Events recorded since start', st.events], ['Last event', st.lastEvent ? ago(st.lastEvent) : 'none yet'], ['Scheduler', st.scheduler + (st.lastTick ? ', last check ' + ago(st.lastTick) : '')], ['Running since', when(st.startedAt)], ['Logged in as', st.user]];
  return `<h1>Settings</h1>${t}<p class="muted">The console service runs on the master (systemd unit salt-console) and keeps its data in ${esc(st.db || 'one SQLite file')}.</p><dl class="dl">${rows.map(r => `<dt>${r[0]}</dt><dd>${esc(r[1])}</dd>`).join('')}</dl>` +
    `<h2>Presence</h2><div style="max-width:520px"><label>Presence expiration (seconds, 60 to 86400)<input id="presExp" type="number" min="60" max="86400" value="${esc(cfg.presenceExpirationSec)}"></label><p class="muted">A minion is Present when the master reported it connected, or it returned job data, within this many seconds; Disconnected when it was seen before but not since; Unknown when it was never seen. The master reports connected minions every 60 seconds. Shared by all users.</p><div class="bar"><button class="btn btn-primary" data-act="savepres">Save</button></div></div>`;
};
acts.savepres = async () => {
  SHARED.settings = await capi('PUT', '/settings', { presenceExpirationSec: parseInt($('#presExp').value, 10) });
  toast('Presence expiration set to ' + SHARED.settings.presenceExpirationSec + ' seconds.');
};

// ---------- sample data mode ----------
function demoState() {
  const now = Date.now() / 1000, J = DEMO_FX._J, jids = Object.keys(J).sort().reverse();
  const hs = jids.find(j => J[j].Function === 'state.apply' && !J[j].Arguments.length);
  const job = (id, name, fun, tgt, extra) => Object.assign({ id: id, name: name, desc: '', command: 'salt', tt: 'glob', tgt: tgt, fun: fun, saltenv: '', states: '', args: '', pillar: '', test: false }, extra || {});
  const origins = {};
  if (hs) origins[hs] = 'Hourly web states';
  return {
    targets: { version: 1, items: [{ name: 'Web servers', tgt: 'web-*', tt: 'glob' }, { name: 'Ubuntu minions', tgt: 'os:Ubuntu', tt: 'grain' }] },
    jobs: { version: 1, items: [job('demo-job-1', 'Apply web states', 'state.apply', 'web-*', { saltenv: 'base', states: 'web.nginx, firewall', desc: 'nginx and firewall' }), job('demo-job-2', 'Disk usage', 'disk.usage', '*'), job('demo-job-3', 'Highstate dry run', 'state.apply', '*', { saltenv: 'base', test: true })] },
    settings: { presenceExpirationSec: 300 },
    scheds: [
      { id: 'demo-s1', name: 'Hourly web states', jobId: 'demo-job-1', tgt: '', tt: '', type: 'recurring', every: 3600, start: null, end: null, tz: TZ, enabled: true, created: now - 86400 * 3, lastRun: now - 1500, lastJid: hs || null, lastError: null },
      { id: 'demo-s2', name: 'Nightly dry run', jobId: 'demo-job-3', tgt: '', tt: '', type: 'cron', cron: '30 2 * * *', tz: TZ, enabled: true, created: now - 86400 * 9, lastRun: now - 30000, lastJid: null, lastError: 'Skipped the run due 2026-11-18 02:30 UTC because the console service was not running then.' },
      { id: 'demo-s3', name: 'Disk check before patching', jobId: 'demo-job-2', tgt: 'db-01', tt: 'list', type: 'once', at: now + 86400 * 2, tz: TZ, enabled: false, created: now - 3600, lastRun: null, lastJid: null, lastError: null }],
    origins: origins,
    notes: [
      { id: 3, ts: now - 600, kind: 'key', text: 'New minion key waiting for acceptance: new-vm-07', link: '#/keys/minions_pre', read: 0 },
      { id: 2, ts: now - 5400, kind: 'presence', text: 'Minion win-01 disconnected from the master.', link: '#/minions/win-01', read: 0 },
      { id: 1, ts: now - 86400, kind: 'job', text: 'state.apply failed on db-01.', link: hs ? '#/job/' + hs : '', read: 1 }],
    audit: jids.slice(0, 12).map((j, i) => ({ id: 100 - i, ts: jidTime(j) / 1000, user: J[j].User, kind: 'job', action: J[j].Function, target: fmtTgt(J[j].Target) + ' (' + J[j]['Target-type'] + ')', detail: J[j].Arguments.length ? JSON.stringify(J[j].Arguments) : '', jid: j })),
    presence: () => {
      const o = {}, t = Date.now() / 1000;
      DEMO_FX._M.forEach(m => { const down = DEMO_FX._DOWN.indexOf(m) >= 0; o[m] = { lastSeen: down ? t - 7200 : t - 20, firstSeen: t - 86400 * 5, status: down ? 'Disconnected' : 'Present' }; });
      return { expirationSec: 300, now: t, minions: o };
    }
  };
}
function demoCapi(method, path, body) {
  const D = demoCapi.s || (demoCapi.s = demoState()), now = Date.now() / 1000, qs = {};
  const p = path.split('?')[0];
  (path.split('?')[1] || '').split('&').forEach(kv => { const i = kv.indexOf('='); if (i > 0) qs[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); });
  const jobOf = s => D.jobs.items.find(x => x.id === s.jobId);
  const nextOf = s => {
    if (!s.enabled) return null;
    if (s.type === 'once') return s.at > now ? s.at : null;
    if (s.type === 'cron') return Math.ceil(now / 3600) * 3600; // sample data only; the master computes real cron times
    const st = s.start || s.created;
    return now < st ? st : st + (Math.floor((now - st) / s.every) + 1) * s.every;
  };
  const view = s => { const j = jobOf(s); return Object.assign({}, s, { nextRun: nextOf(s), jobName: j ? j.name : null, jobFun: j ? j.fun : null, target: j && j.command === 'salt-run' ? 'master (salt-run)' : (s.tt || (j && j.tt) || 'glob') + ': ' + (s.tgt || (j && j.tgt) || '*') }); };
  if (p === '/login') return { token: 'demo', user: 'demo' };
  if (p === '/status') return { version: VERSION, bus: 'connected', events: 4821, lastEvent: now - 4, scheduler: 'running', lastTick: now - 3, startedAt: now - 2 * 86400, user: 'demo', db: '/var/lib/salt-console/console.db' };
  if (p === '/presence') return D.presence();
  if (p === '/settings') { if (method === 'PUT') Object.assign(D.settings, body); return Object.assign({}, D.settings); }
  let m = /^\/shared\/(targets|jobs)$/.exec(p);
  if (m) {
    const L = D[m[1]];
    if (method === 'PUT') { L.items = body.items.map(x => Object.assign({}, x, m[1] === 'jobs' && !x.id ? { id: uid() } : {})); L.version++; }
    return { version: L.version, items: L.items.map(x => Object.assign({}, x)) };
  }
  if (p === '/schedules') {
    if (method === 'POST') { const s = Object.assign({ id: uid(), created: now, lastRun: null, lastJid: null, lastError: null }, body); D.scheds.push(s); return view(s); }
    return { items: D.scheds.map(view) };
  }
  m = /^\/schedules\/([^/]+)(\/run)?$/.exec(p);
  if (m) {
    const i = D.scheds.findIndex(s => s.id === m[1]);
    if (i < 0) throw new Error('Schedule not found.');
    const s = D.scheds[i];
    if (m[2]) {
      const j = jobOf(s), tgt = s.tgt || j.tgt, tt = s.tt || j.tt;
      const jid = DEMO_FX._job(DEMO_FX._jidAt(0, 12, 0).slice(0, 12) + String(Date.now() % 100000000).padStart(8, '0'), j.fun, [], tgt, 'demo', tt);
      s.lastJid = jid; s.lastRun = now; s.lastError = null; D.origins[jid] = s.name;
      return { jid: jid, minions: DEMO_FX._match({ tgt: tgt, tgt_type: tt }) };
    }
    if (method === 'DELETE') { D.scheds.splice(i, 1); return { deleted: m[1] }; }
    D.scheds[i] = Object.assign({}, s, body, { id: s.id, created: s.created });
    return view(D.scheds[i]);
  }
  if (p === '/upcoming') {
    const items = [];
    D.scheds.forEach(s => {
      const j = jobOf(s);
      let t = nextOf(s);
      for (let k = 0; t && k < 20 && t <= now + 7 * 86400; k++) {
        items.push({ time: t, scheduleId: s.id, schedule: s.name, job: j ? j.name : null, fun: j ? j.fun : null, target: view(s).target });
        t = s.type === 'recurring' ? t + s.every : s.type === 'cron' ? t + 86400 : null;
      }
    });
    return { hours: 168, items: items.sort((a, b) => a.time - b.time) };
  }
  if (p === '/origins') { const o = {}; (body.jids || []).forEach(j => { if (D.origins[j]) o[j] = D.origins[j]; }); return o; }
  if (p === '/notifications') return { unread: D.notes.filter(n => !n.read).length, items: D.notes.map(n => Object.assign({}, n)) };
  if (p === '/notifications/read') { D.notes.forEach(n => { if (body.all || (body.ids || []).indexOf(n.id) >= 0) n.read = 1; }); return demoCapi('GET', '/notifications'); }
  if (p === '/audit') return { items: D.audit };
  if (p === '/metrics') {
    const h = +(qs.hours || 12), step = h * 3600 / 48, idx = Array.apply(null, Array(48)).map((x, i) => i);
    return { hours: h, start: now - h * 3600, step: step, events: idx.map(i => 30 + Math.round(18 * Math.sin(i / 4)) + (i % 7)), presence: idx.map(i => i > 40 ? 5 : 6),
      jobs: { ok: idx.map(i => i % 6 === 0 ? 3 : i % 3 === 0 ? 1 : 0), failed: idx.map(i => i === 30 ? 1 : 0), missed: idx.map(i => i === 41 ? 1 : 0), running: idx.map(i => i === 47 ? 1 : 0) }, recordingSince: now - 2 * 86400 };
  }
  throw new Error('Not available in sample data mode: ' + method + ' ' + path);
}
