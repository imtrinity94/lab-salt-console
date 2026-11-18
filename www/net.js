'use strict';
// net.js - request discipline for salt-api.
// 1. salt-api serves runner and wheel calls from threads that share Salt's module loader. When several arrive at once,
//    one can fail inside salt-api with HTTP 500 ("Failed to import runners jobs" in /var/log/salt/api), so runner and
//    wheel requests are sent one at a time.
// 2. Read-only calls are retried once after an HTTP 500. Calls that change something are never retried.
(function () {
  const send = raw;
  const READ = /^(jobs\.|manage\.|fileserver\.|config\.get$|key\.(list|finger)|file_roots\.(list|read|find)|pillar_roots\.(list|read|find)|grains\.item|pillar\.items$|pkg\.list_|schedule\.list$|test\.(ping|version)$|file\.file_exists$)/;
  let chain = Promise.resolve();
  raw = function (path, body) {
    const low = Array.isArray(body) ? body[0] : null;
    if (path !== '/' || !low) return send(path, body);
    const readOnly = READ.test(low.fun || '') && !/_async$/.test(low.client || '');
    const run = async () => {
      try { return await send(path, body); }
      catch (e) { if (readOnly && /HTTP 500/.test(e.message)) return send(path, body); throw e; }
    };
    if (!/^(runner|wheel)/.test(low.client || '')) return run();
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
})();

// A runner call costs most of a second on a small master, and the result of a finished job never changes.
// jobDetail() keeps finished job results for the life of the page, so tabs that read many jobs stay quick after the first load.
const JOB_CACHE = {};
async function jobDetail(jid) {
  if (JOB_CACHE[jid]) return JOB_CACHE[jid];
  const d = await runner('jobs.list_job', { jid: jid });
  if (d && !d.Error) {
    const res = d.Result || {}, mins = d.Minions || [];
    const started = Date.UTC(+jid.slice(0, 4), +jid.slice(4, 6) - 1, +jid.slice(6, 8), +jid.slice(8, 10), +jid.slice(10, 12), +jid.slice(12, 14));
    const allBack = mins.length > 0 && mins.every(m => m in res);
    if (allBack || Date.now() - started > 3600000) JOB_CACHE[jid] = d; // complete, or old enough that late returns are unlikely
  }
  return d;
}
