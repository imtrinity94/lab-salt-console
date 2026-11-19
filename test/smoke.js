// test/smoke.js - renders every route of the UI outside a browser.
// Live:  API_PW=<salt-api password> node test/smoke.js     Sample data:  DEMO=1 node test/smoke.js
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the master's own self-signed certificate on 127.0.0.1
const fs = require('fs'), vm = require('vm'), path = require('path');
const www = path.join(__dirname, '..', 'www');
const demo = process.env.DEMO === '1';
const el = () => new Proxy(function () {}, {
  get: (t, k) => k === 'hidden' ? false : (k === 'value' || k === 'textContent' || k === 'innerHTML' || k === 'className') ? '' : k === 'dataset' ? {} : k === 'length' ? 0 : (k === 'then' || k === Symbol.iterator) ? undefined : k === Symbol.toPrimitive ? () => '' : el(),
  set: () => true, apply: () => el()
});
const mem = {};
const st = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; }, removeItem: k => { delete mem[k]; } };
const realFetch = fetch;
const ctx = { console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN, Intl,
  document: { querySelector: () => el(), querySelectorAll: () => [], getElementById: () => el(), addEventListener() {}, createElement: () => el(), body: el() },
  window: { addEventListener() {}, removeEventListener() {} }, navigator: {}, localStorage: st, sessionStorage: st,
  location: { hash: '', hostname: 'lab-salt01', search: demo ? '?demo=1' : '' },
  fetch: (u, o) => realFetch('https://127.0.0.1' + u, o), API_PW: process.env.API_PW || '', IS_DEMO: demo,
  EXTRA: JSON.parse(fs.readFileSync(path.join(__dirname, 'extra.json'), 'utf8')) };
vm.createContext(ctx);
const scripts = Array.from(fs.readFileSync(path.join(www, 'index.html'), 'utf8').matchAll(/<script src="([^"?]+)/g)).map(m => m[1]);
const tail = "\n;globalThis.__t = async () => { if (!IS_DEMO) { const r = await raw('/login', { username: 'saltapi', password: API_PW, eauth: 'pam' }); token = r.token; } if (typeof refreshShared === 'function') await refreshShared(); const out = {}; const bad = /undefined|\\[object|NaN/; const list = Object.keys(routes).map(n => [n, '']).concat(EXTRA); for (const t of list) { const k = t[0] + '/' + t[1]; try { let a = t[1]; if (t[0] === 'job' && !a) { const jl = jobList(await runner('jobs.list_jobs')); a = jl.length ? jl[0].jid : '0'; } const h = await routes[t[0]](a); out[k] = typeof h !== 'string' ? 'NOT A STRING' : bad.test(h) ? 'SUSPECT ' + (bad.exec(h).index) + ': ' + h.substr(Math.max(0, bad.exec(h).index - 60), 120) : 'ok ' + h.length; } catch (e) { out[k] = 'ERR ' + e.message; } } return out; };";
vm.runInContext(scripts.map(f => fs.readFileSync(path.join(www, f), 'utf8')).join('\n;\n') + tail, ctx, { filename: 'bundle.js' });
ctx.__t().then(o => {
  const keys = Object.keys(o), fail = keys.filter(k => o[k].indexOf('ok ') !== 0);
  fail.forEach(k => console.log('FAIL ' + k + ' -> ' + o[k]));
  console.log((demo ? 'demo' : 'live') + ': ' + scripts.length + ' scripts, ' + (keys.length - fail.length) + '/' + keys.length + ' routes ok');
  process.exit(fail.length ? 1 : 0);
}).catch(e => { console.log('FATAL ' + (e && e.stack || e)); process.exit(2); });
