/* SAVED REPOSITORIES. Bookmarks with your own notes and tags, grouped into
   collections, plus the list of repositories you viewed recently. All of it is
   one file on this computer (saved.json); no login needed. Exports to CSV or
   JSON. */

const fs = require('fs');
const os = require('os');
const path = require('path');

function file() {
  if (process.env.REPOHUB_SAVED) return process.env.REPOHUB_SAVED;
  try { return path.join(require('electron').app.getPath('userData'), 'saved.json'); }
  catch { return path.join(os.homedir(), '.repohub-saved.json'); }
}
const EMPTY = { bookmarks: [], collections: [], history: [] };
function read() { try { return { ...EMPTY, ...(JSON.parse(fs.readFileSync(file(), 'utf8')) || {}) }; } catch { return { ...EMPTY }; } }
function write(d) { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(d, null, 2)); return d; }

const FULL_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function all() { return { ok: true, ...read() }; }

/* Save or update a bookmark. `snap` is a small snapshot shown in lists
   (description, stars, language, license) so the list needs no requests. */
function save(full, { note, tags, collections, snap } = {}) {
  if (!FULL_RE.test(String(full || ''))) return { ok: false, error: 'Not a repository name (owner/repository).' };
  const d = read();
  let b = d.bookmarks.find((x) => x.full.toLowerCase() === full.toLowerCase());
  if (!b) { b = { full, addedAt: new Date().toISOString(), note: '', tags: [], collections: [] }; d.bookmarks.unshift(b); }
  if (note != null) b.note = clean(note, 4000);
  if (Array.isArray(tags)) b.tags = [...new Set(tags.map((t) => clean(t, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
  if (Array.isArray(collections)) b.collections = collections.filter((id) => d.collections.some((c) => c.id === id));
  if (snap) b.snap = { description: clean(snap.description, 300), stars: Number(snap.stars) || 0, language: clean(snap.language, 40), license: clean(snap.license, 40), score: snap.score != null ? Number(snap.score) : (b.snap && b.snap.score) };
  write(d);
  return { ok: true, bookmark: b };
}

function unsave(full) {
  const d = read();
  d.bookmarks = d.bookmarks.filter((x) => x.full.toLowerCase() !== String(full).toLowerCase());
  write(d);
  return { ok: true };
}

function createCollection(name) {
  const n = clean(name, 80);
  if (!n) return { ok: false, error: 'Give the collection a name.' };
  const d = read();
  if (d.collections.some((c) => c.name.toLowerCase() === n.toLowerCase())) return { ok: false, error: 'A collection with that name exists.' };
  const c = { id: uid(), name: n, createdAt: new Date().toISOString() };
  d.collections.push(c);
  write(d);
  return { ok: true, collection: c };
}

function renameCollection(id, name) {
  const n = clean(name, 80);
  const d = read();
  const c = d.collections.find((x) => x.id === id);
  if (!c || !n) return { ok: false, error: 'Could not rename it.' };
  c.name = n; write(d);
  return { ok: true };
}

function deleteCollection(id) {
  const d = read();
  d.collections = d.collections.filter((c) => c.id !== id);
  for (const b of d.bookmarks) b.collections = (b.collections || []).filter((x) => x !== id);
  write(d);
  return { ok: true };
}

function visit(full, snap) {
  if (!FULL_RE.test(String(full || ''))) return { ok: false };
  const d = read();
  d.history = [{ full, at: new Date().toISOString(), description: clean(snap && snap.description, 200) },
    ...d.history.filter((h) => h.full.toLowerCase() !== full.toLowerCase())].slice(0, 40);
  write(d);
  return { ok: true };
}

function clearHistory() { const d = read(); d.history = []; write(d); return { ok: true }; }

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function exportText(format, collectionId) {
  const d = read();
  const names = Object.fromEntries(d.collections.map((c) => [c.id, c.name]));
  const rows = d.bookmarks.filter((b) => !collectionId || (b.collections || []).includes(collectionId));
  if (format === 'json') {
    return JSON.stringify(rows.map((b) => ({ repository: b.full, url: `https://github.com/${b.full}`, collections: (b.collections || []).map((id) => names[id]).filter(Boolean), tags: b.tags, note: b.note, saved: b.addedAt, ...(b.snap || {}) })), null, 2);
  }
  const head = ['repository', 'url', 'collections', 'tags', 'note', 'saved', 'description', 'stars', 'language', 'license', 'health score'];
  const lines = rows.map((b) => [b.full, `https://github.com/${b.full}`, (b.collections || []).map((id) => names[id]).filter(Boolean).join('; '), (b.tags || []).join('; '), b.note, b.addedAt.slice(0, 10),
    b.snap && b.snap.description, b.snap && b.snap.stars, b.snap && b.snap.language, b.snap && b.snap.license, b.snap && b.snap.score].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n');
}

module.exports = { all, save, unsave, createCollection, renameCollection, deleteCollection, visit, clearHistory, exportText, file };
