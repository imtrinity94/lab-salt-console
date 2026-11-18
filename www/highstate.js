'use strict';
// highstate.js - Highstate workspace built on the master's job cache: Limit by, States / Minions / Activity tabs,
// trend chart and state drill-down. hsCollect() and hsMinionsView() are reused for a single target (targets.js).
const HS_LIMITS = [['all', 'All time', 0], ['24h', 'Last 24 hours', 1], ['7d', 'Last 7 days', 7], ['30d', 'Last 30 days', 30]];
const HS_MAX_JOBS = 15;
// A JID is the master's clock at submit time (yyyymmddhhmmss...). The lab master runs in UTC.
const jidTime = j => Date.UTC(+j.slice(0, 4), +j.slice(4, 6) - 1, +j.slice(6, 8), +j.slice(8, 10), +j.slice(10, 12), +j.slice(12, 14));

async function hsCollect(ids) {
  const lim = HS_LIMITS.find(l => l[0] === store.get('hsLimit', 'all')) || HS_LIMITS[0];
  const since = lim[2] ? Date.now() - lim[2] * 864e5 : 0;
  const all = jobList(await runner('jobs.list_jobs')).filter(isHs).filter(j => jidTime(j.jid) >= since);
  const jobs = all.slice(0, HS_MAX_JOBS);
  const dets = await Promise.all(jobs.map(j => runner('jobs.list_job', { jid: j.jid })));
  const inScope = m => !ids || ids.indexOf(m) >= 0;
  const S = {}, M = {}, errs = [], perJob = [];
  dets.forEach((det, n) => {
    const jid = jobs[n].jid, res = (det && det.Result) || {};
    const mins = ((det && det.Minions) || []).slice();
    Object.keys(res).forEach(m => { if (mins.indexOf(m) < 0) mins.push(m); });
    const pj = { jid: jid, job: jobs[n], ok: 0, failed: 0, missing: 0, changed: 0, unchanged: 0 };
    perJob.push(pj);
    mins.filter(inScope).forEach(min => {
      if (!(min in res)) { pj.missing++; return; }
      const ret = res[min].return, good = !!ret && typeof ret === 'object' && !Array.isArray(ret);
      const first = !M[min]; // the newest job wins for the States and Minions views
      const m = first ? (M[min] = { id: min, jid: jid, runs: 0, errors: 0, ok: 0, changed: 0, dur: 0 }) : null;
      let fail = !good, ch = false;
      if (!good) { if (first) { m.errors = 1; errs.push(min + ': ' + (Array.isArray(ret) ? ret.join('; ') : String(ret))); } }
      else Object.keys(ret).forEach(k => {
        const s = ret[k];
        if (!s || typeof s !== 'object') return;
        const c = !!s.changes && Object.keys(s.changes).length > 0;
        if (s.result === false) fail = true;
        if (c) ch = true;
        if (!first) return;
        const id = s.__id__ || k.split('_|-')[1] || k, key = id + '|' + (s.__sls__ || '');
        const st = S[key] || (S[key] = { key: key, id: id, sls: s.__sls__ || '', minions: [], errors: 0, ok: 0, changed: 0, dur: 0, jids: [] });
        st.minions.push({ id: min, ok: s.result !== false, ch: c, dur: s.duration || 0, comment: s.comment || '', jid: jid });
        if (st.jids.indexOf(jid) < 0) st.jids.push(jid);
        m.runs++;
        if (s.result === false) { st.errors++; m.errors++; } else { st.ok++; m.ok++; }
        if (c) { st.changed++; m.changed++; }
        st.dur += s.duration || 0; m.dur += s.duration || 0;
      });
      if (fail) pj.failed++; else pj.ok++;
      if (ch) pj.changed++; else pj.unchanged++;
    });
  });
  return { lim: lim, jobs: jobs, more: all.length - jobs.length, perJob: perJob, S: S, states: Object.keys(S).sort().map(k => S[k]), minions: Object.keys(M).sort().map(k => M[k]), errs: errs };
}

const hsYN = b => b ? 'Yes' : 'No';
const hsTwo = (n1, l1, l2, t, c) => ring(pct(n1, t), c) + kv(n1, l1, t, c) + kv(t - n1, l2, t, c === '#5eb715' ? '#e12200' : '#ccc');
const hsJid = j => `<a href="#/job/${esc(j)}">${esc(j)}</a>`;
const hsLimit = d => `<label class="inl">Limit by: <select data-change="hslimit" aria-label="Limit by">${HS_LIMITS.map(l => `<option value="${l[0]}"${l === d.lim ? ' selected' : ''}>${l[1]}</option>`).join('')}</select></label>`;
const hsSplit = attrs => `<span class="grp"><button class="btn btn-primary" data-act="runhs" data-scope="sel" ${attrs || ''}>Run Highstate</button><button class="btn" data-act="runjob" data-scope="sel" ${attrs || ''}>Run Job</button><button class="btn" data-act="runcmd" data-scope="sel" ${attrs || ''}>Run Command</button></span>`;
function hsInfo(d) {
  if (!d.jobs.length) return `<div class="note">No highstate found${d.lim[2] ? ' in the ' + d.lim[1].toLowerCase() : ''}. A highstate needs a top file, for example top.sls in the File Server.</div>`;
  return `<p class="muted">${plural(d.jobs.length, 'highstate job')} read${d.more > 0 ? ' (' + d.more + ' older in this period not included)' : ''}; each minion shows its most recent result. Latest: ${hsJid(d.jobs[0].jid)}. Times are master time.</p>` + (d.errs.length ? `<div class="alert">${d.errs.map(esc).join('<br>')}</div>` : '');
}
function hsStatesView(d) {
  const st = d.states, t = st.length, mins = st.reduce((a, s) => a + s.minions.length, 0), du = st.reduce((a, s) => a + s.dur, 0);
  return `<div class="rings">${hsTwo(st.filter(s => s.changed).length, 'States with changes', 'States with no changes', t, '#0072a3')}${hsTwo(st.filter(s => !s.errors).length, 'States succeeded', 'States failed', t, '#5eb715')}</div>` +
    `<div class="stats">${tile(t, 'Total States')}${tile(t ? Math.round(mins / t) : 0, 'Avg Minions per State')}${tile(dur(mins ? du / mins : 0), 'Avg duration')}</div>` +
    `<div class="bar"><button class="btn btn-primary" data-act="runhs">Run Highstate</button><span class="spacer"></span>${hsLimit(d)}</div>` +
    table([
      { t: 'State', f: s => `<a href="#/highstate/state:${enc(s.key)}">${esc(s.id)}</a>` },
      { t: 'SLS file', f: s => esc(s.sls) },
      { t: 'Minions', f: s => s.minions.length },
      { t: 'Errors', f: s => hsYN(s.errors) },
      { t: 'Succeeded', f: s => `${pct(s.ok, s.minions.length)}% (${s.ok})` },
      { t: 'Changed', f: s => `${pct(s.changed, s.minions.length)}% (${s.changed})` },
      { t: 'Changes', f: s => hsYN(s.changed) },
      { t: 'Avg Duration', f: s => dur(s.dur / s.minions.length) },
      { t: 'JIDs', f: s => s.jids.slice(0, 2).map(hsJid).join('<br>') + (s.jids.length > 2 ? ` +${s.jids.length - 2}` : '') }
    ], st);
}
function hsMinionsView(d, attrs) {
  const M = d.minions, t = M.length, runs = M.reduce((a, m) => a + m.runs, 0), du = M.reduce((a, m) => a + m.dur, 0);
  return `<div class="rings">${hsTwo(M.filter(m => m.changed).length, 'Minions with changes', 'Minions with no changes', t, '#0072a3')}${hsTwo(M.filter(m => !m.errors).length, 'Minions with no failures', 'Minions with failures', t, '#5eb715')}</div>` +
    `<div class="stats">${tile(t, 'Total Minions')}${tile(t ? Math.round(runs / t) : 0, 'Avg States per Minion')}${tile(dur(t ? du / t : 0), 'Avg duration')}</div>` +
    `<div class="bar">${hsSplit(attrs)}<span class="spacer"></span>${hsLimit(d)}</div>` +
    table([
      { t: 'Minion ID', f: m => `<a href="#/job/${esc(m.jid)}">${esc(m.id)}</a>` },
      { t: 'State Runs', f: m => m.runs },
      { t: 'Errors', f: m => hsYN(m.errors) },
      { t: 'Succeeded', f: m => `${pct(m.ok, m.runs)}% (${m.ok})` },
      { t: 'Changed', f: m => `${pct(m.changed, m.runs)}% (${m.changed})` },
      { t: 'Changes', f: m => hsYN(m.changed) },
      { t: 'Duration', f: m => dur(m.dur) },
      { t: 'JID', f: m => hsJid(m.jid) }
    ], M, null, {
      key: 'hsmin', select: m => m.id,
      menu: m => `<button data-act="runhs" data-tgt="${esc(m.id)}" data-tt="list">Run Highstate</button><button data-act="runcmd" data-tgt="${esc(m.id)}" data-tt="list">Run Command</button><button data-act="go" data-href="#/job/${esc(m.jid)}">Open job</button>`,
      expand: m => table([
        { t: 'State', f: x => esc(x.s.id) }, { t: 'SLS file', f: x => esc(x.s.sls) },
        { t: 'Status', f: x => x.r.ok ? '<span class="pill ok">Succeeded</span>' : '<span class="pill bad">Failed</span>' },
        { t: 'Changes', f: x => hsYN(x.r.ch) }, { t: 'Duration', f: x => dur(x.r.dur) }, { t: 'Comment', f: x => esc(x.r.comment) }
      ], d.states.map(s => ({ s: s, r: s.minions.find(r => r.id === m.id) })).filter(x => x.r), null, { key: 'hsexp-' + m.id })
    });
}
function hsChart(d) {
  const pts = d.perJob.slice().reverse();
  if (pts.length < 2) return '<div class="note">The trend chart needs at least two highstate runs in this period.</div>';
  const W = 800, H = 200, L = 34, R = 14, T = 12, B = 24;
  const t0 = jidTime(pts[0].jid), t1 = jidTime(pts[pts.length - 1].jid), span = Math.max(1, t1 - t0);
  const max = Math.max(1, Math.max.apply(null, pts.map(p => Math.max(p.changed, p.unchanged))));
  const x = p => L + (jidTime(p.jid) - t0) / span * (W - L - R), y = v => T + (1 - v / max) * (H - T - B);
  const line = (k, c, name) => `<polyline fill="none" stroke="${c}" stroke-width="2" points="${pts.map(p => x(p).toFixed(1) + ',' + y(p[k]).toFixed(1)).join(' ')}"/>` + pts.map(p => `<circle cx="${x(p).toFixed(1)}" cy="${y(p[k]).toFixed(1)}" r="4" fill="${c}"><title>${name}: ${p[k]} (${esc(p.job.StartTime)})</title></circle>`).join('');
  const day = j => j.slice(4, 6) + '/' + j.slice(6, 8);
  return `<div class="card"><div class="card-h"><span>MINIONS: CHANGES VS NO CHANGES</span><span>${esc(d.lim[1].toUpperCase())}</span></div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Minions with changes and with no changes per highstate run" style="width:100%;height:auto">` +
    `<line x1="${L}" y1="${y(0)}" x2="${W - R}" y2="${y(0)}" stroke="#ccc"/><line x1="${L}" y1="${y(max)}" x2="${W - R}" y2="${y(max)}" stroke="#eee"/><text x="${L - 8}" y="${y(0) + 4}" text-anchor="end" font-size="11" fill="#666">0</text><text x="${L - 8}" y="${y(max) + 4}" text-anchor="end" font-size="11" fill="#666">${max}</text>` +
    `<text x="${L}" y="${H - 6}" font-size="11" fill="#666">${day(pts[0].jid)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="#666">${day(pts[pts.length - 1].jid)}</text>` +
    line('unchanged', '#5eb715', 'Minions with no changes') + line('changed', '#efc006', 'Minions with changes') + `</svg><div class="legend"><span><i style="background:#efc006"></i>Minions with changes</span><span><i style="background:#5eb715"></i>Minions with no changes</span></div></div>`;
}
function hsActivityView(d) {
  const status = p => p.failed ? '<span class="pill bad">Failed</span>' : p.missing ? '<span class="pill warn">Partial</span>' : '<span class="pill ok">Completed</span>';
  return hsChart(d) + `<div class="bar"><button class="btn btn-primary" data-act="runhs">Run Highstate</button><span class="spacer"></span>${hsLimit(d)}</div>` +
    table([
      { t: 'Status', f: status },
      { t: 'Function', f: p => esc(p.job.Function) },
      { t: 'Target', f: p => esc(fmtTgt(p.job.Target)) },
      { t: 'User', f: p => esc(p.job.User) },
      { t: 'Start Time', f: p => esc(p.job.StartTime) },
      { t: 'Success', f: p => p.ok },
      { t: 'Failed', f: p => p.failed },
      { t: 'Not Returned', f: p => p.missing },
      { t: 'JID', f: p => hsJid(p.jid) }
    ], d.perJob, 'No highstate jobs in this period.');
}
function hsStateDetail(d, key) {
  const st = d.S[key], back = '<p><a href="#/highstate">&lsaquo; BACK TO HIGHSTATE</a></p>';
  if (!st) return back + '<div class="alert">This state is not part of the highstate results in this period.</div>';
  const t = st.minions.length;
  return back + `<h2>${esc(st.id)}</h2><p class="muted">SLS file ${esc(st.sls)}</p><div class="rings">${hsTwo(st.changed, 'Changes made', 'No changes made', t, '#0072a3')}${hsTwo(st.ok, 'Minions with no failures', 'Minions with failures', t, '#5eb715')}</div><div class="bar">${hsSplit()}</div>` +
    table([
      { t: 'Minion ID', f: r => esc(r.id) },
      { t: 'Status', f: r => r.ok ? '<span class="pill ok">Succeeded</span>' : '<span class="pill bad">Failed</span>' },
      { t: 'Changes', f: r => hsYN(r.ch) },
      { t: 'Master', f: () => esc(location.hostname) },
      { t: 'Duration', f: r => dur(r.dur) },
      { t: 'Comment', f: r => esc(r.comment) },
      { t: 'JID', f: r => hsJid(r.jid) }
    ], st.minions, null, { key: 'hsstate', select: r => r.id });
}
routes.highstate = async function (arg) {
  const tab = arg || 'states', d = await hsCollect(null), head = '<h1>Highstate</h1>';
  if (tab.indexOf('state:') === 0) return head + hsStateDetail(d, decodeURIComponent(tab.slice(6)));
  const t3 = tabs([['#/highstate/states', 'States', tab === 'states'], ['#/highstate/minions', 'Minions', tab === 'minions'], ['#/highstate/activity', 'Activity', tab === 'activity']]);
  return head + t3 + (tab === 'activity' ? hsActivityView(d) : hsInfo(d) + (tab === 'minions' ? hsMinionsView(d) : hsStatesView(d)));
};

// Run buttons marked data-scope="sel" act on the selected rows when any are ticked, otherwise on their own target.
['runhs', 'runjob', 'runcmd'].forEach(n => {
  const orig = acts[n];
  acts[n] = d => { const ids = d.scope === 'sel' ? $$('.sel:checked').map(c => c.value) : []; return orig(ids.length ? { tgt: ids.join(','), tt: 'list' } : d); };
});
acts.go = d => { location.hash = d.href; };
acts.hslimit = v => { store.set('hsLimit', v); route(); };
document.addEventListener('change', e => {
  const n = e.target.dataset && e.target.dataset.change;
  if (n && acts[n]) Promise.resolve().then(() => acts[n](e.target.value, e.target)).catch(err => toast(err.message, 'error'));
});
