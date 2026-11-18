'use strict';
// demo.js - sample data mode. Open the UI with ?demo=1 and no salt-api calls are made.
const DEMO = /[?&]demo=1/.test(location.search);
const DEMO_FX = {};
if (DEMO) (function () {
  const M = ['app-01', 'db-01', 'lab-salt01', 'web-01', 'web-02', 'win-01'];
  const DOWN = ['win-01'];
  const mk = (os, rel, ip, cpu, mem) => ({ os: os, osrelease: rel, os_family: os === 'Windows' ? 'Windows' : os === 'Rocky' ? 'RedHat' : 'Debian', kernel: os === 'Windows' ? 'Windows' : 'Linux', saltversion: '3006.30', ipv4: ['127.0.0.1', ip], num_cpus: cpu, mem_total: mem, virtual: 'VMware', cpu_model: 'Intel(R) Xeon(R) Gold 6338', osarch: 'amd64' });
  const G = { 'app-01': mk('Ubuntu', '24.04', '10.20.44.91', 2, 4096), 'db-01': mk('Rocky', '9.4', '10.20.44.92', 4, 16384), 'lab-salt01': mk('Ubuntu', '24.04', '10.20.44.77', 2, 4096), 'web-01': mk('Ubuntu', '24.04', '10.20.44.93', 2, 2048), 'web-02': mk('Ubuntu', '24.04', '10.20.44.94', 2, 2048), 'win-01': mk('Windows', '2022Server', '10.20.44.95', 4, 8192) };
  Object.keys(G).forEach(k => { G[k].id = k; G[k].fqdn = k + '.vmw.lab'; G[k].master = '10.20.44.77'; });
  function match(low) {
    const t = low.tgt, tt = low.tgt_type || 'glob';
    if (tt === 'list') { const l = Array.isArray(t) ? t : String(t).split(','); return M.filter(m => l.indexOf(m) >= 0); }
    if (tt === 'grain') { const p = String(t).split(':'); return M.filter(m => String(G[m][p[0]]) === p[1]); }
    const re = new RegExp('^' + String(t).replace(/[.+^$(){}|]/g, '.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return M.filter(m => re.test(m));
  }
  const each = (low, fn) => { const o = {}; match(low).filter(m => DOWN.indexOf(m) < 0).forEach(m => { o[m] = fn(m); }); return o; };
  const two = n => (n < 10 ? '0' : '') + n;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const jidAt = (daysAgo, h, mi) => { const d = new Date(Date.now() - daysAgo * 864e5); return d.getUTCFullYear() + two(d.getUTCMonth() + 1) + two(d.getUTCDate()) + two(h) + two(mi) + '09929571'; };
  const stamp = j => j.slice(0, 4) + ', ' + MON[+j.slice(4, 6) - 1] + ' ' + j.slice(6, 8) + ' ' + j.slice(8, 10) + ':' + j.slice(10, 12) + ':' + j.slice(12, 14) + '.' + j.slice(14);
  const J = {};
  const job = (jid, fun, args, tgt, user, tt) => { J[jid] = { Function: fun, Arguments: args, Target: tgt, 'Target-type': tt || 'glob', User: user, StartTime: stamp(jid) }; return jid; };
  [9, 7, 5, 3, 2, 1, 0].forEach(d => job(jidAt(d, 9, 35), 'state.apply', [], '*', d % 2 ? 'root' : 'saltapi'));
  job(jidAt(0, 10, 2), 'test.ping', [], '*', 'saltapi');
  job(jidAt(0, 10, 15), 'cmd.run', ['uptime'], 'web-*', 'saltapi');
  job(jidAt(1, 16, 40), 'pkg.list_upgrades', [], 'os:Ubuntu', 'saltapi', 'grain');
  job(jidAt(2, 11, 5), 'state.apply', ['web.nginx'], 'web-*', 'saltapi');
  const ST = [['pkg', 'base_packages', 'common.packages', 'installed', ''], ['user', 'ops_user_present', 'common.users', 'present', ''], ['file', 'ntp_configured', 'common.ntp', 'managed', ''], ['pkg', 'nginx_installed', 'web.nginx', 'installed', 'web'], ['service', 'nginx_running', 'web.nginx', 'running', 'web'], ['file', 'default_site_page', 'web.nginx', 'managed', 'web'], ['firewalld', 'http_port_open', 'firewall', 'present', 'web']];
  function hsResult(jid, m, only) {
    const seed = +jid.slice(6, 8), o = {};
    ST.forEach((s, i) => {
      if (s[4] && m.indexOf(s[4]) !== 0) return;
      if (only && s[2] !== only) return;
      const changed = (seed + i + m.length) % 4 === 0, failed = m === 'db-01' && s[1] === 'ntp_configured' && seed % 2 === 0;
      o[s[0] + '_|-' + s[1] + '_|-' + s[1] + '_|-' + s[3]] = { __id__: s[1], __sls__: s[2], __run_num__: i, result: !failed, changes: changed && !failed ? { diff: 'updated' } : {}, duration: 40 + ((seed * 7 + i * 53 + m.length * 11) % 400), comment: failed ? 'Source file salt://common/files/chrony.conf not found' : changed ? 'State ' + s[1] + ' updated the system' : 'State ' + s[1] + ' is in the correct state' };
    });
    return o;
  }
  const SLS = { 'top.sls': "base:\n  '*':\n    - common.packages\n    - common.users\n    - common.ntp\n  'web-*':\n    - web.nginx\n    - firewall\n", 'common/packages.sls': 'base_packages:\n  pkg.installed:\n    - pkgs:\n      - curl\n      - vim\n', 'common/users.sls': 'ops_user_present:\n  user.present:\n    - name: ops\n', 'common/ntp.sls': 'ntp_configured:\n  file.managed:\n    - name: /etc/chrony.conf\n    - source: salt://common/files/chrony.conf\n', 'web/nginx.sls': 'nginx_installed:\n  pkg.installed:\n    - name: nginx\n', 'firewall.sls': 'http_port_open:\n  firewalld.present:\n    - name: public\n    - ports:\n      - 80/tcp\n' };
  const PIL = { 'top.sls': "base:\n  '*':\n    - common\n", 'common.sls': 'environment: lab\nntp:\n  servers:\n    - 10.20.44.11\n    - 10.20.44.12\n' };
  const tree = map => { const t = {}; Object.keys(map).forEach(p => { const parts = p.split('/'); let n = t; parts.forEach((x, i) => { if (i === parts.length - 1) n[x] = 'f'; else n = n[x] || (n[x] = {}); }); }); return t; };
  Object.assign(DEMO_FX, {
    _M: M, _G: G, _J: J, _DOWN: DOWN, _match: match, _each: each, _jidAt: jidAt, _job: job, _SLS: SLS, _hsResult: hsResult,
    'key.list_all': () => ({ minions: M, minions_pre: ['new-vm-07'], minions_rejected: ['old-test-02'], minions_denied: [], local: ['master.pem', 'master.pub'] }),
    'manage.status': () => ({ up: M.filter(m => DOWN.indexOf(m) < 0), down: DOWN }),
    'jobs.list_jobs': () => J,
    'jobs.active': () => ({}),
    'jobs.list_job': low => {
      const j = J[low.jid];
      if (!j) return { Error: 'Cannot contact returner or no job with this jid' };
      const mins = match({ tgt: j.Target, tgt_type: j['Target-type'] }), res = {};
      mins.filter(m => DOWN.indexOf(m) < 0).forEach(m => {
        let ret = true, rc = 0;
        if (j.Function === 'state.apply') { ret = hsResult(low.jid, m, j.Arguments[0]); if (Object.keys(ret).some(k => !ret[k].result)) rc = 2; }
        else if (j.Function === 'cmd.run') ret = ' 10:15:02 up 12 days,  3:41,  1 user,  load average: 0.08, 0.03, 0.01';
        else if (j.Function === 'pkg.list_upgrades') ret = { openssl: '3.0.13-0ubuntu3.6', 'libssl3t64': '3.0.13-0ubuntu3.6', curl: '8.5.0-2ubuntu10.7' };
        res[m] = { return: ret, retcode: rc, success: rc === 0 };
      });
      return Object.assign({ jid: low.jid, Minions: mins, Result: res }, j);
    },
    'grains.items': low => each(low, m => G[m]),
    'schedule.list': low => each(low, m => m.indexOf('web') === 0 ? { highstate_hourly: { function: 'state.apply', seconds: 3600, enabled: true, name: 'highstate_hourly' } } : m === 'db-01' ? { backup_check: { function: 'cmd.run', args: ['/usr/local/bin/check-backup.sh'], hours: 24, enabled: true, name: 'backup_check' } } : {}),
    'pillar.items': low => each(low, m => ({ environment: 'lab', role: m.split('-')[0], ntp: { servers: ['10.20.44.11', '10.20.44.12'] } })),
    'file_roots.list_env': () => ({ '/srv/salt': tree(SLS) }),
    'file_roots.read': low => [{ ['/srv/salt/' + low.path]: SLS[low.path] || '' }],
    'file_roots.write': low => { SLS[low.path] = low.data; return 'Wrote data to file ' + low.path; },
    'pillar_roots.list_env': () => ({ '/srv/pillar': tree(PIL) }),
    'pillar_roots.read': low => [{ ['/srv/pillar/' + low.path]: PIL[low.path] || '' }],
    'pillar_roots.write': low => { PIL[low.path] = low.data; return 'Wrote data to file ' + low.path; }
  });
  raw = async function (path, body) {
    if (path === '/login') return { token: 'demo', user: 'demo' };
    const low = body[0], fn = DEMO_FX[low.fun];
    let r;
    if (/_async$/.test(low.client)) r = { jid: job(jidAt(0, 12, 0).slice(0, 12) + two(new Date().getSeconds()) + '000001', low.fun, low.arg || [], low.tgt, 'demo', low.tgt_type), minions: match(low) };
    else if (fn) r = fn(low);
    else r = low.client === 'local' ? each(low, () => true) : {};
    return low.client === 'wheel' ? { tag: 'demo', data: { return: r, success: true } } : r;
  };
  token = 'demo';
  who = 'demo (sample data)';
})();
