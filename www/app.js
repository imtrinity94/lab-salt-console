'use strict';
// Lab Salt Console - single page UI on open source salt-api (rest_cherrypy).
const VERSION = '1.4.1';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem('saltui.' + k)); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('saltui.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
};
const sess = {
  get(k) { try { return sessionStorage.getItem('saltui.' + k); } catch (e) { return null; } },
  set(k, v) { try { if (v == null) sessionStorage.removeItem('saltui.' + k); else sessionStorage.setItem('saltui.' + k, v); } catch (e) { /* storage unavailable */ } }
};
let token = sess.get('token'), who = sess.get('user') || '', seq = 0, pollTimer = null, polls = 0;

// ---------- salt-api ----------
async function raw(path, body) {
  const h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (token && path !== '/login') h['X-Auth-Token'] = token;
  let r;
  try { r = await fetch('/salt-api' + path, { method: 'POST', headers: h, body: JSON.stringify(body) }); }
  catch (e) { throw new Error('Cannot reach salt-api on the master.'); }
  if (r.status === 401) {
    if (path === '/login') throw new Error('Login failed. Check the user name and password.');
    logout();
    throw new Error('Session expired. Log in again.');
  }
  if (!r.ok) throw new Error('salt-api returned HTTP ' + r.status + (Array.isArray(body) && body[0] ? ' for ' + body[0].fun : ''));
  const j = await r.json();
  return j.return[0];
}
const api = low => raw('/', [low]);
const runner = (fun, kw) => api(Object.assign({ client: 'runner', fun: fun }, kw || {}));
const wheel = async (fun, kw) => { const r = await api(Object.assign({ client: 'wheel', fun: fun }, kw || {})); return r && r.data ? r.data.return : r; };
const local = (tgt, fun, arg, kwarg, tt, isAsync) => api({ client: isAsync ? 'local_async' : 'local', tgt: tgt, tgt_type: tt || 'glob', fun: fun, arg: arg || [], kwarg: kwarg || {} });

function logout() { token = null; sess.set('token', null); route(); }

// ---------- small UI helpers ----------
function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 9000 : 4500);
}
function closeModal() { const m = $('#modal'); if (m) m.remove(); }
function modal(title, body, actions) {
  closeModal();
  const m = document.createElement('div');
  m.id = 'modal'; m.className = 'modal-back';
  m.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true"><div class="modal-head"><h3>${esc(title)}</h3><button class="x" aria-label="Close">&times;</button></div><div class="modal-body">${body}</div><div class="modal-foot"></div></div>`;
  const foot = $('.modal-foot', m);
  [{ label: 'Cancel' }].concat(actions || []).forEach(a => {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : '');
    b.textContent = a.label;
    b.onclick = async () => {
      if (!a.fn) { closeModal(); return; }
      b.disabled = true;
      try { await a.fn(m); closeModal(); } catch (e) { toast(e.message, 'error'); b.disabled = false; }
    };
    foot.appendChild(b);
  });
  $('.x', m).onclick = closeModal;
  document.body.appendChild(m);
  const f = $('input,select,textarea', m);
  if (f) f.focus();
}
const val = (m, n) => $('[name=' + n + ']', m).value.trim();
function table(cols, rows, empty) {
  const head = `<thead><tr>${cols.map(c => `<th>${esc(c.t)}</th>`).join('')}</tr></thead>`;
  if (!rows.length) return `<div class="tbl"><table>${head}</table><div class="empty">${esc(empty || "We couldn't find any items!")}</div></div>`;
  return `<div class="tbl"><table>${head}<tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${c.f(r)}</td>`).join('')}</tr>`).join('')}</tbody></table><div class="tfoot">${rows.length} item${rows.length === 1 ? '' : 's'}</div></div>`;
}
const tabs = items => `<div class="tabs">${items.map(i => `<a href="${i[0]}" class="${i[2] ? 'on' : ''}">${i[1]}</a>`).join('')}</div>`;
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const pct = (n, t) => t ? Math.round(n * 100 / t) : 0;
const dur = ms => ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's';
const ring = (p, c) => `<svg width="88" height="88" viewBox="0 0 88 88" aria-hidden="true"><circle cx="44" cy="44" r="36" fill="none" stroke="#d8d8d8" stroke-width="10"/><circle cx="44" cy="44" r="36" fill="none" stroke="${c}" stroke-width="10" stroke-dasharray="${(p * 2.262).toFixed(1)} 226.2" transform="rotate(-90 44 44)"/></svg>`;
const kv = (n, label, t, c) => `<div class="kv" style="border-color:${c}"><b>${n}</b><span>${label}</span><em>${pct(n, t)}%</em></div>`;
const tile = (v, label, href) => href ? `<a class="tile" href="${href}"><b>${esc(v)}</b><span>${label}</span></a>` : `<div class="tile"><b>${esc(v)}</b><span>${label}</span></div>`;
const fmtTgt = t => Array.isArray(t) ? t.join(', ') : t;
function badge(n) { const b = $('#pendingBadge'); b.hidden = !n; b.textContent = n; }

function jobList(o) {
  return Object.keys(o || {}).map(j => Object.assign({ jid: j }, o[j]))
    .filter(j => !/^(runner|wheel)\.|^saltutil\.(find_job|running)$/.test(j.Function || ''))
    .sort((a, b) => a.jid < b.jid ? 1 : -1);
}
function jobTable(rows) {
  return table([
    { t: 'JID', f: r => `<a href="#/job/${esc(r.jid)}">${esc(r.jid)}</a>` },
    { t: 'Function', f: r => esc(r.Function) },
    { t: 'Arguments', f: r => esc((r.Arguments || []).length ? JSON.stringify(r.Arguments) : '') },
    { t: 'Target', f: r => esc(fmtTgt(r.Target)) },
    { t: 'User', f: r => esc(r.User) },
    { t: 'Start Time (master)', f: r => esc(r.StartTime) }
  ], rows);
}
function parseArgs(s) {
  const arg = [], kwarg = {};
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const conv = v => { try { return JSON.parse(v); } catch (e) { return v; } };
  let m;
  while ((m = re.exec(s || ''))) {
    const quoted = m[3] == null;
    const t = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3];
    const kvm = !quoted && /^([A-Za-z_]\w*)=(.*)$/.exec(t);
    if (kvm) kwarg[kvm[1]] = conv(kvm[2]); else arg.push(quoted ? t : conv(t));
  }
  return { arg: arg, kwarg: kwarg };
}
async function submit(tgt, tt, fun, argstr) {
  if (!tgt || !fun) throw new Error('Target and function are required.');
  const a = parseArgs(argstr);
  const r = await local(tgt, fun, a.arg, a.kwarg, tt, true);
  if (!r || !r.jid) throw new Error('No minions matched the target.');
  toast('Job ' + r.jid + ' started on ' + plural(r.minions.length, 'minion') + '.');
  location.hash = '#/job/' + r.jid;
}
function tgtFields(tgt, tt) {
  const opts = [['glob', 'Glob'], ['list', 'List (comma separated)'], ['grain', 'Grain'], ['compound', 'Compound']];
  return `<div class="row2"><label>Target type<select name="tt">${opts.map(o => `<option value="${o[0]}"${o[0] === (tt || 'glob') ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label><label>Target<input name="tgt" value="${esc(tgt || '*')}"></label></div>`;
}

// ---------- pages ----------
async function pgDashboard() {
  const res = await Promise.all([wheel('key.list_all'), runner('manage.status'), runner('jobs.list_jobs')]);
  const keys = res[0], status = res[1], jobs = jobList(res[2]);
  badge(keys.minions_pre.length);
  return `<h1>Dashboard</h1><div class="stats">${tile(keys.minions.length, 'Accepted minions', '#/keys/minions')}${tile(keys.minions_pre.length, 'Pending keys', '#/keys/minions_pre')}${tile((status.up || []).length, 'Minions up', '#/targets')}${tile((status.down || []).length, 'Minions down', '#/targets')}${tile(jobs.length, 'Jobs in the job cache', '#/activity/completed')}</div>` +
    (keys.minions_pre.length ? `<div class="note">${plural(keys.minions_pre.length, 'minion key')} waiting for acceptance. <a href="#/keys/minions_pre">Review pending keys</a></div>` : '') +
    `<h2>Recent activity</h2>${jobTable(jobs.slice(0, 8))}`;
}

async function pgTargets(sel) {
  const all = [{ name: 'All Minions', tgt: '*', tt: 'glob', builtin: true }].concat(store.get('targets', []));
  const name = sel ? decodeURIComponent(sel) : '';
  const cur = all.find(t => t.name === name) || all[0];
  const res = await Promise.all([runner('manage.status'), local(cur.tgt, 'grains.items', [], {}, cur.tt)]);
  const up = res[0].up || [], grains = res[1] || {}, ids = Object.keys(grains);
  if (cur.builtin) (res[0].down || []).forEach(d => { if (ids.indexOf(d) < 0) ids.push(d); });
  ids.sort();
  const rows = ids.map(id => ({ id: id, up: up.indexOf(id) >= 0, g: grains[id] && typeof grains[id] === 'object' ? grains[id] : {} }));
  const side = all.map(t => `<a class="${t === cur ? 'on' : ''}" href="#/targets/${enc(t.name)}">${esc(t.name)}</a>`).join('');
  const d = `data-tgt="${esc(cur.tgt)}" data-tt="${esc(cur.tt)}"`;
  return `<h1>Targets</h1><div class="split"><div class="side"><div class="hd">TARGETS</div>${side}</div><div class="grow"><h2 style="margin-top:0">${esc(cur.name)}</h2><p class="muted">${plural(rows.length, 'minion')} &middot; ${esc(cur.tt)}: ${esc(cur.tgt)}</p>` +
    `<div class="bar"><span class="grp"><button class="btn btn-primary" data-act="runhs" ${d}>Run Highstate</button><button class="btn" data-act="runjob" ${d}>Run Job</button><button class="btn" data-act="runcmd" ${d}>Run Command</button></span><span class="spacer"></span><button class="btn" data-act="newtarget">Create Target</button>${cur.builtin ? '' : `<button class="btn" data-act="deltarget" data-name="${esc(cur.name)}">Delete Target</button>`}</div>` +
    table([
      { t: 'Minion ID', f: r => esc(r.id) },
      { t: 'Presence', f: r => r.up ? '<span class="pill ok">Present</span>' : '<span class="pill bad">Not responding</span>' },
      { t: 'OS', f: r => esc(((r.g.os || '') + ' ' + (r.g.osrelease || '')).trim()) },
      { t: 'Salt version', f: r => esc(r.g.saltversion) },
      { t: 'IP address', f: r => esc((r.g.ipv4 || []).filter(i => i !== '127.0.0.1').join(', ')) },
      { t: 'CPU / Memory', f: r => r.g.num_cpus ? esc(r.g.num_cpus + ' vCPU / ' + Math.round((r.g.mem_total || 0) / 1024) + ' GB') : '' }
    ], rows) + `</div></div>`;
}

const KEYS = [['minions', 'Accepted', 'ok'], ['minions_pre', 'Pending', 'warn'], ['minions_rejected', 'Rejected', 'bad'], ['minions_denied', 'Denied', 'bad']];
async function pgKeys(kind) {
  const def = KEYS.find(k => k[0] === kind) || KEYS[0];
  const k = await wheel('key.list_all');
  badge(k.minions_pre.length);
  const ids = (k[def[0]] || []).slice().sort();
  const btn = (op, label, show) => show ? `<button class="btn needs-sel" disabled data-act="keyop" data-op="${op}">${label}</button>` : '';
  return `<h1>${def[1]}</h1><h2 style="margin-top:0">${plural(ids.length, 'minion')}</h2><div class="bar"><span class="grp">${btn('accept', 'Accept Key', def[0] !== 'minions')}${btn('reject', 'Reject Key', def[0] === 'minions' || def[0] === 'minions_pre')}${btn('delete', 'Delete Key', true)}</span></div>` +
    table([
      { t: 'Master', f: () => esc(location.hostname) },
      { t: 'Minion ID', f: r => esc(r) },
      { t: 'Key state', f: () => `<span class="pill ${def[2]}">${def[1]}</span>` }
    ], ids, null, { key: 'keys', select: r => r });
}

async function pgActivity(kind) {
  const bar = `<div class="bar"><button class="btn btn-primary" data-act="runcmd">Run Command</button><button class="btn" data-act="refresh">Refresh</button></div>`;
  if (kind === 'active') {
    const a = await runner('jobs.active');
    const rows = Object.keys(a || {}).sort().reverse().map(j => Object.assign({ jid: j }, a[j]));
    return `<h1>In Progress</h1>${bar}` + table([
      { t: 'JID', f: r => `<a href="#/job/${esc(r.jid)}">${esc(r.jid)}</a>` },
      { t: 'Function', f: r => esc(r.Function) },
      { t: 'Target', f: r => esc(fmtTgt(r.Target)) },
      { t: 'User', f: r => esc(r.User) },
      { t: 'Running on', f: r => esc((r.Running || []).map(x => Object.keys(x)[0]).join(', ')) },
      { t: 'Returned', f: r => esc((r.Returned || []).join(', ')) }
    ], rows, 'No jobs are running right now.');
  }
  const jobs = jobList(await runner('jobs.list_jobs'));
  return `<h1>Completed</h1>${bar}${jobTable(jobs.slice(0, 300))}`;
}

async function pgJob(jid) {
  const my = seq;
  const j = await runner('jobs.list_job', { jid: jid });
  if (!j || j.Error) return `<h1>Job ${esc(jid)}</h1><div class="alert">${esc((j && j.Error) || 'Job not found.')}</div>`;
  const res = j.Result || {}, mins = (j.Minions || []).slice();
  Object.keys(res).forEach(m => { if (mins.indexOf(m) < 0) mins.push(m); });
  mins.sort();
  const pending = mins.filter(m => !(m in res));
  if (pending.length && polls < 40) {
    pollTimer = setTimeout(async () => {
      if (my !== seq) return;
      polls++;
      try { const h = await pgJob(jid); if (my === seq) $('#main').innerHTML = h; } catch (e) { /* keep the last view */ }
    }, 3000);
  }
  const failed = mins.filter(m => (m in res) && (res[m].success === false || res[m].retcode > 0)).length;
  const out = r => typeof r === 'string' ? r : JSON.stringify(r, null, 2);
  return `<p><a href="#/activity/completed">&lsaquo; BACK TO ACTIVITY</a></p><h1>${esc(j.Function)}</h1>` +
    `<p class="muted">JID ${esc(jid)} &middot; target ${esc(fmtTgt(j.Target))} (${esc(j['Target-type'])}) &middot; user ${esc(j.User)} &middot; started ${esc(j.StartTime)} (master time)${(j.Arguments || []).length ? ' &middot; arguments ' + esc(JSON.stringify(j.Arguments)) : ''}</p>` +
    `<div class="stats">${tile(mins.length - pending.length - failed, 'Succeeded')}${tile(failed, 'Failed')}${tile(pending.length, 'Not returned')}</div>` +
    (pending.length ? `<div class="note">Waiting for ${plural(pending.length, 'minion')} to return. This page refreshes every few seconds.</div>` : '') +
    table([
      { t: 'Minion ID', f: m => esc(m) },
      { t: 'Status', f: m => !(m in res) ? '<span class="pill warn">Not returned</span>' : (res[m].success === false || res[m].retcode > 0) ? '<span class="pill bad">Failed</span>' : '<span class="pill ok">Succeeded</span>' },
      { t: 'Return code', f: m => m in res ? esc(res[m].retcode) : '' },
      { t: 'Return', f: m => m in res ? `<pre>${esc(out(res[m].return))}</pre>` : '' }
    ], mins);
}

async function pgJobs() {
  const jobs = store.get('jobs', []);
  return `<h1>Jobs</h1><p class="muted">Saved job definitions. They are kept in this browser only.</p><div class="bar"><button class="btn btn-primary" data-act="newjob">Create Job</button></div>` +
    table([
      { t: 'Job', f: r => esc(r.name) },
      { t: 'Function', f: r => esc(r.fun) },
      { t: 'Arguments', f: r => esc(r.args) },
      { t: 'Target', f: r => esc(r.tt + ': ' + r.tgt) },
      { t: '', f: r => `<button class="btn btn-sm btn-primary" data-act="runsaved" data-i="${jobs.indexOf(r)}">Run Now</button> <button class="btn btn-sm" data-act="deljob" data-i="${jobs.indexOf(r)}">Delete</button>` }
    ], jobs);
}

async function pgSchedules() {
  const r = await local('*', 'schedule.list', [], { return_yaml: false });
  const rows = [];
  Object.keys(r || {}).sort().forEach(m => {
    const s = r[m];
    if (s && typeof s === 'object') Object.keys(s).forEach(n => { if (s[n] && typeof s[n] === 'object') rows.push({ m: m, n: n, s: s[n] }); });
  });
  const every = s => ['seconds', 'minutes', 'hours', 'days'].filter(u => s[u]).map(u => s[u] + ' ' + u).join(' ') || s.cron || s.when || '';
  return `<h1>Schedules</h1><p class="muted">Read from the Salt scheduler on each minion.</p><div class="bar"><button class="btn btn-primary" data-act="newsched">Create Schedule</button><button class="btn" data-act="refresh">Refresh</button></div>` +
    table([
      { t: 'Minion ID', f: x => esc(x.m) },
      { t: 'Schedule', f: x => esc(x.n) },
      { t: 'Function', f: x => esc(x.s.function) },
      { t: 'Arguments', f: x => esc(x.s.args ? JSON.stringify(x.s.args) : '') },
      { t: 'Runs every', f: x => esc(every(x.s)) },
      { t: 'Enabled', f: x => x.s.enabled === false ? 'No' : 'Yes' },
      { t: '', f: x => `<button class="btn btn-sm" data-act="delsched" data-minion="${esc(x.m)}" data-name="${esc(x.n)}">Delete</button>` }
    ], rows);
}

async function rootsEditor(kind, base, cur) {
  const tree = await wheel(kind + '.list_env', { saltenv: 'base' });
  const files = [];
  (function walk(n, p) {
    if (!n || typeof n !== 'object') return;
    Object.keys(n).forEach(k => { const v = n[k]; if (typeof v === 'string') files.push(p + k); else walk(v, k.charAt(0) === '/' ? p : p + k + '/'); });
  })(tree, '');
  files.sort();
  let content = '';
  if (cur) {
    const r = await wheel(kind + '.read', { path: cur, saltenv: 'base' });
    if (Array.isArray(r) && r[0]) content = r[0][Object.keys(r[0])[0]];
  }
  return `<div class="split"><div class="side"><div class="hd">${kind === 'file_roots' ? '/srv/salt' : '/srv/pillar'} (base)</div>${files.map(f => `<a class="${f === cur ? 'on' : ''}" href="${base}${enc(f)}">${esc(f)}</a>`).join('')}<a href="${base}"><b>+ New file</b></a></div>` +
    `<div class="grow"><label>Path, relative to the root<input id="fpath" value="${esc(cur)}" placeholder="lab/example.sls"></label><label>Content<textarea id="fdata" spellcheck="false">${esc(content)}</textarea></label><div class="bar"><button class="btn btn-primary" data-act="savefile" data-kind="${kind}" data-base="${esc(base)}">Save</button></div></div></div>`;
}
async function pgFiles(arg) { return '<h1>File Server</h1>' + await rootsEditor('file_roots', '#/files/', decodeURIComponent(arg || '')); }
async function pgPillars(arg) {
  const m = /^(data|file):?(.*)$/.exec(arg || '') || [0, 'data', ''];
  const mode = m[1], v = decodeURIComponent(m[2] || '');
  const t = tabs([['#/pillars/data:', 'Minion data', mode === 'data'], ['#/pillars/file:', 'Pillar files', mode === 'file']]);
  if (mode === 'file') return `<h1>Pillars</h1>${t}` + await rootsEditor('pillar_roots', '#/pillars/file:', v);
  const k = await wheel('key.list_all');
  const ids = k.minions.slice().sort(), cur = v || ids[0] || '';
  let data;
  if (cur) { const r = await local(cur, 'pillar.items'); data = r && r[cur] !== undefined ? JSON.stringify(r[cur], null, 2) : ''; }
  return `<h1>Pillars</h1>${t}<div class="split"><div class="side"><div class="hd">MINIONS</div>${ids.map(i => `<a class="${i === cur ? 'on' : ''}" href="#/pillars/data:${enc(i)}">${esc(i)}</a>`).join('')}</div><div class="grow"><div class="tbl" style="padding:12px"><pre>${esc(data || 'No pillar data returned.')}</pre></div></div></div>`;
}

const isHs = j => j.Function === 'state.highstate' || (j.Function === 'state.apply' && !(j.Arguments || []).length);
async function pgHighstate(arg) {
  const tab = arg || 'states';
  const jobs = jobList(await runner('jobs.list_jobs')).filter(isHs);
  const last = jobs[0];
  const det = last ? await runner('jobs.list_job', { jid: last.jid }) : null;
  const S = {}, M = [], errs = [];
  Object.keys((det && det.Result) || {}).forEach(min => {
    const ret = det.Result[min].return;
    const m = { id: min, runs: 0, errors: 0, ok: 0, changed: 0, dur: 0 };
    M.push(m);
    if (!ret || typeof ret !== 'object' || Array.isArray(ret)) { m.errors = 1; errs.push(min + ': ' + (Array.isArray(ret) ? ret.join('; ') : String(ret))); return; }
    Object.keys(ret).forEach(k => {
      const s = ret[k];
      if (!s || typeof s !== 'object') return;
      const id = s.__id__ || k.split('_|-')[1] || k, key = id + '|' + (s.__sls__ || '');
      const st = S[key] || (S[key] = { key: key, id: id, sls: s.__sls__ || '', minions: [], errors: 0, ok: 0, changed: 0, dur: 0 });
      const ch = !!s.changes && Object.keys(s.changes).length > 0;
      st.minions.push({ id: min, ok: s.result !== false, ch: ch, dur: s.duration || 0, comment: s.comment || '' });
      m.runs++;
      if (s.result === false) { st.errors++; m.errors++; } else { st.ok++; m.ok++; }
      if (ch) { st.changed++; m.changed++; }
      st.dur += s.duration || 0; m.dur += s.duration || 0;
    });
  });
  const states = Object.keys(S).sort().map(k => S[k]);
  M.sort((a, b) => a.id < b.id ? -1 : 1);
  const yn = b => b ? 'Yes' : 'No';
  const info = (last ? `<p class="muted">Latest highstate: job <a href="#/job/${esc(last.jid)}">${esc(last.jid)}</a>, started ${esc(last.StartTime)} (master time).</p>` : '<div class="note">No highstate has been run yet. A highstate needs a top file, for example /srv/salt/top.sls in the File Server.</div>') +
    (errs.length ? `<div class="alert">${errs.map(esc).join('<br>')}</div>` : '');
  const runBar = `<div class="bar"><button class="btn btn-primary" data-act="runhs">Run Highstate</button></div>`;
  const head = `<h1>Highstate</h1>`;
  const two = (n1, l1, l2, t, c) => ring(pct(n1, t), c) + kv(n1, l1, t, c) + kv(t - n1, l2, t, c === '#5eb715' ? '#e12200' : '#ccc');

  if (tab.indexOf('state:') === 0) {
    const st = S[decodeURIComponent(tab.slice(6))];
    if (!st) return head + '<p><a href="#/highstate">&lsaquo; BACK TO HIGHSTATE</a></p><div class="alert">This state is not part of the latest highstate.</div>';
    const t = st.minions.length;
    return head + `<p><a href="#/highstate">&lsaquo; BACK TO HIGHSTATE</a></p><h2>${esc(st.id)}</h2><div class="rings">${two(st.changed, 'Changes made', 'No changes made', t, '#0072a3')}${two(st.ok, 'Minions with no failures', 'Minions with failures', t, '#5eb715')}</div>` +
      table([
        { t: 'Minion ID', f: r => esc(r.id) },
        { t: 'Status', f: r => r.ok ? '<span class="pill ok">Succeeded</span>' : '<span class="pill bad">Failed</span>' },
        { t: 'Changes', f: r => yn(r.ch) },
        { t: 'Duration', f: r => dur(r.dur) },
        { t: 'Comment', f: r => esc(r.comment) },
        { t: 'JID', f: () => `<a href="#/job/${esc(last.jid)}">${esc(last.jid)}</a>` }
      ], st.minions);
  }
  const t3 = tabs([['#/highstate/states', 'States', tab === 'states'], ['#/highstate/minions', 'Minions', tab === 'minions'], ['#/highstate/activity', 'Activity', tab === 'activity']]);
  if (tab === 'activity') return head + t3 + runBar + jobTable(jobs);
  if (tab === 'minions') {
    const t = M.length, runs = M.reduce((a, m) => a + m.runs, 0), d = M.reduce((a, m) => a + m.dur, 0);
    return head + t3 + info + `<div class="rings">${two(M.filter(m => m.changed).length, 'Minions with changes', 'Minions with no changes', t, '#0072a3')}${two(M.filter(m => !m.errors).length, 'Minions with no failures', 'Minions with failures', t, '#5eb715')}</div>` +
      `<div class="stats">${tile(t, 'Total Minions')}${tile(t ? Math.round(runs / t) : 0, 'Avg States per Minion')}${tile(dur(t ? d / t : 0), 'Avg duration')}</div>${runBar}` +
      table([
        { t: 'Minion ID', f: m => esc(m.id) },
        { t: 'State Runs', f: m => m.runs },
        { t: 'Errors', f: m => yn(m.errors) },
        { t: 'Succeeded', f: m => `${pct(m.ok, m.runs)}% (${m.ok})` },
        { t: 'Changed', f: m => `${pct(m.changed, m.runs)}% (${m.changed})` },
        { t: 'Changes', f: m => yn(m.changed) },
        { t: 'Duration', f: m => dur(m.dur) }
      ], M);
  }
  const t = states.length, mins = states.reduce((a, s) => a + s.minions.length, 0), d = states.reduce((a, s) => a + s.dur, 0);
  return head + t3 + info + `<div class="rings">${two(states.filter(s => s.changed).length, 'States with changes', 'States with no changes', t, '#0072a3')}${two(states.filter(s => !s.errors).length, 'States succeeded', 'States failed', t, '#5eb715')}</div>` +
    `<div class="stats">${tile(t, 'Total States')}${tile(t ? Math.round(mins / t) : 0, 'Avg Minions per State')}${tile(dur(mins ? d / mins : 0), 'Avg duration')}</div>${runBar}` +
    table([
      { t: 'State', f: s => `<a href="#/highstate/state:${enc(s.key)}">${esc(s.id)}</a>` },
      { t: 'SLS file', f: s => esc(s.sls) },
      { t: 'Minions', f: s => s.minions.length },
      { t: 'Errors', f: s => yn(s.errors) },
      { t: 'Succeeded', f: s => `${pct(s.ok, s.minions.length)}% (${s.ok})` },
      { t: 'Changed', f: s => `${pct(s.changed, s.minions.length)}% (${s.changed})` },
      { t: 'Changes', f: s => yn(s.changed) },
      { t: 'Avg Duration', f: s => dur(s.dur / s.minions.length) }
    ], states);
}

// ---------- actions ----------
const acts = {
  logout: () => logout(),
  refresh: () => route(),
  runcmd(d) {
    modal('Run Command', tgtFields(d.tgt, d.tt) + `<label>Function<input name="fun" value="test.ping" placeholder="module.function"></label><label>Arguments<input name="args" placeholder="space separated; key=value for keyword arguments"></label>`,
      [{ label: 'Run Command', primary: true, fn: m => submit(val(m, 'tgt'), val(m, 'tt'), val(m, 'fun'), val(m, 'args')) }]);
  },
  runhs(d) {
    modal('Run Highstate', tgtFields(d.tgt, d.tt) + '<p class="muted">Applies the top file (state.apply without arguments) to the target.</p>',
      [{ label: 'Run Highstate', primary: true, fn: m => submit(val(m, 'tgt'), val(m, 'tt'), 'state.apply', '') }]);
  },
  runjob(d) {
    const jobs = store.get('jobs', []);
    if (!jobs.length) { toast('No saved jobs yet. Create one under Config, Jobs.'); return; }
    modal('Run Job', `<label>Job<select name="job">${jobs.map((j, i) => `<option value="${i}">${esc(j.name)} (${esc(j.fun)})</option>`).join('')}</select></label>` + tgtFields(d.tgt, d.tt),
      [{ label: 'Run Job', primary: true, fn: m => { const j = jobs[+val(m, 'job')]; return submit(val(m, 'tgt'), val(m, 'tt'), j.fun, j.args); } }]);
  },
  async keyop(d) {
    const ids = $$('.sel:checked').map(c => c.value);
    if (!ids.length) return;
    const match = ids.join(',');
    const run = async () => {
      if (d.op === 'accept') await wheel('key.accept', { match: match, include_rejected: true, include_denied: true });
      else if (d.op === 'reject') await wheel('key.reject', { match: match, include_accepted: true, include_denied: true });
      else await wheel('key.delete', { match: match });
      toast('Key ' + d.op + (d.op === 'delete' ? 'd' : 'ed') + ': ' + ids.join(', '));
      route();
    };
    if (d.op === 'delete') modal('Delete Key', `<p>Delete the key for ${esc(ids.join(', '))}? The minion has to submit its key again before it can be managed.</p>`, [{ label: 'Delete Key', danger: true, fn: run }]);
    else await run();
  },
  newtarget() {
    modal('Create Target', `<label>Name<input name="name"></label>` + tgtFields('', 'glob') + '<p class="muted">Examples: glob <code>lab-salt*</code>, grain <code>os:Ubuntu</code>, list <code>a,b</code>. Targets are kept in this browser only.</p>',
      [{ label: 'Save', primary: true, fn: m => {
        const name = val(m, 'name'), tgt = val(m, 'tgt');
        if (!name || !tgt) throw new Error('Name and target are required.');
        const list = store.get('targets', []).filter(t => t.name !== name);
        list.push({ name: name, tgt: tgt, tt: val(m, 'tt') });
        store.set('targets', list);
        location.hash = '#/targets/' + enc(name);
      } }]);
  },
  deltarget(d) { store.set('targets', store.get('targets', []).filter(t => t.name !== d.name)); location.hash = '#/targets'; },
  newjob() {
    modal('Create Job', `<label>Name<input name="name"></label><label>Function<input name="fun" placeholder="state.apply"></label><label>Arguments<input name="args" placeholder="lab.motd"></label>` + tgtFields('*', 'glob'),
      [{ label: 'Save', primary: true, fn: m => {
        const name = val(m, 'name'), fun = val(m, 'fun');
        if (!name || !fun) throw new Error('Name and function are required.');
        const list = store.get('jobs', []);
        list.push({ name: name, fun: fun, args: val(m, 'args'), tgt: val(m, 'tgt'), tt: val(m, 'tt') });
        store.set('jobs', list);
        route();
      } }]);
  },
  deljob(d) { const list = store.get('jobs', []); list.splice(+d.i, 1); store.set('jobs', list); route(); },
  runsaved(d) { const j = store.get('jobs', [])[+d.i]; return submit(j.tgt, j.tt, j.fun, j.args); },
  newsched() {
    modal('Create Schedule', tgtFields('*', 'glob') + `<label>Schedule name<input name="name"></label><label>Function<input name="fun" placeholder="state.apply"></label><label>Arguments<input name="args"></label><label>Run every (seconds)<input name="secs" type="number" min="10" value="3600"></label>`,
      [{ label: 'Save', primary: true, fn: async m => {
        const name = val(m, 'name'), fun = val(m, 'fun'), secs = parseInt(val(m, 'secs'), 10), a = parseArgs(val(m, 'args'));
        if (!name || !fun || !(secs >= 10)) throw new Error('Name, function and an interval of at least 10 seconds are required.');
        const kw = { function: fun, seconds: secs };
        if (a.arg.length) kw.job_args = a.arg;
        if (Object.keys(a.kwarg).length) kw.job_kwargs = a.kwarg;
        await local(val(m, 'tgt'), 'schedule.add', [name], kw, val(m, 'tt'));
        toast('Schedule ' + name + ' added.');
        route();
      } }]);
  },
  delsched(d) {
    modal('Delete Schedule', `<p>Delete schedule ${esc(d.name)} on ${esc(d.minion)}?</p>`, [{ label: 'Delete', danger: true, fn: async () => { await local(d.minion, 'schedule.delete', [d.name]); route(); } }]);
  },
  async savefile(d) {
    const path = $('#fpath').value.trim();
    if (!path) throw new Error('Enter a path for the file.');
    await wheel(d.kind + '.write', { data: $('#fdata').value, path: path, saltenv: 'base' });
    toast('Saved ' + path);
    const target = d.base + enc(path);
    if (location.hash === target) route(); else location.hash = target;
  }
};

// ---------- routing ----------
const routes = { dashboard: pgDashboard, targets: pgTargets, keys: pgKeys, activity: pgActivity, job: pgJob, jobs: pgJobs, schedules: pgSchedules, pillars: pgPillars, files: pgFiles, highstate: pgHighstate };
function markNav(h) {
  let best = null, bestLen = -1;
  $$('.nav a').forEach(a => {
    a.classList.remove('on');
    const p = a.getAttribute('href').slice(2);
    if ((h === p || h.indexOf(p + '/') === 0) && p.length > bestLen) { best = a; bestLen = p.length; }
  });
  if (!best) {
    const map = { job: '#/activity/completed', keys: '#/keys/minions', activity: '#/activity/completed' };
    best = $('.nav a[href="' + (map[h.split('/')[0]] || '#/dashboard') + '"]');
  }
  if (best) best.classList.add('on');
}
async function route() {
  clearTimeout(pollTimer); polls = 0; closeModal();
  if (!token) { $('#app').hidden = true; $('#login').hidden = false; return; }
  $('#login').hidden = true; $('#app').hidden = false; $('#who').textContent = who;
  const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const i = h.indexOf('/');
  const name = i < 0 ? h : h.slice(0, i), arg = i < 0 ? '' : h.slice(i + 1);
  markNav(h);
  const my = ++seq, main = $('#main');
  main.innerHTML = '<div class="loading">Loading...</div>';
  try {
    const html = await (routes[name] || pgDashboard)(arg);
    if (my === seq) main.innerHTML = html;
  } catch (e) {
    if (my === seq && token) main.innerHTML = `<div class="alert">${esc(e.message)}</div>`;
  }
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = acts[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  Promise.resolve().then(() => fn(el.dataset, el)).catch(err => toast(err.message, 'error'));
});
document.addEventListener('change', e => {
  if (e.target.classList && e.target.classList.contains('sel')) {
    const any = $$('.sel:checked').length > 0;
    $$('.needs-sel').forEach(b => { b.disabled = !any; });
  }
});
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, err = $('#loginErr');
  err.hidden = true;
  try {
    const r = await raw('/login', { username: f.username.value, password: f.password.value, eauth: 'pam' });
    token = r.token; who = r.user || f.username.value;
    sess.set('token', token); sess.set('user', who);
    f.password.value = '';
    route();
  } catch (x) { err.textContent = x.message; err.hidden = false; }
});
window.addEventListener('hashchange', route);
$('#ver').textContent = 'Lab Salt Console ' + VERSION;
