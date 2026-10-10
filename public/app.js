'use strict';
/* Flickr archive browser — vanilla JS SPA, hash routed: #/<user>/<tab>/<arg>?k=v&p=<photoId> */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_L = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const nf = new Intl.NumberFormat('en-GB');
const fmtN = (n) => nf.format(+n || 0);

const state = { users: [], cache: {}, lastKey: null, lbOpen: false, lbPushed: false, lbIds: [] };

/* ---------- helpers ---------- */
function fmtDate(s, withTime) {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d))?/.exec(s || '');
  if (!m) return s || '';
  let out = `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`;
  if (withTime && m[4]) out += ` ${m[4]}:${m[5]}`;
  return out;
}
function unixToStr(u) {
  const n = +u; if (!n) return null;
  return new Date(n * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
const prettyKey = (k) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const ALLOWED = new Set(['A', 'BR', 'B', 'I', 'EM', 'STRONG', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'U', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'PRE', 'CODE', 'HR']);
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}`, 'text/html');
  const walk = (node) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 3) continue;
      if (c.nodeType !== 1) { c.remove(); continue; }
      if (!ALLOWED.has(c.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG'].includes(c.tagName)) { c.remove(); continue; }
        walk(c); c.replaceWith(...c.childNodes); continue;
      }
      for (const a of [...c.attributes]) {
        if (!(c.tagName === 'A' && a.name === 'href')) c.removeAttribute(a.name);
      }
      if (c.tagName === 'A') {
        const h = c.getAttribute('href') || '';
        if (!/^https?:\/\//i.test(h)) c.removeAttribute('href');
        c.setAttribute('target', '_blank'); c.setAttribute('rel', 'noopener noreferrer');
      }
      walk(c);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}
/** plain-text-ish with possible html; keep newlines */
const rich = (s) => sanitize(s);

const thumb = (u, id, k = 't') => `/media/${encodeURIComponent(u)}/${id}/${k}`;
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/* ---------- data ---------- */
async function loadUserData(name) {
  if (state.cache[name]) return state.cache[name];
  const [data, photos] = await Promise.all([getJson(`/api/u/${encodeURIComponent(name)}`), getJson(`/api/u/${encodeURIComponent(name)}/photos`)]);
  const byId = new Map(photos.map((p) => [p.id, p]));
  const albumsById = new Map((data.albums || []).map((a) => [String(a.id), a]));
  // name lookup: last url path segment (nsid or alias) -> display name
  const names = new Map();
  const addNames = (obj) => {
    for (const [n, url] of Object.entries(obj || {})) {
      const seg = String(url).replace(/\/+$/, '').split('/').pop();
      if (seg) names.set(seg.toLowerCase(), n);
    }
  };
  addNames(data.contacts); addNames(data.followers);
  const pr = data.profile || {};
  if (pr.nsid) names.set(pr.nsid.toLowerCase(), pr.screen_name || pr.real_name || name);
  if (pr.path_alias) names.set(pr.path_alias.toLowerCase(), pr.screen_name || pr.real_name || name);
  for (const m of [...(data.mailOut || [])]) if (m.to_user_id && m.to_user_name) names.set(m.to_user_id.toLowerCase(), m.to_user_name);
  // photos by taken for stable default order
  photos.sort((a, b) => (b.taken || '').localeCompare(a.taken || ''));
  const entry = { name, data, photos, byId, albumsById, names };
  state.cache[name] = entry;
  return entry;
}
const userInfo = (name) => state.users.find((u) => u.name === name);

function localUserFor(idOrAlias) {
  const k = String(idOrAlias || '').toLowerCase();
  return state.users.find((u) => (u.nsid && u.nsid.toLowerCase() === k) || (u.alias && u.alias.toLowerCase() === k));
}
/** html for a person reference (nsid/alias/name) from the perspective of cache entry E */
function person(E, ref, fallbackName) {
  if (!ref) return esc(fallbackName || 'Unknown');
  const key = String(ref).replace(/\/+$/, '').split('/').pop();
  const local = localUserFor(key);
  const nm = E.names.get(key.toLowerCase()) || fallbackName || key;
  const ext = `https://www.flickr.com/people/${encodeURIComponent(key)}/`;
  if (local) return `<a href="#/${esc(local.name)}/overview" title="Local archive">${esc(nm)}</a> <span class="pill">archive</span>`;
  return `<a href="${esc(ext)}" target="_blank" rel="noopener">${esc(nm)}</a>`;
}

/* ---------- routing ---------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [pathPart, q = ''] = h.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = Object.fromEntries(new URLSearchParams(q));
  return { parts, query };
}
function buildHash(parts, query) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== '' && v != null && v !== false) q.set(k, v === true ? '1' : v);
  const qs = q.toString();
  return '#/' + parts.map(encodeURIComponent).join('/') + (qs ? '?' + qs : '');
}
const keyOf = ({ parts, query }) => { const rest = { ...query }; delete rest.p; return JSON.stringify([parts, rest]); };

function replaceHash(parts, query) {
  history.replaceState(null, '', buildHash(parts, query));
  state.lastKey = keyOf(parseHash());
}
function updateQuery(patch) {
  const r = parseHash();
  const query = { ...r.query, ...patch };
  for (const k of Object.keys(query)) if (query[k] === '' || query[k] == null || query[k] === false) delete query[k];
  replaceHash(r.parts, query);
}

window.addEventListener('hashchange', route);

async function route() {
  const r = parseHash();
  const key = keyOf(r);
  if (key !== state.lastKey) {
    state.lastKey = key;
    window.scrollTo(0, 0);
    try { await renderPage(r); } catch (e) { console.error(e); $('#app').innerHTML = `<div class="page"><div class="card">Error: ${esc(e.message)}</div></div>`; }
  }
  await syncLightbox(r);
}

/* ---------- top bar ---------- */
function renderUserSwitch(active) {
  const single = state.users.length === 1;
  $('.logo').href = single ? `#/${state.users[0].name}/overview` : '#/';
  if (single) { $('#userswitch').innerHTML = ''; return; }
  $('#userswitch').innerHTML = state.users.map((u) =>
    `<a href="#/${esc(u.name)}/overview" class="${u.name === active ? 'on' : ''}">${esc(cap(u.name))}</a>`).join('');
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function pollStatus() {
  try {
    const s = await getJson('/api/status');
    $('#thumbstatus').textContent = s.running ? `Generating thumbnails… ${s.done}/${s.total}` : '';
  } catch { /* ignore */ }
}

/* ---------- landing ---------- */
function renderLanding() {
  renderUserSwitch(null);
  const cards = state.users.map((u) => {
    if (!u.populated || (!u.photos && !u.joined)) {
      return `<a class="ucard empty" href="#/${esc(u.name)}/overview"><div class="info"><h2>${esc(cap(u.name))}</h2><div class="meta">Backup not populated yet</div></div></a>`;
    }
    const ids = shuffle(u.sample, u.name).slice(0, 8);
    const mosaic = ids.map((id) => `<img src="${thumb(u.name, id)}" loading="lazy" alt="">`).join('');
    return `<a class="ucard" href="#/${esc(u.name)}/overview"><div class="mosaic">${mosaic}</div>
      <div class="info"><h2>${esc(u.screenName || cap(u.name))}</h2>
      <div class="meta">${fmtN(u.photos)} photos${u.joined ? ` · member since ${esc(u.joined.slice(0, 4))}` : ''}</div></div></a>`;
  }).join('');
  $('#app').innerHTML = `<div class="landing"><h1>Flickr archive</h1><p class="sub">Pick an account to browse its exported photos, comments, contacts and messages.</p><div class="ucards">${cards}</div></div>`;
}
function shuffle(arr, seed) {
  let s = 0; for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ---------- page shell ---------- */
const TABS = [
  ['overview', 'Overview'], ['timeline', 'Timeline'], ['photos', 'Photos'], ['albums', 'Albums'], ['comments', 'Comments'],
  ['people', 'People'], ['groups', 'Groups'], ['mail', 'Mail'], ['faves', 'Faves'], ['tags', 'Tags'],
];

async function renderPage({ parts, query }) {
  const [user, tab = 'overview', arg] = parts;
  state.users = state.users.length ? state.users : await getJson('/api/users');
  syncSearchBox(user && userInfo(user)?.populated ? user : '', tab, query.q);
  if (!user && state.users.length === 1) { location.replace(`#/${state.users[0].name}/overview`); return; }
  if (!user) { document.title = 'Flickr Archive'; return renderLanding(); }
  const info = userInfo(user);
  renderUserSwitch(user);
  if (!info) { $('#app').innerHTML = `<div class="page"><div class="card">No archive called “${esc(user)}”.</div></div>`; return; }
  if (!info.populated) {
    $('#app').innerHTML = `<div class="empty-note"><h2>${esc(cap(user))}’s backup isn’t here yet</h2>
      <p>Drop the extracted Flickr export into the <code>${esc(user)}/</code> folder — it’s picked up automatically within a minute.</p></div>`;
    return;
  }
  const E = await loadUserData(user);
  document.title = `${E.data.profile.screen_name || cap(user)} · Flickr Archive`;
  const counts = {
    photos: E.photos.length, albums: (E.data.albums || []).length, people: Object.keys(E.data.contacts || {}).length + Object.keys(E.data.followers || {}).length,
    groups: (E.data.groups || []).length, mail: (E.data.mailIn || []).length + (E.data.mailOut || []).length, faves: (E.data.faves || []).length,
    comments: (E.data.commentsMade || []).length + E.photos.reduce((n, p) => n + p.comments.length, 0),
  };
  const pr = E.data.profile;
  const bg = shuffle(info.sample, user).slice(0, 8).map((id) => `<img src="${thumb(user, id)}" alt="">`).join('');
  const loc = [pr.city, pr.country].filter(Boolean).join(', ');
  $('#app').innerHTML = `
    <div class="cover"><div class="bg">${bg}</div>
      <div class="in"><div class="avatar">${esc((pr.screen_name || user).charAt(0).toUpperCase())}</div>
        <div><h1>${esc(pr.screen_name || pr.real_name || cap(user))}</h1>
        <div class="line">${[pr.real_name && pr.real_name !== pr.screen_name ? esc(pr.real_name) : '', esc(loc), pr.join_date ? 'Joined ' + esc(fmtDate(pr.join_date)) : ''].filter(Boolean).join(' · ')}</div>
        <div class="line">${fmtN(counts.photos)} photos · ${fmtN(Object.keys(E.data.followers || {}).length)} followers · ${fmtN(Object.keys(E.data.contacts || {}).length)} following</div></div></div>
      <nav class="tabs">${TABS.map(([k, label]) => `<a href="#/${esc(user)}/${k}" class="${k === tab ? 'on' : ''}">${label}${counts[k] != null ? `<span class="n">${fmtN(counts[k])}</span>` : ''}</a>`).join('')}</nav>
    </div><div id="view"></div>`;
  const view = $('#view');
  const fn = VIEWS[tab] || VIEWS.overview;
  fn(view, E, { arg, query });
}

/* ---------- justified grid ---------- */
function mountGrid(el, photos, { target = 230, batch = 300, caption = true } = {}) {
  let shown = 0;
  const ratio = (p) => (p.w && p.h ? p.w / p.h : 1.4);
  const gap = 4;
  function layout() {
    const W = el.clientWidth || 1000;
    const items = photos.slice(0, shown);
    let html = ''; let row = []; let sum = 0;
    const flush = (last) => {
      if (!row.length) return;
      const avail = W - gap * (row.length - 1) - 1;
      let h = avail / sum;
      if (last && h > target * 1.35) h = target;
      html += row.map((p) => cell(p, Math.floor(ratio(p) * h), Math.floor(h))).join('');
      row = []; sum = 0;
    };
    for (const p of items) {
      row.push(p); sum += ratio(p);
      if (sum * target + gap * (row.length - 1) >= W) flush(false);
    }
    flush(true);
    el.innerHTML = html;
  }
  const cell = (p, w, h) => {
    const cp = caption ? `<div class="cap">${esc(p.name || '(untitled)')}<small>${esc(fmtDate(p.taken))}${p.views ? ' · ' + fmtN(p.views) + ' views' : ''}</small></div>` : '';
    const badge = p.nComments ? `<span class="badge">💬 ${p.nComments}</span>` : '';
    if (!p.file) return `<div class="ph novid" data-pid="${p.id}" style="width:${w}px;height:${h}px" title="${esc(p.name)}">∅</div>`;
    if (p.video) return `<a class="ph novid" data-pid="${p.id}" style="width:${w}px;height:${h}px" title="${esc(p.name)}">▶${cp}</a>`;
    return `<a class="ph" data-pid="${p.id}" style="width:${w}px;height:${h}px"><img loading="lazy" src="${thumb(el.dataset.user, p.id)}" alt="${esc(p.name)}">${badge}${cp}</a>`;
  };
  el.classList.add('jgrid');
  const sentinel = document.createElement('div'); sentinel.className = 'sentinel';
  el.after(sentinel);
  const more = () => { if (shown >= photos.length) return; shown = Math.min(photos.length, shown + batch); layout(); };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) more(); }, { rootMargin: '1200px' });
  io.observe(sentinel);
  let rw = el.clientWidth;
  const ro = new ResizeObserver(() => { if (!el.isConnected) { ro.disconnect(); io.disconnect(); return; } if (el.clientWidth !== rw) { rw = el.clientWidth; layout(); } });
  ro.observe(el);
  more();
  return { destroy() { io.disconnect(); ro.disconnect(); sentinel.remove(); } };
}
document.addEventListener('click', (e) => {
  const ph = e.target.closest('[data-pid]');
  if (!ph) return;
  e.preventDefault();
  openPhoto(ph.dataset.pid);
});

/* ---------- views ---------- */
const VIEWS = {};

function kvRows(obj, prefix = '') {
  const rows = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const label = prefix + prettyKey(k);
    if (typeof v === 'object' && !Array.isArray(v)) rows.push(...kvRows(v, label + ' › '));
    else rows.push([label, Array.isArray(v) ? JSON.stringify(v) : String(v)]);
  }
  return rows;
}
const kvHtml = (rows) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${/^https?:\/\/\S+$/.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)}</dd>`).join('')}</dl>`;

function yearHistogram(counts, linkFn) {
  const years = Object.keys(counts).sort();
  if (!years.length) return '';
  const max = Math.max(...Object.values(counts));
  return `<div class="hist">${years.map((y) => `<a ${linkFn ? `href="${linkFn(y)}"` : ''} style="height:${Math.max(4, (counts[y] / max) * 100)}%" title="${y}: ${counts[y]}"></a>`).join('')}</div>
    <div class="muted" style="display:flex;justify-content:space-between"><span>${years[0]}</span><span>${years[years.length - 1]}</span></div>`;
}

VIEWS.overview = (view, E) => {
  const pr = E.data.profile; const user = E.name;
  const top = [...E.photos].filter((p) => p.file && !p.video).sort((a, b) => b.views - a.views).slice(0, 14);
  const perYear = {};
  for (const p of E.photos) if (p.taken) perYear[p.taken.slice(0, 4)] = (perYear[p.taken.slice(0, 4)] || 0) + 1;
  const totalViews = E.photos.reduce((n, p) => n + p.views, 0);
  const geo = E.photos.filter((p) => p.lat != null).length;
  const tagSet = new Set(E.photos.flatMap((p) => p.tags));
  const vc = pr.stats?.view_counts || {};
  const profileRows = [
    ['Real name', pr.real_name], ['Screen name', pr.screen_name], ['Username', pr.path_alias], ['Occupation', pr.occupation],
    ['Hometown', pr.hometown], ['Location', [pr.city, pr.country].filter(Boolean).join(', ')], ['Joined', pr.join_date && fmtDate(pr.join_date, true)],
    ['Email', pr.email], ['Website', pr.website_url], ['Flickr profile', pr.profile_url], ['NSID', pr.nsid], ['Pro account', pr.pro_user],
    ...Object.entries(pr.social || {}).filter(([, v]) => v).map(([k, v]) => [prettyKey(k), v]),
  ].filter(([, v]) => v);
  const knownTop = new Set(['real_name', 'screen_name', 'path_alias', 'occupation', 'hometown', 'city', 'country', 'join_date', 'email', 'website_url', 'profile_url', 'nsid', 'pro_user', 'social', 'description', 'settings', 'stats', 'showcase']);
  const extra = Object.fromEntries(Object.entries(pr).filter(([k]) => !knownTop.has(k)));
  const d = E.data;
  view.innerHTML = `<div class="page">
    <div class="grid2"><div>
      <div class="card"><h2>Highlights — most viewed</h2>${top.length ? `<div class="grid-top" data-user="${esc(user)}"></div>` : '<p class="muted">No photo files.</p>'}</div>
      <div class="card"><h2>Photos by year taken</h2>${yearHistogram(perYear, (y) => buildHash([user, 'photos'], { year: y }))}</div>
      ${pr.description ? `<div class="card"><h2>About</h2><div>${rich(pr.description)}</div></div>` : ''}
      ${(d.testimonials?.received?.length || d.testimonials?.given?.length) ? `<div class="card"><h2>Testimonials</h2><pre>${esc(JSON.stringify(d.testimonials, null, 1))}</pre></div>` : ''}
      ${(d.galleries || []).length ? `<div class="card"><h2>Galleries</h2>${kvHtml(kvRows(d.galleries))}</div>` : ''}
      ${(d.milestones || []).length ? `<div class="card"><h2>Milestones</h2>${kvHtml(kvRows(d.milestones))}</div>` : ''}
    </div><div>
      <div class="card"><h2>Account</h2>${kvHtml(profileRows)}</div>
      <div class="card"><h2>Numbers</h2><div class="stats">
        <div class="stat"><b>${fmtN(E.photos.length)}</b><span>Photos</span></div>
        <div class="stat"><b>${fmtN(vc.total || totalViews)}</b><span>${vc.total ? 'Total views' : 'Photo views'}</span></div>
        <div class="stat"><b>${fmtN((d.albums || []).length)}</b><span>Albums</span></div>
        <div class="stat"><b>${fmtN(tagSet.size)}</b><span>Tags</span></div>
        <div class="stat"><b>${fmtN(geo)}</b><span>Geotagged</span></div>
        <div class="stat"><b>${fmtN((d.groups || []).length)}</b><span>Groups</span></div>
        <div class="stat"><b>${fmtN((d.faves || []).length)}</b><span>Faves</span></div>
        <div class="stat"><b>${fmtN((d.commentsMade || []).length)}</b><span>Comments made</span></div>
      </div>
      ${Object.keys(vc).length ? `<h3>Views by area (Flickr stats)</h3>${kvHtml(Object.entries(vc).map(([k, v]) => [prettyKey(k), fmtN(v)]))}` : ''}
      </div>
      ${Object.keys(extra).length ? `<div class="card"><h2>Other</h2>${kvHtml(kvRows(extra))}</div>` : ''}
      <div class="card"><details class="raw"><summary>Privacy &amp; account settings</summary>${kvHtml(kvRows(pr.settings))}</details></div>
    </div></div></div>`;
  const g = $('.grid-top', view);
  if (g) mountGrid(g, top, { target: 150, batch: 14 });
};

/* photos list */
const SORTS = {
  taken_desc: ['Date taken — newest', (a, b) => (b.taken || '').localeCompare(a.taken || '')],
  taken_asc: ['Date taken — oldest', (a, b) => (a.taken || '9').localeCompare(b.taken || '9')],
  imported_desc: ['Date uploaded — newest', (a, b) => (b.imported || '').localeCompare(a.imported || '')],
  views_desc: ['Most viewed', (a, b) => b.views - a.views],
  comments_desc: ['Most comments', (a, b) => b.nComments - a.nComments],
  title: ['Title A–Z', (a, b) => (a.name || '~').localeCompare(b.name || '~')],
};
VIEWS.photos = (view, E, { query }) => {
  const user = E.name;
  const years = [...new Set(E.photos.map((p) => (p.taken || '').slice(0, 4)).filter(Boolean))].sort().reverse();
  const albums = E.data.albums || [];
  const st = { q: query.q || '', sort: query.sort || 'taken_desc', year: query.year || '', album: query.album || '', tag: query.tag || '', comments: !!query.comments, geo: !!query.geo, day: query.day || '' };
  view.innerHTML = `<div class="page wide">
    <div class="toolbar">
      <input type="search" id="f-q" placeholder="Search title, description, tags…" value="${esc(st.q)}">
      <select id="f-sort">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}" ${k === st.sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="f-year"><option value="">All years</option>${years.map((y) => `<option ${y === st.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <select id="f-album"><option value="">All albums</option>${albums.map((a) => `<option value="${esc(a.id)}" ${String(a.id) === st.album ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}</select>
      <label><input type="checkbox" id="f-comments" ${st.comments ? 'checked' : ''}> With comments</label>
      <label><input type="checkbox" id="f-geo" ${st.geo ? 'checked' : ''}> With location</label>
      <span id="f-pills"></span><span class="count" id="f-count"></span>
    </div><div id="grid" data-user="${esc(user)}"></div></div>`;
  let grid = null;
  const apply = () => {
    const q = st.q.trim().toLowerCase();
    let list = E.photos.filter((p) =>
      (!q || (p.name + ' ' + p.description + ' ' + p.tags.join(' ')).toLowerCase().includes(q)) &&
      (!st.year || (p.taken || '').startsWith(st.year)) &&
      (!st.album || p.albums.includes(st.album)) &&
      (!st.tag || p.tags.some((t) => t.toLowerCase() === st.tag.toLowerCase())) &&
      (!st.comments || p.nComments > 0) && (!st.geo || p.lat != null) &&
      (!st.day || (p.taken || '').startsWith(st.day) || (p.imported || '').startsWith(st.day)));
    list = list.sort(SORTS[st.sort][1]);
    $('#f-count').textContent = `${fmtN(list.length)} of ${fmtN(E.photos.length)} photos`;
    $('#f-pills').innerHTML = [st.tag && ['tag', `tag: ${st.tag}`], st.day && ['day', `day: ${st.day}`]].filter(Boolean)
      .map(([k, l]) => `<a class="pill" href="#" data-clear="${k}">${esc(l)} ✕</a>`).join('');
    if (grid) grid.destroy();
    $('#grid').innerHTML = '';
    grid = mountGrid($('#grid'), list);
    updateQuery({ q: st.q, sort: st.sort === 'taken_desc' ? '' : st.sort, year: st.year, album: st.album, tag: st.tag, comments: st.comments, geo: st.geo, day: st.day });
  };
  const bind = (id, key, ev = 'change', get = (el) => el.value) => $(id, view).addEventListener(ev, (e) => { st[key] = get(e.target); apply(); });
  let t; $('#f-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; apply(); }, 200); });
  bind('#f-sort', 'sort'); bind('#f-year', 'year'); bind('#f-album', 'album');
  bind('#f-comments', 'comments', 'change', (el) => el.checked); bind('#f-geo', 'geo', 'change', (el) => el.checked);
  view.addEventListener('click', (e) => { const c = e.target.closest('[data-clear]'); if (c) { e.preventDefault(); st[c.dataset.clear] = ''; apply(); } });
  apply();
};

VIEWS.albums = (view, E, { arg }) => {
  const user = E.name; const albums = E.data.albums || [];
  if (arg) {
    const a = E.albumsById.get(arg);
    if (!a) { view.innerHTML = '<div class="page"><div class="card">Album not found.</div></div>'; return; }
    const list = (a.photos || []).map((id) => E.byId.get(String(id))).filter(Boolean);
    view.innerHTML = `<div class="page wide"><div style="padding:8px 8px 14px"><a href="#/${esc(user)}/albums">← Albums</a>
      <h2 style="margin:6px 0 2px;font-weight:300;font-size:28px">${esc(a.title)}</h2>
      <div class="muted">${fmtN(a.photo_count || list.length)} photos${a.created ? ' · created ' + esc(fmtDate(unixToStr(a.created))) : ''}${a.view_count ? ' · ' + fmtN(a.view_count) + ' views' : ''}</div>
      ${a.description ? `<p>${rich(a.description)}</p>` : ''}
      ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">View on Flickr</a>` : ''}</div>
      <div id="grid" data-user="${esc(user)}"></div></div>`;
    mountGrid($('#grid'), list);
    return;
  }
  const rows = [...albums].sort((a, b) => (+b.created || 0) - (+a.created || 0));
  view.innerHTML = `<div class="page"><div class="cards">${rows.map((a) => {
    const imgs = (a.photos || []).map((id) => E.byId.get(String(id))).filter((p) => p && p.file && !p.video).slice(0, 3);
    const cov = imgs.length ? imgs.map((p) => `<img loading="lazy" src="${thumb(user, p.id)}" alt="">`).join('') : '';
    return `<a class="acard" href="#/${esc(user)}/albums/${esc(a.id)}"><div class="cov" style="${imgs.length === 1 ? 'grid-template-columns:1fr' : ''}">${cov}</div>
      <div class="t"><b>${esc(a.title)}</b><span class="muted">${fmtN(a.photo_count || (a.photos || []).length)} photos${a.created ? ' · ' + esc(fmtDate(unixToStr(a.created))) : ''}</span></div></a>`;
  }).join('') || '<p class="muted">No albums.</p>'}</div></div>`;
};

/* comments */
function commentRow(E, { thumbId, who, when, text, link, linkLabel }) {
  const p = thumbId ? E.byId.get(String(thumbId)) : null;
  const th = p && p.file && !p.video
    ? `<div class="th" data-pid="${p.id}"><img loading="lazy" src="${thumb(E.name, p.id)}" alt=""></div>`
    : `<div class="th ph0">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(linkLabel || 'photo')}</a>` : 'photo not in archive'}</div>`;
  return `<div class="cm">${th}<div class="body"><div class="who">${who}<span class="when">${esc(fmtDate(when, true))}</span></div>
    ${p ? `<div class="muted">on <a href="#" data-pid="${p.id}">${esc(p.name || '(untitled)')}</a></div>` : link ? `<div class="muted"><a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a></div>` : ''}
    <div class="txt">${rich(text)}</div></div></div>`;
}
VIEWS.comments = (view, E, { query }) => {
  const d = E.data; const mode = query.mode === 'received' ? 'received' : 'made';
  const received = E.photos.flatMap((p) => p.comments.map((c) => ({ p, c }))).sort((a, b) => (b.c.date || '').localeCompare(a.c.date || ''));
  const made = [...(d.commentsMade || [])].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  const other = [['Album comments', d.setComments], ['Gallery comments', d.galleryComments], ['App comments', d.appComments]].filter(([, l]) => (l || []).length);
  const render = () => {
    const body = mode === 'made'
      ? made.map((c) => commentRow(E, { thumbId: c.photo_id, who: `<b>${esc(E.data.profile.screen_name || E.name)}</b>`, when: c.created, text: c.comment, link: c.comment_url || c.photo_url, linkLabel: 'view on Flickr' })).join('')
      : received.map(({ p, c }) => commentRow(E, { thumbId: p.id, who: person(E, c.user), when: c.date, text: c.comment })).join('');
    $('#cbody').innerHTML = body || '<p class="muted">Nothing here.</p>';
  };
  view.innerHTML = `<div class="page"><div class="card">
    <div class="seg"><button data-m="made" class="${mode === 'made' ? 'on' : ''}">Made by ${esc(cap(E.name))} (${made.length})</button>
    <button data-m="received" class="${mode === 'received' ? 'on' : ''}">Received on photos (${received.length})</button></div>
    <div id="cbody" style="margin-top:10px"></div></div>
    ${other.map(([t, l]) => `<div class="card"><h2>${t}</h2>${kvHtml(kvRows(l))}</div>`).join('')}</div>`;
  render();
  view.onclick = (e) => {
    const b = e.target.closest('[data-m]'); if (!b) return;
    updateQuery({ mode: b.dataset.m === 'made' ? '' : b.dataset.m });
    VIEWS.comments(view, E, { query: parseHash().query });
  };
};

/* people */
VIEWS.people = (view, E) => {
  const c = E.data.contacts || {}; const f = E.data.followers || {};
  const urlKey = (u) => String(u).replace(/\/+$/, '').split('/').pop().toLowerCase();
  const cKeys = new Set(Object.values(c).map(urlKey)); const fKeys = new Set(Object.values(f).map(urlKey));
  const list = (obj, other) => Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' })).map(([n, u]) => {
    const k = urlKey(u); const local = localUserFor(k);
    const link = local ? `<a href="#/${esc(local.name)}/overview">${esc(n)}</a> <span class="pill">archive</span>` : `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}</a>`;
    return `<div data-n="${esc(n.toLowerCase())}">${link}${other.has(k) ? '<span class="mut">mutual</span>' : ''}</div>`;
  }).join('');
  view.innerHTML = `<div class="page"><div class="toolbar"><input type="search" id="pf" placeholder="Filter people…"></div>
    <div class="card"><h2>Following (${Object.keys(c).length})</h2><div class="plist">${list(c, fKeys) || '<span class="muted">None</span>'}</div></div>
    <div class="card"><h2>Followers (${Object.keys(f).length})</h2><div class="plist">${list(f, cKeys) || '<span class="muted">None</span>'}</div></div></div>`;
  $('#pf', view).addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('.plist > div', view).forEach((d) => { d.hidden = q && !d.dataset.n.includes(q); });
  });
};

/* groups + discussions */
VIEWS.groups = (view, E) => {
  const groups = [...(E.data.groups || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const disc = [...(E.data.discussions || [])].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  view.innerHTML = `<div class="page"><div class="grid2"><div class="card"><h2>Group discussion posts (${disc.length})</h2>
    ${disc.map((d) => `<div class="cm"><div class="body"><div class="who"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc((d.url.match(/groups\/([^/]+)/) || [])[1] || 'group')}</a><span class="when">${esc(fmtDate(d.created, true))} · ${esc(d.type || '')}</span></div><div class="txt">${rich(d.message)}</div></div></div>`).join('') || '<p class="muted">None.</p>'}</div>
    <div class="card"><h2>Groups (${groups.length})</h2><input type="search" id="gf" placeholder="Filter groups…" style="width:100%;padding:7px;margin-bottom:8px;border:1px solid #ccc;border-radius:3px">
    <div id="glist">${groups.map((g) => `<div data-n="${esc((g.name || '').toLowerCase())}" style="padding:4px 0;border-bottom:1px solid var(--bg)"><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.name)}</a> <span class="muted">${esc(g.user_role || '')}</span></div>`).join('')}</div></div></div></div>`;
  $('#gf', view).addEventListener('input', (e) => { const q = e.target.value.toLowerCase(); $$('#glist > div', view).forEach((d) => { d.hidden = q && !d.dataset.n.includes(q); }); });
};

/* mail */
VIEWS.mail = (view, E, { query }) => {
  let box = query.box === 'sent' ? 'sent' : 'inbox';
  const inbox = [...(E.data.mailIn || [])].sort((a, b) => (b.date_sent || '').localeCompare(a.date_sent || ''));
  const sent = [...(E.data.mailOut || [])].sort((a, b) => (b.date_sent || '').localeCompare(a.date_sent || ''));
  let sel = 0;
  const draw = () => {
    const list = box === 'inbox' ? inbox : sent;
    const m = list[sel];
    $('#mlist').innerHTML = list.map((x, i) => `<div class="item ${i === sel ? 'on' : ''} ${box === 'inbox' && x.have_read === '0' ? 'unread' : ''}" data-i="${i}"><b>${esc(x.subject || '(no subject)')}</b>
      <small>${box === 'inbox' ? 'From ' + stripTags(person(E, x.from_user_id)) : 'To ' + esc(x.to_user_name || x.to_user_id || '')} · ${esc(fmtDate(x.date_sent))}</small></div>`).join('') || '<div class="item muted">No messages.</div>';
    $('#mmsg').innerHTML = m ? `<h3>${esc(m.subject || '(no subject)')}</h3>
      <div class="muted" style="margin-bottom:14px">${box === 'inbox' ? 'From ' + person(E, m.from_user_id) : 'To ' + person(E, m.to_user_id, m.to_user_name)} · ${esc(fmtDate(m.date_sent, true))}</div>
      <div>${rich(m.message)}</div>` : '';
  };
  view.innerHTML = `<div class="page"><div class="toolbar"><div class="seg"><button data-b="inbox" class="${box === 'inbox' ? 'on' : ''}">Inbox (${inbox.length})</button><button data-b="sent" class="${box === 'sent' ? 'on' : ''}">Sent (${sent.length})</button></div></div>
    <div class="mail"><div class="list" id="mlist"></div><div class="msg" id="mmsg"></div></div></div>`;
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-b]');
    if (b) { box = b.dataset.b; sel = 0; $$('[data-b]', view).forEach((x) => x.classList.toggle('on', x === b)); updateQuery({ box: box === 'inbox' ? '' : box }); draw(); return; }
    const it = e.target.closest('.item[data-i]'); if (it) { sel = +it.dataset.i; draw(); }
  });
  draw();
};
const plain = (h) => new DOMParser().parseFromString(h || '', 'text/html').body.textContent || '';
const hlText = (text, q) => {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text.slice(0, 220));
  const start = Math.max(0, i - 70);
  return (start ? '…' : '') + esc(text.slice(start, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length, i + q.length + 150));
};
const stripTags = (h) => esc(new DOMParser().parseFromString(h, 'text/html').body.textContent);

/* faves */
VIEWS.faves = (view, E) => {
  const f = E.data.faves || [];
  view.innerHTML = `<div class="page"><div class="card"><h2>Favourites (${f.length})</h2><p class="muted">Only the photo IDs are included in a Flickr export, so these link out to Flickr unless the photo is in this archive.</p>
    <div class="cards">${f.map((x) => {
      const p = E.byId.get(String(x.photo_id));
      return `<div class="acard"><div class="t">${p && p.file ? `<img style="width:100%;height:140px;object-fit:cover;cursor:pointer" data-pid="${p.id}" src="${thumb(E.name, p.id)}" alt="">` : ''}
        <b><a href="${esc(x.photo_url)}" target="_blank" rel="noopener">${esc(x.photo_url)}</a></b><span class="muted">Photo ${esc(x.photo_id)}</span></div></div>`;
    }).join('')}</div></div></div>`;
};

/* tags */
VIEWS.tags = (view, E) => {
  const counts = new Map();
  for (const p of E.photos) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  const arr = [...counts].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
  const max = Math.max(1, ...counts.values());
  view.innerHTML = `<div class="page"><div class="card"><h2>Tags (${arr.length})</h2><div class="cloud">${arr.map(([t, n]) =>
    `<a href="${buildHash([E.name, 'photos'], { tag: t })}" style="font-size:${(0.85 + (n / max) * 1.6).toFixed(2)}em" title="${n} photos">${esc(t)}</a>`).join('') || '<span class="muted">No tags.</span>'}</div></div></div>`;
};

/* timeline */
VIEWS.timeline = (view, E, { query }) => {
  const user = E.name; const d = E.data; const pr = d.profile;
  const st = { by: query.by === 'uploaded' ? 'uploaded' : 'taken', order: query.order === 'asc' ? 'asc' : 'desc', off: new Set((query.hide || '').split(',').filter(Boolean)) };
  const KINDS = { photo: 'Photos', 'comment-in': 'Comments received', 'comment-out': 'Comments made', mail: 'Mail', group: 'Group posts', album: 'Albums', account: 'Account' };
  const build = () => {
    const ev = [];
    if (pr.join_date) ev.push({ t: pr.join_date, kind: 'account', html: `<b>Joined Flickr</b>` });
    // photos grouped by day
    const days = new Map();
    for (const p of E.photos) {
      const t = st.by === 'taken' ? p.taken : p.imported;
      if (!t) continue;
      const day = t.slice(0, 10);
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(p);
    }
    for (const [day, ps] of days) {
      ps.sort((a, b) => ((st.by === 'taken' ? a.taken : a.imported) || '').localeCompare((st.by === 'taken' ? b.taken : b.imported) || ''));
      ev.push({ t: (st.by === 'taken' ? ps[0].taken : ps[0].imported), kind: 'photo', photos: ps, day });
    }
    for (const p of E.photos) for (const c of p.comments) ev.push({ t: c.date, kind: 'comment-in', p, c });
    for (const c of d.commentsMade || []) ev.push({ t: c.created, kind: 'comment-out', c });
    for (const m of d.mailIn || []) ev.push({ t: m.date_sent, kind: 'mail', m, dir: 'in' });
    for (const m of d.mailOut || []) ev.push({ t: m.date_sent, kind: 'mail', m, dir: 'out' });
    for (const g of d.discussions || []) ev.push({ t: g.created, kind: 'group', g });
    for (const a of d.albums || []) { const t = unixToStr(a.created); if (t) ev.push({ t, kind: 'album', a }); }
    return ev.filter((e) => e.t && /^\d{4}/.test(e.t));
  };
  const evHtml = (e) => {
    const when = `<span class="when">${esc(fmtDate(e.t, true))}</span>`;
    const kind = (k, l) => `<span class="kind k-${k}">${l}</span>`;
    switch (e.kind) {
      case 'account': return `<div class="ev">${kind('account', 'Account')}${e.html} ${when}</div>`;
      case 'photo': {
        const n = e.photos.length; const shown = e.photos.slice(0, 14);
        const title = n === 1 ? esc(e.photos[0].name || '(untitled)') : `${n} photos ${st.by === 'taken' ? 'taken' : 'uploaded'}`;
        return `<div class="ev">${kind('photo', 'Photos')}<b>${title}</b> ${when}<div class="strip">${shown.map((p) => p.file && !p.video ? `<img loading="lazy" data-pid="${p.id}" src="${thumb(user, p.id)}" alt="${esc(p.name)}" style="aspect-ratio:${p.w && p.h ? p.w + '/' + p.h : '4/3'}">` : '').join('')}
          ${n > shown.length ? `<a class="more" href="${buildHash([user, 'photos'], { day: e.day })}">+${n - shown.length} more</a>` : ''}</div></div>`;
      }
      case 'comment-in': return `<div class="ev">${kind('comment-in', 'Comment received')}${person(E, e.c.user)} on <a href="#" data-pid="${e.p.id}">${esc(e.p.name || '(untitled)')}</a> ${when}<div class="quote">${rich(e.c.comment)}</div></div>`;
      case 'comment-out': {
        const p = E.byId.get(String(e.c.photo_id));
        return `<div class="ev">${kind('comment-out', 'Comment made')}${p ? `on <a href="#" data-pid="${p.id}">${esc(p.name || '(untitled)')}</a>` : `on <a href="${esc(e.c.comment_url || e.c.photo_url)}" target="_blank" rel="noopener">a photo</a>`} ${when}<div class="quote">${rich(e.c.comment)}</div></div>`;
      }
      case 'mail': return `<div class="ev">${kind('mail', e.dir === 'in' ? 'Mail in' : 'Mail out')}<b>${esc(e.m.subject)}</b> — ${e.dir === 'in' ? 'from ' + person(E, e.m.from_user_id) : 'to ' + person(E, e.m.to_user_id, e.m.to_user_name)} ${when}</div>`;
      case 'group': return `<div class="ev">${kind('group', 'Group post')}<a href="${esc(e.g.url)}" target="_blank" rel="noopener">${esc((e.g.url.match(/groups\/([^/]+)/) || [])[1] || 'group')}</a> ${when}<div class="quote">${stripTags(e.g.message).slice(0, 400)}</div></div>`;
      case 'album': return `<div class="ev">${kind('album', 'Album')}Created <a href="#/${esc(user)}/albums/${esc(e.a.id)}">${esc(e.a.title)}</a> (${fmtN(e.a.photo_count)} photos) ${when}</div>`;
    }
    return '';
  };
  const draw = () => {
    const all = build();
    const ev = all.filter((e) => !st.off.has(e.kind)).sort((a, b) => st.order === 'desc' ? b.t.localeCompare(a.t) : a.t.localeCompare(b.t));
    const yc = {};
    for (const e of ev) { const y = e.t.slice(0, 4); yc[y] = (yc[y] || 0) + (e.kind === 'photo' ? e.photos.length : 1); }
    const years = Object.keys(yc).sort();
    if (st.order === 'desc') years.reverse();
    let html = ''; let curY = null; let curM = null;
    for (const e of ev) {
      const y = e.t.slice(0, 4); const m = e.t.slice(5, 7);
      if (y !== curY) { html += `<div class="tl-year" id="y${y}">${y}</div>`; curY = y; curM = null; }
      if (m !== curM) { html += `<div class="tl-month">${MONTHS_L[+m - 1] || m}</div>`; curM = m; }
      html += evHtml(e);
    }
    $('#tl', view).innerHTML = html || '<p class="muted">No events.</p>';
    $('#tlrail', view).innerHTML = years.map((y) => `<a href="#" data-y="${y}">${y}<i>${fmtN(yc[y])}</i></a>`).join('');
    $('#tlhist', view).innerHTML = yearHistogram(yc, null);
    $$('#tlhist .hist a', view).forEach((a, i) => { const y = Object.keys(yc).sort()[i]; a.dataset.y = y; a.href = '#'; });
  };
  view.innerHTML = `<div class="page"><div class="toolbar">
      <div class="seg"><button data-by="taken" class="${st.by === 'taken' ? 'on' : ''}">Date taken</button><button data-by="uploaded" class="${st.by === 'uploaded' ? 'on' : ''}">Date uploaded</button></div>
      <div class="seg"><button data-order="desc" class="${st.order === 'desc' ? 'on' : ''}">Newest first</button><button data-order="asc" class="${st.order === 'asc' ? 'on' : ''}">Oldest first</button></div>
      ${Object.entries(KINDS).map(([k, l]) => `<label><input type="checkbox" data-kind="${k}" ${st.off.has(k) ? '' : 'checked'}> ${l}</label>`).join('')}
    </div><div id="tlhist"></div>
    <div class="tl-wrap"><div class="tl-rail" id="tlrail"></div><div class="tl" id="tl"></div></div></div>`;
  const persist = () => updateQuery({ by: st.by === 'taken' ? '' : st.by, order: st.order === 'desc' ? '' : st.order, hide: [...st.off].join(',') });
  view.addEventListener('click', (e) => {
    const by = e.target.closest('[data-by]'); const ord = e.target.closest('[data-order]'); const y = e.target.closest('[data-y]');
    if (by) { st.by = by.dataset.by; $$('[data-by]', view).forEach((b) => b.classList.toggle('on', b === by)); persist(); draw(); }
    else if (ord) { st.order = ord.dataset.order; $$('[data-order]', view).forEach((b) => b.classList.toggle('on', b === ord)); persist(); draw(); }
    else if (y) { e.preventDefault(); document.getElementById('y' + y.dataset.y)?.scrollIntoView({ behavior: 'smooth' }); }
  });
  view.addEventListener('change', (e) => {
    const k = e.target.dataset.kind; if (!k) return;
    if (e.target.checked) st.off.delete(k); else st.off.add(k);
    persist(); draw();
  });
  draw();
};

/* search view */
VIEWS.search = (view, E, { query }) => {
  const q = (query.q || '').trim().toLowerCase();
  const user = E.name; const d = E.data; const LIMIT = 50;
  if (!q) { view.innerHTML = '<div class="page"><div class="card muted">Type something in the search box above.</div></div>'; return; }
  const has = (s) => String(s || '').toLowerCase().includes(q);
  const photos = E.photos.filter((p) => has(p.name) || has(p.description) || p.tags.some(has));
  const albums = (d.albums || []).filter((a) => has(a.title) || has(a.description));
  const made = (d.commentsMade || []).filter((c) => has(plain(c.comment)));
  const received = E.photos.flatMap((p) => p.comments.map((c) => ({ p, c }))).filter(({ c }) => has(plain(c.comment)));
  const mail = [...(d.mailIn || []).map((m) => ({ m, dir: 'in' })), ...(d.mailOut || []).map((m) => ({ m, dir: 'out' }))]
    .filter(({ m }) => has(m.subject) || has(plain(m.message)));
  const posts = (d.discussions || []).filter((x) => has(plain(x.message)));
  const people = [...Object.entries(d.contacts || {}).map(([n, u]) => [n, u, 'following']), ...Object.entries(d.followers || {}).map(([n, u]) => [n, u, 'follower'])].filter(([n]) => has(n));
  const groups = (d.groups || []).filter((g) => has(g.name));
  const total = photos.length + albums.length + made.length + received.length + mail.length + posts.length + people.length + groups.length;
  const sec = (title, n, body) => n ? `<div class="card sr-sec"><h2>${title} <small>${fmtN(n)}${n > LIMIT ? `, showing first ${LIMIT}` : ''}</small></h2>${body}</div>` : '';
  const rest = (list, fn) => list.slice(0, LIMIT).map(fn).join('');
  view.innerHTML = `<div class="page"><h2 style="font-weight:300;margin:0 0 14px">${fmtN(total)} results for “${esc(query.q)}”</h2>
    ${total ? '' : '<div class="card muted">Nothing found.</div>'}
    ${photos.length ? `<div class="card sr-sec"><h2>Photos <small>${fmtN(photos.length)}</small></h2><div id="srgrid" data-user="${esc(user)}"></div></div>` : ''}
    ${sec('Albums', albums.length, rest(albums, (a) => `<div class="sr-item"><a href="#/${esc(user)}/albums/${esc(a.id)}">${hlText(a.title, q)}</a> <span class="muted">${fmtN(a.photo_count)} photos</span></div>`))}
    ${sec('Comments made', made.length, rest(made, (c) => commentRow(E, { thumbId: c.photo_id, who: `<b>${esc(d.profile.screen_name || user)}</b>`, when: c.created, text: c.comment, link: c.comment_url || c.photo_url, linkLabel: 'view on Flickr' })))}
    ${sec('Comments received', received.length, rest(received, ({ p, c }) => commentRow(E, { thumbId: p.id, who: person(E, c.user), when: c.date, text: c.comment })))}
    ${sec('Mail', mail.length, rest(mail, ({ m, dir }) => `<div class="sr-item"><b>${hlText(m.subject || '(no subject)', q)}</b> <span class="muted">${dir === 'in' ? 'from ' + stripTags(person(E, m.from_user_id)) : 'to ' + esc(m.to_user_name || m.to_user_id || '')} · ${esc(fmtDate(m.date_sent))} · <a href="#/${esc(user)}/mail${dir === 'out' ? '?box=sent' : ''}">open mail</a></span><div class="snip">${hlText(plain(m.message), q)}</div></div>`))}
    ${sec('Group posts', posts.length, rest(posts, (x) => `<div class="sr-item"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc((x.url.match(/groups\/([^/]+)/) || [])[1] || 'group')}</a> <span class="muted">${esc(fmtDate(x.created))}</span><div class="snip">${hlText(plain(x.message), q)}</div></div>`))}
    ${sec('Groups', groups.length, rest(groups, (g) => `<div class="sr-item"><a href="${esc(g.url)}" target="_blank" rel="noopener">${hlText(g.name, q)}</a></div>`))}
    ${sec('People', people.length, rest(people, ([n, u, kind]) => `<div class="sr-item"><a href="${esc(u)}" target="_blank" rel="noopener">${hlText(n, q)}</a> <span class="muted">${kind}</span></div>`))}
  </div>`;
  const g = $('#srgrid', view);
  if (g) mountGrid(g, photos, { target: 150 });
};

/* ---------- lightbox ---------- */
function collectIds() {
  const ids = []; const seen = new Set();
  for (const el of $$('#app [data-pid]')) { if (!seen.has(el.dataset.pid)) { seen.add(el.dataset.pid); ids.push(el.dataset.pid); } }
  return ids;
}
function openPhoto(id) {
  state.lbIds = collectIds();
  const r = parseHash();
  state.lbPushed = true;
  location.hash = buildHash(r.parts, { ...r.query, p: id });
}
function closePhoto() {
  if (state.lbPushed) { state.lbPushed = false; history.back(); return; }
  const r = parseHash(); delete r.query.p;
  replaceHash(r.parts, r.query); syncLightbox(parseHash());
}
function gotoPhoto(id) {
  const r = parseHash();
  history.replaceState(null, '', buildHash(r.parts, { ...r.query, p: id }));
  syncLightbox(parseHash());
}
async function syncLightbox({ parts, query }) {
  const lb = $('#lightbox');
  const id = query.p;
  const user = parts[0];
  if (!id || !user || !state.cache[user]) { if (state.lbOpen) { lb.hidden = true; lb.innerHTML = ''; state.lbOpen = false; document.body.style.overflow = ''; } if (!id) state.lbPushed = false; return; }
  const E = state.cache[user]; const p = E.byId.get(id);
  if (!p) { lb.hidden = true; return; }
  if (!state.lbIds.includes(id)) state.lbIds = state.lbIds.length && state.lbIds.includes(id) ? state.lbIds : (collectIds().includes(id) ? collectIds() : [id]);
  const idx = state.lbIds.indexOf(id);
  const prev = state.lbIds[idx - 1]; const next = state.lbIds[idx + 1];
  const userTag = (t) => `<a class="pill" href="${buildHash([user, 'photos'], { tag: t })}" data-close>${esc(t)}</a>`;
  const albums = p.albums.map((a) => E.albumsById.get(a)).filter(Boolean);
  const media = !p.file ? '<div class="muted">Original file not in archive</div>'
    : p.video ? `<video controls autoplay src="/media/${encodeURIComponent(user)}/${p.id}/o"></video>`
      : `<a href="/media/${encodeURIComponent(user)}/${p.id}/o" target="_blank" rel="noopener" title="Open original"><img src="${thumb(user, p.id, 'p')}" alt="${esc(p.name)}"></a>`;
  const rows = [
    ['Taken', p.taken && fmtDate(p.taken, true)], ['Uploaded', p.imported && fmtDate(p.imported, true)],
    ['Views', p.views ? fmtN(p.views) : ''], ['Faves', p.faves ? fmtN(p.faves) : ''],
    ['Privacy', p.privacy], ['Safety', p.safety], ['License', p.license], ['Comments', p.commentPermissions && 'Who can comment: ' + p.commentPermissions],
    ['Size', p.w ? `${p.w} × ${p.h}` : ''], ['File', p.file],
  ].filter(([, v]) => v);
  lb.innerHTML = `<button class="lb-close" title="Close (Esc)">✕</button>
    <div class="lb-stage">${prev ? '<button class="nav prev" title="Previous (←)">‹</button>' : ''}${media}${next ? '<button class="nav next" title="Next (→)">›</button>' : ''}</div>
    <aside class="lb-side"><h2>${esc(p.name || '(untitled)')}</h2>
      ${p.description ? `<div class="desc">${rich(p.description)}</div>` : ''}
      ${kvHtml(rows)}
      ${p.tags.length ? `<h4>Tags</h4>${p.tags.map(userTag).join('')}` : ''}
      ${albums.length ? `<h4>Albums</h4>${albums.map((a) => `<a class="pill" href="#/${esc(user)}/albums/${esc(a.id)}" data-close>${esc(a.title)}</a>`).join('')}` : ''}
      ${p.groups.length ? `<h4>Groups</h4>${p.groups.map((g) => `<a class="pill" target="_blank" rel="noopener" href="${esc(g.url)}">${esc(g.name)}</a>`).join('')}` : ''}
      ${p.lat != null ? `<h4>Location</h4><a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=15/${p.lat}/${p.lon}" target="_blank" rel="noopener">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} — open map</a>` : ''}
      ${p.people.length ? `<h4>People in photo</h4>${p.people.map((x) => `<div>${person(E, x.person)} <span class="muted">added by ${person(E, x.added_by)}</span></div>`).join('')}` : ''}
      ${p.notes.length ? `<h4>Notes</h4>${p.notes.map((n) => `<div class="pill">${esc(typeof n === 'string' ? n : n.note_text || n.text || n.content || JSON.stringify(n))}</div>`).join('')}` : ''}
      ${p.comments.length ? `<h4>Comments (${p.comments.length})</h4>${p.comments.map((c) => `<div class="cm"><div class="body"><div class="who">${person(E, c.user)}<span class="when">${esc(fmtDate(c.date, true))}</span></div><div class="txt">${rich(c.comment)}</div></div></div>`).join('')}` : ''}
      <div class="btns">${p.photopage ? `<a href="${esc(p.photopage)}" target="_blank" rel="noopener">Flickr page</a>` : ''}${p.file ? `<a href="/media/${encodeURIComponent(user)}/${p.id}/o" target="_blank" rel="noopener">Original file</a>` : ''}</div>
      ${idx >= 0 ? `<p class="muted">${idx + 1} of ${state.lbIds.length}</p>` : ''}
    </aside>`;
  lb.hidden = false; state.lbOpen = true; document.body.style.overflow = 'hidden';
  lb.dataset.prev = prev || ''; lb.dataset.next = next || '';
  $('.lb-side', lb).scrollTop = 0;
  // preload neighbours
  for (const n of [prev, next]) if (n) { const q = E.byId.get(n); if (q?.file && !q.video) new Image().src = thumb(user, n, 'p'); }
}
$('#lightbox').addEventListener('click', (e) => {
  const lb = $('#lightbox');
  if (e.target.closest('.lb-close')) return closePhoto();
  if (e.target.closest('.prev') && lb.dataset.prev) return gotoPhoto(lb.dataset.prev);
  if (e.target.closest('.next') && lb.dataset.next) return gotoPhoto(lb.dataset.next);
  if (e.target.matches('.lb-stage')) return closePhoto();
  if (e.target.closest('[data-close]')) { state.lbPushed = false; /* navigating away: drop lightbox */ const r = parseHash(); delete r.query.p; history.replaceState(null, '', buildHash(r.parts, r.query)); }
});
document.addEventListener('keydown', (e) => {
  if (!state.lbOpen || /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
  const lb = $('#lightbox');
  if (e.key === 'Escape') closePhoto();
  else if (e.key === 'ArrowLeft' && lb.dataset.prev) gotoPhoto(lb.dataset.prev);
  else if (e.key === 'ArrowRight' && lb.dataset.next) gotoPhoto(lb.dataset.next);
});

/* ---------- header search ---------- */
const gq = $('#gq');
let gTimer;
function runGlobalSearch() {
  const { parts } = parseHash();
  const user = parts[0];
  const q = gq.value.trim();
  if (!user || !q) return;
  const target = buildHash([user, 'search'], { q });
  if (parts[1] === 'search') { history.replaceState(null, '', target); state.lastKey = null; route(); } else location.hash = target;
}
gq.addEventListener('input', () => { clearTimeout(gTimer); gTimer = setTimeout(runGlobalSearch, 350); });
$('#gsearch').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(gTimer); runGlobalSearch(); });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName) && !$('#gsearch').hidden) { e.preventDefault(); gq.focus(); gq.select(); }
});
function syncSearchBox(user, tab, q) {
  $('#gsearch').hidden = !user;
  if (tab === 'search') gq.value = q || ''; else if (!user) gq.value = '';
}

/* ---------- boot ---------- */
(async function boot() {
  try { state.users = await getJson('/api/users'); } catch (e) { $('#app').innerHTML = `<div class="page"><div class="card">Cannot reach API: ${esc(e.message)}</div></div>`; return; }
  pollStatus(); setInterval(pollStatus, 5000);
  route();
})();
