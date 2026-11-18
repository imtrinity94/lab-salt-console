'use strict';
// jobs.js - Jobs workspace with the full job definition (salt and salt-run), job page extras (download, stop),
// and status with Success / Failed / Not Returned counts on Activity > Completed.
const ACT_STATUS_JOBS = 15;
// Hide only the console's own housekeeping calls; salt-run jobs started by a person stay visible.
jobList = function (o) {
  return Object.keys(o || {}).map(j => Object.assign({ jid: j }, o[j]))
    .filter(j => !/^(wheel\.|runner\.(jobs|manage|fileserver|config|salt)\.)|^saltutil\.(find_job|running|term_job)$/.test(j.Function || ''))
    .sort((a, b) => a.jid < b.jid ? 1 : -1);
};
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// Arguments field: one argument per line; a line like key=value is a keyword argument.
function lineArgs(s) {
  const arg = [], kwarg = {}, conv = v => { try { return JSON.parse(v); } catch (e) { return v; } };
  String(s || '').split('\n').map(l => l.trim()).filter(Boolean).forEach(l => {
    const m = /^([A-Za-z_]\w*)=(.*)$/.exec(l);
    if (m) kwarg[m[1]] = conv(m[2]); else arg.push(conv(l));
  });
  return { arg: arg, kwarg: kwarg };
}
const isStateFun = f => /^state\.(apply|sls|highstate)$/.test(f || '');
async function runJobDef(job, tgt, tt) {
  const a = job.command ? lineArgs(job.args) : parseArgs(job.args); // jobs saved before 1.3.0 used one space separated line
  if (isStateFun(job.fun)) {
    const mods = String(job.states || '').split(',').map(x => x.trim()).filter(Boolean);
    if (mods.length && job.fun !== 'state.highstate') a.arg.unshift(mods.join(','));
    if (job.saltenv) a.kwarg.saltenv = job.saltenv;
    if (job.pillar && job.pillar.trim()) { try { a.kwarg.pillar = JSON.parse(job.pillar); } catch (e) { throw new Error('Pillar Override is not valid JSON.'); } }
    if (job.test) a.kwarg.test = true;
  }
  let r;
  if (job.command === 'salt-run') {
    r = await api({ client: 'runner_async', fun: job.fun, arg: a.arg, kwarg: a.kwarg });
    if (!r || !r.jid) throw new Error('The master did not start the runner.');
    toast('Runner job ' + r.jid + ' started on the master.');
  } else {
    r = await local(tgt || job.tgt, job.fun, a.arg, a.kwarg, tt || job.tt, true);
    if (!r || !r.jid) throw new Error('No minions matched the target.');
    toast('Job ' + r.jid + ' started on ' + plural(r.minions.length, 'minion') + '.');
  }
  location.hash = '#/job/' + r.jid;
}

routes.jobs = async function (arg) {
  const jobs = store.get('jobs', []);
  if (arg === 'new' || /^edit:\d+$/.test(arg || '')) {
    const i = arg === 'new' ? -1 : +arg.slice(5), j = jobs[i] || { command: 'salt', tt: 'glob', tgt: '*', saltenv: 'base' };
    const args = j.command ? (j.args || '') : parseArgs(j.args).arg.map(String).join('\n');
    const sel = (v, cur) => v === cur ? ' selected' : '';
    return `<p class="crumb"><a href="#/jobs">Jobs</a> / ${i < 0 ? 'Create Job' : 'Edit Job'}</p><h1>${i < 0 ? 'Create Job' : esc(j.name)}</h1><div id="jobForm" style="max-width:640px">` +
      `<label>Name<input name="name" value="${esc(j.name)}"></label><label>Description<input name="desc" value="${esc(j.desc)}"></label>` +
      `<label>Command<select name="command"><option value="salt"${sel('salt', j.command || 'salt')}>salt (run on minions)</option><option value="salt-run"${sel('salt-run', j.command)}>salt-run (runner on the master)</option></select></label>` +
      tgtFields(j.tgt, j.tt) + `<p class="muted" style="margin-top:-6px">The target is ignored for salt-run jobs.</p>` +
      `<label>Function<input name="fun" value="${esc(j.fun)}" placeholder="state.apply"></label>` +
      `<div class="row2"><label>Environment<input name="saltenv" value="${esc(j.saltenv || '')}" placeholder="base"></label><label>States (comma separated, for state.apply)<input name="states" value="${esc(j.states || '')}" placeholder="lab.motd, lab.users"></label></div>` +
      `<label>Arguments (one per line; key=value for keyword arguments)<textarea name="args" class="short" spellcheck="false">${esc(args)}</textarea></label>` +
      `<label>Pillar Override (JSON, state functions only)<textarea name="pillar" class="short" spellcheck="false" placeholder='{"key": "value"}'>${esc(j.pillar || '')}</textarea></label>` +
      `<label class="chk"><input type="checkbox" name="test"${j.test ? ' checked' : ''}> Run as test (dry run, state functions only)</label>` +
      `<div class="bar"><button class="btn btn-primary" data-act="savejob" data-i="${i}">Save</button><a class="btn" href="#/jobs">Cancel</a></div></div>`;
  }
  return `<h1>Jobs</h1><p class="muted">Saved job definitions. They are kept in this browser until the console gets its own storage on the master.</p><div class="bar"><a class="btn btn-primary" href="#/jobs/new">Create Job</a></div>` +
    table([
      { t: 'Job', f: r => `<a href="#/jobs/edit:${jobs.indexOf(r)}">${esc(r.name)}</a>` },
      { t: 'Description', f: r => esc(r.desc) },
      { t: 'Command', f: r => esc(r.command || 'salt') },
      { t: 'Function', f: r => esc(r.fun) + (r.test ? ' <span class="pill info">test</span>' : '') },
      { t: 'States', f: r => esc(r.states) },
      { t: 'Target', f: r => r.command === 'salt-run' ? '<span class="muted">master</span>' : esc(r.tt + ': ' + r.tgt) }
    ], jobs, null, { key: 'jobs', menu: r => `<button data-act="runsaved" data-i="${jobs.indexOf(r)}">Run Now</button><button data-act="go" data-href="#/jobs/edit:${jobs.indexOf(r)}">Edit</button><button data-act="deljob" data-i="${jobs.indexOf(r)}">Delete</button>` });
};
acts.savejob = d => {
  const f = $('#jobForm'), j = { name: val(f, 'name'), desc: val(f, 'desc'), command: val(f, 'command'), tt: val(f, 'tt'), tgt: val(f, 'tgt'), fun: val(f, 'fun'), saltenv: val(f, 'saltenv'), states: val(f, 'states'), args: $('[name=args]', f).value, pillar: $('[name=pillar]', f).value, test: $('[name=test]', f).checked };
  if (!j.name || !j.fun) throw new Error('Name and function are required.');
  if (j.pillar.trim()) { try { JSON.parse(j.pillar); } catch (e) { throw new Error('Pillar Override is not valid JSON.'); } }
  const list = store.get('jobs', []);
  if (+d.i >= 0 && list[+d.i]) list[+d.i] = j; else list.push(j);
  store.set('jobs', list);
  toast('Job ' + j.name + ' saved.');
  location.hash = '#/jobs';
};
acts.runsaved = d => runJobDef(store.get('jobs', [])[+d.i]);
acts.runjob = d => {
  const ids = d.scope === 'sel' ? $$('.sel:checked').map(c => c.value) : [];
  const tgt = ids.length ? ids.join(',') : d.tgt, tt = ids.length ? 'list' : d.tt, jobs = store.get('jobs', []);
  if (!jobs.length) { toast('No saved jobs yet. Create one under Config, Jobs.'); return; }
  modal('Run Job', `<label>Job<select name="job">${jobs.map((j, i) => `<option value="${i}">${esc(j.name)} (${esc(j.fun)})</option>`).join('')}</select></label>` + tgtFields(tgt, tt) + '<p class="muted">The target is ignored for salt-run jobs.</p>',
    [{ label: 'Run Job', primary: true, fn: m => runJobDef(jobs[+val(m, 'job')], val(m, 'tgt'), val(m, 'tt')) }]);
};

// ---------- job page: runner returns, download, stop ----------
function jobCounts(det) {
  const res = (det && det.Result) || {}, mins = ((det && det.Minions) || []).slice();
  Object.keys(res).forEach(m => { if (mins.indexOf(m) < 0) mins.push(m); });
  const c = { mins: mins.sort(), ok: 0, failed: 0, missing: 0 };
  mins.forEach(m => { if (!(m in res)) c.missing++; else if (res[m].success === false || res[m].retcode > 0) c.failed++; else c.ok++; });
  return c;
}
const jobStatus = c => c.failed ? '<span class="pill bad">Failed</span>' : c.missing ? '<span class="pill warn">Partial</span>' : '<span class="pill ok">Completed</span>';
routes.job = async function jobPage(jid) {
  const my = seq;
  const j = await runner('jobs.list_job', { jid: jid });
  if (!j || j.Error) return `<h1>Job ${esc(jid)}</h1><div class="alert">${esc((j && j.Error) || 'Job not found.')}</div>`;
  const res = j.Result || {}, c = jobCounts(j), isRunner = /^runner\./.test(j.Function || '');
  const waiting = c.missing && !isRunner ? c.missing : (isRunner && !c.mins.length ? 1 : 0);
  if (waiting && polls < 40) {
    pollTimer = setTimeout(async () => {
      if (my !== seq) return;
      polls++;
      try { const h = await jobPage(jid); if (my === seq) $('#main').innerHTML = h; } catch (e) { /* keep the last view */ }
    }, 3000);
  }
  const unwrap = r => (isRunner && r && typeof r === 'object' && 'return' in r && 'fun' in r) ? r.return : r;
  const out = r => { const v = unwrap(r); return typeof v === 'string' ? v : JSON.stringify(v, null, 2); };
  return `<p><a href="#/activity/completed">&lsaquo; BACK TO ACTIVITY</a></p><h1>${esc(j.Function)}</h1>` +
    `<p class="muted">JID ${esc(jid)} &middot; target ${esc(fmtTgt(j.Target))} (${esc(j['Target-type'])}) &middot; user ${esc(j.User)} &middot; started ${esc(j.StartTime)} (master time)${(j.Arguments || []).length ? ' &middot; arguments ' + esc(JSON.stringify(j.Arguments)) : ''}</p>` +
    `<div class="stats">${tile(c.ok, 'Succeeded')}${tile(c.failed, 'Failed')}${tile(c.missing, 'Not returned')}</div>` +
    `<div class="bar"><button class="btn" data-act="dljob" data-jid="${esc(jid)}">Download JSON</button>${waiting && !isRunner ? `<button class="btn btn-danger" data-act="stopjob" data-jid="${esc(jid)}" data-tgt="${esc(fmtTgt(j.Target))}" data-tt="${esc(j['Target-type'])}">Stop Job</button>` : ''}</div>` +
    (waiting ? `<div class="note">Waiting for ${isRunner ? 'the master' : plural(c.missing, 'minion')} to return. This page refreshes every few seconds.</div>` : '') +
    table([
      { t: isRunner ? 'Master' : 'Minion ID', f: m => esc(m) },
      { t: 'Status', f: m => !(m in res) ? '<span class="pill warn">Not returned</span>' : (res[m].success === false || res[m].retcode > 0) ? '<span class="pill bad">Failed</span>' : '<span class="pill ok">Succeeded</span>' },
      { t: 'Return code', f: m => m in res && res[m].retcode != null ? esc(res[m].retcode) : '' },
      { t: 'Return', f: m => m in res ? `<pre>${esc(out(res[m].return))}</pre>` : '' }
    ], c.mins, null, { key: 'job' });
};
acts.dljob = async d => { const j = await runner('jobs.list_job', { jid: d.jid }); download('job-' + d.jid + '.json', JSON.stringify(j, null, 2)); };
acts.stopjob = d => {
  modal('Stop Job', `<p>Ask the minions to terminate job ${esc(d.jid)}? Work that already finished on a minion is not undone.</p>`, [{ label: 'Stop Job', danger: true, fn: async () => {
    await local(d.tgt, 'saltutil.term_job', [d.jid], {}, d.tt === 'list' ? 'list' : d.tt);
    toast('Stop signal sent for job ' + d.jid + '.');
    route();
  } }]);
};

routes.activity = async function (kind) {
  if (kind === 'active') return pgActivity('active');
  const jobs = jobList(await runner('jobs.list_jobs')).slice(0, 300);
  const dets = await Promise.all(jobs.slice(0, ACT_STATUS_JOBS).map(j => jobDetail(j.jid).catch(() => null)));
  jobs.forEach((j, i) => { j.c = dets[i] ? jobCounts(dets[i]) : null; });
  const n = (r, k) => r.c ? r.c[k] : '';
  return `<h1>Completed</h1><div class="bar"><button class="btn btn-primary" data-act="runcmd">Run Command</button><button class="btn" data-act="refresh">Refresh</button></div>` +
    (jobs.length > ACT_STATUS_JOBS ? `<p class="muted">Status and counts are read for the ${ACT_STATUS_JOBS} most recent jobs; open an older job to see its result.</p>` : '') +
    table([
      { t: 'Status', f: r => r.c ? jobStatus(r.c) : '' },
      { t: 'Function', f: r => esc(r.Function) },
      { t: 'Arguments', f: r => esc((r.Arguments || []).length ? JSON.stringify(r.Arguments) : '') },
      { t: 'Target', f: r => esc(fmtTgt(r.Target)) },
      { t: 'User', f: r => esc(r.User) },
      { t: 'Start Time', f: r => esc(r.StartTime) },
      { t: 'Success', f: r => n(r, 'ok') },
      { t: 'Failed', f: r => n(r, 'failed') },
      { t: 'Not Returned', f: r => n(r, 'missing') },
      { t: 'JID', f: r => `<a href="#/job/${esc(r.jid)}">${esc(r.jid)}</a>` }
    ], jobs, null, { key: 'completed' });
};
if (DEMO) Object.assign(DEMO_FX, { 'saltutil.term_job': low => DEMO_FX._each(low, () => '') });
