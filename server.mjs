import express from 'express';
import compression from 'compression';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.DATA_DIR || '/data';
const CACHE = process.env.CACHE_DIR || '/cache';
const PORT = +process.env.PORT || 8080;
const RESCAN_MS = 60_000;
const CONCURRENCY = 3;
const here = path.dirname(fileURLToPath(import.meta.url));

sharp.cache(false);
sharp.concurrency(2);

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic', '.avif']);
const VID_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.mpg', '.mpeg', '.wmv']);
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm' };

/** @type {Map<string, any>} */
const users = new Map();
const queue = [];
let active = 0;
const status = { total: 0, done: 0, failed: 0, running: false };

const readJson = async (file) => {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { return null; }
};
const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

// ---------- loading ----------
async function readParts(dir, names, prefix) {
  // prefix.json and prefix_partNNN.json, merged in order
  const re = new RegExp(`^${prefix}(_part\\d+)?\\.json$`);
  const files = names.filter((n) => re.test(n)).sort();
  const out = [];
  for (const f of files) { const d = await readJson(path.join(dir, f)); if (d != null) out.push(d); }
  return out;
}
const mergeKey = (parts, key) => parts.flatMap((p) => (Array.isArray(p) ? p : p?.[key] ?? []));
const mergeMap = (parts, key) => Object.assign({}, ...parts.map((p) => p?.[key] ?? {}));

async function dirSig(dir) {
  const [st, names] = await Promise.all([fs.stat(dir), fs.readdir(dir)]);
  return `${st.mtimeMs}:${names.length}`;
}

async function loadUser(name) {
  const dir = path.join(DATA, name);
  const names = await fs.readdir(dir);
  const sig = await dirSig(dir);
  const profile = (await readJson(path.join(dir, 'account_profile.json'))) || {};
  const get = async (prefix, key) => mergeKey(await readParts(dir, names, prefix), key);

  const albums = mergeKey(await readParts(dir, names, 'albums'), 'albums');
  const contacts = mergeMap(await readParts(dir, names, 'contacts'), 'contacts');
  const followers = mergeMap(await readParts(dir, names, 'followers'), 'followers');
  const faves = await get('faves', 'faves');
  const commentsMade = await get('photos_comments', 'comments');
  const setComments = await get('sets_comments', 'comments');
  const galleryComments = await get('galleries_comments', 'comments');
  const appComments = await get('apps_comments', 'comments');
  const galleries = await get('galleries', 'galleries');
  const groups = await get('groups', 'groups');
  const discussions = await get('group_discussions', 'discussions');
  const mailIn = await get('received_flickrmail', 'flickrmail');
  const mailOut = await get('sent_flickrmail', 'flickrmail');
  const testimonials = (await readJson(path.join(dir, 'account_testimonials.json')))?.testimonials || { given: [], received: [] };
  const milestones = (await get('milestones', 'milestones'));

  // media file index: any run of 6+ digits in a media filename maps to that file
  const media = new Map();
  for (const n of names) {
    const ext = path.extname(n).toLowerCase();
    if (!IMG_EXT.has(ext) && !VID_EXT.has(ext)) continue;
    const runs = n.match(/\d{6,}/g) || [];
    // prefer the run directly before _o / secret
    for (const r of runs) { if (!media.has(r)) media.set(r, n); }
  }

  const photos = [];
  const photoFiles = names.filter((n) => /^photo_.+\.json$/.test(n));
  for (const f of photoFiles) {
    const p = await readJson(path.join(dir, f));
    if (!p || !p.id) continue;
    const id = String(p.id);
    const file = media.get(id) || null;
    const ext = file ? path.extname(file).toLowerCase() : '';
    const geo = Array.isArray(p.geo) ? p.geo[0] : p.geo && p.geo.latitude ? p.geo : null;
    let lat = null, lon = null;
    if (geo && geo.latitude != null) {
      lat = parseFloat(geo.latitude); lon = parseFloat(geo.longitude);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { lat /= 1e6; lon /= 1e6; }
    }
    photos.push({
      id, file, video: VID_EXT.has(ext),
      name: p.name || '', description: p.description || '',
      taken: validDate(p.date_taken), imported: validDate(p.date_imported),
      views: num(p.count_views), faves: num(p.count_faves), nComments: Math.max(num(p.count_comments), (p.comments || []).length),
      tags: (p.tags || []).map((t) => t.tag),
      tagDetail: p.tags || [],
      lat, lon, geoAccuracy: geo?.accuracy ?? null,
      privacy: p.privacy || '', safety: p.safety || '', license: p.license || '',
      photopage: p.photopage || '', original: p.original || '',
      comments: p.comments || [], groups: p.groups || [], albums: p.albums || [],
      people: p.people || [], notes: p.notes || [], rotation: p.rotation || 0,
      commentPermissions: p.comment_permissions || '', taggingPermissions: p.tagging_permissions || '',
      w: 0, h: 0,
    });
  }
  // album membership from albums.json (authoritative for order)
  const byId = new Map(photos.map((p) => [p.id, p]));
  for (const a of albums) {
    for (const pid of a.photos || []) {
      const p = byId.get(String(pid));
      if (p) (p._albums ||= []).push(String(a.id));
    }
  }
  const nsid = profile.nsid || '';
  return {
    name, dir, sig, names, profile, albums, contacts, followers, faves, commentsMade, setComments, galleryComments,
    appComments, galleries, groups, discussions, mailIn, mailOut, testimonials, milestones, photos, byId, nsid,
    populated: names.some((n) => n.endsWith('.json')) || media.size > 0,
  };
}

function validDate(s) {
  if (!s || typeof s !== 'string' || s.startsWith('0000')) return null;
  return s;
}

async function scan() {
  let entries = [];
  try { entries = await fs.readdir(DATA, { withFileTypes: true }); } catch (e) { console.error('cannot read', DATA, e.message); return; }
  const seen = new Set();
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('__')) continue;
    seen.add(e.name);
    try {
      const sig = await dirSig(path.join(DATA, e.name));
      if (users.get(e.name)?.sig === sig) continue;
      console.log('loading', e.name);
      const u = await loadUser(e.name);
      await loadDims(u);
      users.set(e.name, u);
      enqueueThumbs(u);
      console.log(` ${e.name}: ${u.photos.length} photos`);
    } catch (err) { console.error('load failed', e.name, err); }
  }
  for (const k of [...users.keys()]) if (!seen.has(k)) users.delete(k);
}

// ---------- dimensions + thumbnails ----------
const cdir = (u) => path.join(CACHE, u.name);
async function loadDims(u) {
  await fs.mkdir(cdir(u), { recursive: true });
  const dimFile = path.join(cdir(u), 'dims.json');
  const cache = (await readJson(dimFile)) || {};
  let dirty = false;
  for (const p of u.photos) {
    if (!p.file || p.video) continue;
    const full = path.join(u.dir, p.file);
    let st;
    try { st = await fs.stat(full); } catch { p.file = null; continue; }
    const c = cache[p.file];
    if (c && c.s === st.size && c.m === st.mtimeMs) { p.w = c.w; p.h = c.h; continue; }
    try {
      const m = await sharp(full).metadata();
      const swap = (m.orientation || 1) >= 5;
      p.w = swap ? m.height : m.width; p.h = swap ? m.width : m.height;
      cache[p.file] = { w: p.w, h: p.h, s: st.size, m: st.mtimeMs }; dirty = true;
    } catch (e) { console.warn('metadata failed', p.file, e.message); }
  }
  if (dirty) await fs.writeFile(dimFile, JSON.stringify(cache));
}

const SIZES = { t: { w: 800, h: 400, q: 80 }, p: { w: 2000, h: 2000, q: 84 } };
const inflight = new Map();
function thumbPath(u, p, kind) { return path.join(cdir(u), `${p.id}_${kind}.jpg`); }
async function exists(f) { try { await fs.access(f); return true; } catch { return false; } }

function makeThumb(u, p, kind) {
  const out = thumbPath(u, p, kind);
  if (inflight.has(out)) return inflight.get(out);
  const job = (async () => {
    const s = SIZES[kind];
    const tmp = `${out}.${process.pid}.tmp`;
    await sharp(path.join(u.dir, p.file), { failOn: 'none' })
      .rotate().resize(s.w, s.h, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: s.q, mozjpeg: true }).toFile(tmp);
    await fs.rename(tmp, out);
    return out;
  })().finally(() => inflight.delete(out));
  inflight.set(out, job);
  return job;
}

const queued = new Set();
async function enqueueThumbs(u) {
  const now = Date.now();
  for (const p of u.photos) {
    if (!p.file || p.video) continue;
    const key = `${u.name}/${p.id}`;
    if (queued.has(key)) continue;
    // file still being copied in? leave it for a later scan
    try {
      if (now - (await fs.stat(path.join(u.dir, p.file))).mtimeMs < 60_000) { u.sig = 'recent'; continue; }
    } catch { continue; }
    queued.add(key);
    queue.push({ u, p });
  }
  status.total = status.done + status.failed + queue.length + active;
  pump();
}
function pump() {
  while (active < CONCURRENCY && queue.length) {
    const { u, p } = queue.shift();
    active++; status.running = true;
    (async () => {
      try {
        for (const k of ['t', 'p']) if (!(await exists(thumbPath(u, p, k)))) await makeThumb(u, p, k);
        status.done++;
      } catch (e) { status.failed++; console.warn('thumb failed', p.file, e.message); }
    })().finally(() => {
      active--; queued.delete(`${u.name}/${p.id}`);
      if (!queue.length && !active) { status.running = false; console.log('thumbnails complete', status); }
      pump();
    });
  }
}

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
app.use(compression());

const userOr404 = (req, res) => {
  const u = users.get(req.params.user);
  if (!u) { res.status(404).json({ error: 'no such user' }); return null; }
  return u;
};

app.get('/api/users', (req, res) => {
  res.json([...users.values()].sort((a, b) => a.name.localeCompare(b.name)).map((u) => ({
    name: u.name, populated: u.populated, nsid: u.nsid,
    alias: u.profile.path_alias || '', screenName: u.profile.screen_name || u.profile.real_name || u.name,
    realName: u.profile.real_name || '', joined: u.profile.join_date || '',
    photos: u.photos.length, withFiles: u.photos.filter((p) => p.file).length,
    sample: u.photos.filter((p) => p.file && !p.video).slice(0, 400).map((p) => p.id),
  })));
});

app.get('/api/status', (req, res) => res.json({ ...status, queued: queue.length }));

app.get('/api/u/:user', (req, res) => {
  const u = userOr404(req, res); if (!u) return;
  res.json({
    name: u.name, profile: u.profile, albums: u.albums, contacts: u.contacts, followers: u.followers,
    faves: u.faves, commentsMade: u.commentsMade, setComments: u.setComments, galleryComments: u.galleryComments,
    appComments: u.appComments, galleries: u.galleries, groups: u.groups, discussions: u.discussions,
    mailIn: u.mailIn, mailOut: u.mailOut, testimonials: u.testimonials, milestones: u.milestones,
    populated: u.populated,
  });
});

app.get('/api/u/:user/photos', (req, res) => {
  const u = userOr404(req, res); if (!u) return;
  res.json(u.photos.map(({ ...p }) => { p.albums = p._albums || []; delete p._albums; delete p.tagDetail; return p; }));
});

app.get('/media/:user/:id/:kind', async (req, res) => {
  const u = users.get(req.params.user);
  const p = u?.byId.get(req.params.id);
  const kind = req.params.kind;
  if (!p || !p.file || !['t', 'p', 'o'].includes(kind)) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400');
  try {
    if (kind === 'o' || p.video) {
      return res.type(MIME[path.extname(p.file).toLowerCase()] || 'application/octet-stream')
        .sendFile(path.join(u.dir, p.file), { dotfiles: 'allow' });
    }
    let f = thumbPath(u, p, kind);
    if (!(await exists(f))) f = await makeThumb(u, p, kind);
    res.type('image/jpeg').sendFile(f);
  } catch (e) {
    console.warn('media failed', p.file, e.message);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.use(express.static(path.join(here, 'public'), { maxAge: 0, etag: true }));

await fs.mkdir(CACHE, { recursive: true });
app.listen(PORT, () => console.log(`listening on ${PORT}`));
await scan();
setInterval(() => scan().catch((e) => console.error('scan', e)), RESCAN_MS);
