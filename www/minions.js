'use strict';
// minions.js - Minions workspace (list and minion page) and Reports.
addNav(null, '#/reports', 'Reports', 'Dashboard');
addNav(null, '#/minions', 'Minions', 'Targets');
const MIN_ACT_JOBS = 15;
const osName = g => ((g.os || '') + ' ' + (g.osrelease || '')).trim();
const presencePill = up => up ? '<span class="pill ok">Present</span>' : '<span class="pill bad">Not responding</span>';
// /var/run/reboot-required is how Debian and Ubuntu flag a pending reboot; other OS families are shown as not checked.
const rebootCell = (g, flag) => g.os_family !== 'Debian' ? '<span class="muted">not checked</span>' : flag === true ? '<span class="pill warn">Yes</span>' : flag === false ? 'No' : '';

routes.minions = async function (arg) {
  if (arg) return minionPage(arg);
  const res = await Promise.all([wheel('key.list_all'), runner('manage.status'), local('*', 'grains.items'), local('*', 'file.file_exists', ['/var/run/reboot-required'])]);
  const up = res[1].up || [], grains = res[2] || {}, rb = res[3] || {};
  const rows = (res[0].minions || []).slice().sort().map(id => ({ id: id, up: up.indexOf(id) >= 0, g: grains[id] && typeof grains[id] === 'object' ? grains[id] : {}, rb: rb[id] }));
  return `<h1>Minions</h1><h2 class="count">${plural(rows.length, 'minion')}</h2><div class="bar">${hsSplit()}</div>` +
    table([
      { t: 'Minion ID', f: r => `<a href="#/minions/${enc(r.id)}">${esc(r.id)}</a>` },
      { t: 'Presence', f: r => presencePill(r.up) },
      { t: 'OS', f: r => esc(osName(r.g)) },
      { t: 'Salt version', f: r => esc(r.g.saltversion) },
      { t: 'IP address', f: r => esc((r.g.ipv4 || []).filter(i => i !== '127.0.0.1').join(', ')) },
      { t: 'CPU / Memory', f: r => r.g.num_cpus ? esc(r.g.num_cpus + ' vCPU / ' + Math.round((r.g.mem_total || 0) / 1024) + ' GB') : '' },
      { t: 'Needs Reboot', f: r => r.g.os ? rebootCell(r.g, r.rb) : '' }
    ], rows, null, {
      key: 'minions', select: r => r.id,
      menu: r => `<button data-act="go" data-href="#/minions/${enc(r.id)}">Open minion</button><button data-act="runhs" data-tgt="${esc(r.id)}" data-tt="list">Run Highstate</button><button data-act="runjob" data-tgt="${esc(r.id)}" data-tt="list">Run Job</button><button data-act="runcmd" data-tgt="${esc(r.id)}" data-tt="list">Run Command</button>`
    });
};

async function minionPage(arg) {
  const parts = arg.split('/'), id = decodeURIComponent(parts[0]), tab = parts[1] || 'details', base = '#/minions/' + enc(id) + '/';
  const res = await Promise.all([runner('manage.status'), local(id, 'grains.items', [], {}, 'list')]);
  const up = (res[0].up || []).indexOf(id) >= 0, g = res[1] && typeof res[1][id] === 'object' ? res[1][id] : null;
  const d = `data-tgt="${esc(id)}" data-tt="list"`;
  const labels = { details: 'Details', grains: 'Grains', pillar: 'Pillar', packages: 'Packages', activity: 'Activity', targets: 'Targets' };
  const head = `<p class="crumb"><a href="#/minions">Minions</a> / ${esc(id)}</p><h1>${esc(id)} ${presencePill(up)}</h1><div class="bar"><span class="grp"><button class="btn btn-primary" data-act="runhs" ${d}>Run Highstate</button><button class="btn" data-act="runjob" ${d}>Run Job</button><button class="btn" data-act="runcmd" ${d}>Run Command</button></span></div>` + tabs(Object.keys(labels).map(k => [base + k, labels[k], k === tab]));
  const silent = '<div class="note">This minion did not answer, so live data cannot be read right now.</div>';
  let body;
  if (tab === 'activity') {
    const jobs = jobList(await runner('jobs.list_jobs')).slice(0, MIN_ACT_JOBS);
    const dets = await Promise.all(jobs.map(j => jobDetail(j.jid).catch(() => null)));
    const rows = jobs.map((j, i) => ({ j: j, det: dets[i] })).filter(x => x.det && ((x.det.Minions || []).indexOf(id) >= 0 || (x.det.Result && id in x.det.Result)));
    const st = x => { const r = (x.det.Result || {})[id]; return !r ? '<span class="pill warn">Not returned</span>' : (r.success === false || r.retcode > 0) ? '<span class="pill bad">Failed</span>' : '<span class="pill ok">Succeeded</span>'; };
    body = `<p class="muted">Jobs that included this minion, out of the ${MIN_ACT_JOBS} most recent jobs on the master.</p>` + table([
      { t: 'Status', f: st }, { t: 'Function', f: x => esc(x.j.Function) }, { t: 'Arguments', f: x => esc((x.j.Arguments || []).length ? JSON.stringify(x.j.Arguments) : '') },
      { t: 'User', f: x => esc(x.j.User) }, { t: 'Start Time', f: x => esc(x.j.StartTime) }, { t: 'JID', f: x => `<a href="#/job/${esc(x.j.jid)}">${esc(x.j.jid)}</a>` }
    ], rows, null, { key: 'minact' });
  } else if (tab === 'targets') {
    const all = targetList();
    const hits = await Promise.all(all.map(t => t.builtin ? Promise.resolve(true) : local(t.tgt, 'test.ping', [], {}, t.tt).then(r => !!(r && id in r)).catch(() => false)));
    body = (up ? '' : '<div class="note">Membership is tested by asking the minion, so only All Minions can be confirmed while it is not answering.</div>') + table([
      { t: 'Target', f: x => `<a href="#/targets/${enc(x.name)}">${esc(x.name)}</a>` }, { t: 'Type', f: x => esc(x.tt) }, { t: 'Definition', f: x => esc(x.tgt) }
    ], all.filter((t, i) => hits[i]), null, { key: 'mintgt' });
  } else if (!g) body = silent;
  else if (tab === 'grains') {
    body = table([{ t: 'Grain', f: k => esc(k) }, { t: 'Value', f: k => `<pre>${esc(typeof g[k] === 'string' ? g[k] : JSON.stringify(g[k], null, 1))}</pre>` }], Object.keys(g).sort(), null, { key: 'grains', sort: 0 });
  } else if (tab === 'pillar') {
    const p = await local(id, 'pillar.items', [], {}, 'list');
    body = `<div class="tbl" style="padding:12px"><pre>${esc(p && p[id] !== undefined ? JSON.stringify(p[id], null, 2) : 'No pillar data returned.')}</pre></div>`;
  } else if (tab === 'packages') {
    const p = await local(id, 'pkg.list_pkgs', [], {}, 'list'), pk = p && typeof p[id] === 'object' ? p[id] : {};
    body = `<p class="muted">${plural(Object.keys(pk).length, 'installed package')}.</p>` + table([{ t: 'Package', f: k => esc(k) }, { t: 'Version', f: k => esc(Array.isArray(pk[k]) ? pk[k].join(', ') : pk[k]) }], Object.keys(pk).sort(), null, { key: 'pkgs' });
  } else {
    const rb = await local(id, 'file.file_exists', ['/var/run/reboot-required'], {}, 'list');
    const rows = [['FQDN', g.fqdn], ['OS', osName(g)], ['OS family', g.os_family], ['Kernel', (g.kernel || '') + ' ' + (g.kernelrelease || '')], ['Architecture', g.osarch], ['Salt version', g.saltversion], ['Master', g.master], ['IP addresses', (g.ipv4 || []).filter(i => i !== '127.0.0.1').join(', ')], ['CPU', (g.num_cpus || '') + ' x ' + (g.cpu_model || '')], ['Memory', g.mem_total ? Math.round(g.mem_total / 1024) + ' GB' : ''], ['Virtual', g.virtual], ['Serial number', g.serialnumber]];
    body = `<dl class="dl">${rows.filter(p => p[1] != null && String(p[1]).trim() !== '' && String(p[1]).trim() !== 'x').map(p => `<dt>${p[0]}</dt><dd>${esc(p[1])}</dd>`).join('')}<dt>Needs Reboot</dt><dd>${rebootCell(g, rb ? rb[id] : undefined)}</dd></dl>`;
  }
  return head + body;
}

// ---------- Reports ----------
const REPORTS = [['keys', 'Key State'], ['minionver', 'Minion version'], ['osver', 'OS version'], ['masterver', 'Salt master version']];
let reportData = { name: '', rows: [] };
routes.reports = async function (arg) {
  const def = REPORTS.find(r => r[0] === arg) || REPORTS[0], type = def[0];
  const all = targetList(), cur = all.find(t => t.name === store.get('reportTarget', '')) || all[0];
  const scoped = type === 'minionver' || type === 'osver';
  let rows = [], first = 'Value';
  const count = (obj, fn) => { const c = {}; Object.keys(obj || {}).forEach(k => { const v = obj[k] && typeof obj[k] === 'object' ? fn(obj[k]) : ''; if (v) c[v] = (c[v] || 0) + 1; }); return Object.keys(c).sort().map(k => ({ label: k, count: c[k] })); };
  if (type === 'keys') { const k = await wheel('key.list_all'); first = 'Key state'; rows = KEYS.map(x => ({ label: x[1], count: (k[x[0]] || []).length })); }
  else if (type === 'masterver') { first = 'Salt version'; const v = await runner('salt.cmd', { arg: ['test.version'] }); rows = [{ label: String(v), count: 1, extra: location.hostname }]; }
  else { const g = await local(cur.tgt, 'grains.items', [], {}, cur.tt); first = type === 'osver' ? 'Operating system' : 'Salt version'; rows = count(g, type === 'osver' ? osName : x => x.saltversion); }
  reportData = { name: type + (scoped ? '-' + cur.name.replace(/\W+/g, '_') : ''), first: first, rows: rows };
  const max = Math.max(1, Math.max.apply(null, rows.map(r => r.count).concat([1]))), total = rows.reduce((a, r) => a + r.count, 0);
  const side = REPORTS.map(r => `<a class="${r === def ? 'on' : ''}" href="#/reports/${r[0]}">${r[1]}</a>`).join('');
  const unit = type === 'masterver' ? 'master' : type === 'keys' ? 'key' : 'minion';
  return `<h1>Reports</h1><div class="split"><div class="side"><div class="hd">REPORTS</div>${side}</div><div class="grow"><h2 style="margin-top:0">${def[1]}</h2>` +
    `<div class="bar">${scoped ? `<label class="inl">Target: <select data-change="reporttgt" aria-label="Target">${all.map(t => `<option${t === cur ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}<span class="spacer"></span><button class="btn" data-act="dlreport" data-fmt="csv">Download CSV</button><button class="btn" data-act="dlreport" data-fmt="json">Download JSON</button></div>` +
    (scoped ? `<p class="muted">Counts the minions that answered just now (${plural(total, 'minion')}).</p>` : '') +
    `<div class="card">${rows.map(r => `<div class="hrow"><span class="hl">${esc(r.label)}</span><span class="hbar"><i style="width:${(r.count / max * 100).toFixed(1)}%"></i></span><span class="hn">${r.count}</span></div>`).join('') || '<span class="muted">No data.</span>'}</div>` +
    table([{ t: first, f: r => esc(r.label) }].concat(type === 'masterver' ? [{ t: 'Master', f: r => esc(r.extra) }] : [{ t: unit.charAt(0).toUpperCase() + unit.slice(1) + 's', f: r => r.count }, { t: 'Share', f: r => pct(r.count, total) + '%' }]), rows, null, { key: 'report-' + type }) + `</div></div>`;
};
acts.reporttgt = v => { store.set('reportTarget', v); route(); };
acts.dlreport = d => {
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  if (d.fmt === 'json') download('report-' + reportData.name + '.json', JSON.stringify(reportData.rows, null, 2));
  else download('report-' + reportData.name + '.csv', [q(reportData.first) + ',count'].concat(reportData.rows.map(r => q(r.label) + ',' + r.count)).join('\r\n'), 'text/csv');
};
if (DEMO) Object.assign(DEMO_FX, {
  'file.file_exists': low => DEMO_FX._each(low, m => m === 'web-02' || m === 'db-01'),
  'pkg.list_pkgs': low => DEMO_FX._each(low, () => ({ bash: '5.2.21-2ubuntu4', curl: '8.5.0-2ubuntu10.6', nginx: '1.24.0-2ubuntu7.5', openssl: '3.0.13-0ubuntu3.5', 'salt-minion': '3006.30', vim: '2:9.1.0016-1ubuntu7.9' })),
  'salt.cmd': low => (low.arg || [])[0] === 'test.version' ? '3006.30' : true,
  'test.ping': low => DEMO_FX._each(low, () => true)
});
