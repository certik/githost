#!/usr/bin/env node
/**
 * githost-viewer — fast static git commit browser with GitHub-style diffs.
 *
 * Strategy: nothing is read at startup. Each request runs one `git log`/`git
 * show` for just the page being served, parses it and renders static HTML,
 * which is kept in a bounded LRU. Startup and resident memory are therefore
 * independent of repository size. `node server.mjs [repoPath]`
 *
 * Styling: serves GitHub's own CSS (vendor/*.css, downloaded from
 * github.githubassets.com) and uses GitHub's real class names / inline
 * styles, so fonts, colors and shapes match github.com exactly (light theme).
 */
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.argv[2] || '.');
const PORT = Number(process.env.PORT || 4173);

// ---------------------------------------------------------------- vendor css
// GitHub's CSS, in the exact load order used by github.com commit pages.
const VENDOR_CSS = [
  'light-99f877e9ddfc0e51.css',
  'primer-primitives-ed9ca172356fd545.css',
  'primer-1d2c7f7b52a6068b.css',
  'global-adcabba7b5c5d221.css',
  'github-552513ad07a183a1.css',
  'repository-11ee8a031c040c1a.css',
  'code-2d56bdb0166c0238.css',
  'u.d7bdfb98b5635c5f.module.css',
  'xj.896d0af1c7b8e036.module.css',
  '0.3cef67d68cba13e7.module.css',
  'k6.26a811c781d1fa5e.module.css',
  'bz.85e438ab2e9ac4b4.module.css',
  'dynamic-github-ui--commits--route-components.ac52cfc541ab09d5.module.css',
];
const vendorDir = path.join(__dirname, 'vendor');
const cssFiles = new Map(); // name -> content
for (const f of readdirSync(vendorDir)) {
  if (f.endsWith('.css')) cssFiles.set(f, readFileSync(path.join(vendorDir, f), 'utf8'));
}

// ---------------------------------------------------------------- git layer
// Nothing is preloaded. `git log` is asked only about the page actually being
// served, and rendered HTML is kept in a bounded LRU, so a 28k-commit
// repository with a multi-GB history costs the same at startup as a tiny one.

const PAGE_SIZE = 100;                     // commits per index page
const SHOW_MAXBUF = 512 * 1024 * 1024;     // hard ceiling for one commit's patch
const MAX_PATCH_BYTES = 64 * 1024 * 1024;  // above this we don't render a diff

function git(args, maxBuffer = 16 * 1024 * 1024) {
  const r = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer });
  if (r.error) return { ok: false, tooBig: r.error.code === 'ENOBUFS', out: '', err: String(r.error.message || r.error) };
  if (r.status !== 0) return { ok: false, tooBig: false, out: '', err: r.stderr || `git exited with ${r.status}` };
  return { ok: true, tooBig: false, out: r.stdout };
}

// %P = parent hashes (space separated; empty for root, >1 for merges)
const LOG_FMT = '\x01%H\t%h\t%an\t%ae\t%aI\t%P\t%s\x02%B';

// Split `git log` / `git show` output formatted with LOG_FMT into commits.
function parseRecords(out) {
  const commits = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\x01')) {
      if (cur) commits.push(cur);
      const parts = line.slice(1).split('\t');
      const [H, h, an, ae, aI, P] = parts;
      const rest = parts.slice(6).join('\t'); // subject may (rarely) contain tabs
      const sep = rest.indexOf('\x02');
      cur = { H, h, an, ae, aI, parents: P ? P.split(' ') : [], subject: rest.slice(0, sep), tail: rest.slice(sep + 1), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) commits.push(cur);

  for (const c of commits) {
    const body = [c.tail, ...c.lines].join('\n'); // full message + (blank line) + patch
    const di = body.indexOf('\n\ndiff --git ');
    // With no diff (a merge) `git show` pads the body with extra blank lines
    // that `git log -p` does not; normalise so both render the same.
    if (di === -1) { c.message = body.replace(/\n+$/, ''); c.patch = ''; }
    else { c.message = body.slice(0, di + 1); c.patch = body.slice(di + 2); }
    delete c.tail; delete c.lines;
    c.files = [];
  }
  return commits;
}

const headSha = () => { const r = git(['rev-parse', 'HEAD']); return r.ok ? r.out.trim() : ''; };
const commitCount = () => { const r = git(['rev-list', '--count', 'HEAD']); return r.ok ? Number(r.out.trim()) : 0; };

// One page of the commit list: metadata only, no patches.
function logPage(skip, n) {
  const r = git(['log', '--no-color', `--skip=${skip}`, '-n', String(n), `--format=${LOG_FMT}`], 64 * 1024 * 1024);
  return r.ok ? parseRecords(r.out) : [];
}

// Resolve a hash prefix / branch / tag the way git itself does.
function resolveRev(rev) {
  if (rev.startsWith('-') || !/^[0-9A-Za-z._/~^-]{1,120}$/.test(rev)) return null;
  const r = git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const sha = r.ok ? r.out.trim() : '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// One commit with its patch, parsed on demand.
function loadCommit(sha) {
  const r = git(['show', '--no-color', '-U3', `--format=${LOG_FMT}`, sha], SHOW_MAXBUF);
  if (!r.ok) {
    if (!r.tooBig) return null;
    const meta = git(['show', '--no-color', '--no-patch', `--format=${LOG_FMT}`, sha]);
    if (!meta.ok) return null;
    const c = parseRecords(meta.out)[0];
    if (c) c.patchTooBig = true;
    return c || null;
  }
  const c = parseRecords(r.out)[0];
  if (!c) return null;
  if (c.patch.length > MAX_PATCH_BYTES) c.patchTooBig = true;
  else c.files = parsePatch(c.patch);
  c.patch = ''; // the parsed form is what we render from
  return c;
}

const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? JSON.parse(s) : s);
const stripSide = (p) => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

function newFile(line) {
  const m = line.match(/^diff --git (.+) (.+)$/);
  return {
    oldPath: stripSide(unquote(m[1])),
    newPath: stripSide(unquote(m[2])),
    hunks: [], adds: 0, dels: 0, binary: false, renamed: false, modeOnly: false, status: 'M',
  };
}

// A single commit can carry a huge patch (vendored trees, generated code, an
// import of somebody else's tree). One diff row costs ~800 bytes of GitHub's
// markup, so an unbounded commit renders hundreds of MB nobody can read. Past
// these caps we keep the file list and drop the line detail, as GitHub does.
const MAX_DIFF_LINES = 20_000;       // diff lines rendered per commit
const MAX_LINES_PER_FILE = 5_000;    // diff lines rendered per file
const MAX_FILES = 300;               // files rendered per commit

function parsePatch(patch) {
  const files = [];
  if (!patch || !patch.trim()) return files;
  let f = null;
  let budget = MAX_DIFF_LINES;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = newFile(line);
      files.push(f);
      f.budget = files.length > MAX_FILES ? 0 : MAX_LINES_PER_FILE;
      continue;
    }
    if (!f) continue;
    if (line.startsWith('new file mode ')) { f.status = 'A'; continue; }
    if (line.startsWith('deleted file mode ')) { f.status = 'D'; continue; }
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) { f.modeOnly = true; continue; }
    if (line.startsWith('rename from ')) { f.oldPath = unquote(line.slice(12)); continue; }
    if (line.startsWith('rename to ')) { f.newPath = unquote(line.slice(10)); continue; }
    if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) { f.renamed = true; if (f.status === 'M') f.status = 'R'; continue; }
    if (line.startsWith('Binary files ')) { f.binary = true; continue; }
    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('\\ ')) { f.noNewline = true; continue; } // "\ No newline at end of file"
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (m) f.hunks.push({ oldStart: +m[1], newStart: +m[2], heading: m[3].trim(), lines: [] });
      continue;
    }
    const h = f.hunks[f.hunks.length - 1];
    if (!h) continue; // mode-only / binary: no hunks
    if (budget <= 0 || f.budget <= 0) {
      // Still count what we drop, so the +/- totals stay honest.
      f.truncated = true;
      if (line[0] === '+') f.adds++; else if (line[0] === '-') f.dels++;
      continue;
    }
    budget--; f.budget--;
    const t = line[0];
    if (t === '+') h.lines.push({ type: 'add', text: line.slice(1) });
    else if (t === '-') h.lines.push({ type: 'del', text: line.slice(1) });
    else if (t === ' ') h.lines.push({ type: 'ctx', text: line.slice(1) });
    // ignore stray lines (e.g. trailing empty from split)
  }

  for (const f of files) {
    for (const h of f.hunks) {
      let oldNo = h.oldStart, newNo = h.newStart;
      for (const l of h.lines) {
        if (l.type === 'ctx') { l.oldNo = oldNo++; l.newNo = newNo++; }
        else if (l.type === 'add') { l.newNo = newNo++; f.adds++; }
        else if (l.type === 'del') { l.oldNo = oldNo++; f.dels++; }
      }
      pairAndHighlight(h.lines);
    }
  }
  return files;
}

// ------------------------------------------------- word-level (char) diffing
// GitHub highlights the characters that actually changed inside a paired
// del/add line with <span class="x"> (darker red/green). We compute a
// character-level LCS per pair, after trimming common prefix/suffix.

const MAX_DIFF_CELLS = 1_000_000; // safety cap for pathological long lines

function charDiffHtml(a, b) {
  const alen = a.length, blen = b.length;
  let pre = 0;
  while (pre < alen && pre < blen && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
  let suf = 0;
  while (suf < alen - pre && suf < blen - pre && a.charCodeAt(alen - 1 - suf) === b.charCodeAt(blen - 1 - suf)) suf++;
  const am = a.slice(pre, alen - suf), bm = b.slice(pre, blen - suf);
  if (am.length === 0 && bm.length === 0) return null; // identical
  if (am.length * bm.length > MAX_DIFF_CELLS) return null; // too big: skip highlight

  const n = am.length, m = bm.length, W = m + 1;
  const dp = new Uint16Array((n + 1) * W); // LCS lengths, bottom-up
  for (let i = n - 1; i >= 0; i--) {
    const ach = am.charCodeAt(i);
    const row = i * W, nextRow = (i + 1) * W;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = ach === bm.charCodeAt(j) ? dp[nextRow + j + 1] + 1
        : (dp[nextRow + j] > dp[row + j + 1] ? dp[nextRow + j] : dp[row + j + 1]);
    }
  }

  // Backtrace: mark which middle chars are matched (0) vs changed (1).
  const aCh = new Uint8Array(n).fill(1), bCh = new Uint8Array(m).fill(1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (am.charCodeAt(i) === bm.charCodeAt(j)) { aCh[i] = 0; bCh[j] = 0; i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
    else j++;
  }

  const build = (s, marks) => {
    let out = '';
    for (let k = 0; k < s.length;) {
      let e = k + 1;
      while (e < s.length && marks[e] === marks[k]) e++;
      out = marks[k]
        ? out + `<span class="x x-first x-last">${esc(s.slice(k, e))}</span>`
        : out + esc(s.slice(k, e));
      k = e;
    }
    return out;
  };

  const aInner = esc(a.slice(0, pre)) + build(am, aCh) + (suf ? esc(a.slice(alen - suf)) : '');
  const bInner = esc(b.slice(0, pre)) + build(bm, bCh) + (suf ? esc(b.slice(blen - suf)) : '');
  return [aInner, bInner];
}

// Pair consecutive del/add runs in a hunk (like GitHub) and highlight.
function pairAndHighlight(lines) {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'del') { i++; continue; }
    const dels = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    const adds = [];
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    const k = Math.min(dels.length, adds.length);
    for (let p = 0; p < k; p++) {
      const r = charDiffHtml(dels[p].text, adds[p].text);
      if (r) { dels[p].html = r[0]; adds[p].html = r[1]; }
    }
  }
}

// ---------------------------------------------------------------- rendering

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const AVATAR_COLORS = ['#0969da', '#8250df', '#cf222e', '#1a7f37', '#bc4c00', '#953800', '#6639ba', '#1f2328'];
const avatarColor = (s) => AVATAR_COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

function relTime(iso) {
  const then = new Date(iso).getTime();
  const s = Math.max(1, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [sec, name] of units) if (s >= sec) { const n = Math.floor(s / sec); return `${n} ${name}${n > 1 ? 's' : ''} ago`; }
  return new Date(iso).toLocaleDateString();
}

const GH_MARK = `<svg data-component="Octicon" aria-hidden="true" focusable="false" class="octicon octicon-mark-github" viewBox="0 0 24 24" width="32" height="32" fill="currentColor" display="inline-block" overflow="visible" style="vertical-align:text-bottom"><path d="M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943"></path></svg>`;

let REPO_NAME = 'repo';

const LOCAL_CSS = `
/* local layout additions (GitHub's own CSS handles everything else) */
body { background-color: var(--bgColor-muted); }
.gh-topbar { background-color: var(--bgColor-default); border-bottom: 1px solid var(--borderColor-default); }
.gh-topbar a { color: var(--fgColor-default); text-decoration: none; }
.gh-topbar a:hover { color: var(--fgColor-accent); text-decoration: none; }
.gh-main { max-width: 1400px; margin: 0 auto; padding: 24px; }
.avatar { border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-weight: 600; flex: none; }
.commit-row { display: flex; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--borderColor-muted); align-items: flex-start; }
.commit-row:first-child { border-top: 0; }
.commit-subject a { color: var(--fgColor-default); font-weight: 600; text-decoration: none; word-break: break-word; }
.commit-subject a:hover { color: var(--fgColor-accent); text-decoration: underline; }
.commit-side .hash { color: var(--fgColor-muted); background-color: rgba(175,184,193,.2); padding: 2px 6px; border-radius: 6px; margin-left: 8px; text-decoration: none; }
.commit-side .hash:hover { color: var(--fgColor-accent); text-decoration: underline; }
.hash-chip { font-family: var(--fontStack-monospace); background-color: var(--bgColor-muted); border-radius: 6px; padding: .125rem .375rem; color: var(--fgColor-accent); text-decoration: none; cursor: pointer; }
.hash-chip:hover { background-color: var(--bgColor-neutral-muted); text-decoration: underline; }
`;

function pageShell(title, body) {
  const links = VENDOR_CSS.map((f) => `<link rel="stylesheet" href="/vendor/${f}">`).join('\n  ');
  return `<!DOCTYPE html>
<html lang="en" data-color-mode="light" data-light-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%2324292f' d='M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.3c-2.23.49-2.7-1.07-2.7-1.07-.36-.94-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.71 1.23 1.87.87 2.34.67.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z'/%3E%3C/svg%3E">
  ${links}
<style>${LOCAL_CSS}</style>
</head>
<body class="logged-out env-production page-responsive" style="word-wrap: break-word;">
<header class="gh-topbar">
  <div style="max-width:1400px;margin:0 auto;padding:0 24px;height:64px;display:flex;align-items:center;gap:8px">
    <a href="/">${GH_MARK}</a>
    <span style="font-weight:600;font-size:18px"><a href="/">${esc(REPO_NAME)}</a></span>
    <span class="color-fg-muted" style="font-size:14px">/ commits</span>
  </div>
</header>
<div class="gh-main">
${body}
</div>
</body>
</html>`;
}

function pager(page, pages) {
  if (pages <= 1) return '';
  const btn = (href, label, off) => off
    ? `<span class="btn btn-sm" style="pointer-events:none;opacity:.5">${label}</span>`
    : `<a class="btn btn-sm" href="${href}">${label}</a>`;
  return `<div class="d-flex flex-items-center flex-justify-center" style="gap:8px;margin-top:16px">
  ${btn('/?page=1', 'Newest', page === 1)}
  ${btn(`/?page=${page - 1}`, '&larr; Newer', page === 1)}
  <span class="color-fg-muted" style="font-size:14px;padding:0 4px">Page ${page} of ${pages}</span>
  ${btn(`/?page=${page + 1}`, 'Older &rarr;', page === pages)}
  ${btn(`/?page=${pages}`, 'Oldest', page === pages)}
</div>`;
}

function renderIndex(commits, page, pages, total) {
  const rows = commits.map((c) => `
<div class="commit-row">
  <span class="avatar" style="width:32px;height:32px;font-size:12px;background:${avatarColor(c.an)};margin-top:2px">${esc(initials(c.an))}</span>
  <div style="flex:1;min-width:0">
    <div class="commit-subject"><a href="/${c.H}">${esc(c.subject)}</a></div>
    <div class="color-fg-muted" style="font-size:12px;margin-top:2px">committed ${relTime(c.aI)}</div>
  </div>
  <div class="commit-side" style="text-align:right;font-size:12px;color:var(--fgColor-muted);white-space:nowrap;padding-top:2px">${esc(c.an)}<a class="hash" href="/${c.H}">${c.h}</a></div>
</div>`).join('');
  const shown = pages > 1 ? `${(page - 1) * PAGE_SIZE + 1}–${(page - 1) * PAGE_SIZE + commits.length} of ${total}` : `${total}`;
  return pageShell(`${REPO_NAME} · commits${pages > 1 ? ` · page ${page}` : ''}`, `
<div class="f4" style="font-weight:600;font-size:18px;margin-bottom:12px">Commits <span class="color-fg-muted" style="font-weight:400;font-size:14px">(${shown})</span></div>
<div class="Box">${rows}</div>${pager(page, pages)}`);
}

function diffRow(l) {
  if (l.type === 'ctx') {
    return `<tr class="diff-line-row"><td style="background-color:var(--bgColor-default);text-align:center" class="focusable-grid-cell diff-line-number position-relative diff-line-number-neutral left-side"><code>${l.oldNo}</code></td><td style="background-color:var(--bgColor-default);text-align:center" class="focusable-grid-cell diff-line-number position-relative diff-line-number-neutral left-side"><code>${l.newNo}</code></td><td style="background-color:var(--bgColor-default);padding-right:24px" class="focusable-grid-cell diff-text-cell right-side-diff-cell left-side"><code class="diff-text syntax-highlighted-line"><div class="diff-text-inner">${esc(l.text)}</div></code></td></tr>`;
  }
  const isAdd = l.type === 'add';
  const v = isAdd ? 'addition' : 'deletion';
  const numBg = `background-color:var(--diffBlob-${v}Num-bgColor, var(--diffBlob-${v}-bgColor-num));text-align:center`;
  const lineBg = `background-color:var(--diffBlob-${v}Line-bgColor, var(--diffBlob-${v}-bgColor-line));padding-right:24px`;
  const num1 = isAdd ? '' : `<code>${l.oldNo}</code>`;
  const num2 = isAdd ? `<code>${l.newNo}</code>` : '<code></code>';
  const side = isAdd ? 'right-side-diff-cell' : 'left-side-diff-cell border-right';
  const inner = l.html ?? esc(l.text);
  return `<tr class="diff-line-row"><td style="${numBg}" class="focusable-grid-cell diff-line-number position-relative left-side">${num1}</td><td style="${numBg}" class="focusable-grid-cell diff-line-number position-relative left-side">${num2}</td><td style="${lineBg}" class="focusable-grid-cell diff-text-cell ${side} left-side"><code class="diff-text syntax-highlighted-line ${v}"><span class="diff-text-marker">${isAdd ? '+' : '-'}</span><div class="diff-text-inner">${inner}</div></code></td></tr>`;
}

function renderFile(f) {
  const label = f.renamed ? `${esc(f.oldPath)} → ${esc(f.newPath)}` : esc(f.newPath);
  const badge = f.status === 'A' ? '<span class="f6 color-fg-muted" style="border:1px solid var(--borderColor-default);border-radius:6px;padding:0 6px;background:var(--bgColor-default)">new</span>'
    : f.status === 'D' ? '<span class="f6 color-fg-muted" style="border:1px solid var(--borderColor-default);border-radius:6px;padding:0 6px;background:var(--bgColor-default)">deleted</span>'
    : f.status === 'R' ? '<span class="f6 color-fg-muted" style="border:1px solid var(--borderColor-default);border-radius:6px;padding:0 6px;background:var(--bgColor-default)">renamed</span>'
    : '';
  let inner;
  if (f.binary) {
    inner = `<div class="color-fg-muted" style="padding:8px 16px;font-size:12px">Binary file${f.status === 'A' ? ' added' : f.status === 'D' ? ' deleted' : ''} — not shown.</div>`;
  } else if (!f.hunks.length) {
    inner = `<div class="color-fg-muted" style="padding:8px 16px;font-size:12px">No line changes (mode change only).</div>`;
  } else if (f.truncated && !f.adds && !f.dels) {
    inner = `<div class="color-fg-muted" style="padding:8px 16px;font-size:12px">Large diff not rendered.</div>`;
  } else {
    const rows = [];
    for (const h of f.hunks) {
      rows.push(`<tr class="diff-line-row"><td style="background-color:var(--bgColor-accent-muted, var(--color-accent-subtle));flex-grow:1" class="focusable-grid-cell diff-hunk-cell left-side" colSpan="4"><div class="d-flex flex-row"><code class="diff-text-cell hunk"><div class="diff-text-inner color-fg-muted">@@ -${h.oldStart} +${h.newStart}${h.heading ? ' @@ ' + esc(h.heading) : ''}</div></code></div></td></tr>`);
      for (const l of h.lines) rows.push(diffRow(l));
    }
    if (f.truncated) rows.push(`<tr class="diff-line-row"><td class="focusable-grid-cell diff-hunk-cell left-side" colSpan="4"><div class="color-fg-muted" style="padding:8px 16px;font-size:12px">Diff truncated — the rest of this file's changes are not rendered.</div></td></tr>`);
    inner = `<table aria-label="Diff for: ${esc(f.newPath)}" class="tab-size width-full DiffLines-module__tableLayoutFixed__eh13Y" data-tab-size="4" style="--line-number-cell-width:40px;--line-number-cell-width-unified:80px"><colgroup><col width="40"/><col width="40"/><col width="100%"/></colgroup><tbody>${rows.join('')}</tbody></table>`;
  }
  const stats = (f.adds || f.dels) ? `<span class="f6 fgColor-success text-bold">+${f.adds}</span><span class="f6 fgColor-danger text-bold" style="margin-left:8px">-${f.dels}</span>` : '';
  return `<div class="DiffFileHeader-module__diff-file-header__UuNN4">
  <div class="d-flex px-1 flex-items-center overflow-hidden DiffFileHeader-module__file-path-section__ZcmB1">
    <h3 class="DiffFileHeader-module__file-name__VVXpg" style="margin:0"><code>${label}</code> ${badge}</h3>
  </div>
  <div class="d-flex flex-row flex-justify-end flex-items-center gap-2">${stats}</div>
</div>
<div class="border position-relative rounded-bottom-2" style="margin-bottom:16px">${inner}</div>`;
}

function renderCommit(c) {
  const filesHtml = c.files.length ? c.files.map(renderFile).join('')
    : `<div class="Box color-fg-muted" style="padding:24px 16px;font-size:14px">${c.patchTooBig
      ? `This commit's diff is too large to render. Use <code>git show ${c.h}</code>.`
      : 'No changes shown for this commit (merge or empty).'}</div>`;
  const parentsHtml = c.parents.length ? `
    <div class="color-fg-muted d-flex flex-items-center" style="gap:6px;margin-top:10px;font-size:14px">
      <span>${c.parents.length > 1 ? 'parents' : 'parent'}</span>
      ${c.parents.map((p) => `<a class="hash-chip" href="/${p}" title="${p}">${p.slice(0, 7)}</a>`).join(' ')}
    </div>` : '';
  const body = `
<a href="/" style="color:var(--fgColor-accent);text-decoration:none;font-size:14px;display:inline-block;margin-bottom:16px">&larr; All commits</a>
<div style="padding:8px 0 16px">
  <h1 class="f2" style="font-size:24px;font-weight:600;margin:0">Commit <span class="text-mono bgColor-muted rounded p-1" style="font-size:20px">${c.h}</span></h1>
  <div class="color-fg-muted d-flex flex-items-center" style="gap:8px;margin-top:10px;font-size:14px;flex-wrap:wrap">
    <span class="avatar" style="width:20px;height:20px;font-size:9px;background:${avatarColor(c.an)}">${esc(initials(c.an))}</span>
    <strong style="color:var(--fgColor-default)">${esc(c.an)}</strong>
    <span class="pl-1">committed</span>
    <span title="${esc(c.aI)}">${relTime(c.aI)}</span>
  </div>
  ${parentsHtml}
</div>
${c.message.trim() !== c.subject ? `<div class="color-bg-default border rounded-2 color-border-default" style="margin-bottom:16px"><span class="ws-pre-wrap f5 wb-break-word text-mono" style="display:block;padding:12px 16px">${esc(c.message)}</span></div>` : ''}
<div class="f4" style="font-weight:600;font-size:16px;margin:24px 0 8px">Files changed <span class="color-fg-muted" style="font-weight:400;font-size:14px">(${c.files.length})</span></div>
${filesHtml}`;
  return pageShell(`${c.subject} · ${REPO_NAME}`, body);
}

// ---------------------------------------------------------------- serve

const t0 = Date.now();
REPO_NAME = path.basename(REPO);
if (!git(['rev-parse', '--git-dir']).ok) {
  console.error(`githost-viewer: ${REPO} is not a git repository`);
  process.exit(1);
}

// Bounded LRU of rendered pages. Nothing is pre-rendered, so resident memory
// stays flat no matter how large the repository or an individual commit is.
const CACHE_MAX_ENTRIES = 200;
const CACHE_MAX_BYTES = 128 * 1024 * 1024;
const cache = new Map(); // key -> html, iterated in least-recently-used order
let cacheBytes = 0;

function cacheGet(key) {
  const html = cache.get(key);
  if (html === undefined) return null;
  cache.delete(key); cache.set(key, html); // refresh recency
  return html;
}

function cachePut(key, html) {
  const old = cache.get(key);
  if (old !== undefined) { cacheBytes -= old.length; cache.delete(key); }
  cache.set(key, html); cacheBytes += html.length;
  while (cache.size > 1 && (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES)) {
    const oldest = cache.keys().next().value;
    cacheBytes -= cache.get(oldest).length;
    cache.delete(oldest);
  }
  return html;
}

let cachedHead = headSha();

function indexPage(want) {
  const head = headSha();
  if (head !== cachedHead) { cache.clear(); cacheBytes = 0; cachedHead = head; } // history moved
  const total = commitCount();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, want), pages);
  const hit = cacheGet(`i:${page}`);
  if (hit) return hit;
  return cachePut(`i:${page}`, renderIndex(logPage((page - 1) * PAGE_SIZE, PAGE_SIZE), page, pages, total));
}

function commitPage(rev) {
  const sha = resolveRev(rev);
  if (!sha) return null;
  const hit = cacheGet(`c:${sha}`);
  if (hit) return hit;
  const c = loadCommit(sha);
  return c ? cachePut(`c:${sha}`, renderCommit(c)) : null;
}

console.log(`githost-viewer: ${REPO_NAME}, ${commitCount()} commits, rendered on demand (ready in ${Date.now() - t0}ms)`);

const server = createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('bad request'); }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('bad request'); }
  p = p.replace(/\/+$/, '') || '/';

  if (p.startsWith('/vendor/')) {
    const css = cssFiles.get(p.slice(8));
    if (css) { res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=86400' }); return res.end(css); }
    res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found');
  }

  let html = null;
  if (p === '/') html = indexPage(Number(url.searchParams.get('page')) || 1);
  else html = commitPage(p.slice(1));

  if (html === null) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
});

server.listen(PORT, () => console.log(`serving ${REPO} at http://localhost:${PORT}/`));
