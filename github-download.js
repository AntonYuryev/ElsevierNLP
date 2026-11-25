/**
 * github-download.js
 * Downloads the NLPmanager repo from GitHub to the current directory.
 * No git installation required — uses only Node.js built-ins.
 *
 * Usage (run from the folder where you want NLPmanager placed):
 *   node github-download.js
 *
 * The script will create a subfolder called NLPmanager/ and write all files into it.
 * Re-running it fetches only the files that changed on GitHub (compared by git blob SHA); files you edited here are kept
 * (use --force to overwrite them).
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
// The personal access token is read from GithubToken.txt next to this script (first non-empty line); the file is not part of the repo,
// so create it by hand on every computer.
const TOKEN = (() => {
  const f = path.join(__dirname, 'GithubToken.txt');
  let t = '';
  try { t = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#')) || ''; } catch { /* reported below */ }
  if (!t) { console.error(`GitHub token not found. Put it (just the token, one line) in ${f}`); process.exit(1); }
  return t;
})();
const OWNER  = 'AntonYuryev';
const REPO   = 'ElsevierNLP';
// If run from inside an existing NLPmanager folder, update it in place.
// Otherwise create a new NLPmanager subfolder next to the script.
const isInsideRepo = fs.existsSync(path.join(__dirname, 'app', 'src'));
const DEST = isInsideRepo ? __dirname : path.join(__dirname, REPO);

// ── GitHub API helper ─────────────────────────────────────────────────────────
function apiRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path:     apiPath,
      method:   'GET',
      headers: {
        'Authorization': `token ${TOKEN}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'NLPmanager-download/1.0',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try   { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Recursively list all files in the repo via the Trees API ─────────────────
async function getFileTree() {
  // Get default branch SHA
  const repoRes = await apiRequest(`/repos/${OWNER}/${REPO}`);
  if (repoRes.status !== 200) {
    throw new Error(`Failed to fetch repo info: ${repoRes.status} ${repoRes.body?.message || ''}`);
  }
  const defaultBranch = repoRes.body.default_branch || 'main';

  // Get tree (recursive = flat list of all files)
  const treeRes = await apiRequest(
    `/repos/${OWNER}/${REPO}/git/trees/${defaultBranch}?recursive=1`
  );
  if (treeRes.status !== 200) {
    throw new Error(`Failed to fetch tree: ${treeRes.status} ${treeRes.body?.message || ''}`);
  }
  if (treeRes.body.truncated) {
    console.warn('  ⚠ Tree was truncated by GitHub (repo too large) — some files may be missing.');
  }

  // Return only blob (file) entries
  return treeRes.body.tree.filter(e => e.type === 'blob');
}

// ── Download a single file by its blob SHA ───────────────────────────────────
function downloadBlob(sha) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path:     `/repos/${OWNER}/${REPO}/git/blobs/${sha}`,
      method:   'GET',
      headers: {
        'Authorization': `token ${TOKEN}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'NLPmanager-download/1.0',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (json.encoding === 'base64') {
            resolve(Buffer.from(json.content.replace(/\n/g, ''), 'base64'));
          } else {
            resolve(Buffer.from(json.content));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Ensure a directory exists (mkdir -p) ─────────────────────────────────────
function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Git blob SHA of a file's bytes (the same hash GitHub stores) ──────────────
function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

// ── Sync state: the SHA every file had at the last upload / download ──────────
// { "<repo path>": "<blob sha>" } in .github-sync.json in the NLPmanager folder (shared with github-upload.js).
// It tells "changed here" from "changed on GitHub" since the last sync.
const STATE_FILE = path.join(DEST, '.github-sync.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const force = process.argv.includes('--force');     // also overwrite files that were changed here since the last sync
  console.log(`Downloading ${OWNER}/${REPO} → ${DEST}\n`);

  mkdirp(DEST);

  // 1. Get full file list (with the blob SHA of every file)
  console.log('Fetching file list…');
  let files;
  try { files = await getFileTree(); }
  catch (e) { console.error('  Error:', e.message); process.exit(1); }
  console.log(`Found ${files.length} files.\n`);

  // 2. Compare with the local files and with the last sync: download only what changed on GitHub
  const state = loadState();
  const todo = [], unchanged = [], keptLocal = [], conflicts = [];
  for (const f of files) {
    const destFile = path.join(DEST, ...f.path.split('/'));
    f.destFile = destFile;
    let local = null;
    try { local = gitBlobSha(fs.readFileSync(destFile)); } catch { /* not there yet */ }
    if (local === f.sha) { unchanged.push(f); continue; }
    if (local !== null && !force && state[f.path] !== undefined && local !== state[f.path]) {
      // edited here since the last sync: never overwrite silently
      if (f.sha === state[f.path]) keptLocal.push(f);       // GitHub unchanged → the local version is the newer one
      else conflicts.push(f);                               // changed here AND on GitHub
      continue;
    }
    todo.push(f);
  }
  console.log(`${todo.length} to download (${todo.filter(f => !fs.existsSync(f.destFile)).length} new), ${unchanged.length} unchanged` +
    `${keptLocal.length ? `, ${keptLocal.length} edited here (kept)` : ''}${conflicts.length ? `, ${conflicts.length} changed here and on GitHub (skipped)` : ''}.\n`);
  for (const f of keptLocal) console.log(`  KEPT LOCAL: ${f.path} — edited here since the last sync, GitHub has no newer version (upload it)`);
  for (const f of conflicts) console.log(`  CONFLICT:   ${f.path} — changed here and on GitHub since the last sync; run with --force to overwrite the local file`);

  // 3. Download the changed files
  let ok = 0, fail = 0;
  const got = [];                                        // [{ path, isNew }] — listed at the end
  for (let i = 0; i < todo.length; i++) {
    const { path: relPath, sha, destFile } = todo[i];
    const isNew = !fs.existsSync(destFile);

    const tryDownload = async () => {
      const buf = await downloadBlob(sha);
      mkdirp(path.dirname(destFile));
      fs.writeFileSync(destFile, buf);
    };

    try {
      await tryDownload();
      ok++; got.push({ path: relPath, isNew });
      state[relPath] = sha;
      process.stdout.write(`\r  [${i+1}/${todo.length}] ${relPath.padEnd(70).substring(0, 70)}`);
    } catch (e) {
      // Retry once after a short pause
      await new Promise(r => setTimeout(r, 2000));
      try {
        await tryDownload();
        ok++; got.push({ path: relPath, isNew });
        state[relPath] = sha;
        process.stdout.write(`\r  [${i+1}/${todo.length}] ${relPath.padEnd(70).substring(0, 70)}`);
      } catch (e2) {
        fail++;
        console.log(`\n  FAILED: ${relPath} — ${e2.message}`);
      }
    }

    // Stay within GitHub rate limit
    await new Promise(r => setTimeout(r, 150));
  }
  for (const f of unchanged) state[f.path] = f.sha;      // identical on both sides: that is the new common state
  saveState(state);

  console.log('\n');
  if (got.length) {
    console.log(`Downloaded ${got.length} file${got.length === 1 ? '' : 's'}:`);
    for (const g of got) console.log(`  ${g.isNew ? 'new     ' : 'updated '} ${g.path}`);
  } else console.log('No file was downloaded — everything is up to date.');
  console.log(`\n✓ Done — ${ok} downloaded, ${unchanged.length} unchanged (not fetched), ${keptLocal.length} kept (edited here), ${conflicts.length} conflicts, ${fail} failed.`);
  console.log(`  Files are in: ${DEST}`);
  if (ok > 0 && !isInsideRepo || todo.some(f => /(^|\/)package\.json$/.test(f.path))) {
    console.log('\nNext steps:');
    console.log('  1. cd NLPmanager\\app');
    console.log('  2. npm install');
    console.log('  3. If Electron fails to start, install the binary manually:');
    console.log('       a. Download electron-v28.3.3-win32-x64.zip from');
    console.log('          https://github.com/electron/electron/releases/tag/v28.3.3');
    console.log('       b. Extract the zip into node_modules\\electron\\dist\\');
    console.log('          (so that electron.exe is at node_modules\\electron\\dist\\electron.exe)');
    console.log('       c. Set path.txt: echo|set /p="electron.exe" > node_modules\\electron\\path.txt');
    console.log('  4. npm run dev');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
