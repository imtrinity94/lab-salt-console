'use strict';
// targets.js - Targets workspace: target list and a target page with Minions / Highstate / Activity / Edit tabs.
const targetList = () => [{ name: 'All Minions', tgt: '*', tt: 'glob', builtin: true }].concat(store.get('targets', []));
routes.targets = async function (arg) {
  const parts = (arg || '').split('/'), all = targetList();
  const cur = all.find(t => t.name === decodeURIComponent(parts[0] || '')) || all[0], tab = parts[1] || 'minions';
  const base = '#/targets/' + enc(cur.name) + '/';
  const d = `data-tgt="${esc(cur.tgt)}" data-tt="${esc(cur.tt)}"`;
  const res = await Promise.all([runner('manage.status'), local(cur.tgt, 'grains.items', [], {}, cur.tt)]);
  const up = res[0].up || [], grains = res[1] || {}, ids = Object.keys(grains);
  if (cur.builtin) (res[0].down || []).forEach(x => { if (ids.indexOf(x) < 0) ids.push(x); });
  ids.sort();
  const rows = ids.map(id => ({ id: id, up: up.indexOf(id) >= 0, g: grains[id] && typeof grains[id] === 'object' ? grains[id] : {} }));
  const labels = { minions: 'Minions', highstate: 'Highstate', activity: 'Activity', edit: 'Edit' };
  const side = all.map(t => `<a class="${t === cur ? 'on' : ''}" href="#/targets/${enc(t.name)}">${esc(t.name)}</a>`).join('');
  const head = `<p class="crumb"><a href="#/targets">Targets</a> / ${labels[tab] || 'Minions'}</p><h1>${esc(cur.name)} <span class="rel"><button class="link-act" data-act="tgtmenu" aria-haspopup="true">ACTIONS &#9662;</button><div class="pop" id="tgtPop" hidden><button data-act="runhs" ${d}>Run Highstate</button><button data-act="runjob" ${d}>Run Job</button><button data-act="runcmd" ${d}>Run Command</button><button data-act="newtarget">Create Target</button>${cur.builtin ? '' : `<button data-act="go" data-href="${base}edit">Edit Target</button><button data-act="deltarget" data-name="${esc(cur.name)}">Delete Target</button>`}</div></span></h1>` +
    `<h2 class="count">${plural(rows.length, 'minion')}</h2>` + tabs(Object.keys(labels).map(k => [base + k, labels[k], k === tab]));
  let body;
  if (tab === 'highstate') { const hd = await hsCollect(ids); body = hsInfo(hd) + hsMinionsView(hd, d); }
  else if (tab === 'activity') {
    const jobs = jobList(await runner('jobs.list_jobs')).filter(j => fmtTgt(j.Target) === cur.tgt);
    body = `<p class="muted">Jobs that were run against this target expression (${esc(cur.tt)}: ${esc(cur.tgt)}).</p>` + jobTable(jobs.slice(0, 300));
  } else if (tab === 'edit') {
    body = cur.builtin ? '<div class="note">All Minions is built in and cannot be changed. Use Create Target for your own targets.</div>'
      : `<div id="tgtForm" style="max-width:560px"><label>Name<input name="name" value="${esc(cur.name)}"></label>${tgtFields(cur.tgt, cur.tt)}<div class="bar"><button class="btn btn-primary" data-act="savetarget" data-old="${esc(cur.name)}">Save</button><button class="btn" data-act="deltarget" data-name="${esc(cur.name)}">Delete Target</button></div></div>`;
  } else {
    body = `<div class="bar">${hsSplit(d)}<span class="spacer"></span><button class="btn" data-act="newtarget">Create Target</button></div>` +
      table([
        { t: 'Minion ID', f: r => esc(r.id) },
        { t: 'Presence', f: r => r.up ? '<span class="pill ok">Present</span>' : '<span class="pill bad">Not responding</span>' },
        { t: 'OS', f: r => esc(((r.g.os || '') + ' ' + (r.g.osrelease || '')).trim()) },
        { t: 'Salt version', f: r => esc(r.g.saltversion) },
        { t: 'IP address', f: r => esc((r.g.ipv4 || []).filter(i => i !== '127.0.0.1').join(', ')) },
        { t: 'CPU / Memory', f: r => r.g.num_cpus ? esc(r.g.num_cpus + ' vCPU / ' + Math.round((r.g.mem_total || 0) / 1024) + ' GB') : '' }
      ], rows, null, {
        key: 'tgtmin', select: r => r.id,
        menu: r => `<button data-act="runhs" data-tgt="${esc(r.id)}" data-tt="list">Run Highstate</button><button data-act="runjob" data-tgt="${esc(r.id)}" data-tt="list">Run Job</button><button data-act="runcmd" data-tgt="${esc(r.id)}" data-tt="list">Run Command</button>`,
        expand: r => r.g.os ? `<dl class="dl">${[['FQDN', r.g.fqdn], ['Kernel', r.g.kernel], ['OS family', r.g.os_family], ['Architecture', r.g.osarch], ['CPU model', r.g.cpu_model], ['Virtual', r.g.virtual], ['Master', r.g.master]].filter(p => p[1] != null && p[1] !== '').map(p => `<dt>${p[0]}</dt><dd>${esc(p[1])}</dd>`).join('')}</dl>` : '<span class="muted">This minion did not answer, so no details are available.</span>'
      });
  }
  return `<div class="split"><div class="side"><div class="hd">TARGETS</div>${side}</div><div class="grow">${head}${body}</div></div>`;
};
acts.tgtmenu = () => { const p = $('#tgtPop'); p.hidden = !p.hidden; };
acts.savetarget = d => {
  const f = $('#tgtForm'), name = val(f, 'name'), tgt = val(f, 'tgt');
  if (!name || !tgt) throw new Error('Name and target are required.');
  const list = store.get('targets', []).filter(t => t.name !== d.old && t.name !== name);
  list.push({ name: name, tgt: tgt, tt: val(f, 'tt') });
  store.set('targets', list);
  toast('Target ' + name + ' saved.');
  const h = '#/targets/' + enc(name);
  if (location.hash === h) route(); else location.hash = h;
};
document.addEventListener('click', e => { if (!e.target.closest('[data-act=tgtmenu]')) { const p = $('#tgtPop'); if (p) p.hidden = true; } });
