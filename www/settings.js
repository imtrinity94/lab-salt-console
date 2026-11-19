'use strict';
// settings.js - User Preferences (theme, automatic logout, page size), Login Banner,
// and File Server / Pillar file extras: saltenv selector, delete and rename.
addNav('Settings', '#/settings', 'User Preferences');
addNav('Settings', '#/settings/banner', 'Login Banner');
const BANNER_PATH = '/opt/salt-ui/www/banner.json';
function applyTheme() { document.body.classList.toggle('dark', store.get('theme', 'light') === 'dark'); }
applyTheme();

// Automatic logout after a period without clicks or key presses.
let lastActive = Date.now();
['click', 'keydown'].forEach(ev => document.addEventListener(ev, () => { lastActive = Date.now(); }));
setInterval(() => {
  const min = store.get('idleMin', 30);
  if (token && !DEMO && Date.now() - lastActive > min * 60000) { toast('Logged out after ' + min + ' minutes without activity.'); logout(); }
}, 30000);

async function loadBanner() {
  try { const r = await fetch('banner.json?t=' + Date.now()); if (!r.ok) return null; const b = await r.json(); return b && typeof b === 'object' ? b : null; } catch (e) { return null; }
}
(async function () {
  const form = $('#loginForm'), el = document.createElement('div');
  el.id = 'loginBanner'; el.hidden = true;
  form.insertBefore(el, form.querySelector('label'));
  const b = await loadBanner();
  if (b && b.enabled && b.message) { el.className = b.style === 'warning' ? 'alert' : 'note'; el.textContent = b.message; el.hidden = false; }
})();

routes.settings = async function (arg) {
  const t = tabs([['#/settings', 'User Preferences', !arg], ['#/settings/banner', 'Login Banner', arg === 'banner'], ['#/settings/service', 'Console Service', arg === 'service']]);
  if (arg === 'banner') {
    const b = (await loadBanner()) || { enabled: false, style: 'info', message: '' };
    return `<h1>Settings</h1>${t}<div id="bannerForm" style="max-width:560px"><p class="muted">Shown on the login page to everyone who opens this console. Stored on the master in ${BANNER_PATH}.</p>` +
      `<label class="chk"><input type="checkbox" name="enabled"${b.enabled ? ' checked' : ''}> Show the banner</label>` +
      `<label>Style<select name="style"><option value="info"${b.style !== 'warning' ? ' selected' : ''}>Info</option><option value="warning"${b.style === 'warning' ? ' selected' : ''}>Warning</option></select></label>` +
      `<label>Message<textarea name="message" class="short">${esc(b.message || '')}</textarea></label><div class="bar"><button class="btn btn-primary" data-act="savebanner">Save</button></div></div>`;
  }
  const theme = store.get('theme', 'light'), size = store.get('pageSize', 20);
  return `<h1>Settings</h1>${t}<div style="max-width:420px"><p class="muted">These preferences are kept in this browser.</p>` +
    `<label>Theme<select data-change="settheme"><option value="light"${theme === 'light' ? ' selected' : ''}>Light</option><option value="dark"${theme === 'dark' ? ' selected' : ''}>Dark</option></select></label>` +
    `<label>Automatic logout after (minutes, 1 to 60)<input type="number" min="1" max="60" value="${esc(store.get('idleMin', 30))}" data-change="setidle"></label>` +
    `<label>Default items per page<select data-change="setpage">${[10, 20, 50, 100].map(n => `<option${n === size ? ' selected' : ''}>${n}</option>`).join('')}</select></label></div>`;
};
acts.settheme = v => { store.set('theme', v); applyTheme(); };
acts.setidle = v => { const n = Math.min(60, Math.max(1, parseInt(v, 10) || 30)); store.set('idleMin', n); toast('Automatic logout set to ' + n + ' minutes.'); };
acts.setpage = v => { store.set('pageSize', +v); Object.keys(GRIDS).forEach(k => { GRIDS[k].size = +v; }); toast('Tables now show ' + v + ' items per page.'); };
acts.savebanner = async () => {
  const f = $('#bannerForm'), b = { enabled: $('[name=enabled]', f).checked, style: val(f, 'style'), message: val(f, 'message') };
  if (b.enabled && !b.message) throw new Error('Enter a message, or switch the banner off.');
  // The text goes in the args keyword: positional runner arguments are re-parsed by Salt and would not stay valid JSON.
  await runner('salt.cmd', { arg: ['file.write', BANNER_PATH], kwarg: { args: JSON.stringify(b) } });
  toast('Login banner saved.');
};

// ---------- File Server and Pillar files: saltenv, delete, rename ----------
rootsEditor = async function (kind, base, cur) {
  const isFile = kind === 'file_roots';
  let envs = ['base'];
  try {
    const e = isFile ? await runner('fileserver.envs') : Object.keys((await runner('config.get', { arg: ['pillar_roots'] })) || {});
    if (Array.isArray(e) && e.length) envs = e;
  } catch (x) { /* keep base */ }
  let env = store.get('saltenv:' + kind, 'base');
  if (envs.indexOf(env) < 0) env = envs[0];
  const tree = await wheel(kind + '.list_env', { saltenv: env });
  const files = [], roots = Object.keys(tree || {}).filter(k => k.charAt(0) === '/');
  (function walk(n, p) {
    if (!n || typeof n !== 'object') return;
    Object.keys(n).forEach(k => { const v = n[k]; if (typeof v === 'string') files.push(p + k); else walk(v, k.charAt(0) === '/' ? p : p + k + '/'); });
  })(tree, '');
  files.sort();
  let content = '', full = '';
  if (cur) {
    const r = await wheel(kind + '.read', { path: cur, saltenv: env });
    if (Array.isArray(r) && r[0]) { full = Object.keys(r[0])[0]; content = r[0][full]; }
  }
  const d = `data-kind="${kind}" data-base="${esc(base)}" data-env="${esc(env)}"`;
  return `<div class="split"><div class="side"><div class="hd"><label class="inl">saltenv <select data-change="setenv" ${d} aria-label="Salt environment">${envs.map(e => `<option${e === env ? ' selected' : ''}>${esc(e)}</option>`).join('')}</select></label></div><div class="hd">${esc(roots.join(', ') || (isFile ? 'file roots' : 'pillar roots'))}</div>` +
    `${files.map(f => `<a class="${f === cur ? 'on' : ''}" href="${base}${enc(f)}">${esc(f)}</a>`).join('')}<a href="${base}"><b>+ New file</b></a></div>` +
    `<div class="grow"><label>Path, relative to the root<input id="fpath" value="${esc(cur)}" placeholder="lab/example.sls"></label><label>Content<textarea id="fdata" spellcheck="false">${esc(content)}</textarea></label>` +
    `<div class="bar"><button class="btn btn-primary" data-act="savefile" ${d}>Save</button>${full ? `<button class="btn" data-act="renfile" ${d} data-full="${esc(full)}" data-cur="${esc(cur)}">Rename</button><button class="btn" data-act="delfile" ${d} data-full="${esc(full)}" data-cur="${esc(cur)}">Delete</button>` : ''}</div></div></div>`;
};
const goHash = h => { if (location.hash === h) route(); else location.hash = h; };
const safeRel = p => !!p && p.charAt(0) !== '/' && p.split('/').indexOf('..') < 0;
acts.setenv = (v, el) => { store.set('saltenv:' + el.dataset.kind, v); goHash(el.dataset.base); };
acts.savefile = async d => {
  const path = $('#fpath').value.trim();
  if (!safeRel(path)) throw new Error('Enter a path relative to the root, without "..".');
  await wheel(d.kind + '.write', { data: $('#fdata').value, path: path, saltenv: d.env || 'base' });
  toast('Saved ' + path);
  goHash(d.base + enc(path));
};
acts.delfile = d => {
  modal('Delete File', `<p>Delete <b>${esc(d.cur)}</b> from the master? This cannot be undone from the console.</p>`, [{ label: 'Delete', danger: true, fn: async () => {
    const ok = await runner('salt.cmd', { arg: ['file.remove', d.full] });
    if (ok !== true) throw new Error('The master did not confirm the delete.');
    toast('Deleted ' + d.cur);
    goHash(d.base);
  } }]);
};
acts.renfile = d => {
  modal('Rename File', `<label>New path, relative to the root<input name="to" value="${esc(d.cur)}"></label><p class="muted">The content currently in the editor is saved under the new path, then the old file is removed.</p>`, [{ label: 'Rename', primary: true, fn: async m => {
    const to = val(m, 'to');
    if (!safeRel(to)) throw new Error('Enter a path relative to the root, without "..".');
    if (to === d.cur) return;
    await wheel(d.kind + '.write', { data: $('#fdata').value, path: to, saltenv: d.env || 'base' });
    const ok = await runner('salt.cmd', { arg: ['file.remove', d.full] });
    toast(ok === true ? 'Renamed to ' + to : 'Saved as ' + to + ', but the old file could not be removed.', ok === true ? '' : 'error');
    goHash(d.base + enc(to));
  } }]);
};
if (DEMO) Object.assign(DEMO_FX, {
  'fileserver.envs': () => ['base'],
  'config.get': () => ({ base: ['/srv/pillar'] }),
  'salt.cmd': low => {
    const a = low.arg || [];
    if (a[0] === 'test.version') return '3006.30';
    if (a[0] === 'file.remove') delete DEMO_FX._SLS[String(a[1]).replace('/srv/salt/', '')];
    return true;
  }
});
