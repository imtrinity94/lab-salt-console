'use strict';
// net.js - salt-api serves runner and wheel calls from threads that share Salt's module loader. When several arrive
// at once, one can fail inside salt-api with HTTP 500 (seen as "Failed to import runners jobs" in /var/log/salt/api).
// Runner and wheel requests are therefore sent one at a time, and read-only ones are retried once.
(function () {
  const send = raw;
  const READ = /^(jobs\.|manage\.|fileserver\.|config\.get$|key\.(list|finger)|file_roots\.(list|read|find)|pillar_roots\.(list|read|find))/;
  let chain = Promise.resolve();
  raw = function (path, body) {
    const low = Array.isArray(body) ? body[0] : null;
    if (path !== '/' || !low || !/^(runner|wheel)/.test(low.client || '')) return send(path, body);
    const run = async () => {
      try { return await send(path, body); }
      catch (e) { if (READ.test(low.fun || '') && /HTTP 500/.test(e.message)) return send(path, body); throw e; }
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
})();
