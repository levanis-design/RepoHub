/* ============================================================
   REPOHUB — the page. Two things on screen:

   Left    every repository on this computer, with what needs attention
   Right   either a GitHub link you pasted (Explore: what it is, whether it is
           safe to install, and an Install button), or a repository you picked
           (Overview, Git, Run, README)

   Everything that touches the computer goes through window.hub (preload.js).
   ============================================================ */
(() => {
  const hub = window.hub;
  const $ = (id) => document.getElementById(id);

  /* replaceChildren that skips null and false, like h() does: a conditional
     child must never show up as the text "null". */
  const _replace = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...kids) { return _replace.apply(this, kids.filter((k) => k != null && k !== false)); };

  /* ---------- small helpers ---------- */
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const ownerOf = (remote) => { const m = String(remote || '').match(/[/:]([^/:]+)\/[^/]+?(\.git)?$/); return m ? m[1] : ''; };
  const webOf = (s) => (s && s.web) || '';
  const sameRepo = (a, b) => a && b && a.replace(/\.git$/i, '').toLowerCase() === b.replace(/\.git$/i, '').toLowerCase();

  function toast(msg, ms = 5000, kind = '') {
    const el = h('div', { class: `toast ${kind}`, text: msg });
    $('toasts').append(el);
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 400);
  }
  const fail = (res, fallback) => toast((res && res.error) || fallback || 'That did not work.', 9000, 'bad');

  /* ---------- markdown, made safe ---------- */
  const BAD_TAGS = 'script,style,iframe,object,embed,form,input,button,textarea,select,link,meta,base,frame,frameset,svg,math';
  function md(text, base) {
    const wrap = h('div', { class: 'markdown' });
    let html = '';
    try { html = window.marked ? window.marked.parse(String(text || ''), { gfm: true }) : ''; } catch { html = ''; }
    if (!html) { wrap.append(h('pre', { text: String(text || '') })); return wrap; }
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    doc.querySelectorAll(BAD_TAGS).forEach((n) => n.remove());
    doc.querySelectorAll('*').forEach((n) => {
      for (const a of [...n.attributes]) {
        const name = a.name.toLowerCase();
        const val = a.value.trim().toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcset') n.removeAttribute(a.name);
        else if ((name === 'href' || name === 'src') && /^(javascript|vbscript|data|file):/.test(val) && !(name === 'src' && val.startsWith('data:image/'))) n.removeAttribute(a.name);
      }
      if (n.tagName === 'A') {
        const href = n.getAttribute('href') || '';
        if (!href || href.startsWith('#')) n.removeAttribute('href');
        else if (base && base.blob && !/^[a-z]+:/i.test(href)) n.setAttribute('href', base.blob + href.replace(/^\.?\//, ''));
        n.setAttribute('target', '_blank');
        n.setAttribute('rel', 'noopener noreferrer');
      }
      if (n.tagName === 'IMG') {
        const src = n.getAttribute('src') || '';
        if (base && base.raw && src && !/^[a-z]+:/i.test(src)) n.setAttribute('src', base.raw + src.replace(/^\.?\//, ''));
        else if (!/^(https:|data:image\/)/i.test(n.getAttribute('src') || '')) n.remove();
        if (S && S.readmeImages === false && n.isConnected !== false) { const alt = doc.createElement('span'); alt.className = 'img-off'; alt.textContent = `[image${n.getAttribute('alt') ? `: ${n.getAttribute('alt')}` : ''}]`; n.replaceWith(alt); return; }
        n.setAttribute('loading', 'lazy');
        n.setAttribute('referrerpolicy', 'no-referrer');
      }
    });
    wrap.append(...doc.body.firstChild.childNodes);
    return wrap;
  }

  /* ---------- state ---------- */
  const S = {
    repos: [], status: {}, owner: '',
    filter: '', view: 'all', showHidden: false,
    sel: null,               // { type: 'repo', path, tab } | { type: 'explore', link, data, tab }
    busy: new Set(),         // repos with a git action running
    running: new Set(),      // repos with a job running
    output: new Map(),       // dir → text
    local: new Map(),        // dir → { info, facts, summary }
    tools: null,             // { git: 'git version …', node: '', … }
    cats: {},                // dir → { id, label, why, mine } (categories.js)
    catList: [],             // [[id, label], …] in display order
    collapsed: new Set(),    // category groups folded in the list
    sort: 'recent',          // recent | name | name-desc | attention | category
  };
  const st = (p) => S.status[p] || null;
  const repoByPath = (p) => S.repos.find((r) => r.path === p);
  const isMine = (r) => !!S.owner && ownerOf((st(r.path) || {}).remote).toLowerCase() === S.owner.toLowerCase();
  const attention = (s) => !!s && s.ok && (s.changed > 0 || s.ahead > 0 || s.behind > 0 || s.locked || s.conflicts > 0 || !s.remote);

  /* ---------- library (left) ---------- */
  const catOf = (r) => S.cats[r.path] || null;
  const catRank = (r) => { const c = catOf(r); const i = c ? S.catList.findIndex(([id]) => id === c.id) : -1; return i < 0 ? 999 : i; };
  const attScore = (r) => { const s2 = st(r.path); return s2 && s2.ok ? (s2.conflicts ? 100 : 0) + (s2.locked ? 50 : 0) + s2.changed + s2.ahead * 2 + s2.behind * 3 : -1; };
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const byRecent = (a, b) => String((st(b.path) || {}).lastDate || '').localeCompare(String((st(a.path) || {}).lastDate || '')) || byName(a, b);
  const SORTS = [['recent', 'Most recent', 'Sort: recent'], ['name', 'Name, A to Z', 'Sort: A to Z'], ['name-desc', 'Name, Z to A', 'Sort: Z to A'], ['category', 'Category (what it does)', 'Sort: category'], ['attention', 'Needs attention first', 'Sort: attention']];
  function sortRows(rows, mode) {
    const cmp = mode === 'name' ? byName
      : mode === 'name-desc' ? (a, b) => byName(b, a)
        : mode === 'attention' ? (a, b) => attScore(b) - attScore(a) || byRecent(a, b)
          : mode === 'category' ? (a, b) => catRank(a) - catRank(b) || byName(a, b)
            : byRecent;
    return rows.slice().sort(cmp);
  }
  /* Rows split into category groups, in category order: [{ id, label, rows }]. */
  function groupByCategory(rows) {
    const groups = new Map();
    for (const r of rows) {
      const c = catOf(r) || { id: 'unknown', label: 'Reading…' };
      if (!groups.has(c.id)) groups.set(c.id, { id: c.id, label: c.label, rows: [] });
      groups.get(c.id).rows.push(r);
    }
    return [...groups.values()];
  }
  function visible() {
    return sortRows(S.repos.filter((r) => {
      if (r.hidden && !S.showHidden) return false;
      const s = st(r.path);
      if (S.view === 'attention' && !attention(s)) return false;
      if (S.view === 'mine' && !isMine(r)) return false;
      if (S.view === 'others' && isMine(r)) return false;
      if (S.filter && !`${r.name} ${r.path} ${(s && s.remote) || ''} ${(catOf(r) || {}).label || ''}`.toLowerCase().includes(S.filter)) return false;
      return true;
    }), S.sort);
  }
  async function loadCategories() {
    const r = await hub.repos.categories(S.repos.map((x) => x.path)).catch(() => null);
    if (!r || !r.ok) return;
    S.cats = r.categories || {};
    S.catList = r.list || [];
    paintList();
    if (S.sel && S.sel.type === 'grid') paintGrid();
    else if (S.sel && S.sel.type === 'repo') paintMain();
  }
  function setSort(mode) {
    S.sort = mode;
    const el = $('sort'); if (el) el.value = mode;
    paintList();
    setSetting({ librarySort: mode });
  }

  function chips(s, r) {
    const out = [];
    if (r && S.running.has(r.path)) out.push(h('span', { class: 'chip info', text: 'running' }));
    if (!s) return [...out, h('span', { class: 'chip', text: 'reading…' })];
    if (!s.ok) return [...out, h('span', { class: 'chip bad', text: 'error' })];
    if (s.locked) out.push(h('span', { class: 'chip bad', text: 'locked' }));
    if (s.conflicts) out.push(h('span', { class: 'chip bad', text: `${s.conflicts} conflict` }));
    if (s.changed) out.push(h('span', { class: 'chip warn', text: `${s.changed} changed` }));
    if (s.ahead) out.push(h('span', { class: 'chip warn', text: `↑${s.ahead} to push` }));
    if (s.behind) out.push(h('span', { class: 'chip info', text: `↓${s.behind} new` }));
    if (!s.remote) out.push(h('span', { class: 'chip', text: 'local only' }));
    if (!out.length) out.push(h('span', { class: 'chip ok', text: 'clean' }));
    return out;
  }

  function paintTiles() {
    const shown = S.repos.filter((r) => !r.hidden).map((r) => st(r.path)).filter((s) => s && s.ok);
    const n = (f) => shown.filter(f).length;
    const tile = (label, value, view) => h('button', { class: 'tile', title: 'Show these', onclick: () => { S.view = view; $('view').value = view; paintList(); } },
      h('div', { class: 'tile-v', text: String(value) }), h('div', { class: 'tile-l', text: label }));
    $('summary-tiles').replaceChildren(
      tile('changed', n((s) => s.changed > 0), 'attention'),
      tile('to push', n((s) => s.ahead > 0), 'attention'),
      tile('new on GitHub', n((s) => s.behind > 0), 'attention'));
  }

  function paintList() {
    paintTiles();
    const hiddenCount = S.repos.filter((r) => r.hidden).length;
    $('lib-count').textContent = S.repos.length ? `${S.repos.length - hiddenCount}${hiddenCount ? ` (+${hiddenCount} hidden)` : ''}` : '';
    const list = $('repo-list');
    const rows = visible();
    if (!S.repos.length) { list.replaceChildren(h('div', { class: 'empty', text: 'No repositories found yet. Use More → Rescan, or paste a link above and install one.' })); return; }
    if (!rows.length) { list.replaceChildren(h('div', { class: 'empty', text: 'Nothing matches.' })); return; }
    const rowEl = (r) => {
      const s = st(r.path);
      const sel = S.sel && S.sel.type === 'repo' && S.sel.path === r.path;
      const c = catOf(r);
      return h('button', { class: `repo-row${sel ? ' sel' : ''}${r.hidden ? ' hidden-repo' : ''}`, title: c ? `${r.path}\n${c.label} (${c.why})` : r.path, onclick: () => openRepo(r.path) },
        h('div', { class: 'row-top' }, h('span', { class: 'row-name', text: r.name }),
          S.busy.has(r.path) ? h('span', { class: 'spin', text: '⟳' }) : null,
          h('span', { class: 'grow' }), h('span', { class: 'dim', text: (s && s.lastDate) || '' })),
        h('div', { class: 'row-sub' }, h('span', { class: 'dim mono', text: [ownerOf(s && s.remote), s && s.branch].filter(Boolean).join(' · ') }),
          c && S.sort !== 'category' ? h('span', { class: 'row-cat', text: c.label }) : null,
          h('span', { class: 'grow' }), ...chips(s, r)));
    };
    if (S.sort !== 'category') { list.replaceChildren(...rows.map(rowEl)); return; }
    list.replaceChildren(...groupByCategory(rows).flatMap((g) => {
      const folded = S.collapsed.has(g.id) && !S.filter;
      return [
        h('button', { class: `group-head${folded ? ' folded' : ''}`, 'aria-expanded': folded ? 'false' : 'true', title: folded ? 'Show this group' : 'Fold this group', onclick: () => { if (S.collapsed.has(g.id)) S.collapsed.delete(g.id); else S.collapsed.add(g.id); paintList(); } },
          h('span', { class: 'caret', text: folded ? '▸' : '▾' }), h('span', { class: 'grow', text: g.label }), h('span', { class: 'count', text: String(g.rows.length) })),
        ...(folded ? [] : g.rows.map(rowEl)),
      ];
    }));
  }

  async function refreshOne(p) {
    try { S.status[p] = await hub.repos.status(p); } catch (e) { S.status[p] = { ok: false, error: String(e && e.message) }; }
  }
  async function refreshAll() {
    const paths = S.repos.filter((r) => !r.hidden || S.showHidden).map((r) => r.path);
    Object.assign(S.status, await hub.repos.statusMany(paths));
    paintList();
    if (S.sel && S.sel.type === 'repo') paintMain();
  }
  async function rescan() {
    $('repo-list').replaceChildren(h('div', { class: 'empty', text: 'Looking for repositories…' }));
    const r = await hub.repos.scan();
    if (!r || !r.ok) { fail(r, 'The scan failed.'); return; }
    S.repos = r.repos;
    if (r.timedOut) toast('The scan stopped after a minute. Narrow the folders in Tools.', 8000);
    loadCategories().catch(() => {});
    await refreshAll();
  }
  async function reloadList() { const c = await hub.repos.cached(); if (c && c.ok) { S.repos = c.repos; loadCategories().catch(() => {}); } }
  async function fetchAll() {
    const list = S.repos.filter((r) => !r.hidden && st(r.path) && st(r.path).remote);
    let done = 0, failed = 0;
    const btn = $('fetch-btn');
    btn.disabled = true;
    const q = list.slice();
    const worker = async () => {
      while (q.length) {
        const r = q.shift();
        const res = await hub.repos.fetch(r.path).catch(() => null);
        if (!res || !res.ok) failed += 1;
        btn.textContent = `Fetching ${++done}/${list.length}`;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    btn.disabled = false; btn.textContent = 'Fetch all';
    if (failed) toast(`${plural(failed, 'repository')} could not be fetched (offline, signed out, or no access).`, 7000);
    await refreshAll();
  }

  /* ---------- shared pieces for the right side ---------- */
  const main = $('main');
  const tabsBar = (tabs, current, onPick) => h('div', { class: 'tabs' },
    tabs.map(([id, label]) => h('button', { class: `tab${id === current ? ' active' : ''}`, text: label, onclick: () => onPick(id) })));
  const section = (title, ...kids) => h('section', { class: 'card' }, title ? h('div', { class: 'card-title', text: title }) : null, ...kids);

  async function ensureTools() {
    if (S.tools) return S.tools;
    const r = await hub.tools.check().catch(() => null);
    S.tools = (r && r.tools) || {};
    return S.tools;
  }

  function needsBox(facts) {
    const tools = S.tools || {};
    return h('div', { class: 'needs' }, facts.needs.map((n) => {
      const have = tools[n.tool];
      const known = S.tools != null;
      return h('div', { class: 'need' },
        h('span', { class: `dot ${!known ? '' : have ? 'ok' : 'bad'}` }),
        h('span', { class: 'need-tool', text: n.tool }),
        h('span', { class: 'dim', text: known ? (have ? have : 'not installed') : 'checking…' }),
        h('span', { class: 'dim need-why', text: n.why }));
    }));
  }

  function factsBlock(facts, info) {
    const kids = [];
    kids.push(h('div', { class: 'kinds' }, facts.kinds.map((k) => h('span', { class: 'kind', text: k }))));
    if (facts.cautions.length) kids.push(h('div', { class: 'cautions' }, h('div', { class: 'card-sub', text: 'Worth knowing before installing' }), h('ul', {}, facts.cautions.map((c) => h('li', { text: c })))));
    kids.push(h('div', { class: 'card-sub', text: 'What it needs on this computer' }), needsBox(facts));
    if (facts.envKeys.length) kids.push(h('div', { class: 'card-sub', text: 'Settings it expects (from .env.example)' }), h('div', { class: 'mono dim wrap', text: facts.envKeys.join('  ') }));
    const cr = facts.claudeReady;
    kids.push(h('div', { class: 'card-sub', text: 'Claude' }), h('div', { class: 'dim', text:
      [cr.claudeMd ? 'has CLAUDE.md (notes for Claude)' : 'no CLAUDE.md yet', cr.agentsMd ? 'has AGENTS.md' : '', cr.mcp ? 'has an MCP config' : '', cr.skills ? 'has skills or a .claude folder' : ''].filter(Boolean).join(' · ') }));
    if (info && info.files && info.files.length) {
      kids.push(h('details', { class: 'files' }, h('summary', { text: `Top-level files (${info.files.length})` }),
        h('div', { class: 'file-grid' }, info.files.slice(0, 200).map((f) => h('span', { class: `mono ${f.type === 'dir' ? 'dir' : ''}`, text: f.name + (f.type === 'dir' ? '/' : '') })))));
    }
    return kids;
  }

  function summaryBlock(summary, onExplain, busy) {
    return section('Plain-English summary',
      summary && summary.text ? h('div', { class: 'md-compact' }, md(summary.text)) : h('div', { class: 'dim', text: 'Ask Claude Code on this computer to read the README and setup files and explain this repository in plain words. Takes about a minute.' }),
      h('div', { class: 'bar' },
        h('button', { class: 'btn btn-accent', text: busy ? 'Claude is reading…' : summary ? 'Explain again' : 'Explain with Claude', disabled: busy, onclick: onExplain }),
        summary && summary.at ? h('span', { class: 'dim', text: `written ${summary.at.slice(0, 10)}` }) : null));
  }

  /* ---------- Explore: a pasted link ---------- */
  async function explore(link) {
    const value = String(link || '').trim();
    if (!value) return;
    S.sel = { type: 'explore', link: value, data: null, tab: 'overview', loading: true };
    paintList(); paintMain();
    const data = await hub.gh.preview(value);
    if (!S.sel || S.sel.link !== value) return;
    S.sel.loading = false;
    S.sel.data = data;
    if (data && data.ok) {
      const [f, sum] = await Promise.all([hub.explain.facts(data), hub.explain.summary(`gh:${data.fullName.toLowerCase()}`)]);
      S.sel.facts = f.facts; S.sel.summary = sum.summary;
      hub.saved.visit(data.fullName, { description: data.description }).then(loadSaved).catch(() => {});
    }
    paintMain();
    ensureTools().then(() => { if (S.sel && S.sel.type === 'explore') paintMain(); });
  }

  function localMatch(web) {
    return S.repos.find((r) => sameRepo(webOf(st(r.path)), web));
  }

  function paintExplore() {
    const E = S.sel;
    if (E.loading) { main.replaceChildren(h('div', { class: 'loading', text: `Reading ${E.link} from GitHub…` })); return; }
    const d = E.data;
    if (!d || !d.ok) {
      main.replaceChildren(section('Could not preview this link',
        h('p', { text: (d && d.error) || 'Unknown error.' }),
        d && d.parsed ? h('div', {}, h('p', { class: 'dim', text: 'If it is a private repository, you can still download it: Git will ask you to sign in.' }), installBox({ cloneUrl: d.parsed.cloneUrl, name: d.parsed.repo })) : null));
      return;
    }
    const base = { blob: `${d.web}/blob/${d.defaultBranch}/`, raw: `https://raw.githubusercontent.com/${d.fullName}/${d.defaultBranch}/` };
    const have = localMatch(d.web);
    const stat = (label, value) => h('div', { class: 'stat' }, h('div', { class: 'stat-v', text: value }), h('div', { class: 'stat-l', text: label }));
    const head = h('div', { class: 'head' },
      h('div', { class: 'head-title' }, h('span', { class: 'head-name', text: d.fullName }),
        d.archived ? h('span', { class: 'chip bad', text: 'archived' }) : null,
        d.fork ? h('span', { class: 'chip', text: 'fork' }) : null),
      d.description ? h('div', { class: 'head-desc', text: d.description }) : null,
      h('div', { class: 'stats' },
        stat('stars', num(d.stars)), stat('forks', num(d.forks)), stat('license', d.license || 'none'),
        stat('last change', d.pushedAt || 'n/a'), stat('created', d.createdAt || 'n/a'),
        stat('main language', (d.languages[0] && `${d.languages[0].name} ${d.languages[0].pct}%`) || 'n/a')),
      d.topics.length ? h('div', { class: 'kinds' }, d.topics.slice(0, 10).map((t) => h('span', { class: 'topic', text: t }))) : null,
      h('div', { class: 'bar' },
        saveButton(d, E.ins),
        h('button', { class: 'btn', text: S.compare.includes(d.fullName) ? 'In compare' : 'Add to compare', disabled: S.compare.includes(d.fullName), onclick: () => addCompare(d.fullName) }),
        h('button', { class: 'btn', text: 'Open on GitHub', onclick: () => hub.open.web(d.web) }),
        d.homepage && /^https:\/\//.test(d.homepage) ? h('span', { class: 'dim mono', text: d.homepage }) : null));
    const tab = E.tab || 'overview';
    const body = [];
    if (tab === 'overview') {
      body.push(summaryBlock(E.summary, async () => {
        E.explaining = true; paintMain();
        const r = await hub.explain.claude({ key: `gh:${d.fullName.toLowerCase()}`, link: d.web });
        E.explaining = false;
        if (r && r.ok) E.summary = { text: r.text, at: new Date().toISOString() }; else fail(r, 'Claude could not explain it.');
        if (S.sel === E) paintMain();
      }, E.explaining));
      if (E.facts) body.push(section('What RepoHub found in the files', ...factsBlock(E.facts, d)));
      if (E.facts && E.facts.plan.length) body.push(section('How it installs', h('div', { class: 'dim', text: 'After downloading, these run from the repository\'s own page, one click each, with the output shown.' }),
        h('ol', { class: 'plan' }, E.facts.plan.map((p) => h('li', {}, h('span', { class: 'mono', text: p.command }), h('span', { class: 'dim', text: ` · ${p.why}` }))))));
    } else if (tab === 'health') {
      body.push(...healthView(E, d.web));
    } else if (tab === 'activity') {
      body.push(...activityView(E, d.web));
    } else if (tab === 'files') {
      body.push(fileBrowser(E, { kind: 'gh', link: d.web, ref: d.defaultBranch }));
    } else if (tab === 'readme') {
      body.push(section('', d.readme ? md(d.readme, base) : h('div', { class: 'dim', text: 'This repository has no README.' })));
    }
    const side = h('div', { class: 'side-col' },
      have
        ? section('Already on this computer', h('div', { class: 'mono dim wrap', text: have.path }), h('div', { class: 'bar' }, h('button', { class: 'btn btn-primary', text: 'Open it', onclick: () => openRepo(have.path) })))
        : installBox(d),
      sandboxCard({ link: d.web, cloneUrl: d.cloneUrl, repo: d.fullName }),
      aiToolsCard(d.fullName, { private: d.private }));
    main.replaceChildren(head, h('div', { class: `split${tab === 'files' ? ' full' : ''}` },
      h('div', { class: 'main-col' }, tabsBar([['overview', 'Overview'], ['health', E.ins ? `Health ${E.ins.total}` : 'Health'], ['activity', 'Activity'], ['files', 'Files'], ['readme', 'README']], tab, (t) => { E.tab = t; paintMain(); }), ...body),
      tab === 'files' ? null : side));
  }

  /* GitIngest, GitDiagram, DeepWiki and GitMCP for a GitHub repository. The
     links are built in the main process from the owner and repository name. */
  const AI_ACTION = { gitingest: 'Open as text', gitdiagram: 'Open diagram', deepwiki: 'Open wiki', gitmcp: 'Open' };
  function aiToolsCard(full, opts = {}) {
    const box = h('div', { class: 'ai-tools' }, h('div', { class: 'dim', text: 'Loading…' }));
    hub.aitools.links(full).then((l) => {
      if (!l || !l.ok) { box.replaceChildren(h('div', { class: 'dim', text: (l && l.error) || 'Not a GitHub repository.' })); return; }
      box.replaceChildren(
        opts.private ? h('div', { class: 'warn-box', text: 'This repository is private. These services only read public repositories.' }) : null,
        ...l.services.map((sv) => h('div', { class: 'ai-tool' },
          h('div', { class: 'ai-tool-text' },
            h('div', { class: 'ai-tool-name' }, h('b', { text: sv.name }), h('span', { class: 'mono dim', text: ` ${sv.host}/${l.full}` })),
            h('div', { class: 'dim', text: sv.what })),
          h('div', { class: 'bar tight' },
            h('button', { class: 'btn btn-sm', text: AI_ACTION[sv.id] || 'Open', title: `Opens ${sv.url} in your browser`, onclick: () => hub.aitools.open(sv.id, l.full).then((x) => x && !x.ok && fail(x)) }),
            h('button', { class: 'btn btn-sm btn-ghost', text: 'Copy link', onclick: () => copyText(sv.url) }),
            sv.id === 'gitmcp' ? h('button', { class: 'btn btn-sm btn-accent', text: 'Add to Claude Code', title: 'Lets Claude Code look things up in this repository\'s docs', onclick: () => addGitMcp(l.full) }) : null))));
    });
    return section('Explore with AI tools', h('div', { class: 'dim', text: 'Free web services that read public GitHub repositories. Links open in your browser.' }), box);
  }
  async function addGitMcp(full) {
    const c = await hub.aitools.mcpCommand(full);
    if (!c || !c.ok) { fail(c); return; }
    if (!(await confirmBox('Add GitMCP to Claude Code?', `Claude Code will be able to look things up in ${full}'s docs in every project. RepoHub runs:\n${c.text}\nRemove it later with: claude mcp remove ${c.name} --scope user`, 'Add to Claude Code'))) return;
    const r = await hub.aitools.addMcp(full);
    if (r && r.ok) toast(r.already ? `${r.name} was already in Claude Code.` : `Added ${r.name} to Claude Code. Start a new Claude session to use it.`, 7000, 'good'); else fail(r);
  }

  function installBox(d) {
    const whereEl = h('div', { class: 'mono dim wrap', text: 'reading…' });
    const destEl = h('div', { class: 'mono wrap' });
    let parent = '';
    const paint = () => { whereEl.textContent = parent; destEl.textContent = parent ? `${parent}\\${(d.name || '').replace(/[^\w.\-]/g, '')}`.replace(/\\\\/g, '\\') : ''; };
    hub.app.defaultCloneDir().then((r) => { parent = (r && r.path) || ''; paint(); });
    const go = async (e) => {
      const b = e.target;
      if (!parent) return;
      b.disabled = true; b.textContent = 'Downloading…';
      const mk = await hub.app.setCloneDir(parent);
      if (!mk || !mk.ok) { b.disabled = false; b.textContent = 'Download to this computer'; fail(mk, 'Could not use that folder.'); return; }
      const res = await hub.repos.clone(d.cloneUrl, parent);
      if (!res || !res.ok) { b.disabled = false; b.textContent = 'Download to this computer'; fail(res, 'Download failed.'); return; }
      toast(`Downloaded to ${res.path}`, 6000, 'good');
      await reloadList();
      await refreshOne(res.path);
      openRepo(res.path, 'overview', true);
    };
    return section('Install',
      h('div', { class: 'dim', text: 'Step 1 downloads the code (git clone). Nothing runs yet. Step 2, on the next screen, installs what it needs, one command at a time, with the output shown.' }),
      h('div', { class: 'card-sub', text: 'Download into' }), whereEl,
      h('div', { class: 'bar' }, h('button', { class: 'btn btn-sm', text: 'Change folder', onclick: async () => { const p = await hub.pickFolder('Download repositories into which folder?', parent); if (p && p.ok) { parent = p.path; paint(); } } })),
      h('div', { class: 'card-sub', text: 'It will be at' }), destEl,
      h('div', { class: 'bar' }, h('button', { class: 'btn btn-primary', text: 'Download to this computer', onclick: go })));
  }

  /* ---------- a repository on this computer ---------- */
  async function openRepo(p, tab, justInstalled) {
    if (S.settings && S.settings.lastRepo !== p) hub.settings.set({ lastRepo: p }).then((r) => { if (r && r.settings) S.settings = r.settings; });
    S.sel = { type: 'repo', path: p, tab: tab || (S.sel && S.sel.type === 'repo' && S.sel.path === p ? S.sel.tab : 'overview'), justInstalled: !!justInstalled };
    paintList(); paintMain();
    if (!st(p)) { await refreshOne(p); paintList(); }
    loadLocal(p);
    ensureTools().then(() => { if (S.sel && S.sel.path === p) paintMain(); });
  }

  async function loadLocal(p, force) {
    if (S.local.has(p) && !force) { paintMain(); return; }
    const r = await hub.explain.local(p);
    if (!r || !r.ok) return;
    let summary = r.summary;
    const web = webOf(st(p));
    if (!summary && /github\.com\/[^/]+\/[^/]+/i.test(web)) {
      const full = web.replace(/^https:\/\/github\.com\//i, '').toLowerCase();
      summary = (await hub.explain.summary(`gh:${full}`)).summary;
    }
    const [lg, run] = await Promise.all([hub.repos.log(p, 15), hub.repos.runOptions(p)]);
    S.local.set(p, { info: r.info, facts: r.facts, summary, log: (lg && lg.commits) || [], run: (run && run.ok) ? run : { options: [] } });
    if (S.sel && S.sel.path === p) paintMain();
  }

  async function act(r, action, message) {
    if (S.busy.has(r.path)) return;
    S.busy.add(r.path); paintList(); paintMain();
    let res;
    try { res = await hub.repos[action](r.path, message); } catch (e) { res = { ok: false, error: e && e.message }; }
    S.busy.delete(r.path);
    if (res && res.ok) toast(`${r.name}: ${(res.steps || ['Done']).join(' · ')}`, 5000, 'good'); else fail(res);
    await refreshOne(r.path);
    await loadLocal(r.path, true);
    paintList(); paintMain();
  }

  function runJob(r, command) {
    hub.job.start(r.path, command).then((res) => {
      if (!res || !res.ok) { fail(res); return; }
      S.running.add(r.path);
      S.sel = { ...S.sel, tab: 'run' };
      paintList(); paintMain();
    });
  }

  /* What the repository is for: RepoHub's guess, or your own choice. */
  function categoryControl(r) {
    const c = catOf(r);
    if (!S.catList.length) return null;
    const sel = h('select', { class: 'input input-sm', title: 'Category, used to group the list', onchange: async (e) => {
      const res = await hub.repos.setCategory(r.path, e.target.value === '__auto' ? '' : e.target.value);
      if (!res || !res.ok) { fail(res); return; }
      S.cats[r.path] = res.category;
      paintList(); paintMain();
    } },
    h('option', { value: '__auto', text: c && !c.mine ? `Detected: ${c.label}` : 'Let RepoHub detect it' }),
    S.catList.map(([id, label]) => h('option', { value: id, text: label })));
    sel.value = c && c.mine ? c.id : '__auto';
    return h('div', { class: 'bar tight cat-line' }, h('span', { class: 'dim', text: 'Category' }), sel,
      c ? h('span', { class: 'dim', text: c.mine ? 'chosen by you' : `Reason: ${c.why}` }) : h('span', { class: 'dim', text: 'reading…' }));
  }

  function paintRepo() {
    const p = S.sel.path;
    const r = repoByPath(p);
    if (!r) { main.replaceChildren(h('div', { class: 'loading', text: 'This repository is no longer in the list.' })); return; }
    const s = st(p);
    const L = S.local.get(p);
    const busy = S.busy.has(p);
    const btn = (text, onclick, opts = {}) => h('button', { class: `btn btn-sm${opts.cls ? ' ' + opts.cls : ''}`, text, onclick, disabled: busy || opts.disabled, title: opts.title });

    const warnings = [];
    if (r.isHome) warnings.push(h('div', { class: 'warn-box', text: 'This is your whole user folder set up as one git repository. That usually happens by accident and makes tools treat everything in your user folder as one project. Do not commit here until you have checked what it is.' }));
    if (s && s.locked) warnings.push(h('div', { class: 'warn-box' }, 'A lock file is blocking git here. If no other git program is running, clear it. ', btn('Clear lock', () => act(r, 'clearLock'))));
    if (s && s.conflicts) warnings.push(h('div', { class: 'warn-box', text: `${plural(s.conflicts, 'file')} with conflicts. Open Claude here and ask it to resolve them.` }));
    if (s && !s.ok) warnings.push(h('div', { class: 'warn-box', text: s.error || 'Could not read this repository.' }));

    const head = h('div', { class: 'head' },
      h('div', { class: 'head-title' }, h('span', { class: 'head-name', text: r.name }), ...chips(s, r)),
      h('div', { class: 'mono dim wrap', text: p }),
      s && s.remote ? h('div', { class: 'mono dim wrap', text: s.remote }) : null,
      categoryControl(r),
      h('div', { class: 'bar' },
        h('button', { class: 'btn btn-primary', text: 'Open Claude here', title: 'A terminal window in this folder, running Claude Code', onclick: () => hub.term.open(p, 'claude').then((x) => x && !x.ok && fail(x)) }),
        btn('Terminal', () => hub.term.open(p, '').then((x) => x && !x.ok && fail(x))),
        btn('Folder', () => hub.open.folder(p)),
        s && /^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(webOf(s)) ? btn('Try in sandbox', () => { S.sel = { ...S.sel, tab: 'sandbox' }; paintMain(); }, { title: 'Run a fresh copy from GitHub in a Docker container' }) : null,
        btn('VS Code', () => hub.open.editor(p).then((x) => x && !x.ok && fail(x))),
        s && /^https:\/\//.test(webOf(s)) ? btn('GitHub', () => hub.open.web(webOf(s))) : null,
        h('span', { class: 'grow' }),
        btn(r.hidden ? 'Show in list' : 'Hide', async () => { await hub.repos.setHidden(p, !r.hidden); r.hidden = !r.hidden; paintList(); paintMain(); })));

    const tab = S.sel.tab || 'overview';
    const ghWeb = s && /^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(webOf(s)) ? webOf(s) : '';
    const body = [];
    if (!L) body.push(h('div', { class: 'loading', text: 'Reading…' }));
    else if (tab === 'overview') {
      if (S.sel.justInstalled) body.push(h('div', { class: 'good-box', text: 'Downloaded. Next, run the setup steps below in order. Each one shows its output under Run.' }));
      if (L.facts.plan.length) {
        body.push(section('Set up and run', h('div', { class: 'dim', text: 'Each button runs one command in this folder. Installing runs code from this repository, so install only what you trust.' }),
          h('div', { class: 'plan-rows' }, L.facts.plan.map((st2, i) => h('div', { class: 'plan-row' },
            h('span', { class: 'plan-n', text: String(i + 1) }),
            h('div', { class: 'grow' }, h('div', { class: 'mono', text: st2.command }), h('div', { class: 'dim', text: st2.why })),
            h('button', { class: `btn btn-sm${st2.kind === 'run' ? '' : ' btn-accent'}`, text: S.running.has(p) ? 'Busy' : 'Run', disabled: S.running.has(p), onclick: () => runJob(r, st2.command) }))))));
      }
      body.push(summaryBlock(L.summary, async () => {
        L.explaining = true; paintMain();
        const res = await hub.explain.claude({ key: `local:${p.toLowerCase()}`, dir: p });
        L.explaining = false;
        if (res && res.ok) L.summary = { text: res.text, at: new Date().toISOString() }; else fail(res, 'Claude could not explain it.');
        if (S.sel && S.sel.path === p) paintMain();
      }, L.explaining));
      if (ghWeb) body.push(aiToolsCard(ghWeb));
      body.push(section('What RepoHub found in the files', ...factsBlock(L.facts, L.info),
        !L.facts.claudeReady.claudeMd ? h('div', { class: 'dim tip', text: 'Tip: Open Claude here and type /init to have Claude write a CLAUDE.md for this project.' }) : null));
    } else if (tab === 'git') {
      const msg = h('input', { class: 'input grow', placeholder: 'Commit message (empty = "Update from this computer — N files")', disabled: busy });
      body.push(...warnings);
      if (s && s.ok && !s.remote) body.push(section('No GitHub address', h('div', { class: 'dim', text: 'This repository only lives on this computer. Create an empty repository on GitHub, then paste its address here to back it up.' }), remoteForm(r)));
      body.push(section('Git',
        h('div', { class: 'dim', text: s && s.ok ? `Branch ${s.branch || '(none)'}${s.upstream ? ` → ${s.upstream}` : ''}${s.lastMessage ? ` · last commit ${s.lastDate}: ${s.lastMessage}` : s.noCommits ? ' · no commits yet' : ''}` : '' }),
        h('div', { class: 'bar' },
          btn('Fetch', () => act(r, 'fetch'), { title: 'See what is new on GitHub without changing files' }),
          btn('Pull', () => act(r, 'pull'), { title: 'Bring in new commits from GitHub (needs no uncommitted changes)' }),
          btn('Push', () => act(r, 'push'), { title: 'Send your commits to GitHub' })),
        h('div', { class: 'bar' }, msg,
          btn('Commit', () => act(r, 'commit', msg.value), { title: 'Save every change as one commit on this computer' }),
          btn('Sync', () => act(r, 'sync', msg.value), { cls: 'btn-accent', title: 'Commit, then pull, then push' }))));
      const files = (s && s.files) || [];
      body.push(section(`Changes${s && s.changed ? ` (${s.changed})` : ''}`,
        files.length ? h('div', { class: 'files-list' }, files.slice(0, 300).map((f) => h('button', { class: 'file-row', title: 'Show the change', onclick: () => showDiff(r, f.file) },
          h('span', { class: `kind-${f.kind} file-kind`, text: f.kind }), h('span', { class: 'mono', text: f.file }))))
          : h('div', { class: 'dim', text: 'No uncommitted changes.' })));
      body.push(section('Recent commits', L.log.length ? h('div', { class: 'log' }, L.log.map((c) => h('div', { class: 'log-row' },
        h('span', { class: 'mono dim', text: c.hash }), h('span', { class: 'dim', text: c.date }), h('span', { class: 'log-subj', text: c.subject, title: c.author })))) : h('div', { class: 'dim', text: 'No commits yet.' })));
    } else if (tab === 'run') {
      const cmd = h('input', { class: 'input grow', placeholder: 'Any command, for example npm run build' });
      const isRunning = S.running.has(p);
      body.push(section('Run',
        h('div', { class: 'bar wrap' }, (L.run.options || []).map((o) => h('button', { class: `btn btn-sm${o.kind === 'custom' ? ' dashed' : ''}`, text: o.label, title: o.command, disabled: isRunning, onclick: () => runJob(r, o.command) }))),
        h('div', { class: 'bar' }, cmd,
          h('button', { class: 'btn btn-sm', text: 'Run', disabled: isRunning, onclick: () => cmd.value.trim() && runJob(r, cmd.value.trim()) }),
          h('button', { class: 'btn btn-sm', text: 'Save as button', onclick: async () => {
            const c = cmd.value.trim(); if (!c) return;
            const res = await hub.repos.setCommands(p, [...(r.commands || []).filter((x) => x !== c), c]);
            if (res && res.ok) { r.commands = res.commands; await loadLocal(p, true); } else fail(res);
          } }),
          r.commands && r.commands.length ? h('button', { class: 'btn btn-sm', text: 'Clear saved', onclick: async () => { await hub.repos.setCommands(p, []); r.commands = []; await loadLocal(p, true); } }) : null),
        h('div', { class: 'dim', text: 'Long-running commands (a dev server) keep running until you press Stop. For anything that asks questions, use Terminal.' })));
      const pre = h('pre', { class: 'console', id: 'console', text: S.output.get(p) || 'Output appears here.' });
      body.push(section('Output',
        h('div', { class: 'bar' },
          isRunning ? h('button', { class: 'btn btn-sm btn-danger', text: 'Stop', onclick: () => hub.job.stop(p) }) : null,
          h('button', { class: 'btn btn-sm', text: 'Clear', onclick: () => { S.output.delete(p); pre.textContent = ''; } }),
          isRunning ? h('span', { class: 'dim', text: 'running…' }) : null),
        pre));
      requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    } else if (tab === 'health' && ghWeb) {
      body.push(...healthView(S.sel, ghWeb));
    } else if (tab === 'activity' && ghWeb) {
      body.push(...activityView(S.sel, ghWeb));
    } else if (tab === 'files') {
      body.push(fileBrowser(S.sel, { kind: 'local', dir: p, web: ghWeb, branch: s && s.branch }));
    } else if (tab === 'sandbox') {
      const web = webOf(s);
      body.push(h('div', { class: 'dim', text: 'Runs the version on GitHub (not your local changes) in a throwaway container.' }),
        sandboxCard({ dir: p, cloneUrl: `${web}.git`, repo: web.replace(/^https:\/\/github\.com\//i, '') }));
    } else if (tab === 'readme') {
      const web = webOf(s);
      const gh = /github\.com\/[^/]+\/[^/]+/i.test(web) && s.branch ? { blob: `${web}/blob/${s.branch}/`, raw: web.replace('https://github.com/', 'https://raw.githubusercontent.com/') + `/${s.branch}/` } : null;
      body.push(section('', L.info.readme ? md(L.info.readme, gh) : h('div', { class: 'dim', text: 'No README in this folder.' })));
    }
    const changed = s && s.changed ? ` (${s.changed})` : '';
    main.replaceChildren(head, ...(tab === 'git' ? [] : warnings),
      tabsBar([['overview', 'Overview'], ['git', `Git${changed}`], ['run', S.running.has(p) ? 'Run ●' : 'Run'], ['files', 'Files'], ...(ghWeb ? [['health', 'Health'], ['activity', 'Activity']] : []), ['readme', 'README'], ...(ghWeb ? [['sandbox', 'Sandbox']] : [])], tab, (t) => { S.sel.tab = t; paintMain(); }),
      ...body);
  }

  function remoteForm(r) {
    const url = h('input', { class: 'input grow', placeholder: 'https://github.com/you/repository' });
    return h('div', { class: 'bar' }, url, h('button', { class: 'btn btn-sm', text: 'Save address', onclick: async () => {
      const res = await hub.repos.setRemote(r.path, url.value);
      if (!res || !res.ok) { fail(res); return; }
      toast('Address saved. Use Push to send it to GitHub.', 6000, 'good');
      await refreshOne(r.path); paintList(); paintMain();
    } }));
  }

  /* ---------- dialogs ---------- */
  function overlay(title, width, ...content) {
    const ov = $('overlay');
    const close = () => { ov.hidden = true; ov.replaceChildren(); };
    const card = h('div', { class: 'modal', style: { width: `${width}px` }, onclick: (e) => e.stopPropagation() },
      h('div', { class: 'modal-head' }, h('span', { class: 'modal-title', text: title }), h('button', { class: 'icon-btn', text: '✕', title: 'Close', onclick: close })),
      ...content);
    ov.replaceChildren(card);
    ov.hidden = false;
    ov.onclick = close;
    return { card, close };
  }
  /* Yes or no, in the app's own dialog. Resolves true only on the confirm button. */
  function confirmBox(title, text, yes = 'OK') {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (answered) return; answered = true; resolve(v); };
      const { close } = overlay(title, 480, h('div', { class: 'dim', text }),
        h('div', { class: 'bar end' }, h('button', { class: 'btn', text: 'Cancel', onclick: () => { close(); done(false); } }), h('button', { class: 'btn btn-primary', text: yes, onclick: () => { close(); done(true); } })));
      const ov = $('overlay');
      const prev = ov.onclick;
      ov.onclick = () => { prev && prev(); done(false); };
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('overlay').hidden) { $('overlay').hidden = true; $('overlay').replaceChildren(); } });

  async function showDiff(r, file) {
    const pre = h('pre', { class: 'diff', text: 'Reading…' });
    overlay(file, 960, pre);
    const res = await hub.repos.diff(r.path, file);
    if (!res || !res.ok) { pre.textContent = (res && res.error) || 'Could not read the change.'; return; }
    pre.replaceChildren(...String(res.text).split('\n').map((line) => h('div', {
      class: line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : '',
      text: line || ' ',
    })));
  }

  // Tools moved into Settings (Installers, Accounts, Start).
  function toolsDialog() { openSettings('installers'); }

  /* ---------- Try before install: Docker sandboxes ---------- */
  S.sb = { logs: new Map(), info: new Map(), docker: null };
  const STEPS = [
    ['detect', 'Detecting the framework and how it starts'],
    ['image', 'Getting the base image (first time only)'],
    ['clone', 'Downloading the code inside the sandbox'],
    ['install', 'Installing dependencies'],
    ['start', 'Starting the app'],
    ['ready', 'Waiting for a web page'],
  ];
  async function dockerStatus(force) {
    if (S.sb.docker && !force) return S.sb.docker;
    S.sb.docker = await hub.sandbox.status().catch(() => ({ ok: false, running: false, installed: false }));
    return S.sb.docker;
  }
  const sbInfo = (name) => { if (!S.sb.info.has(name)) S.sb.info.set(name, { state: 'starting', steps: {}, stepAt: {} }); return S.sb.info.get(name); };

  /* The Try before install card on a repository or link page: the detected
     recipe, editable, and Launch. */
  function sandboxCard({ link, dir, cloneUrl, repo }) {
    const body = h('div', { class: 'sb-body' }, h('div', { class: 'dim', text: 'Checking Docker…' }));
    const card = section('Try before install', body);
    (async () => {
      // Checked fresh each time: Docker Desktop may have been started or stopped since.
      const d = await dockerStatus(true);
      if (!d.running) {
        body.replaceChildren(h('div', { class: 'warn-box', text: d.installed ? 'Docker Desktop is installed but not running. Start it from the Start menu, wait until it says "Engine running", then press Check again.' : 'Try before install needs Docker Desktop, which is not installed. Install it from Settings → Installers (it takes a few minutes and may ask to restart Windows).' }),
          h('div', { class: 'bar' },
            !d.installed ? h('button', { class: 'btn btn-sm btn-primary', text: 'Open Installers', onclick: () => openSettings('installers') }) : null,
            h('button', { class: 'btn btn-sm', text: 'Check again', onclick: async () => { await dockerStatus(true); card.replaceWith(sandboxCard({ link, dir, cloneUrl, repo })); } })));
        return;
      }
      const r = await hub.sandbox.plan(dir ? { dir } : { link });
      if (!r || !r.ok) { body.replaceChildren(h('div', { class: 'warn-box', text: (r && r.error) || 'Could not plan the sandbox.' })); return; }
      const p = r.plan;
      const image = h('input', { class: 'input mono', value: p.image || '' });
      const install = h('input', { class: 'input mono', value: p.install || '', placeholder: '(nothing to install)' });
      const startIn = h('input', { class: 'input mono', value: p.start || '', placeholder: '(no start command: waits, use Shell)' });
      const port = h('input', { class: 'input', type: 'number', value: String(p.port || ''), placeholder: 'auto', style: { width: '90px' } });
      let mode = p.mode;
      const imageFields = h('div', { class: 'sb-fields' },
        h('label', { class: 'dim', text: 'Base image' }), image,
        h('label', { class: 'dim', text: 'Install' }), install,
        h('label', { class: 'dim', text: 'Start' }), startIn,
        h('label', { class: 'dim', text: 'Web port' }), h('div', { class: 'bar tight' }, port, h('span', { class: 'dim', text: 'the usual ports are watched too' })));
      const modeSel = p.dockerfile ? h('select', { class: 'input', onchange: (e) => { mode = e.target.value; imageFields.hidden = mode === 'dockerfile'; } },
        h('option', { value: 'image', text: 'Use a standard image' }), h('option', { value: 'dockerfile', text: 'Use its Dockerfile' })) : null;
      if (modeSel) modeSel.value = mode;
      imageFields.hidden = mode === 'dockerfile';
      const st = S.settings || {};
      const go = async (e) => {
        e.target.disabled = true; e.target.textContent = 'Launching…';
        const plan = { ...p, mode, image: image.value.trim(), install: install.value.trim(), start: startIn.value.trim(), port: Number(port.value) || 0 };
        const res = await hub.sandbox.start(cloneUrl, repo, plan);
        if (!res || !res.ok) { e.target.disabled = false; e.target.textContent = 'Launch sandbox'; fail(res, 'Could not start the sandbox.'); return; }
        S.sb.info.set(res.name, { repo, state: 'starting', url: '', plan, cloneUrl, link, dir, steps: {}, stepAt: {}, started: Date.now(),
          limits: { memGb: st.sandboxMemoryGb, cpus: st.sandboxCpus, ttl: st.sandboxTtlMinutes, readOnly: st.sandboxReadOnly } });
        openSandbox(res.name);
      };
      body.replaceChildren(
        h('div', { class: 'sb-idle' },
          h('div', { class: 'sb-idle-title', text: `Run it in an isolated sandbox${p.framework ? ` (${p.framework}${p.language && p.language !== p.framework ? ` + ${p.language}` : ''})` : ''}` }),
          h('div', { class: 'dim', text: 'A throwaway Docker container: its own copy of the code, none of your folders, limited memory and CPU, reachable only from this computer.' }),
          h('div', { class: 'sb-meta' },
            h('span', { text: `${st.sandboxMemoryGb || 2} GB · ${st.sandboxCpus || 2} CPUs` }),
            h('span', { text: st.sandboxTtlMinutes ? `removed after ${st.sandboxTtlMinutes} min` : 'no time limit' }),
            h('span', { text: `recipe: ${p.source}` }))),
        p.notes.length ? h('ul', { class: 'sb-notes' }, p.notes.map((n) => h('li', { text: n }))) : null,
        modeSel ? h('div', { class: 'bar' }, modeSel) : null,
        h('details', { class: 'sb-edit' }, h('summary', { text: 'Edit the recipe' }), imageFields),
        h('div', { class: 'bar' }, h('button', { class: 'btn btn-primary', text: 'Launch sandbox', onclick: go })),
        h('div', { class: 'dim', text: `Docker ${d.version}. The first run downloads a base image (about 1 GB, once).` }));
    })();
    return card;
  }

  function openSandbox(name) {
    S.sel = { type: 'sandbox', name };
    paintList(); paintMain();
    hub.sandbox.attach(name).then((r) => {
      if (!r || !r.ok) return;
      const i = sbInfo(name);
      if (r.url) { i.url = r.url; i.state = 'ready'; }
      if (r.expiresAt) i.expiresAt = r.expiresAt;
      if (r.plan && !i.plan) i.plan = r.plan;
      if (r.cloneUrl && !i.cloneUrl) i.cloneUrl = r.cloneUrl;
      if (r.limits && !i.limits) i.limits = r.limits;
      if (r.steps) for (const [k, v] of Object.entries(r.steps)) i.steps[k] = v;
      if (r.log && !S.sb.logs.get(name)) S.sb.logs.set(name, r.log);
      if (S.sel && S.sel.name === name) paintMain();
    });
    refreshSandboxCount();
  }

  async function refreshSandboxCount() {
    const l = await hub.sandbox.list().catch(() => null);
    const n = (l && l.items && l.items.length) || 0;
    if ($('sb-count')) $('sb-count').textContent = n ? String(n) : '';
    return (l && l.items) || [];
  }

  const mmss = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  let ttlTick = null;

  /* The Live Demo page for one sandbox: progress, then log and the running app
     side by side; the recipe, the isolation and the time left on the right. */
  function paintSandbox() {
    const name = S.sel.name;
    const i = sbInfo(name);
    const state = i.state || 'starting';
    const label = { starting: 'provisioning', running: 'installing', ready: 'running', failed: 'failed', stopped: 'stopped', expired: 'removed' }[state] || state;
    const badgeCls = state === 'ready' ? 's-run' : ['failed', 'stopped', 'expired'].includes(state) ? 's-bad' : 's-build';
    const pre = h('pre', { class: 'console sb-log', id: 'sb-console', text: S.sb.logs.get(name) || 'Waiting for the sandbox…' });
    const p = i.plan || {};

    // Progress steps
    const stepsEl = h('div', { class: 'prov' }, STEPS.map(([key, text]) => {
      const st2 = i.steps[key];
      const cls = st2 === 'done' ? 'done' : st2 === 'on' ? 'on' : st2 === 'failed' ? 'failed' : '';
      const at = i.stepAt[key];
      const took = at && at.end ? secs(at.end - at.start) : at && at.start && st2 === 'on' ? '…' : '';
      return h('div', { class: `step ${cls}` },
        h('span', { class: 'step-ico', text: st2 === 'done' ? '✓' : st2 === 'failed' ? '✕' : String(STEPS.findIndex((x) => x[0] === key) + 1) }),
        h('span', { text: key === 'image' && p.image ? `${text}: ${p.image}` : key === 'start' && p.port ? `${text} on port ${p.port}` : text }),
        h('span', { class: 'step-time', text: took }));
    }));

    let stage;
    if (state === 'ready' && i.url) {
      const frame = h('iframe', { class: 'sb-frame', src: i.url, sandbox: 'allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads', referrerpolicy: 'no-referrer', title: 'Live preview' });
      stage = h('div', { class: 'run-body' },
        h('div', { class: 'pane' }, h('div', { class: 'pane-head' }, 'sandbox log', h('span', { class: 'grow' }), h('span', { class: 'live', text: '● streaming' })), pre),
        h('div', { class: 'pane' },
          h('div', { class: 'pane-head' }, 'live preview', h('span', { class: 'grow' }),
            h('button', { class: 'icon-btn', text: '↻', title: 'Reload the preview', onclick: () => { frame.src = i.url; } })),
          h('div', { class: 'browser-bar' }, h('span', { class: 'url mono', text: i.url })),
          frame));
    } else if (['failed', 'stopped', 'expired'].includes(state)) {
      stage = h('div', {},
        stepsEl,
        state !== 'expired' ? h('div', { class: 'fallback' },
          h('div', { class: 'fb-body' },
            h('div', { class: 'card-title', text: 'It did not run' }),
            h('div', { class: 'dim', text: 'The log below shows why, which is useful to know before installing it for real. Claude can read the log and the README and explain what happened, what it would need, and how to run it locally.' }),
            i.failure ? h('div', { class: 'md-compact' }, md(i.failure)) : null,
            h('div', { class: 'bar' }, h('button', { class: 'btn btn-accent', text: i.explaining ? 'Claude is reading the log…' : i.failure ? 'Explain again' : 'Explain why it did not run', disabled: !!i.explaining, onclick: async () => {
              i.explaining = true; paintMain();
              const r = await hub.sandbox.explainFailure({ name, link: i.link, dir: i.dir });
              i.explaining = false;
              if (r && r.ok) i.failure = r.text; else fail(r, 'Claude could not explain it.');
              if (S.sel && S.sel.name === name) paintMain();
            } }),
            h('span', { class: 'dim', text: 'Written by Claude from the log; check it before acting on it.' })))) : null,
        h('div', { class: 'pane' }, h('div', { class: 'pane-head' }, 'sandbox log'), pre));
    } else {
      stage = h('div', {}, stepsEl, h('div', { class: 'pane' }, h('div', { class: 'pane-head' }, 'sandbox log', h('span', { class: 'grow' }), h('span', { class: 'live', text: '● streaming' })), pre));
    }

    const actions = h('div', { class: 'sb-actions' },
      h('button', { class: 'btn btn-sm', text: '↻ Rebuild', disabled: !i.cloneUrl || !i.plan, title: 'Remove this sandbox and start a fresh one with the same recipe', onclick: async () => {
        await hub.sandbox.remove(name);
        const res = await hub.sandbox.start(i.cloneUrl, i.repo, i.plan);
        if (!res || !res.ok) { fail(res); return; }
        S.sb.info.set(res.name, { ...i, state: 'starting', url: '', steps: {}, stepAt: {}, failure: '', started: Date.now() });
        S.sb.info.delete(name); S.sb.logs.delete(name);
        openSandbox(res.name);
      } }),
      h('button', { class: 'btn btn-sm', text: '⬇ Download log', onclick: async () => { const r = await hub.sandbox.saveLog(name); if (r && r.ok) toast(`Saved to ${r.path}`, 5000, 'good'); } }),
      h('button', { class: 'btn btn-sm', text: '↗ Open in browser', disabled: !i.url, onclick: () => hub.sandbox.openBrowser(i.url) }),
      h('button', { class: 'btn btn-sm', text: 'Preview window', disabled: !i.url, onclick: () => hub.sandbox.preview(i.url, i.repo).then((x) => x && !x.ok && fail(x)) }),
      h('button', { class: 'btn btn-sm', text: 'Shell', title: 'A terminal inside the sandbox, in /app', disabled: state === 'expired', onclick: () => hub.sandbox.shell(name).then((x) => x && !x.ok && fail(x)) }),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn btn-sm btn-danger', text: '■ Destroy sandbox', disabled: state === 'expired', onclick: async () => {
        const r = await hub.sandbox.remove(name);
        if (!r || !r.ok) { fail(r); return; }
        S.sb.info.delete(name); S.sb.logs.delete(name);
        toast('Sandbox removed. Nothing was left on your computer.', 5000, 'good');
        showSandboxes();
      } }));

    const lim = i.limits || {};
    const kv = (k, v, cls) => h('div', { class: 'kv' }, h('span', { text: k }), h('b', { class: cls || '', text: v }));
    const ttlTotal = (lim.ttl || 0) * 60000;
    const left = i.expiresAt ? i.expiresAt - Date.now() : 0;
    const side = h('aside', { class: 'side-col' },
      h('section', { class: 'card flush' }, h('div', { class: 'card-head' }, 'Run recipe', h('span', { class: 'dim', text: p.source || 'detected' })),
        kv('Framework', p.framework || 'not detected'), kv('Language', p.language || 'not detected'), kv('Package manager', p.packageManager || 'none'),
        kv('Install', p.install || '(none)'), kv('Run', p.start || (p.mode === 'dockerfile' ? 'from its Dockerfile' : '(none)')), kv('Port', p.port ? `:${p.port}` : 'watching usual ports'),
        kv('Image', p.mode === 'dockerfile' ? 'built from its Dockerfile' : (p.image || 'n/a'))),
      h('section', { class: 'card flush' }, h('div', { class: 'card-head' }, 'Isolation'),
        kv('Runtime', 'Docker container'), kv('CPU and memory', `${lim.cpus || 2} CPUs · ${lim.memGb || 2} GB`),
        kv('System files', lim.readOnly ? 'read-only' : 'writable inside the sandbox', lim.readOnly ? 'ok' : ''),
        kv('Your folders', 'none shared', 'ok'), kv('Reachable from', 'this computer only', 'ok'),
        kv('Internet', 'allowed (needed to install)', 'warn'), kv('Secrets', 'none passed in', 'ok')),
      h('section', { class: 'card flush ttl' },
        h('div', { class: 'ttl-top' }, h('span', { class: 'ttl-lbl', text: 'Time to live' }), h('span', { class: `ttl-val${left && left < 120000 ? ' low' : ''}`, id: 'ttl-val', text: i.expiresAt ? mmss(left) : state === 'expired' ? '—' : 'no limit' })),
        h('div', { class: 'ttl-bar' }, h('div', { class: 'ttl-fill', id: 'ttl-fill', style: { width: i.expiresAt && ttlTotal ? `${Math.max(0, Math.min(100, (left / ttlTotal) * 100))}%` : '0%' } })),
        h('div', { class: 'dim', text: i.expiresAt ? 'Removed automatically when the time is up. Nothing is kept.' : 'Set a time limit in Settings → Security.' }),
        i.expiresAt ? h('div', { class: 'bar' }, h('button', { class: 'btn btn-sm', text: '+15 minutes', onclick: async () => { const r = await hub.sandbox.extend(name, 15); if (r && r.ok) { i.expiresAt = r.expiresAt; paintMain(); } else fail(r); } })) : null));

    main.replaceChildren(
      h('div', { class: 'head' },
        h('div', { class: 'head-title' }, h('span', { class: 'head-name', text: i.repo || name }),
          h('span', { class: `state-badge ${badgeCls}` }, state === 'ready' || badgeCls === 's-build' ? h('span', { class: 'pulse' }) : null, label)),
        h('div', { class: 'mono dim', text: `Sandbox ${name}` })),
      h('div', { class: 'split' },
        h('div', { class: 'main-col' }, h('section', { class: 'card flush' }, h('div', { class: 'card-head' }, 'Sandbox preview', h('span', { class: 'dim', text: 'Docker container on this computer' })), stage, actions)),
        side));
    requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    clearInterval(ttlTick);
    if (i.expiresAt) {
      ttlTick = setInterval(() => {
        const el = $('ttl-val'), fill = $('ttl-fill');
        if (!el || !S.sel || S.sel.name !== name) { clearInterval(ttlTick); return; }
        const l2 = i.expiresAt - Date.now();
        el.textContent = mmss(l2);
        el.classList.toggle('low', l2 < 120000);
        if (fill && ttlTotal) fill.style.width = `${Math.max(0, Math.min(100, (l2 / ttlTotal) * 100))}%`;
      }, 1000);
    }
  }

  async function showSandboxes() {
    S.sel = { type: 'sandboxes' };
    paintList();
    main.replaceChildren(h('div', { class: 'loading', text: 'Reading sandboxes…' }));
    const d = await dockerStatus(true);
    if (!d.running) { main.replaceChildren(section('Sandboxes', h('div', { class: 'warn-box', text: d.installed ? 'Docker Desktop is not running. Start it, then come back.' : 'Docker Desktop is not installed. Install it from Settings → Installers.' }), !d.installed ? h('div', { class: 'bar' }, h('button', { class: 'btn btn-primary', text: 'Open Installers', onclick: () => openSettings('installers') })) : null)); return; }
    const items = await refreshSandboxCount();
    main.replaceChildren(section(`Sandboxes (${items.length})`,
      h('div', { class: 'dim', text: 'Containers RepoHub started to try repositories. Remove them when you are done; they use memory while running.' }),
      items.length ? h('div', { class: 'sb-list' }, items.map((c) => h('div', { class: 'plan-row' },
        h('div', { class: 'grow' }, h('div', {}, h('b', { text: c.repo || c.name }), ' ', h('span', { class: `chip ${c.state === 'running' ? 'ok' : 'bad'}`, text: c.state }), c.expiresAt ? h('span', { class: 'dim', text: ` · ${mmss(c.expiresAt - Date.now())} left` }) : null),
          h('div', { class: 'dim mono', text: `${c.name} · ${c.status}` })),
        h('button', { class: 'btn btn-sm', text: 'Open', onclick: () => { const i = sbInfo(c.name); i.repo = i.repo || c.repo; if (c.state !== 'running' && !i.url) i.state = 'stopped'; if (c.url) { i.url = c.url; i.state = 'ready'; } openSandbox(c.name); } }),
        h('button', { class: 'btn btn-sm btn-danger', text: 'Remove', onclick: async () => { const r = await hub.sandbox.remove(c.name); if (!r || !r.ok) fail(r); showSandboxes(); } }))))
        : h('div', { class: 'dim', text: 'No sandboxes. Paste a link above, then use Launch sandbox.' }),
      items.length > 1 ? h('div', { class: 'bar end' }, h('button', { class: 'btn btn-danger', text: 'Remove all', onclick: async () => { await hub.sandbox.removeAll(); S.sb.info.clear(); S.sb.logs.clear(); showSandboxes(); } })) : null));
  }

  hub.sandbox.onEvent((m) => {
    const i = sbInfo(m.name);
    if (m.repo) i.repo = m.repo;
    if (m.type === 'step') {
      i.steps[m.step] = m.state;
      const at = i.stepAt[m.step] || (i.stepAt[m.step] = {});
      if (m.state === 'on' && !at.start) at.start = Date.now();
      if (m.state === 'done' || m.state === 'failed') { at.end = Date.now(); if (!at.start) at.start = at.end; }
    }
    if (m.type === 'running') i.state = 'running';
    if (m.type === 'ready') { i.state = 'ready'; i.url = m.url; toast(`${i.repo || 'Sandbox'} is running.`, 6000, 'good'); }
    if (m.type === 'failed') i.state = 'failed';
    if (m.type === 'stopped') i.state = 'stopped';
    if (m.type === 'expired') { i.state = 'expired'; i.expiresAt = 0; refreshSandboxCount(); }
    if (m.type === 'ttl') i.expiresAt = m.expiresAt;
    if (m.text) S.sb.logs.set(m.name, ((S.sb.logs.get(m.name) || '') + m.text).slice(-300000));
    const viewing = S.sel && S.sel.type === 'sandbox' && S.sel.name === m.name;
    if (!viewing) return;
    if (m.type === 'log') {
      const pre = $('sb-console');
      if (pre) { const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30; pre.textContent = S.sb.logs.get(m.name); if (atEnd) pre.scrollTop = pre.scrollHeight; }
    } else paintMain();
  });

  /* ============================================================
     PHASE 2: health, activity, files, saved, compare, login
     ============================================================ */
  const C = window.RHCharts;
  S.auth = { signedIn: false, user: null, rate: null };
  S.saved = { bookmarks: [], collections: [], history: [] };
  S.compare = (() => { try { return JSON.parse(localStorage.getItem('repohub.compare') || '[]'); } catch { return []; } })();
  const saveCompare = () => { try { localStorage.setItem('repohub.compare', JSON.stringify(S.compare)); } catch { /* private storage */ } };
  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} minutes ago` : `${Math.round(m / 60)} hours ago`; };
  const STATUS_ICON = { ok: '✓', warn: '!', bad: '✕' };

  /* ---------- login ---------- */
  async function refreshAuth() {
    const r = await hub.auth.status().catch(() => null);
    if (r && r.ok) S.auth = r;
    paintAuthChip();
  }
  function paintAuthChip() {
    const el = $('auth-chip');
    if (!el) return;
    const core = S.auth.rate && S.auth.rate.core;
    el.textContent = S.auth.signedIn ? `GitHub: ${S.auth.user ? S.auth.user.login : 'signed in'}` : 'GitHub: not connected';
    el.className = `chip ${S.auth.signedIn ? 'ok' : ''}`;
    el.title = core ? `${core.remaining} of ${core.limit} GitHub requests left this hour` : '';
  }
  /* RepoHub's own GitHub requests: borrow Git's saved login or the GitHub CLI's. */
  function loginSection() {
    const box = h('div', {});
    const signIn = (source) => async (e) => {
      e.target.disabled = true;
      const r = await hub.auth.signIn(source);
      e.target.disabled = false;
      if (r && r.ok) toast(`Signed in as ${r.user.login}.`, 5000, 'good'); else fail(r);
      await refreshAuth(); paint();
    };
    const paint = () => {
      const core = S.auth.rate && S.auth.rate.core;
      const via = S.auth.source === 'git' ? 'your Git sign-in' : 'the GitHub CLI';
      box.replaceChildren(
        h('div', { class: 'dim', text: S.auth.signedIn
          ? `Connected as ${S.auth.user ? S.auth.user.login : '(unknown)'} through ${via}.${core ? ` ${core.remaining} of ${core.limit} requests left this hour.` : ''}`
          : `Not connected: GitHub allows 60 requests an hour${core ? ` (${core.remaining} left)` : ''}. Connecting raises it to 5,000, adds star history and opens private repositories. RepoHub borrows a login you already have, keeps it in memory only and never stores it.` }),
        h('div', { class: 'bar wrap' },
          S.auth.signedIn
            ? h('button', { class: 'btn btn-sm', text: 'Disconnect', title: 'RepoHub forgets the login. Git and the GitHub CLI stay signed in.', onclick: async () => { await hub.auth.signOut(); await refreshAuth(); paint(); } })
            : [
              h('button', { class: 'btn btn-sm btn-primary', text: 'Use my Git sign-in', title: 'The same GitHub login Git uses for clone, pull and push (Git Credential Manager)', onclick: signIn('git') }),
              h('button', { class: 'btn btn-sm', text: 'Use the GitHub CLI login', title: 'The login held by the GitHub CLI (gh)', onclick: signIn('gh') }),
              h('button', { class: 'btn btn-sm', text: 'Sign in with the GitHub CLI', title: 'Opens a terminal running "gh auth login"; finish in the browser, then press Use the GitHub CLI login', onclick: () => hub.auth.openCliLogin().then((x) => x && !x.ok && fail(x)) }),
            ]));
    };
    paint();
    return box;
  }

  /* Git's own sign-in: Git Credential Manager, which clone, pull and push use. */
  function gitSignInSection(onChange) {
    const box = h('div', { class: 'git-signin' }, h('div', { class: 'dim', text: 'Checking Git…' }));
    const paint = async () => {
      const g = await hub.gitauth.status().catch(() => null);
      if (!g || !g.ok) { box.replaceChildren(h('div', { class: 'dim', text: (g && g.error) || 'Could not read the Git sign-in.' })); return; }
      if (!g.git) {
        box.replaceChildren(h('div', { class: 'dim', text: g.note }), h('div', { class: 'bar' }, h('button', { class: 'btn btn-sm btn-primary', text: 'Install Git', onclick: () => runInstall(['git']) })));
        return;
      }
      const kids = [h('div', { class: 'dim', text: `Git ${g.git}. Saved logins are kept by ${g.helper.label}.${g.gcm ? ` Git Credential Manager ${g.gcm}.` : ''}` })];
      if (!g.gcm && g.helper.kind !== 'gh') kids.push(h('div', { class: 'warn-box', text: 'Git Credential Manager was not found. It comes with Git for Windows: reinstall Git from Installers (keep "Git Credential Manager" ticked), then press Check again.' }));
      if (g.gcm && !['gcm', 'gh'].includes(g.helper.kind)) {
        kids.push(h('div', { class: 'warn-box' }, `Git is not set to use Git Credential Manager, so GitHub sign-in may not be saved. `,
          h('button', { class: 'btn btn-sm', text: 'Use Git Credential Manager', title: 'Sets credential.helper to manager in your Git settings', onclick: async () => { const r = await hub.gitauth.useGcm(); if (r && r.ok) { toast('Git now uses Git Credential Manager.', 5000, 'good'); paint(); } else fail(r); } })));
      }
      if (g.helper.kind === 'gh') kids.push(h('div', { class: 'dim', text: 'Git uses the GitHub CLI login for github.com. Sign in or out with the GitHub CLI below.' }));
      if (g.accounts.length) {
        kids.push(h('div', { class: 'git-accounts' }, g.accounts.map((a) => h('div', { class: 'agent' },
          h('span', { class: 'dot ok' }),
          h('div', { class: 'grow' }, h('div', { class: 'agent-name', text: a }), h('div', { class: 'dim', text: 'GitHub account saved in Git Credential Manager' })),
          h('button', { class: 'btn btn-sm', text: 'Sign out', onclick: async (e) => {
            if (!(await confirmBox(`Sign ${a} out of Git?`, 'Git forgets this GitHub login. Pushing and pulling private repositories will ask you to sign in again.', 'Sign out'))) return;
            e.target.disabled = true;
            const r = await hub.gitauth.logout(a);
            if (r && r.ok) toast(`${a} is signed out of Git.`, 5000, 'good'); else fail(r);
            paint();
          } })))));
      } else if (g.gcm) {
        kids.push(h('div', { class: 'dim', text: 'No GitHub account is saved in Git yet.' }));
      }
      kids.push(h('div', { class: 'bar wrap' },
        g.gcm ? h('button', { class: `btn btn-sm${g.accounts.length ? '' : ' btn-primary'}`, text: g.accounts.length ? 'Add another GitHub account' : 'Sign in to GitHub', title: 'Opens Git Credential Manager\'s browser sign-in in a terminal window', onclick: async () => {
          const r = await hub.gitauth.login();
          if (r && r.ok) toast('Finish the sign-in in the browser window, then press Check again.', 9000); else fail(r);
        } }) : null,
        h('button', { class: 'btn btn-sm', text: 'Check again', onclick: () => { box.replaceChildren(h('div', { class: 'dim', text: 'Checking Git…' })); paint(); if (onChange) onChange(); } }),
        g.helper.kind !== 'gh' ? h('button', { class: 'btn btn-sm', text: 'Let Git use the GitHub CLI login', title: 'Runs "gh auth setup-git" in a terminal: Git then uses the GitHub CLI login for github.com', onclick: () => hub.gitauth.useGh().then((x) => x && !x.ok && fail(x)) }) : null));
      box.replaceChildren(...kids);
    };
    paint();
    return box;
  }

  /* ---------- saved repositories ---------- */
  async function loadSaved() { const r = await hub.saved.all().catch(() => null); if (r && r.ok) S.saved = r; paintSavedCount(); }
  function paintSavedCount() { const el = $('saved-count'); if (el) el.textContent = S.saved.bookmarks.length ? String(S.saved.bookmarks.length) : ''; const c = $('compare-count'); if (c) c.textContent = S.compare.length ? String(S.compare.length) : ''; }
  const bookmarkOf = (full) => S.saved.bookmarks.find((b) => b.full.toLowerCase() === String(full).toLowerCase());

  function saveButton(d, ins) {
    const b = bookmarkOf(d.fullName);
    return h('button', { class: `btn${b ? ' btn-accent' : ''}`, text: b ? '★ Saved' : '☆ Save', title: b ? 'Edit notes, tags and collections' : 'Save to your list', onclick: async () => {
      if (!b) {
        const r = await hub.saved.save(d.fullName, { snap: { description: d.description, stars: d.stars, language: d.languages[0] && d.languages[0].name, license: d.license, score: ins && ins.total } });
        if (!r || !r.ok) { fail(r); return; }
        await loadSaved(); paintMain();
      }
      editBookmark(d.fullName);
    } });
  }

  function editBookmark(full) {
    const b = bookmarkOf(full);
    if (!b) return;
    const note = h('textarea', { class: 'input note', rows: '4', placeholder: 'Your notes: why you saved it, what to check' });
    note.value = b.note || '';
    const tags = h('input', { class: 'input grow', value: (b.tags || []).join(', '), placeholder: 'tags, comma separated (for example video, self-hosted)' });
    const picks = new Set(b.collections || []);
    const colsEl = h('div', { class: 'col-picks' });
    const paintCols = () => colsEl.replaceChildren(...S.saved.collections.map((c) => h('label', { class: 'col-pick' },
      h('input', { type: 'checkbox', checked: picks.has(c.id) || null, onchange: (e) => { if (e.target.checked) picks.add(c.id); else picks.delete(c.id); } }), c.name)),
      S.saved.collections.length ? null : h('span', { class: 'dim', text: 'No collections yet.' }));
    paintCols();
    const newCol = h('input', { class: 'input grow', placeholder: 'New collection name' });
    const { close } = overlay(`Saved: ${full}`, 560,
      h('div', { class: 'card-sub', text: 'Notes' }), note,
      h('div', { class: 'card-sub', text: 'Tags' }), h('div', { class: 'bar' }, tags),
      h('div', { class: 'card-sub', text: 'Collections' }), colsEl,
      h('div', { class: 'bar' }, newCol, h('button', { class: 'btn btn-sm', text: 'Add collection', onclick: async () => {
        const r = await hub.saved.createCollection(newCol.value);
        if (!r || !r.ok) { fail(r); return; }
        picks.add(r.collection.id); newCol.value = '';
        await loadSaved(); paintCols();
      } })),
      h('div', { class: 'bar end' },
        h('button', { class: 'btn btn-danger', text: 'Remove from saved', onclick: async () => { await hub.saved.unsave(full); close(); await loadSaved(); paintMain(); } }),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn btn-primary', text: 'Save', onclick: async () => {
          const r = await hub.saved.save(full, { note: note.value, tags: tags.value.split(',').map((x) => x.trim()).filter(Boolean), collections: [...picks] });
          if (!r || !r.ok) { fail(r); return; }
          close(); await loadSaved(); paintMain();
        } })));
    note.focus();
  }

  function showSaved() {
    S.sel = { type: 'saved', filter: (S.sel && S.sel.type === 'saved' && S.sel.filter) || '', col: (S.sel && S.sel.col) || '' };
    paintList(); paintMain();
  }

  function paintSaved() {
    const V = S.sel;
    const q = (V.filter || '').toLowerCase();
    const rows = S.saved.bookmarks.filter((b) => (!V.col || (b.collections || []).includes(V.col))
      && (!q || `${b.full} ${b.note} ${(b.tags || []).join(' ')} ${(b.snap && b.snap.description) || ''}`.toLowerCase().includes(q)));
    const filter = h('input', { class: 'input grow', type: 'search', placeholder: 'Search saved: name, note, tag', value: V.filter || '' });
    filter.addEventListener('input', () => { V.filter = filter.value; const pos = filter.selectionStart; paintSaved(); const f2 = main.querySelector('input[type=search]'); if (f2) { f2.focus(); f2.setSelectionRange(pos, pos); } });
    const colSel = h('select', { class: 'input', onchange: (e) => { V.col = e.target.value; paintSaved(); } },
      h('option', { value: '', text: 'All collections' }), S.saved.collections.map((c) => h('option', { value: c.id, text: `${c.name} (${S.saved.bookmarks.filter((b) => (b.collections || []).includes(c.id)).length})` })));
    colSel.value = V.col || '';
    const col = S.saved.collections.find((c) => c.id === V.col);
    main.replaceChildren(
      h('div', { class: 'head' }, h('div', { class: 'head-title' }, h('span', { class: 'head-name', text: 'Saved repositories' }), h('span', { class: 'chip', text: String(S.saved.bookmarks.length) })),
        h('div', { class: 'bar' }, filter, colSel,
          col ? h('button', { class: 'btn btn-sm', text: 'Rename', onclick: () => renameCollection(col) }) : null,
          col ? h('button', { class: 'btn btn-sm btn-danger', text: 'Delete collection', title: 'Deletes the collection only; the repositories stay saved', onclick: async () => { await hub.saved.deleteCollection(col.id); V.col = ''; await loadSaved(); paintSaved(); } }) : null,
          h('button', { class: 'btn btn-sm', text: 'Export CSV', onclick: async () => { const r = await hub.saved.exportFile('csv', V.col); if (r && r.ok) toast(`Exported to ${r.path}`, 6000, 'good'); } }),
          h('button', { class: 'btn btn-sm', text: 'Export JSON', onclick: async () => { const r = await hub.saved.exportFile('json', V.col); if (r && r.ok) toast(`Exported to ${r.path}`, 6000, 'good'); } }))),
      rows.length ? h('div', { class: 'saved-list' }, rows.map((b) => h('div', { class: 'saved-row' },
        h('div', { class: 'grow' },
          h('div', { class: 'saved-top' },
            h('button', { class: 'linkish', text: b.full, onclick: () => { $('explore-input').value = `https://github.com/${b.full}`; explore(b.full); } }),
            b.snap && b.snap.score != null ? h('span', { class: 'chip', text: `health ${b.snap.score}` }) : null,
            b.snap && b.snap.stars ? h('span', { class: 'dim', text: `★ ${num(b.snap.stars)}` }) : null,
            b.snap && b.snap.language ? h('span', { class: 'dim', text: b.snap.language }) : null),
          b.snap && b.snap.description ? h('div', { class: 'dim', text: b.snap.description }) : null,
          b.note ? h('div', { class: 'saved-note', text: b.note }) : null,
          h('div', { class: 'kinds' }, (b.tags || []).map((t) => h('span', { class: 'topic', text: t })),
            (b.collections || []).map((id) => { const c = S.saved.collections.find((x) => x.id === id); return c ? h('span', { class: 'kind', text: c.name }) : null; }))),
        h('div', { class: 'saved-actions' },
          h('button', { class: 'btn btn-sm', text: 'Edit', onclick: () => editBookmark(b.full) }),
          h('button', { class: 'btn btn-sm', text: S.compare.includes(b.full) ? 'In compare' : 'Compare', disabled: S.compare.includes(b.full), onclick: () => addCompare(b.full) })))))
        : section('', h('div', { class: 'dim', text: S.saved.bookmarks.length ? 'Nothing matches.' : 'Nothing saved yet. Paste a link above, then press ☆ Save.' })),
      S.saved.history.length ? section('Recently viewed',
        h('div', { class: 'history' }, S.saved.history.slice(0, 20).map((x) => h('button', { class: 'linkish', text: x.full, title: x.description || '', onclick: () => { $('explore-input').value = `https://github.com/${x.full}`; explore(x.full); } }))),
        h('div', { class: 'bar' }, h('button', { class: 'btn btn-sm', text: 'Clear history', onclick: async () => { await hub.saved.clearHistory(); await loadSaved(); paintSaved(); } }))) : null);
  }

  function renameCollection(col) {
    const name = h('input', { class: 'input grow', value: col.name });
    const { close } = overlay('Rename collection', 420, h('div', { class: 'bar' }, name),
      h('div', { class: 'bar end' }, h('button', { class: 'btn btn-primary', text: 'Rename', onclick: async () => { const r = await hub.saved.renameCollection(col.id, name.value); if (!r || !r.ok) { fail(r); return; } close(); await loadSaved(); paintSaved(); } })));
    name.focus();
  }

  /* ---------- insights: health and activity ---------- */
  async function loadInsights(holder, link, force) {
    if (holder.insLoading) return;
    holder.insLoading = true; holder.insError = '';
    // Called from inside a paint (the gate) it must not paint again; a button press repaints.
    if (force && S.sel === holder) paintMain();
    const r = await hub.insights.get(link, force).catch((e) => ({ ok: false, error: e && e.message }));
    holder.insLoading = false;
    if (r && r.ok) holder.ins = r; else holder.insError = (r && r.error) || 'Could not read the insights.';
    if (holder.ins && bookmarkOf(holder.ins.fullName)) hub.saved.save(holder.ins.fullName, { snap: { description: holder.ins.description, stars: holder.ins.stars, language: holder.ins.languages[0] && holder.ins.languages[0].name, license: holder.ins.license, score: holder.ins.total } }).then(loadSaved);
    if (S.sel === holder) paintMain();
  }

  function insightsGate(holder, link) {
    if (holder.insLoading) return h('div', { class: 'loading', text: 'Gathering evidence from GitHub: releases, contributors, weekly commits, issues and checks. About 15 seconds.' });
    if (holder.insError) return section('Could not read the insights', h('p', { text: holder.insError }), h('div', { class: 'bar' }, h('button', { class: 'btn btn-sm', text: 'Try again', onclick: () => loadInsights(holder, link, true) })));
    if (!holder.ins) { loadInsights(holder, link); return h('div', { class: 'loading', text: 'Gathering evidence from GitHub…' }); }
    return null;
  }

  function healthView(holder, link) {
    const gate = insightsGate(holder, link);
    if (gate) return [gate];
    const i = holder.ins;
    const m = i.maintained;
    const level = i.total >= 60 ? 'ok' : i.total >= 40 ? 'warn' : 'bad';
    const out = [];
    out.push(h('div', { class: 'health-top' },
      h('div', { class: 'card health-score' },
        h('div', { class: 'card-sub', text: 'Health score' }),
        h('div', { class: 'score-line' }, h('span', { class: 'hero', text: String(i.total) }), h('span', { class: 'dim', text: '/ 100' }),
          h('span', { class: `status status-${level}`, text: `${STATUS_ICON[level]} ${i.grade}` })),
        C.meter(i.total)),
      h('div', { class: 'card health-verdict' },
        h('div', { class: 'card-sub', text: 'Is this maintained?' }),
        h('div', { class: `status status-${m.level} verdict`, text: `${STATUS_ICON[m.level]} ${m.verdict}` }),
        h('ul', { class: 'reasons' }, m.reasons.map((r) => h('li', { text: r }))))));
    out.push(section('How the score is made', h('div', { class: 'parts' }, i.parts.map((p) => {
      const lv = p.points / p.max >= 0.6 ? 'ok' : p.points / p.max >= 0.4 ? 'warn' : 'bad';
      return h('div', { class: 'part' },
        h('div', { class: 'part-head' }, h('span', { class: 'part-name', text: p.label }), h('span', { class: `status status-${lv}`, text: `${p.points} of ${p.max}` })),
        C.meter(p.points, p.max),
        h('ul', { class: 'part-items' }, p.items.map((x) => h('li', {}, h('span', { text: x.label }), h('span', { class: 'dim', text: ` +${Math.round(x.pts)}` })))));
    }))));
    out.push(h('div', { class: 'dim', text: `Evidence from GitHub, gathered ${ago(i.at)}${i.cached ? ' (saved copy)' : ''}. The score is a guide built from public signals, not a security audit.` }),
      h('div', { class: 'bar' }, h('button', { class: 'btn btn-sm', text: 'Refresh evidence', onclick: () => loadInsights(holder, link, true) }),
        h('button', { class: 'btn btn-sm', text: S.compare.includes(i.fullName) ? 'In compare' : 'Add to compare', disabled: S.compare.includes(i.fullName), onclick: () => addCompare(i.fullName) })));
    return out;
  }

  function activityView(holder, link) {
    const gate = insightsGate(holder, link);
    if (gate) return [gate];
    const i = holder.ins;
    const tile = (label, value) => h('div', { class: 'stat' }, h('div', { class: 'stat-v', text: value == null ? 'n/a' : num(value) }), h('div', { class: 'stat-l', text: label }));
    const out = [h('div', { class: 'stats' },
      tile('open issues', i.openIssues), tile('open pull requests', i.openPRs), tile('issues opened, 90 days', i.opened90), tile('issues closed, 90 days', i.closed90), tile('pull requests merged, 90 days', i.merged90), tile('contributors', i.contributorCount))];
    out.push(section('', i.activity
      ? C.columns(i.activity, { title: 'Commits per week', sub: 'The last 52 weeks', label: 'commits' })
      : h('div', { class: 'dim', text: 'GitHub is still counting weekly commits for this repository. Refresh evidence in a minute.' })));
    out.push(section('', i.starHistory
      ? C.line(i.starHistory.points, { title: 'Star history', sub: i.starHistory.partial ? 'GitHub lists only part of this repository\'s stars, so the early curve is incomplete' : 'Sampled from GitHub\'s star list', label: 'stars' })
      : h('div', {}, h('div', { class: 'chart-title', text: 'Star history' }), h('div', { class: 'dim', text: 'Sign in (Tools → GitHub) to see star history; it takes about a dozen requests.' }))));
    out.push(section('', C.timeline(i.releases, { title: 'Releases', sub: i.releases.length ? `${i.releases.length} shown; filled = release, hollow = pre-release` : '' })));
    out.push(h('div', { class: 'two-col' },
      section('', C.bars(i.contributors.slice(0, 10).map((c) => ({ label: c.login, value: c.commits })), { title: 'Top contributors', sub: 'Commits on the default branch' })),
      section('', C.bars(i.languages.map((l) => ({ label: l.name, value: l.pct })), { title: 'Languages', sub: 'Share of code', unit: '%', max: 100 }))));
    return out;
  }

  /* ---------- files ---------- */
  /* src: { kind: 'gh', link, ref } or { kind: 'local', dir, web, branch }. State lives on `holder.fb`. */
  function fileBrowser(holder, src) {
    const F = holder.fb || (holder.fb = { ref: src.ref || '', items: null, expanded: new Set(), file: null, q: '', line: 0, refs: null, loadingTree: false });
    const wrap = h('div', { class: 'fb' });
    const loadTree = async () => {
      F.loadingTree = true; F.items = null; paintMain();
      const r = src.kind === 'gh' ? await hub.files.tree(src.link, F.ref || src.ref) : await hub.files.localTree(src.dir);
      F.loadingTree = false;
      if (r && r.ok) { F.items = r.items; F.truncated = r.truncated; } else { F.items = []; F.error = (r && r.error) || 'Could not list files.'; }
      if (S.sel === holder) paintMain();
    };
    if (!F.items && !F.loadingTree) loadTree();
    if (src.kind === 'gh' && !F.refs) hub.files.refs(src.link).then((r) => { F.refs = r && r.ok ? r : { branches: [], tags: [] }; if (S.sel === holder) paintMain(); });

    // Ref picker (GitHub only): branches, tags, or any commit id
    const bar = h('div', { class: 'bar' });
    if (src.kind === 'gh') {
      const refIn = h('input', { class: 'input', list: 'fb-refs', value: F.ref || src.ref, title: 'Branch, tag or commit', style: { width: '220px' } });
      const dl = h('datalist', { id: 'fb-refs' }, ((F.refs && F.refs.branches) || []).map((b) => h('option', { value: b, label: 'branch' })), ((F.refs && F.refs.tags) || []).map((t) => h('option', { value: t, label: 'tag' })));
      bar.append(h('span', { class: 'dim', text: 'Branch, tag or commit' }), refIn, dl, h('button', { class: 'btn btn-sm', text: 'Go', onclick: () => { F.ref = refIn.value.trim() || src.ref; F.file = null; F.expanded.clear(); loadTree(); } }));
    } else bar.append(h('span', { class: 'dim', text: `Your local copy${src.branch ? ` on ${src.branch}` : ''}, including uncommitted changes` }));
    const q = h('input', { class: 'input grow', type: 'search', placeholder: 'Find a file by name or path', value: F.q });
    q.addEventListener('input', () => { F.q = q.value; paintTreeOnly(); });
    bar.append(q);
    wrap.append(bar);

    const treeEl = h('div', { class: 'fb-tree' });
    const viewEl = h('div', { class: 'fb-view' });
    wrap.append(h('div', { class: 'fb-split' }, treeEl, viewEl));

    function children(prefix) {
      const depth = prefix ? prefix.split('/').length : 0;
      return F.items.filter((x) => (prefix ? x.path.startsWith(prefix + '/') : true) && x.path.split('/').length === depth + 1)
        .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
    }
    function node(item, depth) {
      const name = item.path.split('/').pop();
      if (item.type === 'dir') {
        const open = F.expanded.has(item.path);
        const row = h('button', { class: 'fb-row dir', style: { paddingLeft: `${8 + depth * 14}px` }, onclick: () => { if (open) F.expanded.delete(item.path); else F.expanded.add(item.path); paintTreeOnly(); } }, `${open ? '▾' : '▸'} ${name}`);
        return [row, ...(open ? children(item.path).flatMap((c) => node(c, depth + 1)) : [])];
      }
      return [h('button', { class: `fb-row file${F.file && F.file.path === item.path ? ' sel' : ''}`, style: { paddingLeft: `${22 + depth * 14}px` }, title: item.path, onclick: () => openFile(item.path) }, name)];
    }
    function paintTreeOnly() {
      if (F.loadingTree || !F.items) { treeEl.replaceChildren(h('div', { class: 'dim pad', text: 'Listing files…' })); return; }
      if (F.error && !F.items.length) { treeEl.replaceChildren(h('div', { class: 'warn-box', text: F.error })); return; }
      const qq = F.q.trim().toLowerCase();
      if (qq) {
        const hits = F.items.filter((x) => x.type === 'file' && x.path.toLowerCase().includes(qq)).slice(0, 300);
        treeEl.replaceChildren(...(hits.length ? hits.map((x) => h('button', { class: `fb-row file${F.file && F.file.path === x.path ? ' sel' : ''}`, title: x.path, onclick: () => openFile(x.path) }, x.path)) : [h('div', { class: 'dim pad', text: 'No file matches.' })]));
        return;
      }
      treeEl.replaceChildren(...children('').flatMap((c) => node(c, 0)), F.truncated ? h('div', { class: 'dim pad', text: 'Very large repository: only part of the file list is shown. Use Find.' }) : null);
    }
    async function openFile(p) {
      F.file = { path: p, loading: true }; F.line = 0;
      paintTreeOnly(); paintView();
      const r = src.kind === 'gh' ? await hub.files.file(src.link, F.ref || src.ref, p) : await hub.files.localFile(src.dir, p);
      if (!F.file || F.file.path !== p) return;
      F.file = { path: p, ...(r || { ok: false, error: 'Could not read the file.' }) };
      paintView();
    }
    const blobBase = () => {
      if (src.kind === 'gh') return `https://github.com/${src.link.replace(/^https:\/\/github\.com\//i, '')}/blob/${encodeURIComponent(F.ref || src.ref)}/`;
      return src.web && src.branch ? `${src.web}/blob/${encodeURIComponent(src.branch)}/` : '';
    };
    const copy = async (text, what) => {
      try { await navigator.clipboard.writeText(text); toast(`${what} copied.`, 3000, 'good'); }
      catch { const t = h('textarea', {}); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); toast(`${what} copied.`, 3000, 'good'); }
    };
    function paintView() {
      const f = F.file;
      if (!f) { viewEl.replaceChildren(h('div', { class: 'dim pad', text: 'Pick a file to read it here, before installing anything.' })); return; }
      const base = blobBase();
      const link = base ? base + f.path.split('/').map(encodeURIComponent).join('/') + (F.line ? `#L${F.line}` : '') : '';
      const head = h('div', { class: 'fb-head' },
        h('span', { class: 'mono wrap grow', text: f.path }),
        f.size ? h('span', { class: 'dim', text: `${Math.max(1, Math.round(f.size / 1024))} KB` }) : null,
        link ? h('button', { class: 'btn btn-sm', text: F.line ? `Copy link to line ${F.line}` : 'Copy link', onclick: () => copy(link, 'Link') }) : null,
        link ? h('button', { class: 'btn btn-sm', text: 'Open on GitHub', onclick: () => hub.open.web(link) }) : null,
        f.text != null ? h('button', { class: 'btn btn-sm', text: 'Save a copy', onclick: async () => { const r = await hub.files.save(f.path.split('/').pop(), f.text); if (r && r.ok) toast(`Saved to ${r.path}`, 5000, 'good'); } }) : null);
      if (f.loading) { viewEl.replaceChildren(head, h('div', { class: 'dim pad', text: 'Reading…' })); return; }
      if (!f.ok) { viewEl.replaceChildren(head, h('div', { class: 'warn-box', text: f.error || 'Could not read the file.' })); return; }
      if (f.tooLarge) { viewEl.replaceChildren(head, h('div', { class: 'dim pad', text: `Too large to show here (${Math.round(f.size / 1048576 * 10) / 10} MB). Open it on GitHub instead.` })); return; }
      if (f.binary) {
        const img = /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(f.path) && src.kind === 'gh'
          ? h('img', { class: 'fb-img', src: `https://raw.githubusercontent.com/${src.link.replace(/^https:\/\/github\.com\//i, '')}/${encodeURIComponent(F.ref || src.ref)}/${f.path.split('/').map(encodeURIComponent).join('/')}`, referrerpolicy: 'no-referrer' }) : null;
        viewEl.replaceChildren(head, img || h('div', { class: 'dim pad', text: 'A binary file (not text), so it is not shown.' }));
        return;
      }
      const isMd = /\.(md|markdown)$/i.test(f.path);
      if (isMd && !F.rawMd) {
        viewEl.replaceChildren(head, h('div', { class: 'bar' }, h('button', { class: 'btn btn-sm', text: 'Show source', onclick: () => { F.rawMd = true; paintView(); } })),
          h('div', { class: 'fb-md' }, md(f.text, src.kind === 'gh' ? { blob: base + f.path.replace(/[^/]+$/, ''), raw: `https://raw.githubusercontent.com/${src.link.replace(/^https:\/\/github\.com\//i, '')}/${F.ref || src.ref}/${f.path.replace(/[^/]+$/, '')}` } : null)));
        return;
      }
      // Selecting a line repaints the viewer; keep the reader's place in the file.
      const prev = viewEl.querySelector('.code-wrap');
      const keep = prev && prev.dataset.path === f.path ? prev.scrollTop : 0;
      const cv = codeView(f.text, f.path, F.line, (n) => { F.line = n; paintView(); });
      cv.dataset.path = f.path;
      viewEl.replaceChildren(head, isMd ? h('div', { class: 'bar' }, h('button', { class: 'btn btn-sm', text: 'Show formatted', onclick: () => { F.rawMd = false; paintView(); } })) : null, cv);
      cv.scrollTop = keep;
    }
    paintTreeOnly(); paintView();
    return wrap;
  }

  /* Highlighted code with line numbers. highlight.js escapes the text; the
     result is split into lines with every open span closed and reopened, so a
     comment spanning lines keeps its colour. */
  const LANG_BY_EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: 'dos', cmd: 'dos', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', scss: 'scss', sql: 'sql', swift: 'swift', dart: 'dart', lua: 'lua', r: 'r', dockerfile: 'dockerfile', makefile: 'makefile' };
  function splitHighlighted(html) {
    const lines = []; let cur = ''; const stack = [];
    const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)|(<)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1]) { stack.push(m[1]); cur += m[1]; }
      else if (m[2]) { stack.pop(); cur += m[2]; }
      else if (m[3]) { cur += '</span>'.repeat(stack.length); lines.push(cur); cur = stack.join(''); }
      else cur += m[4] || m[5];
    }
    lines.push(cur);
    return lines;
  }
  function codeView(text, filePath, selected, onLine) {
    const name = filePath.split('/').pop().toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : name;
    let html;
    const hl = window.hljs;
    const lang = LANG_BY_EXT[ext] || LANG_BY_EXT[name];
    try {
      if (hl && text.length < 400000) html = lang && hl.getLanguage(lang) ? hl.highlight(text, { language: lang, ignoreIllegals: true }).value : hl.highlightAuto(text.slice(0, 200000)).value;
    } catch { html = null; }
    const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = html ? splitHighlighted(html) : escape(text).split('\n');
    const table = h('table', { class: 'code' });
    const tbody = h('tbody', {});
    const frag = document.createDocumentFragment();
    lines.forEach((ln, i) => {
      const tr = document.createElement('tr');
      tr.dataset.line = String(i + 1);
      if (selected === i + 1) tr.className = 'sel';
      const num = document.createElement('td'); num.className = 'ln'; num.textContent = String(i + 1); num.title = 'Select this line for a link';
      num.onclick = () => onLine(i + 1);
      const code = document.createElement('td'); code.className = 'lc hljs'; code.innerHTML = ln || ' ';
      tr.append(num, code); frag.append(tr);
    });
    tbody.append(frag); table.append(tbody);
    return h('div', { class: 'code-wrap' }, table);
  }

  /* ---------- compare ---------- */
  function addCompare(full) {
    if (S.compare.includes(full)) return;
    if (S.compare.length >= 4) { toast('Compare holds up to four repositories. Remove one first.', 6000); return; }
    S.compare.push(full); saveCompare(); paintSavedCount();
    toast(`${full} added to Compare (${S.compare.length}).`, 4000, 'good');
    if (S.sel && S.sel.type !== 'compare') paintMain();
  }
  function showCompare() { S.sel = { type: 'compare', data: S.sel && S.sel.type === 'compare' ? S.sel.data : {} }; paintList(); paintMain(); }
  function paintCompare() {
    const V = S.sel;
    const add = h('input', { class: 'input grow', placeholder: 'Add a repository: link or owner/repository' });
    const addBtn = h('button', { class: 'btn btn-sm', text: 'Add', onclick: async () => {
      const r = await hub.gh.parse(add.value);
      if (!r || !r.parsed) { toast('That is not a GitHub repository link.', 5000, 'bad'); return; }
      addCompare(r.parsed.full); paintCompare();
    } });
    const head = h('div', { class: 'head' }, h('div', { class: 'head-title' }, h('span', { class: 'head-name', text: 'Compare' }), h('span', { class: 'dim', text: 'up to four repositories, side by side' })),
      h('div', { class: 'bar' }, add, addBtn, S.compare.length ? h('button', { class: 'btn btn-sm', text: 'Clear', onclick: () => { S.compare = []; V.data = {}; saveCompare(); paintSavedCount(); paintCompare(); } }) : null));
    if (!S.compare.length) { main.replaceChildren(head, section('', h('div', { class: 'dim', text: 'Add repositories here, or use Add to compare on a repository\'s Health tab or in Saved.' }))); return; }
    // Load what is missing
    for (const full of S.compare) {
      if (!V.data[full]) {
        V.data[full] = { loading: true };
        hub.insights.get(full).then((r) => { V.data[full] = r && r.ok ? r : { error: (r && r.error) || 'Could not read it.' }; if (S.sel === V) paintCompare(); });
      }
    }
    const cols = S.compare.map((f) => ({ full: f, d: V.data[f] }));
    const ready = (d) => d && !d.loading && !d.error;
    const lastRel = (d) => { const r = d.releases.find((x) => !x.prerelease) || d.releases[0]; return r ? r.date : null; };
    const weeks12 = (d) => (Array.isArray(d.activity) ? d.activity.slice(-12).reduce((a, w) => a + w.total, 0) : null);
    // label, value getter, display, which is better ('high' | 'low' | null)
    const rows = [
      ['Health score', (d) => d.total, (v, d) => `${v} (${d.grade})`, 'high'],
      ['Is this maintained?', (d) => ({ ok: 3, warn: 2, bad: 1 })[d.maintained.level], (v, d) => `${STATUS_ICON[d.maintained.level]} ${d.maintained.verdict}`, 'high'],
      ...['activity', 'maintenance', 'community', 'docs', 'engineering', 'safety'].map((k) => [`  ${({ activity: 'Activity', maintenance: 'Maintenance', community: 'People', docs: 'Documentation', engineering: 'Engineering', safety: 'Safety' })[k]}`, (d) => (d.parts.find((p) => p.key === k) || {}).points, (v, d) => `${v} of ${(d.parts.find((p) => p.key === k) || {}).max}`, 'high']),
      ['Stars', (d) => d.stars, (v) => num(v), 'high'],
      ['Forks', (d) => d.forks, (v) => num(v), 'high'],
      ['Last change', (d) => (d.pushedAt ? Date.parse(d.pushedAt) : null), (v, d) => d.pushedAt || 'n/a', 'high'],
      ['Commits, last 12 weeks', weeks12, (v) => (v == null ? 'n/a' : num(v)), 'high'],
      ['Latest release', (d) => { const x = lastRel(d); return x ? Date.parse(x) : null; }, (v, d) => lastRel(d) || 'none', 'high'],
      ['Contributors', (d) => d.contributorCount, (v) => (v == null ? 'n/a' : num(v)), 'high'],
      ['Median days to close an issue', (d) => d.medianCloseDays, (v) => (v == null ? 'n/a' : String(v)), 'low'],
      ['Open issues', (d) => d.openIssues, (v) => (v == null ? 'n/a' : num(v)), null],
      ['Open pull requests', (d) => d.openPRs, (v) => (v == null ? 'n/a' : num(v)), null],
      ['License', (d) => d.license, (v) => v || 'none', null],
      ['Main language', (d) => d.languages[0] && d.languages[0].name, (v) => v || 'n/a', null],
      ['Created', (d) => d.createdAt, (v) => v || 'n/a', null],
    ];
    const table = h('table', { class: 'compare' });
    table.append(h('tr', {}, h('th', { text: '' }), cols.map((c) => h('th', {},
      h('button', { class: 'linkish', text: c.full, onclick: () => { $('explore-input').value = `https://github.com/${c.full}`; explore(c.full); } }),
      h('button', { class: 'icon-btn', text: '✕', title: 'Remove from compare', onclick: () => { S.compare = S.compare.filter((x) => x !== c.full); delete V.data[c.full]; saveCompare(); paintSavedCount(); paintCompare(); } })))));
    for (const [label, get, show, better] of rows) {
      const vals = cols.map((c) => (ready(c.d) ? get(c.d) : undefined));
      const nums = vals.filter((v) => typeof v === 'number');
      const best = better && nums.length > 1 ? (better === 'high' ? Math.max(...nums) : Math.min(...nums)) : null;
      const allSame = nums.length > 1 && nums.every((v) => v === nums[0]);
      table.append(h('tr', { class: label.startsWith('  ') ? 'sub' : '' }, h('td', { class: 'dim', text: label.trim() }), cols.map((c, ix) => {
        if (!c.d || c.d.loading) return h('td', { class: 'dim', text: 'reading…' });
        if (c.d.error) return h('td', { class: 'dim', text: '—' });
        const v = vals[ix];
        const isBest = best != null && !allSame && v === best;
        return h('td', { class: isBest ? 'best' : '' }, v == null ? 'n/a' : show(v, c.d), isBest ? h('span', { class: 'best-mark', text: ' ▲ best' }) : null);
      })));
    }
    const errors = cols.filter((c) => c.d && c.d.error);
    main.replaceChildren(head, section('', h('div', { class: 'compare-wrap' }, table),
      errors.length ? h('div', { class: 'warn-box', text: errors.map((c) => `${c.full}: ${c.d.error}`).join(' · ') }) : null,
      h('div', { class: 'dim', text: '▲ best marks the strongest value in each comparable row. Scores are guides built from public signals.' })));
  }

  /* ============================================================
     PHASE 3: settings, command palette, grid view, update all
     ============================================================ */
  S.settings = null;
  const IS_SETTINGS_WINDOW = new URLSearchParams(location.search).get('view') === 'settings';
  const FONTS_UI = [['"Segoe UI", system-ui, sans-serif', 'Segoe UI (Windows)'], ['"Aptos", "Segoe UI", sans-serif', 'Aptos'], ['"Inter", "Segoe UI", sans-serif', 'Inter'], ['"Calibri", "Segoe UI", sans-serif', 'Calibri'], ['Arial, sans-serif', 'Arial'], ['Verdana, sans-serif', 'Verdana'], ['system-ui, sans-serif', 'System default']];
  const FONTS_READ = [...FONTS_UI, ['Georgia, serif', 'Georgia (serif)'], ['Cambria, Georgia, serif', 'Cambria (serif)']];
  const FONTS_CODE = [['"Cascadia Code", Consolas, ui-monospace, monospace', 'Cascadia Code'], ['Consolas, ui-monospace, monospace', 'Consolas'], ['"JetBrains Mono", Consolas, monospace', 'JetBrains Mono'], ['"Fira Code", Consolas, monospace', 'Fira Code'], ['"Courier New", monospace', 'Courier New']];
  const THEMES = [['indigo', 'Indigo', '#6e8bff', '#a06bff'], ['ember', 'Ember', '#d97757', '#e8a07a'], ['forest', 'Forest', '#3fb98a', '#7bd3a8'], ['ocean', 'Ocean', '#38bdf8', '#22d3ee'], ['graphite', 'Graphite', '#9aa7ba', '#c3ccd8']];

  function applySettings(st) {
    S.settings = st;
    const root = document.documentElement;
    root.dataset.color = st.colorTheme;
    root.dataset.density = st.density;
    root.style.setProperty('--ui', st.uiFont);
    root.style.setProperty('--reading', st.readingFont);
    root.style.setProperty('--mono', st.codeFont);
    S.readmeImages = st.readmeImages;
    if (st.librarySort && st.librarySort !== S.sort) { S.sort = st.librarySort; const el = document.getElementById('sort'); if (el) el.value = S.sort; if (S.repos.length) paintList(); }
    applyLayout();
  }

  /* ---------- movable separators ----------
     Two separators: between the repository list and the main area, and (when
     Settings is pinned) between the main area and Settings. Drag, or focus one
     and use the arrow keys; double-click puts it back. Widths are saved in
     settings (sidebarWidth, dockWidth), and the main area always keeps at
     least MIN_MAIN pixels, so a narrow window shrinks the side panes for the
     moment without changing what is saved. */
  const MIN_MAIN = 380;
  const drag = { side: null, dock: null };
  function layoutWidths() {
    const W = window.innerWidth || 1400;
    const pinned = document.body.classList.contains('settings-pinned');
    const st2 = S.settings || {};
    let dock = pinned ? (drag.dock != null ? drag.dock : (st2.dockWidth || 480)) : 0;
    let side = drag.side != null ? drag.side : (st2.sidebarWidth || 340);
    side = Math.max(220, Math.min(side, W - dock - MIN_MAIN));
    if (pinned) dock = Math.max(320, Math.min(dock, W - side - MIN_MAIN));
    return { side: Math.max(180, side), dock: Math.max(0, dock) };
  }
  function applyLayout() {
    const lay = document.querySelector('.layout');
    if (!lay) return;
    const w = layoutWidths();
    lay.style.setProperty('--side-w', `${w.side}px`);
    lay.style.setProperty('--dock-w', `${w.dock}px`);
  }
  function wireSplitter(el, which) {
    if (!el) return;
    const key = which === 'side' ? 'sidebarWidth' : 'dockWidth';
    const def = which === 'side' ? 340 : 480;
    const dir = which === 'side' ? 1 : -1;
    const save = (w) => { drag[which] = null; setSetting({ [key]: Math.round(w) }); };
    let start = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      start = { x: e.clientX, w: layoutWidths()[which] };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging'); document.body.classList.add('resizing');
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      drag[which] = start.w + dir * (e.clientX - start.x);
      applyLayout();
    });
    const end = (e) => {
      if (!start) return;
      start = null;
      try { el.releasePointerCapture(e.pointerId); } catch { /* released */ }
      el.classList.remove('dragging'); document.body.classList.remove('resizing');
      const w = layoutWidths()[which];
      save(w);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => { drag[which] = null; setSetting({ [key]: def }); });
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 64 : 16;
      const cur = layoutWidths()[which];
      let next = null;
      if (e.key === 'ArrowLeft') next = cur - dir * step;
      else if (e.key === 'ArrowRight') next = cur + dir * step;
      else if (e.key === 'Home') next = def;
      if (next == null) return;
      e.preventDefault();
      drag[which] = next; applyLayout();
      save(layoutWidths()[which]);
    });
  }
  window.addEventListener('resize', () => applyLayout());

  /* ---------- settings panel ---------- */
  let settingsSection = '';
  function openSettings(sectionId) {
    settingsSection = sectionId || settingsSection || 'appearance';
    if (IS_SETTINGS_WINDOW) { renderSettings(); return; }
    const dock = $('settings-dock');
    dock.hidden = false;
    document.body.classList.toggle('settings-pinned', (S.settings || {}).settingsMode === 'pinned');
    document.body.classList.toggle('settings-overlay', (S.settings || {}).settingsMode !== 'pinned');
    applyLayout();
    renderSettings();
    const q = dock.querySelector('.set-search'); if (q) q.focus();
  }
  function closeSettings() {
    if (IS_SETTINGS_WINDOW) { window.close(); return; }
    $('settings-dock').hidden = true;
    document.body.classList.remove('settings-pinned', 'settings-overlay');
    applyLayout();
  }
  const settingsOpen = () => IS_SETTINGS_WINDOW || !$('settings-dock').hidden;

  async function setSetting(patch) {
    const r = await hub.settings.set(patch);
    if (r && r.settings) applySettings(r.settings);
    if (r && !r.ok) fail({ error: `Not saved: ${r.refused.join(', ')}` });
  }

  /* One row: label, description, control. data-search makes it findable. */
  const row = (label, desc, control, extra = '') => h('div', { class: 'set-row', 'data-search': `${label} ${desc || ''} ${extra}`.toLowerCase() },
    h('div', { class: 'set-text' }, h('div', { class: 'set-label', text: label }), desc ? h('div', { class: 'set-desc', text: desc }) : null),
    h('div', { class: 'set-control' }, control));
  const seg = (key, options) => h('div', { class: 'seg' }, options.map(([v, label]) => h('button', { class: `seg-btn${S.settings[key] === v ? ' on' : ''}`, text: label, onclick: () => setSetting({ [key]: v }).then(renderSettings) })));
  const toggle = (key) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: S.settings[key] ? true : null, onchange: (e) => setSetting({ [key]: e.target.checked }) }), h('span', { class: 'slider' }));
  function fontPicker(key, presets) {
    const cur = S.settings[key];
    const known = presets.some(([v]) => v === cur);
    const sel = h('select', { class: 'input', onchange: (e) => { if (e.target.value !== '__custom') setSetting({ [key]: e.target.value }).then(renderSettings); else custom.hidden = false; } },
      presets.map(([v, l]) => h('option', { value: v, text: l })), h('option', { value: '__custom', text: 'Another font…' }));
    sel.value = known ? cur : '__custom';
    const custom = h('input', { class: 'input', placeholder: 'Font name, as installed', value: known ? '' : cur.replace(/^"([^"]+)".*$/, '$1'), hidden: known ? true : null });
    custom.addEventListener('change', () => { const n = custom.value.replace(/["'<>;{}]/g, '').trim(); if (n) setSetting({ [key]: `"${n}", ${key === 'codeFont' ? 'Consolas, monospace' : '"Segoe UI", sans-serif'}` }).then(renderSettings); });
    return h('div', { class: 'font-pick' }, sel, custom, h('span', { class: 'font-sample', style: { fontFamily: cur }, text: key === 'codeFont' ? 'const x = 42; // 0O 1lI' : 'The quick brown fox, 0123' }));
  }
  function slider(key, min, max, step, unit) {
    const val = h('span', { class: 'slider-val', text: `${S.settings[key]}${unit}` });
    let t;
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(S.settings[key]) });
    input.addEventListener('input', () => { val.textContent = `${input.value}${unit}`; clearTimeout(t); t = setTimeout(() => setSetting({ [key]: Number(input.value) }), 250); });
    return h('div', { class: 'range' }, input, val);
  }

  const SECTIONS = [
    ['appearance', 'Appearance'], ['writing', 'Writing style'], ['start', 'Start and folders'], ['accounts', 'Accounts'],
    ['installers', 'Installers'], ['security', 'Security'], ['shortcuts', 'Shortcuts'], ['about', 'About'],
  ];
  let settingsQuery = '';
  let installState = null;   // result of installers.check()
  let installPicks = new Set();

  async function renderSettings() {
    if (!S.settings) { const r = await hub.settings.get(); if (r && r.ok) applySettings(r.settings); }
    const host = IS_SETTINGS_WINDOW ? $('main') : $('settings-dock');
    const st = S.settings;
    const pinned = st.settingsMode === 'pinned';
    const search = h('input', { class: 'input set-search', type: 'search', placeholder: 'Search settings', value: settingsQuery });
    search.addEventListener('input', () => { settingsQuery = search.value.trim().toLowerCase(); filterRows(); });
    const head = h('div', { class: 'set-head' },
      h('div', { class: 'set-title', text: 'Settings' }),
      search,
      !IS_SETTINGS_WINDOW ? h('button', { class: `icon-btn${pinned ? ' on' : ''}`, text: pinned ? '⇥ Unpin' : '⇤ Pin', title: pinned ? 'Show as a floating panel' : 'Keep Settings docked beside your work', onclick: async () => { await setSetting({ settingsMode: pinned ? 'overlay' : 'pinned' }); openSettings(); } }) : null,
      !IS_SETTINGS_WINDOW ? h('button', { class: 'icon-btn', text: '⧉ Pop out', title: 'Open Settings in its own window', onclick: async () => { await hub.settings.popout(); closeSettings(); } }) : null,
      h('button', { class: 'icon-btn', text: '✕', title: 'Close (Esc)', onclick: closeSettings }));
    const nav = h('nav', { class: 'set-nav' }, SECTIONS.map(([id, label]) => h('button', { class: `set-nav-btn${settingsSection === id ? ' on' : ''}`, text: label, onclick: () => { settingsSection = id; settingsQuery = ''; renderSettings(); } })));
    const body = h('div', { class: 'set-body' });
    const sec = (id, title, ...rows) => h('section', { class: 'set-section', 'data-sec': id }, h('h3', { text: title }), ...rows);

    // Appearance
    body.append(sec('appearance', 'Appearance',
      row('Day or night', 'Follow Windows, or choose day (light) or night (dark).', seg('themeMode', [['system', 'Follow Windows'], ['day', 'Day'], ['night', 'Night']]), 'theme dark light mode'),
      row('Color theme', 'The accent colour and the night background.', h('div', { class: 'swatches' }, THEMES.map(([v, l, a, b]) => h('button', { class: `swatch${st.colorTheme === v ? ' on' : ''}`, title: l, onclick: () => setSetting({ colorTheme: v }).then(renderSettings) },
        h('span', { class: 'swatch-dot', style: { background: `linear-gradient(135deg, ${a}, ${b})` } }), h('span', { text: l })))), 'colour accent'),
      row('Text size', 'Scales the whole window, text and controls.', slider('textSize', 80, 150, 5, '%'), 'zoom scale bigger smaller'),
      row('Density', 'Compact fits more on screen.', seg('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']]), 'spacing'),
      row('Interface font', 'Buttons, lists and labels.', fontPicker('uiFont', FONTS_UI), 'typeface'),
      row('Reading font', 'READMEs, summaries and formatted Markdown.', fontPicker('readingFont', FONTS_READ), 'typeface markdown'),
      row('Code font', 'Code, logs, paths and the Output panel.', fontPicker('codeFont', FONTS_CODE), 'monospace typeface')));

    // Writing style
    body.append(sec('writing', 'Writing style',
      row('Style of Claude\'s explanations', 'Used by Explain with Claude and Explain why it did not run.', seg('writeStyle', [['plain', 'Plain English'], ['brief', 'Brief'], ['detailed', 'Detailed'], ['technical', 'Technical']]), 'summary tone write'),
      row('Length', 'The most words an explanation may use.', slider('summaryLength', 100, 600, 50, ' words'), 'summary words')));

    // Start and folders
    const startSec = sec('start', 'Start and folders',
      row('When RepoHub opens', 'What the right side shows first.', seg('startView', [['welcome', 'Welcome'], ['grid', 'Repository grid'], ['saved', 'Saved'], ['last', 'Last repository']]), 'startup open'));
    body.append(startSec);
    (async () => {
      const [cfg, clone] = await Promise.all([hub.repos.settings(), hub.app.defaultCloneDir()]);
      let roots = (cfg.roots || []).slice();
      const cloneEl = h('span', { class: 'mono wrap', text: clone.path });
      const rootsEl = h('div', { class: 'roots' });
      const saveRepoSettings = async (patch) => { const res = await hub.repos.saveSettings(patch); S.owner = (res && res.owner) || S.owner; };
      const paintRoots = () => rootsEl.replaceChildren(...(roots.length ? roots.map((p, ix) => h('div', { class: 'bar tight' }, h('span', { class: 'mono wrap grow', text: p }),
        h('button', { class: 'icon-btn', text: '✕', title: 'Stop scanning this folder', onclick: async () => { roots.splice(ix, 1); paintRoots(); await saveRepoSettings({ roots }); } }))) : [h('span', { class: 'dim', text: `Your user folder (${cfg.home})` })]),
        h('button', { class: 'btn btn-sm', text: 'Add folder', onclick: async () => { const p = await hub.pickFolder('Scan which folder?'); if (p && p.ok) { roots.push(p.path); paintRoots(); await saveRepoSettings({ roots }); } } }));
      paintRoots();
      const depth = h('input', { class: 'input', type: 'number', min: '1', max: '8', value: String(cfg.depth || 4), style: { width: '80px' }, onchange: (e) => saveRepoSettings({ depth: Number(e.target.value) }) });
      const owner = h('input', { class: 'input', value: cfg.owner || '', placeholder: 'GitHub account name', onchange: (e) => saveRepoSettings({ owner: e.target.value }) });
      const pats = h('input', { class: 'input', value: (cfg.hidePatterns || []).join(', '), onchange: (e) => saveRepoSettings({ hidePatterns: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) }) });
      startSec.append(
        row('Download folder', 'Where Install puts new repositories.', h('div', { class: 'bar tight' }, cloneEl, h('button', { class: 'btn btn-sm', text: 'Change', onclick: async () => { const p = await hub.pickFolder('Download repositories into which folder?', clone.path); if (p && p.ok) { await hub.app.setCloneDir(p.path); cloneEl.textContent = p.path; } } })), 'clone start folder'),
        row('Folders to scan', 'Where RepoHub looks for repositories on this computer.', rootsEl, 'start folder scan roots'),
        row('How deep to look', 'Folder levels below each scanned folder.', depth, 'depth levels'),
        row('My GitHub account', 'Repositories under this account show in the Mine view.', owner, 'owner username'),
        row('Hide repositories whose path contains', 'Comma separated. Grafsnas is hidden by default.', pats, 'hidden exclude'),
        row('Find repositories again', 'After changing the folders above.', h('button', { class: 'btn btn-sm', text: 'Rescan now', onclick: () => rescan() }), 'rescan'));
      filterRows();
    })();

    // Accounts
    const acct = sec('accounts', 'Accounts');
    body.append(acct);
    (async () => {
      const idt = await hub.tools.identity();
      const name = h('input', { class: 'input', value: idt.name || '', placeholder: 'Your name' });
      const email = h('input', { class: 'input', value: idt.email || '', placeholder: 'you@example.com' });
      acct.append(
        row('Git identity', 'Your name and email on commits. Saved in Git\'s own settings.', h('div', { class: 'bar tight wrap' }, name, email,
          h('button', { class: 'btn btn-sm', text: 'Save', onclick: async () => { const r = await hub.tools.setIdentity(name.value, email.value); if (r && r.ok) toast('Git identity saved.', 4000, 'good'); else fail(r); } })), 'git login name email commit'),
        row('Git sign-in', 'The GitHub login Git uses to clone, pull and push. Signing in happens in Git Credential Manager\'s browser window; RepoHub never sees your password.', gitSignInSection(), 'git login sign in credential manager gcm github account sign out'),
        row('Connect RepoHub to GitHub', 'For RepoHub\'s own GitHub requests: 5,000 an hour instead of 60, star history and private repositories.', loginSection(), 'github login gh sign in connect connector token'));
      const agentsEl = h('div', { class: 'agents' }, h('div', { class: 'dim', text: 'Checking which agents are installed…' }));
      const provEl = h('div', { class: 'agents' });
      acct.append(
        row('AI agents and models', 'Sign-in happens in each agent\'s own window or browser page; RepoHub never sees the password or key. The dot shows whether the agent is installed; RepoHub does not check whether its account is signed in.', agentsEl, 'agent login sign in chatgpt codex claude gemini copilot openai google qwen alibaba kimi moonshot ollama opencode kilo cline factory droid mistral vibe'),
        row('Model providers without a sign-in program', 'These providers only offer API keys on Windows. RepoHub opens their key page; you paste the key into an agent that supports them, which keeps it.', provEl, 'deepseek perplexity grok xai api key provider'));
      const paintAgents = (data) => {
        const agents = data.tools.filter((x) => x.group === 'agent');
        agentsEl.replaceChildren(...agents.map((t) => h('div', { class: 'agent' },
          h('span', { class: `dot ${t.version ? 'ok' : 'bad'}` }),
          h('div', { class: 'grow' },
            h('div', { class: 'agent-name', text: t.signIn ? t.signIn.label : t.name }),
            h('div', { class: 'dim', text: t.version ? `${t.name} · ${t.version}` : `${t.name} is not installed` }),
            t.signIn ? h('div', { class: 'dim', text: t.signIn.hint }) : null,
            t.note ? h('div', { class: 'dim inst-note', text: t.note }) : null),
          h('div', { class: 'agent-actions' },
            t.version && t.signIn ? h('button', { class: 'btn btn-sm', text: 'Sign in', title: `Opens a terminal running: ${t.signIn.command}`, onclick: () => hub.installers.signIn(t.id).then((x) => x && !x.ok && fail(x)) }) : null,
            t.version && t.signOut ? h('button', { class: 'btn btn-sm btn-ghost', text: 'Sign out', onclick: () => hub.installers.signOut(t.id).then((x) => x && !x.ok && fail(x)) }) : null,
            !t.version && t.canInstall ? h('button', { class: 'btn btn-sm btn-primary', text: 'Install', title: t.command, onclick: () => runInstall([t.id]) }) : null))));
        provEl.replaceChildren(...(data.providers || []).map((p) => {
          const ready = p.via.find((v) => v.installed);
          return h('div', { class: 'agent' },
            h('span', { class: 'dot' }),
            h('div', { class: 'grow' }, h('div', { class: 'agent-name', text: p.name }), h('div', { class: 'dim', text: p.note })),
            h('div', { class: 'agent-actions' },
              h('button', { class: 'btn btn-sm', text: 'Get an API key', title: p.keyUrl, onclick: () => hub.installers.providerKey(p.id).then((x) => x && !x.ok && fail(x)) }),
              ready ? h('button', { class: 'btn btn-sm', text: `Add it in ${ready.name}`, onclick: () => hub.installers.signIn(ready.id).then((x) => x && !x.ok && fail(x)) })
                : p.via.length ? h('button', { class: 'btn btn-sm btn-primary', text: `Install ${p.via[0].name}`, onclick: () => runInstall([p.via[0].id]) }) : null));
        }));
      };
      const data = installState || await hub.installers.check();
      installState = data;
      paintAgents(data);
      filterRows();
    })();

    // Installers
    const inst = sec('installers', 'Installers', h('div', { class: 'set-desc', text: 'Everything the repositories you try may need. Installs run in a visible window with the official installers (winget, built into Windows, npm, or uv for Python tools). You answer the license and administrator prompts yourself.' }));
    body.append(inst);
    const instList = h('div', { class: 'inst-list' }, h('div', { class: 'dim', text: 'Checking what is installed…' }));
    inst.append(instList);
    const paintInstallers = (data) => {
      const GROUPS = [['runtime', 'Languages and runtimes'], ['package', 'Package managers'], ['container', 'Containers'], ['tool', 'Tools'], ['agent', 'AI agents and models']];
      const missing = data.tools.filter((t) => !t.version && t.canInstall);
      instList.replaceChildren(
        data.windows && !data.winget ? h('div', { class: 'warn-box', text: 'winget (Windows Package Manager) was not found. Install "App Installer" from the Microsoft Store, then press Check again.' }) : null,
        ...GROUPS.map(([g, label]) => {
          const items = data.tools.filter((t) => t.group === g);
          if (!items.length) return null;
          return h('div', { class: 'inst-group' }, h('div', { class: 'card-sub', text: label }), items.map((t) => h('div', { class: 'inst-row set-row', 'data-search': `${t.name} ${t.why} ${t.id} install installer`.toLowerCase() },
            t.canInstall && !t.version ? h('input', { type: 'checkbox', checked: installPicks.has(t.id) ? true : null, onchange: (e) => { if (e.target.checked) installPicks.add(t.id); else installPicks.delete(t.id); paintInstallers(data); } }) : h('span', { class: 'inst-spacer' }),
            h('span', { class: `dot ${t.version ? 'ok' : 'bad'}` }),
            h('div', { class: 'grow' }, h('div', { class: 'agent-name', text: t.name }), h('div', { class: 'dim', text: t.why }), t.note ? h('div', { class: 'dim inst-note', text: t.note }) : null),
            h('div', { class: 'inst-status' }, h('div', { class: t.version ? 'mono' : 'dim', text: t.version || (t.method.startsWith('installed with') ? t.method : 'not installed') }), !t.version && t.command ? h('div', { class: 'mono dim inst-cmd', text: t.command }) : null),
            t.canInstall && !t.version ? h('button', { class: 'btn btn-sm', text: 'Install', onclick: () => runInstall([t.id]) }) : null)));
        }),
        h('div', { class: 'bar' },
          h('button', { class: 'btn btn-primary', text: installPicks.size ? `Install selected (${installPicks.size})` : 'Install selected', disabled: !installPicks.size, onclick: () => runInstall([...installPicks]) }),
          missing.length ? h('button', { class: 'btn btn-sm', text: `Select all missing (${missing.length})`, onclick: () => { missing.forEach((t) => installPicks.add(t.id)); paintInstallers(data); } }) : null,
          h('button', { class: 'btn btn-sm', text: 'Check again', onclick: async () => { instList.replaceChildren(h('div', { class: 'dim', text: 'Checking…' })); installState = await hub.installers.check(); S.tools = null; S.sb.docker = null; paintInstallers(installState); } })));
      filterRows();
    };
    (async () => { installState = installState || await hub.installers.check(); paintInstallers(installState); })();

    // Security
    body.append(sec('security', 'Security',
      row('Sandbox memory', 'The most memory one sandbox may use.', slider('sandboxMemoryGb', 1, 16, 1, ' GB'), 'docker limit ram'),
      row('Sandbox CPUs', 'The most processor cores one sandbox may use.', slider('sandboxCpus', 1, 8, 1, ''), 'docker limit cpu'),
      row('Sandbox time limit', 'Sandboxes are removed automatically after this many minutes. 0 means no limit.', slider('sandboxTtlMinutes', 0, 240, 5, ' min'), 'ttl time to live destroy'),
      row('Strict sandboxes', 'Read-only system files inside the sandbox. Safer, but many installs fail; turn on for repositories you distrust.', toggle('sandboxReadOnly'), 'read-only filesystem'),
      row('Show images in READMEs', 'Images load from the internet, which tells those servers your address. Off shows a placeholder.', toggle('readmeImages'), 'privacy remote images'),
      row('Confirm before installing', 'Show the exact commands before an installer window opens.', toggle('confirmInstalls'), 'install prompt'),
      row('Clear saved data', 'Health evidence, Claude summaries or recently viewed. Saved repositories and settings stay.', h('div', { class: 'bar tight wrap' },
        h('button', { class: 'btn btn-sm', text: 'Clear health evidence', onclick: async () => { await hub.settings.clearData('cache'); toast('Health evidence cleared.', 3000, 'good'); } }),
        h('button', { class: 'btn btn-sm', text: 'Clear summaries', onclick: async () => { await hub.settings.clearData('summaries'); toast('Summaries cleared.', 3000, 'good'); } }),
        h('button', { class: 'btn btn-sm', text: 'Clear recently viewed', onclick: async () => { await hub.settings.clearData('history'); await loadSaved(); toast('Recently viewed cleared.', 3000, 'good'); } })), 'cache privacy delete')));

    // Shortcuts
    body.append(sec('shortcuts', 'Shortcuts',
      h('div', { class: 'set-desc', text: 'Press Ctrl+K for the command palette: every action, searchable, with its shortcut.' }),
      ...SHORTCUTS.map(([keys, what, note]) => row(what, note || '', h('span', { class: 'keys' }, keys.split(' ').map((k) => h('kbd', { text: k }))), keys))));

    // About
    body.append(sec('about', 'About',
      row('Version', '', h('span', { class: 'mono', id: 'about-version', text: '…' }), 'version'),
      row('Settings file', 'All settings live in one file; delete it to start over.', h('span', { class: 'mono wrap', id: 'about-file', text: '…' }), 'file path data'),
      row('Reset everything in Settings', 'Restores every setting above to its default. Your repositories and saved items are not touched.', h('button', { class: 'btn btn-sm btn-danger', text: 'Reset settings', onclick: async () => { const r = await hub.settings.reset(); if (r && r.settings) applySettings(r.settings); renderSettings(); } }), 'defaults reset')));
    hub.app.version().then((v) => { const el = $('about-version'); if (el && v) el.textContent = v.version; });
    hub.settings.get().then((g) => { const el = $('about-file'); if (el && g) el.textContent = g.file; });

    host.replaceChildren(h('div', { class: 'settings' }, head, h('div', { class: 'set-wrap' }, nav, body)));
    function filterRows() {
      const q = settingsQuery;
      for (const secEl of body.querySelectorAll('.set-section')) {
        if (!q) { secEl.hidden = secEl.dataset.sec !== settingsSection; for (const r of secEl.querySelectorAll('.set-row')) r.hidden = false; continue; }
        let any = false;
        for (const r of secEl.querySelectorAll('.set-row')) { const hit = (r.dataset.search || '').includes(q) || secEl.querySelector('h3').textContent.toLowerCase().includes(q); r.hidden = !hit; any = any || hit; }
        secEl.hidden = !any;
        // Group headings with nothing left under them go too.
        for (const g of secEl.querySelectorAll('.inst-group')) g.hidden = ![...g.querySelectorAll('.set-row')].some((r) => !r.hidden);
      }
      if (!q) for (const g of body.querySelectorAll('.inst-group')) g.hidden = false;
      nav.classList.toggle('dim-nav', !!q);
    }
    filterRows();
  }

  async function runInstall(ids) {
    const data = installState || await hub.installers.check();
    const picks = data.tools.filter((t) => ids.includes(t.id));
    const go = async () => {
      const r = await hub.installers.install(ids);
      if (r && r.ok) { toast('The installer window is open. Answer its prompts; when it says Done, press Check again.', 9000, 'good'); installPicks.clear(); }
      else fail(r);
    };
    if (!(S.settings || {}).confirmInstalls) { go(); return; }
    const { close } = overlay('Install these?', 620,
      h('div', { class: 'dim', text: 'A PowerShell window opens and runs these official installers, one after another. Windows may ask for administrator permission, and winget asks you to accept each package\'s license.' }),
      h('div', { class: 'cmd-list' }, picks.map((t) => h('div', { class: 'cmd-row' }, h('b', { text: t.name }), h('div', { class: 'mono', text: t.command || '(no command)' }), t.note ? h('div', { class: 'dim', text: t.note }) : null))),
      h('div', { class: 'bar end' }, h('button', { class: 'btn', text: 'Cancel', onclick: () => close() }), h('button', { class: 'btn btn-primary', text: 'Open the installer', onclick: () => { close(); go(); } })));
  }

  /* ---------- shortcuts and command palette ---------- */
  const SHORTCUTS = [
    ['Ctrl+K', 'Command palette', 'Every action, searchable'],
    ['Ctrl+,', 'Settings'],
    ['Ctrl+L', 'Paste a link (focus the Explore box)'],
    ['Ctrl+G', 'Repository grid'],
    ['Ctrl+Shift+F', 'Fetch all'],
    ['Ctrl+Shift+U', 'Update all', 'Pulls every clean repository that is behind GitHub'],
    ['Ctrl+Shift+C', 'Copy selected text in a log or code view'],
    ['Ctrl+Shift+V', 'Paste into the focused box'],
    ['Right-click', 'In a log or code view: copies the selected text'],
    ['Drag a separator', 'Resize the repository list or pinned Settings; arrow keys when it has focus, double-click to reset'],
    ['F5', 'Reload the window', 'For page edits (renderer.js, styles.css, index.html). Running jobs and sandboxes keep running.'],
    ['Ctrl+Shift+R', 'Full relaunch', 'Use after editing main.js or preload.js'],
    ['F12', 'Toggle DevTools'],
    ['Esc', 'Close the palette, a dialog or Settings'],
  ];

  function actions() {
    const A = [
      ['Paste a link to explore', 'Ctrl+L', () => { $('explore-input').focus(); $('explore-input').select(); }],
      ['Repository grid', 'Ctrl+G', () => showGrid()],
      ['Fetch all', 'Ctrl+Shift+F', () => fetchAll()],
      ['Update all', 'Ctrl+Shift+U', () => updateAll()],
      ['Refresh repository status', '', () => refreshAll()],
      ['Rescan folders for repositories', '', () => rescan()],
      ['Saved repositories', '', () => showSaved()],
      ['Compare', '', () => showCompare()],
      ['Sandboxes', '', () => showSandboxes()],
      ['Settings', 'Ctrl+,', () => openSettings()],
      ...SECTIONS.map(([id, label]) => [`Settings: ${label}`, '', () => openSettings(id)]),
      ['Install tools', '', () => openSettings('installers')],
      ['Sign in to GitHub', '', () => openSettings('accounts')],
      ['Sign in to Git (Git Credential Manager)', '', () => openSettings('accounts')],
      ...SORTS.map(([v, l]) => [`Sort the list: ${l}`, '', () => setSort(v)]),
      ['Reset the list width', '', () => setSetting({ sidebarWidth: 340 })],
      ...(() => {
        const full = S.sel && S.sel.type === 'explore' && S.sel.data ? S.sel.data.fullName
          : S.sel && S.sel.type === 'repo' ? (webOf(st(S.sel.path)).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/i) || [])[1] : '';
        return full ? [['GitIngest', 'gitingest.com'], ['GitDiagram', 'gitdiagram.com'], ['DeepWiki', 'deepwiki.com'], ['GitMCP', 'gitmcp.io']].map(([n], i) => [`Open ${full} in ${n}`, '', () => hub.aitools.open(['gitingest', 'gitdiagram', 'deepwiki', 'gitmcp'][i], full)]) : [];
      })(),
      ['AI agent sign-ins', '', () => openSettings('accounts')],
      ['Switch to day', '', () => setSetting({ themeMode: 'day' })],
      ['Switch to night', '', () => setSetting({ themeMode: 'night' })],
      ['Follow Windows day or night', '', () => setSetting({ themeMode: 'system' })],
      ['Bigger text', '', () => setSetting({ textSize: Math.min(150, (S.settings.textSize || 100) + 10) })],
      ['Smaller text', '', () => setSetting({ textSize: Math.max(80, (S.settings.textSize || 100) - 10) })],
      ['Reload the window', 'F5', () => hub.appControl.reload()],
      ['Full relaunch', 'Ctrl+Shift+R', () => hub.appControl.relaunch()],
      ['Toggle DevTools', 'F12', () => hub.appControl.devtools()],
    ];
    for (const r of S.repos.filter((x) => !x.hidden)) A.push([`Open repository: ${r.name}`, '', () => openRepo(r.path), r.path]);
    for (const b of S.saved.bookmarks) A.push([`Explore saved: ${b.full}`, '', () => { $('explore-input').value = `https://github.com/${b.full}`; explore(b.full); }]);
    return A;
  }

  function openPalette() {
    const pal = $('palette');
    const input = h('input', { class: 'input pal-input', placeholder: 'Type an action or a repository name' });
    const list = h('div', { class: 'pal-list' });
    let items = actions(), shown = [], ix = 0;
    const score = (label, q) => { const l = label.toLowerCase(); if (!q) return 1; if (l.includes(q)) return 100 - l.indexOf(q); let i = 0; for (const ch of l) if (ch === q[i]) i++; return i === q.length ? 10 : 0; };
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      shown = items.map((a) => [a, score(`${a[0]} ${a[3] || ''}`, q)]).filter(([, sc]) => sc > 0).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([a]) => a);
      ix = Math.min(ix, Math.max(0, shown.length - 1));
      list.replaceChildren(...(shown.length ? shown.map((a, n) => h('button', { class: `pal-item${n === ix ? ' on' : ''}`, onclick: () => run(n), onmousemove: () => { if (ix !== n) { ix = n; paint(); } } },
        h('span', { class: 'grow', text: a[0] }), a[1] ? h('span', { class: 'keys' }, a[1].split(' ').map((k) => h('kbd', { text: k }))) : null)) : [h('div', { class: 'dim pad', text: 'No action matches.' })]));
      const on = list.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const close = () => { pal.hidden = true; pal.replaceChildren(); };
    const run = (n) => { const a = shown[n]; close(); if (a) a[2](); };
    input.addEventListener('input', () => { ix = 0; paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); ix = Math.min(shown.length - 1, ix + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); ix = Math.max(0, ix - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(ix); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    pal.replaceChildren(h('div', { class: 'pal', onclick: (e) => e.stopPropagation() }, input, list));
    pal.onclick = close;
    pal.hidden = false;
    paint();
    input.focus();
  }

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.shiftKey && k === 'k') { e.preventDefault(); if ($('palette').hidden) openPalette(); else { $('palette').hidden = true; } return; }
    if (e.ctrlKey && !e.shiftKey && k === ',') { e.preventDefault(); if (settingsOpen() && !IS_SETTINGS_WINDOW) closeSettings(); else openSettings(); return; }
    if (IS_SETTINGS_WINDOW) { if (k === 'escape') window.close(); return; }
    if (e.ctrlKey && !e.shiftKey && k === 'l') { e.preventDefault(); $('explore-input').focus(); $('explore-input').select(); return; }
    if (e.ctrlKey && !e.shiftKey && k === 'g') { e.preventDefault(); showGrid(); return; }
    if (e.ctrlKey && e.shiftKey && k === 'f') { e.preventDefault(); fetchAll(); return; }
    if (e.ctrlKey && e.shiftKey && k === 'u') { e.preventDefault(); updateAll(); return; }
    if (e.ctrlKey && e.shiftKey && k === 'c') { const t = String(window.getSelection() || ''); if (t) { e.preventDefault(); copyText(t); } return; }
    if (e.ctrlKey && e.shiftKey && k === 'v') {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) { e.preventDefault(); navigator.clipboard.readText().then((t) => { el.setRangeText(t, el.selectionStart, el.selectionEnd, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })); }).catch(() => {}); }
      return;
    }
    if (k === 'escape' && !$('palette').hidden) { $('palette').hidden = true; return; }
    if (k === 'escape' && $('overlay').hidden && settingsOpen() && (S.settings || {}).settingsMode !== 'pinned') closeSettings();
  });

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); }
    catch { const ta = h('textarea', {}); ta.value = t; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    toast('Copied.', 2000, 'good');
  }
  // Right-click in a log or code view copies the selection.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.console, .code-wrap, .diff, .sb-log')) return;
    const t = String(window.getSelection() || '');
    if (t) { e.preventDefault(); copyText(t); }
  });

  /* ---------- repository grid ---------- */
  function showGrid() { S.sel = { type: 'grid', q: (S.sel && S.sel.type === 'grid' && S.sel.q) || '', sort: (S.sel && S.sel.type === 'grid' && S.sel.sort) || S.sort || 'recent' }; paintList(); paintMain(); }
  function paintGrid() {
    const V = S.sel;
    const q = (V.q || '').toLowerCase();
    const rows = sortRows(S.repos.filter((r) => (!r.hidden || S.showHidden) && (!q || `${r.name} ${r.path} ${(st(r.path) || {}).remote || ''} ${(catOf(r) || {}).label || ''}`.toLowerCase().includes(q))), V.sort);
    const filter = h('input', { class: 'input grow', type: 'search', placeholder: 'Filter repositories', value: V.q || '' });
    filter.addEventListener('input', () => { V.q = filter.value; const pos = filter.selectionStart; paintGrid(); const f2 = main.querySelector('.grid-tools input'); if (f2) { f2.focus(); f2.setSelectionRange(pos, pos); } });
    const sort = h('select', { class: 'input', title: 'Sort', onchange: (e) => { V.sort = e.target.value; paintGrid(); } }, SORTS.map(([v, l]) => h('option', { value: v, text: l })));
    sort.value = V.sort;
    const card = (r) => {
      const s2 = st(r.path);
      const busy = S.busy.has(r.path);
      return h('div', { class: `repo-card${r.hidden ? ' hidden-repo' : ''}` },
        h('div', { class: 'rc-top' }, h('button', { class: 'linkish rc-name', text: r.name, title: r.path, onclick: () => openRepo(r.path) }), busy ? h('span', { class: 'spin', text: '⟳' }) : null),
        h('div', { class: 'dim mono rc-sub', text: [ownerOf(s2 && s2.remote), s2 && s2.branch].filter(Boolean).join(' · ') || 'local' }),
        catOf(r) && V.sort !== 'category' ? h('div', { class: 'row-cat rc-cat', text: catOf(r).label, title: catOf(r).why }) : null,
        h('div', { class: 'rc-chips' }, ...chips(s2, r)),
        h('div', { class: 'dim rc-last', text: s2 && s2.lastMessage ? `${s2.lastDate} · ${s2.lastMessage}` : s2 && s2.noCommits ? 'no commits yet' : '' }),
        h('div', { class: 'rc-actions' },
          h('button', { class: 'btn btn-sm', text: 'Open', onclick: () => openRepo(r.path) }),
          h('button', { class: 'btn btn-sm', text: 'Claude', title: 'Open Claude in this folder', onclick: () => hub.term.open(r.path, 'claude').then((x) => x && !x.ok && fail(x)) }),
          s2 && s2.remote ? h('button', { class: 'btn btn-sm', text: 'Fetch', disabled: busy, onclick: () => act(r, 'fetch').then(paintGrid) }) : null,
          s2 && s2.behind && !s2.changed ? h('button', { class: 'btn btn-sm btn-accent', text: `Update (${s2.behind})`, disabled: busy, onclick: () => act(r, 'pull').then(paintGrid) }) : null));
    };
    main.replaceChildren(
      h('div', { class: 'head' }, h('div', { class: 'head-title' }, h('span', { class: 'head-name', text: 'Repositories' }), h('span', { class: 'chip', text: String(rows.length) })),
        h('div', { class: 'bar grid-tools' }, filter, sort,
          h('button', { class: 'btn btn-sm', text: 'Refresh', onclick: () => refreshAll().then(() => S.sel.type === 'grid' && paintGrid()) }),
          h('button', { class: 'btn btn-sm', text: 'Fetch all', onclick: () => fetchAll().then(() => S.sel.type === 'grid' && paintGrid()) }),
          h('button', { class: 'btn btn-sm btn-primary', text: 'Update all', onclick: () => updateAll() }))),
      !rows.length ? section('', h('div', { class: 'dim', text: 'No repositories match.' }))
        : V.sort === 'category' ? h('div', { class: 'grid-groups' }, groupByCategory(rows).map((g) => h('section', { class: 'grid-group' },
          h('div', { class: 'grid-group-head' }, h('span', { text: g.label }), h('span', { class: 'count', text: String(g.rows.length) })),
          h('div', { class: 'repo-grid' }, g.rows.map(card)))))
          : h('div', { class: 'repo-grid' }, rows.map(card)));
  }

  /* ---------- update all ---------- */
  /* For every repository with a GitHub address: fetch, then pull when it is
     behind and has no uncommitted changes. Anything that needs a decision is
     skipped and listed with the reason, never forced. */
  let updating = false;
  async function updateAll() {
    if (updating) return;
    const list = S.repos.filter((r) => !r.hidden);
    if (!list.length) { toast('No repositories with a GitHub address to update.', 5000); return; }
    updating = true;
    const res = new Map(list.map((r) => [r.path, { r, state: 'waiting', note: '' }]));
    const listEl = h('div', { class: 'upd-list' });
    const summary = h('div', { class: 'dim', text: `Updating ${list.length} repositories…` });
    const paint = () => listEl.replaceChildren(...[...res.values()].map((x) => h('div', { class: 'upd-row' },
      h('span', { class: `upd-state upd-${x.state}`, text: { waiting: '·', working: '⟳', updated: '✓', current: '✓', skipped: '!', failed: '✕' }[x.state] }),
      h('span', { class: 'grow', text: x.r.name }), h('span', { class: 'dim', text: x.note }))));
    paint();
    overlay('Update all', 640, h('div', { class: 'dim', text: 'Fetches each repository, then pulls the ones that are behind GitHub and have no uncommitted changes. Repositories that need a decision are skipped, not forced.' }), summary, listEl);
    const q = list.slice();
    const worker = async () => {
      while (q.length) {
        const r = q.shift();
        const x = res.get(r.path);
        x.state = 'working'; x.note = 'fetching'; paint();
        const result = await hub.repos.updateOne(r.path).catch((e) => ({ state: 'failed', note: e.message }));
        x.state = result.state || 'failed'; x.note = result.note || result.error || 'Update failed.';
        await refreshOne(r.path);
        paint();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const count = (k) => [...res.values()].filter((x) => x.state === k).length;
    summary.textContent = `Done: ${count('updated')} updated, ${count('current')} already up to date, ${count('skipped')} skipped, ${count('failed')} failed.`;
    updating = false;
    paintList();
    if (S.sel && (S.sel.type === 'grid' || S.sel.type === 'repo')) paintMain();
  }

  /* ---------- painting the right side ---------- */
  function paintMain() {
    if (!S.sel) {
      main.replaceChildren(h('div', { class: 'welcome' },
        h('h1', { text: 'RepoHub' }),
        h('p', { text: 'Paste a GitHub link above to see what a repository is, whether it is worth installing, and to install it in two steps.' }),
        h('p', { text: 'Pick a repository on the left to see its changes, commit and sync it, run it, or open Claude in it.' })));
      return;
    }
    if (S.sel.type === 'explore') paintExplore();
    else if (S.sel.type === 'sandbox') paintSandbox();
    else if (S.sel.type === 'sandboxes') showSandboxes();
    else if (S.sel.type === 'saved') paintSaved();
    else if (S.sel.type === 'compare') paintCompare();
    else if (S.sel.type === 'grid') paintGrid();
    else paintRepo();
  }

  /* ---------- job output ---------- */
  hub.job.onEvent((m) => {
    const prev = S.output.get(m.dir) || '';
    const next = (prev + m.text).slice(-300000);
    S.output.set(m.dir, next);
    const viewing = S.sel && S.sel.type === 'repo' && S.sel.path === m.dir && S.sel.tab === 'run';
    if (m.type === 'end') {
      S.running.delete(m.dir);
      const r = repoByPath(m.dir);
      toast(`${r ? r.name : 'Job'}: ${m.ok ? 'finished' : 'did not finish, see Output'}`, 6000, m.ok ? 'good' : 'bad');
      refreshOne(m.dir).then(() => { paintList(); if (S.sel && S.sel.path === m.dir) paintMain(); });
      return;
    }
    if (viewing) {
      const pre = $('console');
      if (pre) {
        const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = next;
        if (atEnd) pre.scrollTop = pre.scrollHeight;
      }
    }
  });

  /* ---------- wiring ---------- */
  $('explore-form').addEventListener('submit', (e) => { e.preventDefault(); explore($('explore-input').value); });
  $('explore-input').addEventListener('paste', () => setTimeout(() => { const v = $('explore-input').value.trim(); if (/github\.com\//i.test(v)) explore(v); }, 0));

  $('refresh-btn').addEventListener('click', refreshAll);
  $('fetch-btn').addEventListener('click', fetchAll);
  $('filter').addEventListener('input', (e) => { S.filter = e.target.value.trim().toLowerCase(); paintList(); });
  $('view').addEventListener('change', (e) => { S.view = e.target.value; paintList(); });
  $('more-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('more-menu');
    m.hidden = !m.hidden;
    // Placed under the button, wherever the button row wraps to.
    const b = $('more-btn'); m.style.top = `${b.offsetTop + b.offsetHeight + 4}px`;
  });
  document.addEventListener('click', (e) => { if (!$('more-menu').contains(e.target)) $('more-menu').hidden = true; });
  $('show-hidden').addEventListener('change', (e) => { S.showHidden = e.target.checked; refreshAll(); });
  $('more-menu').addEventListener('click', async (e) => {
    const act2 = e.target && e.target.dataset && e.target.dataset.act;
    if (!act2) return;
    $('more-menu').hidden = true;
    if (act2 === 'rescan') rescan();
    if (act2 === 'add') {
      const p = await hub.pickFolder('Choose a repository folder');
      if (!p || !p.ok) return;
      const res = await hub.repos.addFolder(p.path);
      if (!res || !res.ok) { fail(res); return; }
      await reloadList(); await refreshOne(p.path); openRepo(p.path);
    }
  });

  async function start() {
    const sr = await hub.settings.get().catch(() => null);
    if (sr && sr.ok) applySettings(sr.settings);
    hub.settings.onChanged((v) => { applySettings(v); if (settingsOpen()) renderSettings(); });
    if (IS_SETTINGS_WINDOW) {
      document.body.classList.add('settings-window');
      settingsSection = 'appearance';
      renderSettings();
      return;
    }
    hub.settings.onPopped((on) => { if (on) closeSettings(); });
    $('settings-btn').addEventListener('click', () => (settingsOpen() ? closeSettings() : openSettings()));
    $('palette-btn').addEventListener('click', openPalette);
    $('grid-btn').addEventListener('click', showGrid);
    $('update-btn').addEventListener('click', updateAll);
    const sortEl = $('sort');
    if (sortEl) { sortEl.replaceChildren(...SORTS.map(([v, l, short]) => h('option', { value: v, text: short, title: l }))); sortEl.value = S.sort; sortEl.addEventListener('change', (e) => setSort(e.target.value)); }
    wireSplitter($('side-split'), 'side');
    wireSplitter($('dock-split'), 'dock');
    applyLayout();
    paintMain();
    try { const cfg = await hub.repos.settings(); S.owner = (cfg && cfg.owner) || ''; } catch { /* default */ }
    const running = await hub.job.running().catch(() => null);
    for (const j of (running && running.jobs) || []) S.running.add(j.dir);
    refreshSandboxCount().catch(() => {});
    refreshAuth().catch(() => {});
    hub.auth.onChanged(() => refreshAuth());
    loadSaved().catch(() => {});
    $('saved-btn').addEventListener('click', showSaved);
    $('compare-btn').addEventListener('click', showCompare);
    $('auth-chip').addEventListener('click', () => openSettings('accounts'));
    $('sandboxes-btn').addEventListener('click', showSandboxes);
    const c = await hub.repos.cached().catch(() => null);
    if (c && c.ok && c.repos.length) { S.repos = c.repos; paintList(); loadCategories().catch(() => {}); await refreshAll(); } else await rescan();
    const sv = (S.settings || {}).startView;
    if (!S.sel) {
      if (sv === 'grid') showGrid();
      else if (sv === 'saved') showSaved();
      else if (sv === 'last' && S.settings.lastRepo && repoByPath(S.settings.lastRepo)) openRepo(S.settings.lastRepo);
    }
  }

  window.__repohub = { S, explore, openRepo, paintMain, md, facts: null };
  start().catch((e) => {
    $('main').replaceChildren(h('div', { class: 'warn-box' }, h('h2', { text: 'RepoHub could not finish starting' }), h('p', { text: String(e && e.message || e) }), h('p', { text: 'Press F5 to reload, Ctrl+Shift+R to relaunch, or F12 to see the error details.' })));
    console.error(e);
  });
})();
