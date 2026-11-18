'use strict';
// grid.js - datagrid behaviour for every table: sort, column filters, Clear Filters, paging,
// show/hide columns, and optional row selection, row menu and row expand (opts.select / opts.menu / opts.expand).
const GRIDS = {};
const FUNNEL = '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1h10L7.5 6v4.5l-3-1.5V6z" fill="currentColor"/></svg>';
const cellText = h => String(h == null ? '' : h).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&[a-z]+;/g, ' ').trim();
const gridText = (c, r) => c.v ? String(c.v(r)) : cellText(c.f(r));

table = function (cols, rows, empty, opts) {
  opts = opts || {};
  const id = location.hash + '|' + cols.map(c => c.t).join(',') + '|' + (opts.key || '');
  const p = GRIDS[id] || {};
  const g = GRIDS[id] = { id: id, cols: cols, rows: rows, empty: empty, opts: opts, sort: p.sort == null ? (opts.sort == null ? -1 : opts.sort) : p.sort, dir: p.dir || opts.dir || 1, filters: p.filters || {}, page: p.page || 0, size: p.size || store.get('pageSize', 20), hidden: p.hidden || {}, exp: p.exp || {}, sel: {}, open: -1, colsOpen: false, menu: -1 };
  return `<div class="grid" data-grid="${esc(id)}">${gridBody(g)}</div>`;
};

function gridView(g) {
  let v = g.rows.map((r, i) => ({ r: r, i: i }));
  Object.keys(g.filters).forEach(k => {
    const f = (g.filters[k] || '').toLowerCase(), c = g.cols[k];
    if (f && c) v = v.filter(x => gridText(c, x.r).toLowerCase().indexOf(f) >= 0);
  });
  if (g.sort >= 0 && g.cols[g.sort]) {
    const c = g.cols[g.sort];
    v.sort((a, b) => {
      const x = gridText(c, a.r), y = gridText(c, b.r), nx = parseFloat(x), ny = parseFloat(y);
      return ((!isNaN(nx) && !isNaN(ny) && nx !== ny) ? nx - ny : x.localeCompare(y)) * g.dir;
    });
  }
  return v;
}

function gridBody(g) {
  const o = g.opts, view = gridView(g), n = view.length;
  const pages = Math.max(1, Math.ceil(n / g.size));
  if (g.page >= pages) g.page = pages - 1;
  const from = g.page * g.size, slice = view.slice(from, from + g.size);
  const vis = g.cols.map((c, i) => i).filter(i => !g.hidden[i]);
  const anyF = Object.keys(g.filters).some(k => g.filters[k]);
  const util = (o.select ? 1 : 0) + (o.menu ? 1 : 0) + (o.expand ? 1 : 0);
  const head = (o.select ? '<th class="util"><input type="checkbox" class="selall" aria-label="Select all rows"></th>' : '') + (o.menu ? '<th class="util"></th>' : '') + (o.expand ? '<th class="util"></th>' : '') +
    vis.map(i => {
      const c = g.cols[i];
      if (!c.t) return '<th class="util"></th>';
      return `<th><span class="thw"><button class="thb" data-g="sort" data-i="${i}">${esc(c.t)}${g.sort === i ? (g.dir > 0 ? ' &uarr;' : ' &darr;') : ''}</button><button class="fb${g.filters[i] ? ' act' : ''}" data-g="filt" data-i="${i}" aria-label="Filter ${esc(c.t)}">${FUNNEL}</button></span>${g.open === i ? `<input class="finp" data-i="${i}" value="${esc(g.filters[i] || '')}" placeholder="Filter" aria-label="Filter ${esc(c.t)}">` : ''}</th>`;
    }).join('');
  const body = slice.map(x => {
    const key = o.select ? String(o.select(x.r)) : '';
    let h = '<tr>' + (o.select ? `<td class="util"><input type="checkbox" class="sel" value="${esc(key)}"${g.sel[key] ? ' checked' : ''} aria-label="Select ${esc(key)}"></td>` : '') +
      (o.menu ? `<td class="util rel"><button class="ib" data-g="menu" data-r="${x.i}" aria-label="Row actions">&#8942;</button>${g.menu === x.i ? `<div class="pop">${o.menu(x.r)}</div>` : ''}</td>` : '') +
      (o.expand ? `<td class="util"><button class="ib" data-g="exp" data-r="${x.i}" aria-label="Show or hide details">${g.exp[x.i] ? '&#8964;' : '&raquo;'}</button></td>` : '') +
      vis.map(i => `<td>${g.cols[i].f(x.r)}</td>`).join('') + '</tr>';
    if (o.expand && g.exp[x.i]) h += `<tr class="exprow"><td colspan="${vis.length + util}">${o.expand(x.r)}</td></tr>`;
    return h;
  }).join('');
  const colsPop = g.colsOpen ? `<div class="pop up">${g.cols.map((c, i) => c.t ? `<label class="chk"><input type="checkbox" class="colchk" data-i="${i}"${g.hidden[i] ? '' : ' checked'}> ${esc(c.t)}</label>` : '').join('')}</div>` : '';
  return `<div class="gbar"><button class="btn btn-sm" data-g="clear"${anyF ? '' : ' disabled'}>Clear Filters</button></div><div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${n ? '' : `<div class="empty">${esc(g.empty || "We couldn't find any items!")}</div>`}` +
    `<div class="tfoot"><span class="rel"><button class="ib" data-g="cols" aria-label="Show or hide columns">&#9707;</button>${colsPop}</span><span class="spacer"></span>Items per page <select class="psize" aria-label="Items per page">${[10, 20, 50, 100].map(s => `<option${s === g.size ? ' selected' : ''}>${s}</option>`).join('')}</select><span>${n ? (from + 1) + ' - ' + Math.min(n, from + g.size) : 0} of ${n} item${n === 1 ? '' : 's'}</span><button class="ib" data-g="prev"${g.page ? '' : ' disabled'} aria-label="Previous page">&lsaquo;</button><button class="ib" data-g="next"${g.page < pages - 1 ? '' : ' disabled'} aria-label="Next page">&rsaquo;</button></div></div>`;
}

function gridOf(el) { const d = el.closest('[data-grid]'); return d && GRIDS[d.dataset.grid] ? { d: d, g: GRIDS[d.dataset.grid] } : null; }
function syncSel() { const any = $$('.sel:checked').length > 0; $$('.needs-sel').forEach(b => { b.disabled = !any; }); }
function gridDraw(x, focus) {
  x.d.innerHTML = gridBody(x.g);
  if (focus) { const inp = x.d.querySelector('.finp'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }
  syncSel();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-g]');
  if (!b) {
    if (e.target.closest('.pop') && !e.target.closest('[data-act]')) return;
    $$('[data-grid]').forEach(d => { const g = GRIDS[d.dataset.grid]; if (g && (g.menu >= 0 || g.colsOpen)) { g.menu = -1; g.colsOpen = false; d.innerHTML = gridBody(g); } });
    return;
  }
  const x = gridOf(b);
  if (!x) return;
  const g = x.g, i = +b.dataset.i, r = +b.dataset.r;
  switch (b.dataset.g) {
    case 'sort': if (g.sort === i) { if (g.dir > 0) g.dir = -1; else { g.sort = -1; g.dir = 1; } } else { g.sort = i; g.dir = 1; } break;
    case 'filt': g.open = g.open === i ? -1 : i; gridDraw(x, true); return;
    case 'clear': g.filters = {}; g.open = -1; g.page = 0; break;
    case 'prev': g.page--; break;
    case 'next': g.page++; break;
    case 'cols': g.colsOpen = !g.colsOpen; break;
    case 'menu': g.menu = g.menu === r ? -1 : r; break;
    case 'exp': g.exp[r] = !g.exp[r]; break;
  }
  gridDraw(x);
});
document.addEventListener('input', e => {
  if (!e.target.classList || !e.target.classList.contains('finp')) return;
  const x = gridOf(e.target);
  if (!x) return;
  x.g.filters[+e.target.dataset.i] = e.target.value; x.g.page = 0;
  gridDraw(x, true);
});
document.addEventListener('change', e => {
  const t = e.target, c = t.classList;
  if (!c) return;
  const x = gridOf(t);
  if (!x) return;
  const g = x.g;
  if (c.contains('psize')) { g.size = +t.value; g.page = 0; store.set('pageSize', g.size); gridDraw(x); }
  else if (c.contains('colchk')) { g.hidden[+t.dataset.i] = !t.checked; g.colsOpen = true; gridDraw(x); }
  else if (c.contains('sel')) { g.sel[t.value] = t.checked; syncSel(); }
  else if (c.contains('selall')) { $$('.sel', x.d).forEach(s => { s.checked = t.checked; g.sel[s.value] = t.checked; }); syncSel(); }
});
