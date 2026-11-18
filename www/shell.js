'use strict';
// shell.js - header menus, navigation icons, collapsible navigation, and addNav() for feature modules.
const ICONS = {
  'Dashboard': '<circle cx="8" cy="9" r="5.5"/><path d="M8 9l3-3"/>',
  'Reports': '<rect x="1.5" y="2.5" width="13" height="11"/><path d="M4.5 11V8M8 11V5.5M11.5 11V7"/>',
  'Targets': '<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>',
  'Minions': '<rect x="5" y="2" width="6" height="5"/><rect x="1.5" y="9" width="6" height="5"/><rect x="8.5" y="9" width="6" height="5"/>',
  'Minion Keys': '<circle cx="5" cy="5.5" r="3"/><path d="M7.2 7.7L14 14.5M10.8 11.3l2-2"/>',
  'Activity': '<rect x="1.5" y="3" width="13" height="10"/><path d="M4 10l2.5-3 2 2L12 6"/>',
  'Config': '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  'Compliance': '<path d="M8 1.5l5.5 2v4c0 3.5-2.4 5.9-5.5 7-3.1-1.1-5.5-3.5-5.5-7v-4z"/><path d="M5.5 8l2 2 3.2-3.6"/>',
  'Vulnerability': '<circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="1.3"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15"/>',
  'Settings': '<path d="M4 1.5v13M8 1.5v13M12 1.5v13"/><path d="M2.5 5h3M6.5 10h3M10.5 4h3"/>',
  'Administration': '<path d="M10.5 2a3.2 3.2 0 0 0-3 4.3L2 11.8 4.2 14l5.5-5.5A3.2 3.2 0 0 0 14 5.5l-2 2-1.5-.5-.5-1.5z"/>'
};
const icon = n => ICONS[n] ? `<svg class="ni" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">${ICONS[n]}</svg>` : '';
function decorateNav() {
  $$('.nav > a, .nav > details > summary').forEach(el => {
    if (el.querySelector('.ni')) return;
    el.innerHTML = icon(el.textContent.trim()) + `<span class="nl">${el.innerHTML}</span>`;
  });
}
const navLabel = e => (e.tagName === 'A' ? e : e.querySelector('summary')).textContent.trim();
// addNav('Config', '#/x', 'Label') adds a link to a group (created when missing); addNav(null, '#/x', 'Label', 'Targets') adds a top-level link after another item.
function addNav(group, href, label, after) {
  const nav = $('.nav'), foot = $('.nav-foot');
  if ($$('.nav a').some(a => a.getAttribute('href') === href)) return;
  const a = document.createElement('a');
  a.setAttribute('href', href); a.textContent = label;
  if (group) {
    let d = $$('.nav > details').find(x => navLabel(x) === group);
    if (!d) { d = document.createElement('details'); d.innerHTML = '<summary></summary>'; d.querySelector('summary').textContent = group; nav.insertBefore(d, foot); }
    d.appendChild(a);
  } else {
    const top = $$('.nav > a, .nav > details'), idx = top.findIndex(e => navLabel(e) === after);
    nav.insertBefore(a, idx >= 0 && top[idx + 1] ? top[idx + 1] : foot);
  }
  decorateNav();
}
(function () {
  const h = $('.hdr-right'), nav = $('.nav');
  h.innerHTML = `<span id="bellSlot"></span><button class="hb" data-act="about" aria-label="Help and about">?</button><span class="rel"><button class="hb" data-act="usermenu" aria-haspopup="true"><span id="who"></span> &#9662;</button><div class="pop right" id="userPop" hidden><button data-act="about">About</button><button data-act="logout">Log out</button></div></span>`;
  const b = document.createElement('button');
  b.className = 'nav-toggle'; b.setAttribute('data-act', 'navtoggle'); b.setAttribute('aria-label', 'Collapse or expand navigation'); b.innerHTML = '&laquo;';
  nav.insertBefore(b, nav.firstChild);
  if (store.get('navCollapsed', false)) $('.shell').classList.add('collapsed');
  decorateNav();
})();
acts.navtoggle = () => { store.set('navCollapsed', $('.shell').classList.toggle('collapsed')); };
acts.usermenu = () => { const p = $('#userPop'); p.hidden = !p.hidden; };
acts.about = () => {
  $('#userPop').hidden = true;
  modal('About Lab Salt Console', `<p>Version ${VERSION}. A web console for open source Salt, talking to salt-api on master <b>${esc(location.hostname)}</b>.</p><p>${DEMO ? 'You are looking at sample data. Remove <code>?demo=1</code> from the address to work with the real master.' : 'Add <code>?demo=1</code> to the address to explore the console with sample data.'}</p><p><a href="https://docs.saltproject.io/en/latest/ref/modules/all/index.html" target="_blank" rel="noopener">Salt execution modules</a> &middot; <a href="https://docs.saltproject.io/en/latest/ref/states/all/index.html" target="_blank" rel="noopener">Salt state modules</a> &middot; <a href="https://docs.saltproject.io/en/latest/topics/targeting/index.html" target="_blank" rel="noopener">Targeting</a></p>`);
};
document.addEventListener('click', e => { if (!e.target.closest('[data-act=usermenu]')) { const p = $('#userPop'); if (p) p.hidden = true; } });
