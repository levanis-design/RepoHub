/* SETTINGS. One file (settings.json beside the other RepoHub data), read and
   written only here, with every value checked against its allowed range. The
   page shows and edits them; a change is sent to every open RepoHub window
   (the main window and a popped-out Settings window) so both stay in step. */

const fs = require('fs');
const os = require('os');
const path = require('path');

function file() {
  if (process.env.REPOHUB_SETTINGS) return process.env.REPOHUB_SETTINGS;
  try { return path.join(require('electron').app.getPath('userData'), 'settings.json'); }
  catch { return path.join(os.homedir(), '.repohub-settings.json'); }
}

const FONT_RE = /^[A-Za-z0-9 ,"'\-]{1,120}$/;

/* key: [default, validator] */
const SCHEMA = {
  // Appearance
  themeMode: ['system', (v) => ['system', 'day', 'night'].includes(v)],
  colorTheme: ['indigo', (v) => ['indigo', 'ember', 'forest', 'graphite', 'ocean'].includes(v)],
  textSize: [100, (v) => Number.isFinite(v) && v >= 80 && v <= 150],
  uiFont: ['"Segoe UI", system-ui, sans-serif', (v) => typeof v === 'string' && FONT_RE.test(v)],
  readingFont: ['"Segoe UI", system-ui, sans-serif', (v) => typeof v === 'string' && FONT_RE.test(v)],
  codeFont: ['"Cascadia Code", Consolas, ui-monospace, monospace', (v) => typeof v === 'string' && FONT_RE.test(v)],
  density: ['comfortable', (v) => ['compact', 'comfortable'].includes(v)],
  // Writing style for Claude summaries
  writeStyle: ['plain', (v) => ['plain', 'brief', 'detailed', 'technical'].includes(v)],
  summaryLength: [250, (v) => Number.isFinite(v) && v >= 100 && v <= 600],
  // Start
  startView: ['welcome', (v) => ['welcome', 'grid', 'saved', 'last'].includes(v)],
  libraryView: ['list', (v) => ['list', 'grid'].includes(v)],
  librarySort: ['recent', (v) => ['recent', 'name', 'name-desc', 'attention', 'category'].includes(v)],
  // Layout: the movable separators
  sidebarWidth: [340, (v) => Number.isFinite(v) && v >= 220 && v <= 900],
  dockWidth: [480, (v) => Number.isFinite(v) && v >= 360 && v <= 1000],
  // Security
  sandboxMemoryGb: [2, (v) => Number.isFinite(v) && v >= 1 && v <= 16],
  sandboxCpus: [2, (v) => Number.isFinite(v) && v >= 1 && v <= 8],
  sandboxTtlMinutes: [30, (v) => Number.isFinite(v) && v >= 0 && v <= 480],
  sandboxReadOnly: [false, (v) => typeof v === 'boolean'],
  readmeImages: [true, (v) => typeof v === 'boolean'],
  confirmInstalls: [true, (v) => typeof v === 'boolean'],
  // Settings panel
  settingsMode: ['overlay', (v) => ['overlay', 'pinned'].includes(v)],
  // Remembered places
  lastRepo: ['', (v) => typeof v === 'string' && v.length < 1000],
};

function defaults() { return Object.fromEntries(Object.entries(SCHEMA).map(([k, [d]]) => [k, d])); }

function read() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch { /* first run */ }
  if (typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const out = defaults();
  for (const [k, [, ok]] of Object.entries(SCHEMA)) if (k in raw && ok(raw[k])) out[k] = raw[k];
  return out;
}

/* Apply a patch; unknown keys and invalid values are refused, by name. */
function write(patch = {}) {
  const cur = read();
  const refused = [];
  for (const [k, v] of Object.entries(patch || {})) {
    const rule = SCHEMA[k];
    if (rule && rule[1](v)) cur[k] = v; else refused.push(k);
  }
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cur, null, 2));
  return { ok: refused.length === 0, settings: cur, refused };
}

function reset(keys) {
  const d = defaults();
  const patch = Array.isArray(keys) && keys.length ? Object.fromEntries(keys.filter((k) => k in d).map((k) => [k, d[k]])) : d;
  return write(patch);
}

module.exports = { read, write, reset, defaults, SCHEMA, file };
