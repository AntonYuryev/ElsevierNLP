const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const os   = require('os');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const zlib = require('zlib');
const https = require('https');
const http  = require('http');
const llmTriple = require('./llmTriple');
const centree = require('./centree');

// Shared tokenizer — single source of truth for all alias tokenization.
// src/shared/tokenizer.js is an ES module (src/shared/package.json has "type":"module").
// CJS main.js loads it via dynamic import(), cached after first call.
const { pathToFileURL } = require('url');
let _tokCache = null;
async function _tok() {
  if (!_tokCache) {
    _tokCache = await import(pathToFileURL(path.join(__dirname, '../shared/tokenizer.js')).href);
  }
  return _tokCache;
}

// src/shared/entityTypes.js (an ES module as well) holds THE table of MedScan ID ranges (rangeOf('Virus') …); loaded the same way.
let _entCache = null;
async function _ent() {
  if (!_entCache) _entCache = await import(pathToFileURL(path.join(__dirname, '../shared/entityTypes.js')).href);
  return _entCache;
}

const isDev = process.env.NODE_ENV === 'development';

// ── Global crash diagnostics ──────────────────────────────────────────────────
// Write crash details to a log file so we can see what killed the process
// even if the window is gone before the error can be sent via IPC.
const crashLogPath = path.join(app.getPath('userData'), 'crash.log');
function writeCrashLog(type, err) {
  const line = `[${new Date().toISOString()}] ${type}: ${err?.stack || err}\n`;
  try { fs.appendFileSync(crashLogPath, line); } catch {}
}
process.on('uncaughtException',    (err) => { writeCrashLog('uncaughtException',    err); });
process.on('unhandledRejection',   (err) => { writeCrashLog('unhandledRejection',   err); });

// ── Single-instance lock ──────────────────────────────────────────────────────
// If a second instance is launched (e.g. by running the VBS again), focus the
// existing window and exit the new instance immediately.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Note: --max-old-space-size=8192 is passed via the electron launch command in package.json.

// ── Tables included in every database backup / restore ───────────────────────
// IMPORTANT: if you add a new table to schema.sql that holds user data,
// add it here too — otherwise it will be silently omitted from backups.
const TABLES_FOR_BACKUP = [
  // Core dictionary tables (entity aliases)
  'objectnames',
  'curnames', 'exactliteral', 'celldictionary', 'casdictionary',
  'chemnames', 'keywords', 'userdict', 'combnames', 'rsmap',
  // Exclusion-word tables (xwords)
  'xwords', 'xwords_cells', 'xwords_cas', 'xwords_comb',
  // Other service tables
  'spelling', 'bracketstop', 'proteinclasses', 'ontology',
  // Configuration
  'entity_types',
];

// ── Embedded PostgreSQL constants ────────────────────────────────────────────
const PG_PORT     = 5433;
const PG_USER     = 'nlpmanager';
const PG_PASSWORD = 'nlpmanager_internal';
const PG_DATABASE = 'nlpmanager';

let embeddedPg = null;

async function startEmbeddedPostgres() {
  // dynamic import because embedded-postgres ships as ESM
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const dataDir = path.join(app.getPath('userData'), 'pg-data');
  console.log('[EmbeddedPG] Data directory:', dataDir);

  embeddedPg = new EmbeddedPostgres({
    databaseDir:  dataDir,
    user:         PG_USER,
    password:     PG_PASSWORD,
    port:         PG_PORT,
    persistent:   true,
    initdbFlags:  ['--encoding=UTF8', '--locale=C'],  // force UTF-8 cluster
  });

  // Only initialise (run initdb) if the cluster doesn't exist yet
  const pgVersionFile = path.join(dataDir, 'PG_VERSION');
  if (!fs.existsSync(pgVersionFile)) {
    await embeddedPg.initialise();
  }

  // With persistent:true the server keeps running after the app closes.
  // On next launch, probe the port first — if it answers, reuse the running instance
  // instead of trying to start a second one (which causes "shared memory already in use").
  const { Client } = require('pg');
  let alreadyRunning = false;
  {
    const probe = new Client({
      host: 'localhost', port: PG_PORT, database: 'postgres',
      user: PG_USER, password: PG_PASSWORD,
      connectionTimeoutMillis: 2000,
    });
    try {
      await probe.connect();
      await probe.end();
      alreadyRunning = true;
      console.log('[EmbeddedPG] PostgreSQL already running on port', PG_PORT, '— reusing.');
    } catch {
      alreadyRunning = false;
    }
  }

  if (!alreadyRunning) {
    // Remove stale postmaster.pid so postgres doesn't think a peer is running
    const pidFile = path.join(dataDir, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch {}
      console.log('[EmbeddedPG] Removed stale postmaster.pid');
    }

    // Kill any orphaned postgres.exe processes that may still hold shared memory
    // (they don't accept connections, so alreadyRunning is false, but they block startup)
    if (process.platform === 'win32') {
      try {
        require('child_process').execSync('taskkill /F /IM postgres.exe /T 2>nul', { stdio: 'ignore' });
        console.log('[EmbeddedPG] Killed orphaned postgres.exe processes');
        await new Promise(r => setTimeout(r, 1000)); // wait for OS to release shared memory
      } catch { /* no postgres.exe running — that's fine */ }
    } else {
      try {
        require('child_process').execSync(`pkill -f "postgres.*${PG_PORT}" 2>/dev/null || true`, { stdio: 'ignore' });
        await new Promise(r => setTimeout(r, 500));
      } catch { /* ignore */ }
    }

    await embeddedPg.start();
    console.log('[EmbeddedPG] Server started on port', PG_PORT);
  }

  // Create the application database (no-op if it already exists)
  const adminClient = new Client({
    host: 'localhost', port: PG_PORT,
    database: 'postgres',
    user: PG_USER, password: PG_PASSWORD,
  });
  await adminClient.connect();
  const exists = await adminClient.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`, [PG_DATABASE]
  );
  if (exists.rows.length === 0) {
    await adminClient.query(`CREATE DATABASE ${PG_DATABASE}`);
    console.log('[EmbeddedPG] Created database:', PG_DATABASE);
  }
  await adminClient.end();

  // Run schema (CREATE TABLE IF NOT EXISTS — idempotent)
  const schemaFile = app.isPackaged
    ? path.join(process.resourcesPath, 'db', 'schema.sql')
    : path.join(__dirname, '../../db/schema.sql');
  const schemaSql = fs.readFileSync(schemaFile, 'utf8');

  // Connect to the app database and apply schema
  const { Pool } = require('pg');
  pgPool = new Pool({
    host: 'localhost', port: PG_PORT,
    database: PG_DATABASE,
    user: PG_USER, password: PG_PASSWORD,
  });
  // Prevent uncaught ECONNRESET / idle-client errors from crashing the main process
  pgPool.on('error', (err) => {
    console.error('[PgPool] Idle client error:', err.message);
  });
  await pgPool.query(schemaSql);
  console.log('[EmbeddedPG] Schema applied to', PG_DATABASE);

  // Tune WAL settings to avoid frequent checkpoint warnings.
  // ALTER SYSTEM writes to postgresql.auto.conf and persists across restarts.
  try {
    await pgPool.query(`ALTER SYSTEM SET max_wal_size = '4GB'`);
    await pgPool.query(`ALTER SYSTEM SET checkpoint_completion_target = '0.9'`);
    await pgPool.query(`SELECT pg_reload_conf()`);
    console.log('[EmbeddedPG] WAL tuning applied (max_wal_size=4GB, checkpoint_completion_target=0.9)');
  } catch (e) {
    console.warn('[EmbeddedPG] WAL tuning failed (non-fatal):', e.message);
  }
}

// Lazy-load electron-store
let Store;
let store;
function getStore() {
  if (!store) {
    Store = require('electron-store');
    store = new Store({
      schema: {
        medscanLicense: { type: 'string', default: '' },
        medscanDir: { type: 'string', default: '' },
        userDict:      { type: 'string', default: '' },
        bwFilter:      { type: 'string', default: '' },
        lastInputDir:  { type: 'string', default: '' },
        lastOutputDir: { type: 'string', default: '' },
        lastRestoreDir: { type: 'string', default: '' },      // folder of the last database backup file chosen for "Restore"
      },
    });
  }
  return store;
}

let mainWindow;

// ── ObjectNames URN→MedscanID cache ─────────────────────────────────────────
// Loaded asynchronously from xfdata/*.ObjectNames.tab in every cartridge under
// medscanDir.  The result is cached as a resolved Promise so subsequent callers
// await the same work rather than re-reading the files.
let urnMapCachePromise = null; // Promise<Map<urn,id>> | null
let urnMapCacheDir     = null;

// Start (or return cached) background load.  Always returns a Promise<Map>.
function loadUrnMap(medscanDir) {
  if (!medscanDir) return Promise.resolve(new Map());
  if (urnMapCachePromise && urnMapCacheDir === medscanDir) return urnMapCachePromise;

  urnMapCacheDir     = medscanDir;
  urnMapCachePromise = (async () => {
    const map = new Map();
    try {
      const entries = fs.readdirSync(medscanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const xfdata = path.join(medscanDir, entry.name, 'xfdata');
        let tabFiles;
        try { tabFiles = fs.readdirSync(xfdata); } catch { continue; }
        for (const tab of tabFiles) {
          if (!tab.endsWith('.ObjectNames.tab')) continue;
          // Async read — does not block the main-process event loop
          const content = await fs.promises.readFile(path.join(xfdata, tab), 'utf8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const cols = lines[i].trimEnd().split('\t');
            if (cols.length < 3) continue;
            const id = cols[0].trim();
            // Decode URL-encoding to match what RNEF XML xmlDecode produces.
            const urn = cols[2].trim()
              .replace(/%20/g, ' ').replace(/%2c/gi, ',')
              .replace(/%28/gi, '(').replace(/%29/gi, ')')
              .replace(/%3a/gi, ':').replace(/%2f/gi, '/');
            if (id && urn && !map.has(urn)) map.set(urn, id);
            // Yield to the event loop every 50 000 lines so the UI stays responsive
            if (i % 50000 === 0) await new Promise(r => setImmediate(r));
          }
        }
      }
    } catch { /* medscanDir unreadable */ }
    console.log(`[URN map] Loaded ${map.size} decoded URN→MedscanID entries from ${medscanDir}`);
    return map;
  })();

  return urnMapCachePromise;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // right-click menu: spelling suggestions for a misspelled word (Chromium's spell-checker only underlines it), Cut / Copy / Paste
  // Find in page (Ctrl+F, like a browser): the key is taken here so it works wherever the focus is (also inside a document frame of the Reader); the page — frames included — is searched by Chromium
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && !input.alt && !input.shift && String(input.key).toLowerCase() === 'f') { e.preventDefault(); try { mainWindow.webContents.send('find:open'); } catch (_) {} return; }
    // while the find bar is open (and the focus is not in another text box — the bar says so, see find:keys): Enter = next match, Shift+Enter = previous, Esc = close.
    // Taken here because Chromium moves the focus into the page when it finds something, and the text box must not take it back (that moves the start of the next search to the box itself)
    if (findKeys && input.type === 'keyDown' && !input.control && !input.alt && !input.meta) {
      if (input.key === 'Enter') { e.preventDefault(); findStep(!input.shift); }
      else if (input.key === 'Escape') { e.preventDefault(); try { mainWindow.webContents.send('find:close'); } catch (_) {} }
    }
  });
  mainWindow.webContents.on('found-in-page', (_e, r) => { try { mainWindow.webContents.send('find:result', { active: r.activeMatchOrdinal, matches: r.matches, final: r.finalUpdate }); } catch (_) {} });
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const wc = mainWindow.webContents;
    const items = [];
    if (params.misspelledWord) {
      for (const w of params.dictionarySuggestions || []) items.push({ label: w, click: () => wc.replaceMisspelling(w) });
      if (!items.length) items.push({ label: 'No spelling suggestions', enabled: false });
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: 'separator' });
    }
    if (params.isEditable) items.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  if (isDev) {
    // 127.0.0.1, not "localhost": Chromium may try ::1 first while the Vite dev server listens on IPv4 only -> ERR_CONNECTION_REFUSED and a white window (seen with Node 26).
    // A failed load (the dev server is still starting) is retried.
    let tries = 0;
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain && /127.0.0.1:5173/.test(url) && tries++ < 60) setTimeout(() => { if (!mainWindow.isDestroyed()) mainWindow.loadURL('http://127.0.0.1:5173'); }, 1000);
    });
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  try {
    await startEmbeddedPostgres();
    // Apply schema (idempotent — CREATE TABLE IF NOT EXISTS) and ensure
    // organisms_lookup is populated. Runs in the background after window opens.
    const _pool = await getPool();
    const schemaFile = app.isPackaged
      ? path.join(process.resourcesPath, 'db', 'schema.sql')
      : path.join(__dirname, '../../db/schema.sql');
    _pool.query(fs.readFileSync(schemaFile, 'utf8'))
      .then(async () => {
        const [orgRes, matchRes, cartRes] = await Promise.all([
          _pool.query('SELECT COUNT(*) AS c FROM organisms_lookup'),
          _pool.query('SELECT COUNT(*) AS c FROM match_opts_lookup'),
          _pool.query('SELECT COUNT(*) AS c FROM cartridges_lookup'),
        ]);
        const needOrg   = Number(orgRes.rows[0].c)   === 0;
        const needMatch = Number(matchRes.rows[0].c)  === 0;
        const needCart  = Number(cartRes.rows[0].c)   === 0;
        if (needOrg || needMatch || needCart) {
          console.log('[Startup] Populating lookup tables for the first time…');
          if (needOrg)   await rebuildOrganismsLookup(_pool);
          if (needMatch) await rebuildMatchOptsLookup(_pool);
          if (needCart)  await rebuildCartridgesLookup(_pool);
          console.log('[Startup] Lookup tables populated.');
        }
      })
      .catch(e => console.warn('[Startup] Schema/lookup init failed:', e.message));
  } catch (e) {
    console.error('[EmbeddedPG] Startup failed:', e?.message || e || '(no error message)');
    // Still open the window — DB errors will surface as query errors
  }
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => { refreshLocalLlm().then(autoConnectTunnel).catch(() => {}); });   // is the local LLM port open? which models?
  // Deploy HTML converter to all cartridges in the configured MEDSCAN directory
  try { deployHtmlConverter(getStore().get('medscanDir')); } catch {}
  // Pre-warm URN map in the background so rnef:parse and pipeline:getUrnEntries
  // respond instantly when the user first needs them.
  const _medscanDirForWarmup = getStore().get('medscanDir');
  if (_medscanDirForWarmup) loadUrnMap(_medscanDirForWarmup).catch(() => {});
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

app.on('before-quit', (event) => {
  llmTriple.stopTunnel();                                            // the SSH tunnel must not outlive the app
  if (!embeddedPg) return;
  // Prevent Electron from quitting until the embedded PostgreSQL is stopped.
  // Without this the PG child process orphans and keeps the Node process alive.
  event.preventDefault();
  const pg = embeddedPg;
  embeddedPg = null;

  const doStop = async () => {
    // CHECKPOINT flushes all dirty buffers to disk before stopping.
    // Without it, PG must replay WAL on next startup (slow, noisy logs).
    if (pgPool) {
      try {
        await Promise.race([
          pgPool.query('CHECKPOINT'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        console.log('[EmbeddedPG] Checkpoint complete.');
      } catch (e) {
        console.warn('[EmbeddedPG] Checkpoint skipped:', e.message);
      }
      try { await pgPool.end(); } catch {}
      pgPool = null;
    }
    // Stop PG with a 15-second timeout — if it hangs, force exit anyway.
    await Promise.race([
      pg.stop(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('stop timeout')), 15000)),
    ]).then(
      () => console.log('[EmbeddedPG] Stopped.'),
      (e) => console.warn('[EmbeddedPG] Stop issue:', e.message),
    );
  };

  doStop().finally(() => {
    // Kill the parent npm/cmd.exe process tree that the VBS launched us inside.
    // Without this, those processes orphan and accumulate in Task Manager across
    // every app open/close cycle.
    if (process.platform === 'win32' && process.ppid) {
      try {
        // Detached so taskkill survives app.exit(0) killing our own process.
        const tk = spawn('taskkill', ['/F', '/T', '/PID', String(process.ppid)],
          { detached: true, stdio: 'ignore' });
        tk.unref();
      } catch {}
    }
    app.exit(0);
  });
});

// ── HTML converter deployment ─────────────────────────────────────────────────
// Patches every locscan.ini under medscanDir with HTMLTXT abbreviation and
// htmltext:/htmltextfiles: input entries, and copies htmltext.py + htmltext.bat.
// Uses section-based insertion so it works regardless of exact ini content.
// Returns { patched: [...], skipped: [...], errors: [...] }
function deployHtmlConverter(medscanDir) {
  const result = { patched: [], skipped: [], errors: [] };
  if (!medscanDir) return result;

  const htmltextSrc = path.join(app.getAppPath(), '..', 'htmltext.py');
  if (!fs.existsSync(htmltextSrc)) {
    result.errors.push(`htmltext.py not found at ${htmltextSrc}`);
    return result;
  }

  let binDirs;
  try {
    binDirs = fs.readdirSync(medscanDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.endsWith('.bin'))
      .map(e => path.join(medscanDir, e.name));
  } catch (e) {
    result.errors.push(`Cannot read medscanDir: ${e.message}`);
    return result;
  }

  for (const binDir of binDirs) {
    // Copy htmltext.py
    try { fs.copyFileSync(htmltextSrc, path.join(binDir, 'htmltext.py')); } catch {}
    // Create htmltext.bat wrapper
    try { fs.writeFileSync(path.join(binDir, 'htmltext.bat'), '@py "%~dp0htmltext.py" %*\n', 'utf8'); } catch {}

    const iniPath = path.join(binDir, 'locscan.ini');
    if (!fs.existsSync(iniPath)) { result.skipped.push(`${binDir} (no locscan.ini)`); continue; }

    try {
      let content = fs.readFileSync(iniPath, 'utf8');
      if (content.includes('htmltextfiles:')) { result.skipped.push(iniPath); continue; }

      // Insert HTMLTXT into [abbreviations] section — append before the next section header
      if (!content.includes('HTMLTXT=')) {
        content = content.replace(
          /(\[abbreviations\][^\[]*)/s,
          (sec) => sec.trimEnd() + '\nHTMLTXT=./htmltext -w$w -v$v -q$q -T -A\n'
        );
      }

      // Insert htmltext: and htmltextfiles: into [input] section
      content = content.replace(
        /(\[input\][^\[]*)/s,
        (sec) => {
          let s = sec.trimEnd();
          s += '\nhtmltext:=| ${HTMLTXT} - | ${MEDSCAN} -Imsxml | ${PROTGLUE} | ${CONCEPTSCAN}';
          s += '\nhtmltextfiles:=| ${HTMLTXT} -l- -s$s| ${MEDSCAN} -Imsxml | ${PROTGLUE} | ${CONCEPTSCAN}\n';
          return s;
        }
      );

      fs.writeFileSync(iniPath, content, 'utf8');
      result.patched.push(iniPath);
      console.log('[htmltext] Patched', iniPath);
    } catch (e) {
      result.errors.push(`${iniPath}: ${e.message}`);
    }
  }
  return result;
}

ipcMain.handle('medscan:deployHtmlConverter', async (_, medscanDir) => {
  const result = { patched: [], skipped: [], errors: [], pipOutput: '' };

  // Install required Python packages first
  await new Promise((resolve) => {
    const proc = spawn('py', ['-m', 'pip', 'install', 'beautifulsoup4', 'lxml', '--quiet'], {
      shell: false,
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', (code) => {
      result.pipOutput = out.trim();
      if (code !== 0) result.errors.push(`pip install failed (exit ${code}): ${out.trim()}`);
      resolve();
    });
    proc.on('error', (e) => {
      result.errors.push(`pip not available: ${e.message}`);
      resolve();
    });
  });

  // Patch cartridges even if pip had a warning (non-zero exit for already-installed is common)
  const deploy = deployHtmlConverter(medscanDir || getStore().get('medscanDir'));
  result.patched = deploy.patched;
  result.skipped = deploy.skipped;
  result.errors  = [...result.errors.filter(e => !e.startsWith('pip install failed')), ...deploy.errors];
  // If pip failed with a real error keep it
  if (deploy.errors.length === 0 && result.errors.some(e => e.startsWith('pip install failed'))) {
    // pip non-zero but might just be "already satisfied" noise — clear it
    const pipErr = result.pipOutput.toLowerCase();
    if (!pipErr.includes('error') && !pipErr.includes('not found')) {
      result.errors = result.errors.filter(e => !e.startsWith('pip install failed'));
    }
  }
  return result;
});

// ── LLM proxy (runs server-side to avoid CORS) ───────────────────────────────
// Used by the renderer when it needs to call LLM APIs that block browser-origin
// requests (e.g. Gemini's native generateContent endpoint with grounding tools,
// or any OpenAI-compatible gateway that doesn't set CORS headers).
ipcMain.handle('llm:fetch', async (_, { url, body, headers, method }) => {
const isGet = (method || 'POST').toUpperCase() === 'GET';
  const res = await fetch(url, {
    method: isGet ? 'GET' : 'POST',
    headers: { ...(!isGet ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
    ...(isGet ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  const data = JSON.parse(text);
  // Log whether Google Search grounding was triggered (Gemini-specific, no-op otherwise)
  const grounded = !!(data.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length);
  const queries  = data.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];
  const finish   = data.candidates?.[0]?.finishReason;
  const textOut  = data.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('');
  if (grounded || finish) {
    console.log(`[llm:fetch] grounded=${grounded} queries=${JSON.stringify(queries)} finish=${finish} text=${JSON.stringify(textOut?.slice(0, 120))}`);
  }
  return data;
});

// ── The Triplefication choice (one for the NLP Runner and the Pipeline screen) ─────────────────────────────────────────────
// Kept in the user's settings by the Triplefication panel: triplefication = { kind:'conceptscan' | 'provider' | 'local', model } and llmPairPrompts = { <cartridge name>: the template edited by the user }.
// storedTriple() -> null (the cartridge's own conceptscan) or { kind, model, prompts }.
// ── "Clear LLM cache": the question/answer cache of conceptscan_llm (one SQLite file in the user data folder, shared by the Reader, the Pipeline screen and the NLP Runner) ──────────────────────
// The checkbox "Clear LLM cache before each run" is NOT a stored setting: it lives only in memory, so after a restart of the app it is off again (a forgotten ON would throw the answers away at every run).
let llmCacheClearFlag = false;
const llmCacheFile = () => path.join(app.getPath('userData'), 'conceptscan_llm_cache.sqlite');
function clearLlmCacheFile() {                                   // -> { ok, bytes, error }  (the file is deleted: conceptscan_llm makes a new one at its next run)
  let bytes = 0, error = '';
  for (const f of [llmCacheFile(), llmCacheFile() + '-wal', llmCacheFile() + '-shm', llmCacheFile() + '-journal']) {
    try { bytes += fs.statSync(f).size; fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') error = e.message; }
  }
  return { ok: !error, bytes, error };
}
function clearLlmCacheForRun(note) {                             // at the start of a run with an LLM: with the checkbox on the cache is emptied first; note(text) says so in the run's log
  if (!llmCacheClearFlag) return;
  const r = clearLlmCacheFile();
  if (note) note(r.ok ? `LLM cache cleared (${Math.round(r.bytes / 1024).toLocaleString()} KB): every sentence is asked of the LLM again` : `The LLM cache could not be cleared: ${r.error}`);
}
const sendLlmCacheFlag = () => { try { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('llm:cache:flag', llmCacheClearFlag); } catch {} };
ipcMain.handle('llm:cache:get', () => { let bytes = 0; try { bytes = fs.statSync(llmCacheFile()).size; } catch {} return { clear: llmCacheClearFlag, file: llmCacheFile(), bytes }; });
ipcMain.handle('llm:cache:setClear', (_, on) => { llmCacheClearFlag = !!on; sendLlmCacheFlag(); return llmCacheClearFlag; });
ipcMain.handle('llm:cache:clearNow', () => clearLlmCacheFile());
function storedTriple() {
  const s = getStore(), t = s.get('triplefication');
  if (!t || (t.kind !== 'local' && t.kind !== 'provider')) return null;
  // 'local' = the ONE local model of Settings -> Local LLM ("Model for the functions set to Local LLM"), the same as for every other function set to Local LLM
  const model = t.kind === 'local' ? String(s.get('llmLocalModel') || '') : t.model;
  return { ...t, model, prompts: s.get('llmPairPrompts') || {} };            // one request per entity pair of the cartridge's frames; the user's template per cartridge, else the default
}
// the conceptscan step of the Pipeline screen run by conceptscan_llm: { exe, env, label, promptFile } or null. Throws a readable message when the LLM cannot be used.
function pipelineTriple(cartridgePath) {
  const t = storedTriple();
  if (!t) return null;
  const exe = llmTriple.findExe(getStore(), path.join(__dirname, '..', '..'));
  if (!exe) throw new Error('Triplefication by LLM: conceptscan_llm (conceptscan.exe) not found - set its path in Settings -> Local LLM settings, or choose conceptscan.');
  const name = cartName(path.basename(cartridgePath)), text = t.prompts[name];
  let promptFile = '';
  if (text && text.trim()) {
    const dir = path.join(os.tmpdir(), 'nlpmanager-llm'); fs.mkdirSync(dir, { recursive: true });
    promptFile = path.join(dir, `${name}.prompt.txt`); fs.writeFileSync(promptFile, text, 'utf8');
  }
  const env = llmTriple.buildEnv(getStore(), t, cartridgePath, promptFile);
  env.CSLLM_DEBUG = '1';                                             // the Stderr tab then shows the raw answer of the model and what became of every triple
  const who = t.kind === 'local' ? t.model : (getStore().get('llmProviderName') || 'LLM provider');
  return { exe, env, promptFile, label: `ConceptScan (LLM: ${who}${promptFile ? ', edited template' : ''})` };
}

// ── Local LLM (Ollama on a port, usually an SSH tunnel to a GPU server) ─────────────────────────────────────────────────────
// Probed at startup (and on demand): when the port answers, the model names are pulled for the NLP Runner's Triplefication list.
let localLlmState = { ok: false, port: 0, models: [], error: 'not probed yet', checkedAt: 0 };
async function refreshLocalLlm() {
  const port = llmTriple.localSettings(getStore()).port;
  const r = await llmTriple.probeLocalLlm(port);
  localLlmState = { ...r, port, checkedAt: Date.now() };
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('llm:local:update', localLlmState); } catch {}
  return localLlmState;
}
ipcMain.handle('llm:local:state',   () => localLlmState);
ipcMain.handle('llm:local:refresh', () => refreshLocalLlm());
// SSH tunnel to a remote Ollama server (plink + .ppk key): local port = "Tunnel port" of the Local LLM settings
const sendTunnel = (st) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('llm:tunnel:update', st); } catch {} };
ipcMain.handle('llm:tunnel:start', async (_, { server }) => {
  const r = await llmTriple.startTunnel(getStore(), server || {}, llmTriple.localSettings(getStore()).port, sendTunnel);
  if (r.ok) await refreshLocalLlm();                                 // pull the model names through the new tunnel
  return { ...r, state: llmTriple.tunnelState() };
});
// After a restart: connect the tunnel of the saved remote LLM server by itself (the Connect tunnel button of Settings does the same). Nothing is done when no complete server is saved, when the port already
// answers (a local Ollama, or a tunnel that is still up) or when a tunnel is already starting. A failure is shown like a click on the button would show it: the red error of Settings / the Triplefication box.
async function autoConnectTunnel(st) {
  try {
    const srv = getStore().get('llmServer') || {};
    if (!(String(srv.host || '').trim() && String(srv.user || '').trim() && String(srv.key || '').trim())) return;
    if (st && st.ok) return;
    const cur = llmTriple.tunnelState().state;
    if (cur === 'up' || cur === 'starting') return;
    const pr = llmTriple.startTunnel(getStore(), srv, llmTriple.localSettings(getStore()).port, sendTunnel);
    sendTunnel(llmTriple.tunnelState());                              // 'connecting...'
    const r = await pr;
    if (r.ok) await refreshLocalLlm();
  } catch (e) { sendTunnel({ state: 'failed', error: String((e && e.message) || e) }); }
}
ipcMain.handle('llm:tunnel:stop',  () => { llmTriple.stopTunnel(); const st = llmTriple.tunnelState(); sendTunnel(st); refreshLocalLlm().catch(() => {}); return st; });
ipcMain.handle('llm:tunnel:state', () => llmTriple.tunnelState());
ipcMain.handle('llm:plink:find',   () => llmTriple.findPlink(getStore()));
ipcMain.handle('llm:exe:find',      () => llmTriple.findExe(getStore(), path.join(__dirname, '..', '..')));
ipcMain.handle('llm:referent:default', async () => ({ ok: true, text: await llmTriple.defaultReferentPrompt(llmTriple.findExe(getStore(), path.join(__dirname, '..', '..'))) }));      // the pronoun question; the edited one is in the settings: llmReferentPrompt
// the default template of the requests (the user's edited template per cartridge is in the settings: llmPairPrompts)
ipcMain.handle('llm:prompt:default', async (_e, args) => { const c = args && args.cartridge; return { ok: true, text: await llmTriple.defaultPrompt(c, llmTriple.findExe(getStore(), path.join(__dirname, '..', '..'))), answerLine: llmTriple.answerLine(c) }; });      // per cartridge: only DiseaseFX asks for a change type

// ── Settings ────────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => {
  const s = getStore();
  return {
    medscanLicense:    s.get('medscanLicense'),
    medscanDir:        s.get('medscanDir'),
    userDict:          s.get('userDict'),
    bwFilter:          s.get('bwFilter'),
    lastInputDir:      s.get('lastInputDir'),
    lastOutputDir:     s.get('lastOutputDir'),
    litOutputDir:      s.get('litOutputDir'),
    elsevierApiKey:      s.get('elsevierApiKey'),
    ncbiApiKey:          s.get('ncbiApiKey'),
    consynBearerToken:        s.get('consynBearerToken'),
    consynUserId:             s.get('consynUserId'),
    selectedCartridgeNames:   s.get('selectedCartridgeNames'),  // string[] | undefined
    xmlFormat:                s.get('xmlFormat'),
    centreeUrl:         s.get('centreeUrl') ?? '',
    centreeToken:       s.get('centreeToken') ?? '',
    centreeApiPrefix:   s.get('centreeApiPrefix') ?? '/api',
    centreeSelectedOntologies: s.get('centreeSelectedOntologies') ?? [],   // ontology ids ticked in the CENtree selector of Batch Import
    centreeSelectedBranches: s.get('centreeSelectedBranches') ?? {},        // { <ontology id>: { <branch primaryId>: { label } } } branches ticked in the selector (without the whole ontology)
    centreeBranchMap:   s.get('centreeBranchMap') ?? {},        // { <ontology id>: { <branch primaryId>: { entity, label, depth } } } - parts of an ontology mapped to their own entity type
    centreeOntologyMap: s.get('centreeOntologyMap') ?? {},      // { <CENtree ontology id>: <entity type display name of shared/entityTypes.js> }
    centreeUser:        s.get('centreeUser') ?? '',
    centreePassword:    s.get('centreePassword') ?? '',
    centreeTimeoutSec:  s.get('centreeTimeoutSec') ?? 30,
    centreeInsecureTls: s.get('centreeInsecureTls') ?? false,
    // LLM connector
    llmProviderName: s.get('llmProviderName'),
    llmProviderUrl:  s.get('llmProviderUrl'),
    llmApiKey:       s.get('llmApiKey'),
    llmAuthHeader:   s.get('llmAuthHeader') ?? '',
    llmExtraHeaders: s.get('llmExtraHeaders') ?? '',
    llmModel:        s.get('llmModel'),
    llmTemperature:  s.get('llmTemperature') ?? 0.2,
    llmTopP:         s.get('llmTopP')        ?? 0.9,
    llmMaxRequestsPerDay: s.get('llmMaxRequestsPerDay') ?? 1000,
    // Local LLM settings (Ollama on a port / SSH tunnel) and the conceptscan_llm program
    llmLocalPort:       llmTriple.localSettings(s).port,
    llmLocalMaxWorkers: llmTriple.localSettings(s).maxWorkers,
    llmLocalTimeout:    llmTriple.localSettings(s).timeout,
    llmLocalNumCtx:     llmTriple.localSettings(s).numCtx,
    llmLocalCacheMaxMb: llmTriple.localSettings(s).cacheMaxMb,
    llmLocalCache:      llmTriple.localSettings(s).cache,
    conceptscanLlmExe:  s.get('conceptscanLlmExe') ?? '',
    llmFunctionTargets: s.get('llmFunctionTargets') ?? {},      // { <function id of shared/llmFunctions.js>: 'api' | 'local' } - which LLM answers each function
    llmLocalModel:      s.get('llmLocalModel') ?? '',           // the model of the local Ollama server for the functions set to 'local'
    llmProfiles:        s.get('llmProfiles') ?? [],
    llmServer:          s.get('llmServer') ?? {},
    llmServers:         s.get('llmServers') ?? [],
    plinkExe:           s.get('plinkExe') ?? '',
    llmPairPrompts:     s.get('llmPairPrompts') ?? {},
    readerResolvePronouns: s.get('readerResolvePronouns') !== false,
    readerCorefN:       s.get('readerCorefN') ?? 1,
    llmReferentPrompt:  s.get('llmReferentPrompt') ?? '',
    triplefication:     s.get('triplefication') ?? { kind: 'conceptscan' },
    mixedImportDir:       s.get('mixedImportDir') ?? '',
    keepMsxml:            s.get('keepMsxml') ?? false,
    maxParallelCartridges: s.get('maxParallelCartridges') ?? 2,
    readerMaxParallel: s.get('readerMaxParallel') ?? s.get('maxParallelCartridges') ?? 2,        // the Reader's own (one web page, its cartridges); starts from the NLP Runner's value
    lastRnefDir:          s.get('lastRnefDir') ?? '',
  };
});

ipcMain.handle('settings:set', (_, settings) => {
  const s = getStore();
  if (settings.medscanLicense !== undefined) s.set('medscanLicense', settings.medscanLicense);
  if (settings.medscanDir !== undefined) {
    s.set('medscanDir', settings.medscanDir);
    urnMapCachePromise = null; urnMapCacheDir = null; // invalidate URN map when medscanDir changes
    loadUrnMap(settings.medscanDir).catch(() => {}); // pre-warm in background
    try { deployHtmlConverter(settings.medscanDir); } catch {}
  }
  if (settings.userDict !== undefined) s.set('userDict', settings.userDict);
  if (settings.bwFilter      !== undefined) s.set('bwFilter',      settings.bwFilter);
  if (settings.lastInputDir  !== undefined) s.set('lastInputDir',  settings.lastInputDir);
  if (settings.lastOutputDir !== undefined) s.set('lastOutputDir', settings.lastOutputDir);
  if (settings.litOutputDir  !== undefined) s.set('litOutputDir',  settings.litOutputDir);
  if (settings.elsevierApiKey    !== undefined) s.set('elsevierApiKey',    settings.elsevierApiKey);
  if (settings.ncbiApiKey        !== undefined) s.set('ncbiApiKey',        settings.ncbiApiKey);
  if (settings.consynBearerToken      !== undefined) s.set('consynBearerToken',      settings.consynBearerToken);
  if (settings.consynUserId           !== undefined) s.set('consynUserId',           settings.consynUserId);
  if (settings.selectedCartridgeNames !== undefined) s.set('selectedCartridgeNames', settings.selectedCartridgeNames);
  if (settings.xmlFormat             !== undefined) s.set('xmlFormat',             settings.xmlFormat);
  if (settings.centreeUrl         !== undefined) s.set('centreeUrl',         String(settings.centreeUrl || '').trim());
  if (settings.centreeToken       !== undefined) s.set('centreeToken',       String(settings.centreeToken || '').trim());
  if (settings.centreeSelectedOntologies !== undefined) s.set('centreeSelectedOntologies', Array.isArray(settings.centreeSelectedOntologies) ? settings.centreeSelectedOntologies.filter(x => typeof x === 'string') : []);
  if (settings.centreeSelectedBranches !== undefined) s.set('centreeSelectedBranches', settings.centreeSelectedBranches && typeof settings.centreeSelectedBranches === 'object' ? settings.centreeSelectedBranches : {});
  if (settings.centreeBranchMap   !== undefined) s.set('centreeBranchMap',   settings.centreeBranchMap && typeof settings.centreeBranchMap === 'object' ? settings.centreeBranchMap : {});
  if (settings.centreeOntologyMap !== undefined) s.set('centreeOntologyMap', settings.centreeOntologyMap && typeof settings.centreeOntologyMap === 'object' ? settings.centreeOntologyMap : {});
  if (settings.centreeUser        !== undefined) s.set('centreeUser',        String(settings.centreeUser || '').trim());
  if (settings.centreePassword    !== undefined) s.set('centreePassword',    String(settings.centreePassword || ''));
  if (settings.centreeApiPrefix   !== undefined) s.set('centreeApiPrefix',   String(settings.centreeApiPrefix || '/api').trim());
  if (settings.centreeTimeoutSec  !== undefined) s.set('centreeTimeoutSec',  Math.max(1, parseInt(settings.centreeTimeoutSec) || 30));
  if (settings.centreeInsecureTls !== undefined) s.set('centreeInsecureTls', !!settings.centreeInsecureTls);
  // LLM connector
  if (settings.llmProviderName !== undefined) s.set('llmProviderName', settings.llmProviderName);
  if (settings.llmProviderUrl  !== undefined) s.set('llmProviderUrl',  settings.llmProviderUrl);
  if (settings.llmApiKey       !== undefined) s.set('llmApiKey',       settings.llmApiKey);
  if (settings.llmAuthHeader   !== undefined) s.set('llmAuthHeader',   settings.llmAuthHeader);
  if (settings.llmExtraHeaders !== undefined) s.set('llmExtraHeaders', settings.llmExtraHeaders);
  if (settings.llmModel        !== undefined) s.set('llmModel',        settings.llmModel);
  if (settings.llmTemperature  !== undefined) s.set('llmTemperature',  settings.llmTemperature);
  if (settings.llmTopP         !== undefined) s.set('llmTopP',         settings.llmTopP);
  if (settings.llmMaxRequestsPerDay !== undefined) s.set('llmMaxRequestsPerDay', settings.llmMaxRequestsPerDay);
  const posInt = (v, d) => { const n = parseInt(v); return Number.isFinite(n) && n > 0 ? n : d; };
  if (settings.llmLocalPort       !== undefined) { const before = s.get('llmLocalPort'); s.set('llmLocalPort', posInt(settings.llmLocalPort, 11434)); if (before !== s.get('llmLocalPort')) refreshLocalLlm().catch(() => {}); }
  if (settings.llmLocalMaxWorkers !== undefined) s.set('llmLocalMaxWorkers', posInt(settings.llmLocalMaxWorkers, 4));
  if (settings.llmLocalTimeout    !== undefined) s.set('llmLocalTimeout',    posInt(settings.llmLocalTimeout, 300));
  if (settings.llmLocalNumCtx     !== undefined) s.set('llmLocalNumCtx',     posInt(settings.llmLocalNumCtx, 4096));
  if (settings.llmLocalCacheMaxMb !== undefined) { const v = parseInt(settings.llmLocalCacheMaxMb); s.set('llmLocalCacheMaxMb', Number.isFinite(v) && v >= 0 ? v : 1024); }      // MB; 0 = no limit
  if (settings.llmLocalCache      !== undefined) s.set('llmLocalCache',      !!settings.llmLocalCache);
  if (settings.conceptscanLlmExe  !== undefined) s.set('conceptscanLlmExe',  settings.conceptscanLlmExe);
  if (settings.llmFunctionTargets !== undefined) s.set('llmFunctionTargets', settings.llmFunctionTargets && typeof settings.llmFunctionTargets === 'object' ? Object.fromEntries(Object.entries(settings.llmFunctionTargets).filter(([, v]) => v === 'api' || v === 'local')) : {});
  if (settings.llmLocalModel      !== undefined) s.set('llmLocalModel',      String(settings.llmLocalModel || ''));
  if (settings.llmServer          !== undefined) s.set('llmServer',          settings.llmServer && typeof settings.llmServer === 'object' ? settings.llmServer : {});
  if (settings.llmServers         !== undefined) s.set('llmServers',         Array.isArray(settings.llmServers) ? settings.llmServers : []);
  if (settings.plinkExe           !== undefined) s.set('plinkExe',           settings.plinkExe);
  if (settings.llmProfiles        !== undefined) s.set('llmProfiles',        Array.isArray(settings.llmProfiles) ? settings.llmProfiles : []);
  if (settings.llmReferentPrompt  !== undefined) s.set('llmReferentPrompt',  String(settings.llmReferentPrompt || ''));
  if (settings.readerResolvePronouns !== undefined) s.set('readerResolvePronouns', !!settings.readerResolvePronouns);
  if (settings.readerCorefN       !== undefined) s.set('readerCorefN', Math.max(0, Math.min(20, parseInt(settings.readerCorefN) || 0)));
  if (settings.llmPairPrompts     !== undefined) s.set('llmPairPrompts',     settings.llmPairPrompts && typeof settings.llmPairPrompts === 'object' ? settings.llmPairPrompts : {});
  if (settings.triplefication     !== undefined) s.set('triplefication',     settings.triplefication);
  if (settings.mixedImportDir       !== undefined) s.set('mixedImportDir',       settings.mixedImportDir);
  if (settings.keepMsxml            !== undefined) s.set('keepMsxml',            !!settings.keepMsxml);
  if (settings.lastRnefDir          !== undefined) s.set('lastRnefDir',          settings.lastRnefDir);
  if (settings.maxParallelCartridges !== undefined) s.set('maxParallelCartridges', Math.max(1, parseInt(settings.maxParallelCartridges) || 2));
  if (settings.readerMaxParallel !== undefined) s.set('readerMaxParallel', Math.max(1, parseInt(settings.readerMaxParallel) || 2));
  return true;
});

// ── SciBite CENtree connector ───────────────────────────────────────────────
ipcMain.handle('centree:test',       () => centree.test(getStore()));
ipcMain.handle('centree:ontologies', (_, q) => centree.ontologies(getStore(), q));
ipcMain.handle('centree:ontology',   (_, id) => centree.ontology(getStore(), id));
ipcMain.handle('centree:term',       (_, a) => centree.term(getStore(), a && a.ontology, a && a.primaryId));
ipcMain.handle('centree:classById',  (_, a) => centree.classById(getStore(), a && a.ontology, a && a.classId));
ipcMain.handle('centree:exactLabel', (_, a) => centree.exactLabel(getStore(), a && a.ontology, a && a.label));
ipcMain.handle('centree:search',     (_, a) => centree.search(getStore(), a || {}));
ipcMain.handle('centree:call',       (_, a) => centree.call(getStore(), a || {}));

// ── CENtree batch import: fetch changes since a date, then prepare an aggregated file for Batch Import ───────────────
const centreeRuns = new Map();                                   // runId -> { cancelled }
const centreeLog = (line) => { try { const d = path.join(app.getPath('userData'), 'centree-import'); fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(path.join(d, 'centree-import.log'), `${new Date().toISOString()} user=${os.userInfo().username} ${line}\n`); } catch {} };
const centreeSend = (ch, p) => { try { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(ch, p); } catch {} };
ipcMain.handle('centree:branchChildren', async (_, { ontologyId, parentClassId }) => { try { return { ok: true, data: await centree.branchChildren(getStore(), ontologyId, parentClassId || null) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('centree:classify', async (_, { runId, ontologyId, primaryIds }) => {
  const run = { cancelled: false }; centreeRuns.set(runId, run);
  const debug = {};
  try { const data = await centree.classAncestors(getStore(), ontologyId, primaryIds, { debug, isCancelled: () => run.cancelled, onTick: (d, n) => centreeSend('centree:progress', { runId, done: d, total: n, ontology: ontologyId }) }); return { ok: true, data, sample: debug.sample || '' }; }
  catch (e) { return { ok: false, error: e.message, cancelled: e.message === 'Cancelled' }; }
  finally { centreeRuns.delete(runId); }
});
// Downloads a file of CENtree (e.g. a version-comparison report) into <userData>/centree-import/downloads and, for a zip, lists its entries with the beginning of each text file.
ipcMain.handle('centree:inspectDownload', async (_, { path: apiPath, lines = 8 }) => {
  const r = await centree.download(getStore(), apiPath);
  if (!r.ok) return r;
  try {
    const dir = path.join(app.getPath('userData'), 'centree-import', 'downloads'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(String(apiPath).split('?')[0]));
    fs.writeFileSync(file, r.data);
    const out = { ok: true, file, bytes: r.data.length, entries: [] };
    if (/\.zip$/i.test(file)) {
      const JSZip = require('jszip'); const zip = await JSZip.loadAsync(r.data);
      for (const [name, e] of Object.entries(zip.files)) {
        if (e.dir) continue;
        const buf = await e.async('nodebuffer'); const text = buf.slice(0, 20000).toString('utf8');
        const ls = text.split(/\r?\n/);
        out.entries.push({ name, bytes: buf.length, lines: ls.length, head: ls.slice(0, lines).join('\n').slice(0, 1500) });
      }
    }
    return out;
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('centree:cancel', (_, runId) => { const r = centreeRuns.get(runId); if (r) r.cancelled = true; return true; });
ipcMain.handle('centree:listOntologies', () => centree.listOntologies(getStore()));
// Downloaded classes of an ontology are kept for a while (the branch counts and the download use the same data); at most 2 ontologies are kept.
const centreeClassCache = new Map();               // ontology id -> { at, classes }
async function centreeGetClasses(ontologyId, run, onTick) {
  const hit = centreeClassCache.get(ontologyId);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.classes;
  const classes = await centree.downloadClasses(getStore(), ontologyId, { isCancelled: () => run.cancelled, onTick });
  centreeClassCache.delete(ontologyId); centreeClassCache.set(ontologyId, { at: Date.now(), classes });
  while (centreeClassCache.size > 2) centreeClassCache.delete(centreeClassCache.keys().next().value);
  return classes;
}
ipcMain.handle('centree:branchCounts', async (_, { runId, ontologyId, primaryIds }) => {
  const run = { cancelled: false }; centreeRuns.set(runId, run);
  try {
    const classes = await centreeGetClasses(ontologyId, run, (d, t) => centreeSend('centree:progress', { runId, done: d, total: t || d, ontology: ontologyId }));
    return { ok: true, data: centree.countBelow(classes, Array.isArray(primaryIds) ? primaryIds : []) };
  } catch (e) { return { ok: false, error: e.message, cancelled: e.message === 'Cancelled' }; }
  finally { centreeRuns.delete(runId); }
});
ipcMain.handle('centree:ontologyShape', (_, ids) => centree.ontologyShape(getStore(), Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : []));
// Downloads the selected ontologies (whole, or only the given branches) and writes ONE aggregated file (name ⇥ synonyms) for Batch Import, plus a .meta.json with the source of every record.
// sources: [{ id, name, whole: true } | { id, name, whole: false, branches: [{ primaryId, label }] }]
ipcMain.handle('centree:downloadSelected', async (_, { runId, sources }) => {
  const run = { cancelled: false }; centreeRuns.set(runId, run);
  try {
    const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
    const byLabel = new Map(); const per = [];
    // the ontologies are downloaded side by side (3 at a time); the terms are then merged in the order of the selection
    const fetched = new Array(sources.length); let nextSrc = 0;
    await Promise.all(Array.from({ length: Math.min(3, sources.length) }, async () => {
      while (nextSrc < sources.length) {
        const i = nextSrc++, src = sources[i];
        fetched[i] = await centreeGetClasses(src.id, run, (d, t) => centreeSend('centree:progress', { runId, done: d, total: t || d, ontology: src.name }));
      }
    }));
    for (let si = 0; si < sources.length; si++) {
      const src = sources[si];
      let classes = fetched[si];
      const downloaded = classes.length;
      if (!src.whole) classes = centree.branchMembers(classes, (src.branches || []).map(b => b.primaryId));
      for (const c of classes) {
        const label = clean(c.label); if (!label) continue;
        const key = label.toLowerCase();
        const e = byLabel.get(key) || { label, syns: new Set(), sources: [] };
        for (const s of c.synonyms || []) { const x = clean(s).replace(/[|;]+/g, ' '); if (x && x.toLowerCase() !== key) e.syns.add(x); }
        e.sources.push(src.id + ':' + c.primaryId); byLabel.set(key, e);
      }
      per.push({ id: src.id, name: src.name, branches: src.whole ? null : (src.branches || []).map(b => b.label), downloaded, selected: classes.length });
    }
    const dir = path.join(app.getPath('userData'), 'centree-import'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `centree_${new Date().toISOString().replace(/[:.]/g, '-')}.tsv`);
    const entries = [...byLabel.values()];
    fs.writeFileSync(file, '#name\tsyns\n' + entries.map(e => e.label + '\t' + [...e.syns].join('|')).join('\n') + '\n', 'utf8');
    fs.writeFileSync(file.replace(/\.tsv$/, '.meta.json'), JSON.stringify({ created: new Date().toISOString(), sources: per, records: entries.map(e => ({ label: e.label, sources: e.sources })) }, null, 1), 'utf8');
    centreeLog(`download sources=${per.map(p => p.id + (p.branches ? '[' + p.branches.join('|') + ']' : '') + ':' + p.selected).join(',')} records=${entries.length} file=${file}`);
    return { ok: true, file, count: entries.length, per };
  } catch (e) { return { ok: false, error: e.message, cancelled: e.message === 'Cancelled' }; }
  finally { centreeRuns.delete(runId); }
});
ipcMain.handle('centree:ontologyStats', (_, ids) => centree.ontologyStats(getStore(), Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : []));
ipcMain.handle('centree:fetchChanges', async (_, { runId, fromDate, useVersions, ontologyIds }) => {
  const run = { cancelled: false }; centreeRuns.set(runId, run);
  try {
    const data = await centree.fetchChanges(getStore(), { fromDate, ontologyIds, useVersions: useVersions !== false, isCancelled: () => run.cancelled, onProgress: (p) => centreeSend('centree:progress', { runId, ...p }) });
    centreeLog(`fetch cutoff=${fromDate} ontologies=${data.ontologies.map(o => o.id + ':' + o.records.length).join(',') || '-'}`);
    return { ok: true, data };
  } catch (e) { centreeLog(`fetch cutoff=${fromDate} FAILED ${e.message}`); return { ok: false, error: e.message, cancelled: e.message === 'Cancelled' }; }
  finally { centreeRuns.delete(runId); }
});
// ontologies: [{ id, name, records }]; entityType: display name. Writes <userData>/centree-import/centree_<time>.tsv (aggregated: name, syns) and a .meta.json with the source metadata of every record.
ipcMain.handle('centree:prepare', async (_, { runId, ontologies, entityType }) => {
  const run = { cancelled: false }; centreeRuns.set(runId, run);
  try {
    const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
    const rows = [], meta = []; let done = 0, total = ontologies.reduce((n, o) => n + o.records.length, 0);
    for (const o of ontologies) {
      const det = await centree.classDetails(getStore(), o.id, o.records, { isCancelled: () => run.cancelled, onTick: () => centreeSend('centree:progress', { runId, done: ++done, total, ontology: o.name }) });
      for (const r of det) {
        if (r.obsolete || r.missing || !clean(r.label)) continue;
        const syns = [...new Set((r.synonyms || []).map(x => clean(x).replace(/[|;]+/g, ' ')).filter(x => x && x.toLowerCase() !== clean(r.label).toLowerCase()))];
        rows.push(clean(r.label) + '\t' + syns.join('|'));
        meta.push({ ontology: o.id, primaryId: r.primaryId, label: r.label, status: r.created ? 'new' : 'updated', lastModified: r.ts });
      }
    }
    const dir = path.join(app.getPath('userData'), 'centree-import'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `centree_${new Date().toISOString().replace(/[:.]/g, '-')}.tsv`);
    fs.writeFileSync(file, '#name\tsyns\n' + rows.join('\n') + '\n', 'utf8');
    fs.writeFileSync(file.replace(/\.tsv$/, '.meta.json'), JSON.stringify({ entityType, records: meta }, null, 1), 'utf8');
    centreeLog(`submit entityType=${entityType} ontologies=${ontologies.map(o => o.id).join(',')} records=${rows.length} file=${file}`);
    return { ok: true, file, count: rows.length, skipped: total - rows.length };
  } catch (e) { return { ok: false, error: e.message, cancelled: e.message === 'Cancelled' }; }
  finally { centreeRuns.delete(runId); }
});

// ── Consyn OAuth Login ───────────────────────────────────────────────────────
async function consynLogin() {
  return new Promise((resolve, reject) => {
    const { session: electronSession } = require('electron');
    const authWin = new BrowserWindow({
      width: 900, height: 700,
      title: 'Login to Elsevier Consyn',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      parent: mainWindow,
      modal: false,
    });

    const authUrl = 'https://id.elsevier.com/as/authorization.oauth2?' + new URLSearchParams({
      client_id:     'consyn',
      redirect_uri:  'https://consyn.elsevier.com/api/auth/redirect',
      response_type: 'code',
      scope:         'openid profile email els_auth_info els_analytics_info urn:com:elsevier:idp:policy:product:indv_identity',
      state:         'nlpmanager',
      nonce:         Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      platSite:      'CS/Consyn',
      ui_locales:    'en-US',
    }).toString();

    authWin.loadURL(authUrl);
    let resolved = false;

    const checkForToken = async () => {
      if (resolved) return;
      try {
        const cookies = await electronSession.defaultSession.cookies.get({
          url: 'https://consyn.elsevier.com',
          name: 'auth-token',
        });
        if (cookies.length > 0) {
          resolved = true;
          const token = cookies[0].value;
          getStore().set('consynBearerToken', token);
          // Try to extract userId from the current URL or /api/user
          try {
            const currentUrl = authWin.webContents.getURL();
            const umatch = currentUrl.match(/[?&]userId=([^&]+)/);
            if (umatch) getStore().set('consynUserId', decodeURIComponent(umatch[1]));
          } catch {}
          authWin.close();
          resolve(token);
        }
      } catch (e) { /* ignore */ }
    };

    authWin.webContents.on('did-navigate', (_, url) => {
      if (url.startsWith('https://consyn.elsevier.com')) {
        setTimeout(checkForToken, 800);
      }
    });
    authWin.webContents.on('did-finish-load', () => {
      const url = authWin.webContents.getURL();
      if (url.startsWith('https://consyn.elsevier.com')) {
        setTimeout(checkForToken, 800);
      }
    });
    authWin.on('closed', () => {
      if (!resolved) { resolved = true; reject(new Error('Login window closed before authentication completed.')); }
    });
  });
}

ipcMain.handle('consyn:login', async () => {
  try {
    const token = await consynLogin();
    return { ok: true, token };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Consyn Search — open search page in an in-app window with query pre-filled ─
ipcMain.handle('consyn:openSearch', async (_, rawQuery) => {
  // Normalise every term to  all:"term"  regardless of input format.
  // Split on boolean operators (keeping them), process each term, rejoin.
  const consynQuery = rawQuery
    .split(/(\s+(?:OR|AND|NOT)\s+)/i)
    .map(part => {
      // Keep boolean operators unchanged
      if (/^\s*(?:OR|AND|NOT)\s*$/i.test(part)) return part;
      let t = part.trim();
      if (!t) return part;
      // Strip existing field prefix in any format:
      //   all("term")  all('term')  all:"term"  all:'term'  all:term
      t = t.replace(/^[a-z]+\(["']?([^"')]+)["']?\)$/i, '"$1"')  // all("x") → "x"
           .replace(/^[a-z]+:["']([^"']+)["']$/i,       '"$1"')  // all:"x"  → "x"
           .replace(/^[a-z]+:([^"\s]+)$/i,               '"$1"'); // all:x    → "x"
      // Strip any remaining outer quotes, then wrap with all:"..."
      const inner = t.replace(/^["']|["']$/g, '').trim();
      return `all:"${inner}"`;
    })
    .join('');

  const searchWin = new BrowserWindow({
    width: 1200, height: 800,
    title: 'Consyn Search',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    parent: mainWindow,
    modal: false,
  });

  // The injection script uses MutationObserver + timed retries so it works
  // regardless of when the SPA finishes rendering the search input.
  const injectionScript = `
    (function() {
      var q = ${JSON.stringify(consynQuery)};
      var injected = false;

      function fillInput(el) {
        try {
          // Use the correct prototype setter depending on element type
          var proto = el.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, q);
          el.dispatchEvent(new InputEvent('input',  { bubbles: true, data: q }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.focus();
          injected = true;
        } catch(e) {}
      }

      function findAndFill() {
        if (injected) return;

        // PRIMARY: Consyn's main search box is a <textarea> — target it first
        var textareas = Array.from(document.querySelectorAll('textarea')).filter(function(el) {
          var r = el.getBoundingClientRect();
          return r.width > 100 && r.height > 20;
        });
        if (textareas.length > 0) { fillInput(textareas[0]); return; }

        // FALLBACK: input with placeholder hinting at the search field
        var byPlaceholder = document.querySelector('input[placeholder*="3 characters"]') ||
                            document.querySelector('input[placeholder*="Please enter"]') ||
                            document.querySelector('input[placeholder*="characters"]');
        if (byPlaceholder) { fillInput(byPlaceholder); return; }

        // LAST RESORT: second visible text input
        var inputs = Array.from(document.querySelectorAll(
          'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])'
        )).filter(function(el) {
          var r = el.getBoundingClientRect();
          return r.width > 60 && r.height > 10;
        });
        if (inputs.length >= 2) { fillInput(inputs[1]); }
        else if (inputs.length === 1) { fillInput(inputs[0]); }
      }

      // Watch for DOM changes (SPA rendering search box after route change)
      var observer = new MutationObserver(function() { findAndFill(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });

      // Also try at increasing delays to catch slow renders
      [200, 600, 1200, 2000, 3500, 5000].forEach(function(ms) {
        setTimeout(findAndFill, ms);
      });

      // Stop observing after 20 seconds
      setTimeout(function() { observer.disconnect(); }, 20000);
    })();
  `;

  // Inject on every page load within this window (catches SPA route changes too)
  const injectOnLoad = () => {
    const url = searchWin.webContents.getURL();
    if (url.includes('consyn.elsevier.com')) {
      searchWin.webContents.executeJavaScript(injectionScript).catch(() => {});
    }
  };

  searchWin.webContents.on('did-finish-load', injectOnLoad);
  searchWin.webContents.on('dom-ready',       injectOnLoad);

  // Copy formatted query to clipboard — reliable fallback if JS injection doesn't land
  const { clipboard } = require('electron');
  clipboard.writeText(consynQuery);

  // Navigate to search page — include query param in case SPA reads it on init
  const searchUrl = `https://consyn.elsevier.com/consyn/search/render?query=${encodeURIComponent(consynQuery)}`;
  searchWin.loadURL(searchUrl);

  return { ok: true, query: consynQuery };
});

// ── File / Folder dialogs ────────────────────────────────────────────────────
ipcMain.handle('dialog:openDir', async (_, opts) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    ...(opts?.defaultPath ? { defaultPath: opts.defaultPath } : {}),
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openFiles', async (_, format) => {
  const filter = format === 'html' ? { name: 'HTML files', extensions: ['html', 'htm'] }
    : format === 'msxml' ? { name: 'MedScan files', extensions: ['msxml'] }
    : { name: 'XML files', extensions: ['xml', 'nxml', 'msxml', 'sdxml'] };
  // open in the folder of the last selection (remembered across runs); fall back to the dialog's own default if that folder is gone
  const last = getStore().get('lastSelectFilesDir');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    ...(last && fs.existsSync(last) ? { defaultPath: last } : {}),
    filters: [filter, { name: 'All files', extensions: ['*'] }],
  });
  if (!result.canceled && result.filePaths.length) getStore().set('lastSelectFilesDir', path.dirname(result.filePaths[0]));
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:openFile', async (_, options) => {
  const opts = {
    properties: ['openFile'],
    filters: options?.filters || [{ name: 'All files', extensions: ['*'] }],
  };
  if (options?.defaultPath) opts.defaultPath = options.defaultPath;
  const result = await dialog.showOpenDialog(mainWindow, opts);
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('fs:exists', (_, p) => {
  try { fs.accessSync(p); return true; } catch { return false; }
});

ipcMain.handle('fs:listDir', (_, dirPath) => {
  try {
    return fs.readdirSync(dirPath).map(name => ({
      name,
      isDir: fs.statSync(path.join(dirPath, name)).isDirectory(),
    }));
  } catch { return []; }
});

// Detailed listing for the in-app file picker (name, isDir, size, mtime + parent dir)
ipcMain.handle('fs:listDirDetailed', (_, dirPath) => {
  try {
    const dir = path.resolve(dirPath);
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, name));
        entries.push({ name, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
      } catch { /* unreadable entry (locked / permission) — skip */ }
    }
    const parent = path.dirname(dir);
    return { ok: true, dir, parent: parent !== dir ? parent : null, entries };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Quick-access locations + drive letters for the in-app file picker
ipcMain.handle('fs:quickPlaces', () => {
  const places = [];
  for (const [label, key] of [['Desktop', 'desktop'], ['Downloads', 'downloads'], ['Documents', 'documents'], ['Home', 'home']]) {
    try { places.push({ label, path: app.getPath(key) }); } catch {}
  }
  const drives = [];
  if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) { // C..Z
      const d = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(d)) drives.push({ label: d, path: d }); } catch {}
    }
  }
  return { places, drives };
});

// Recursive file listing — returns absolute paths of all files matching extLower (e.g. '.xml')
ipcMain.handle('fs:listDirRecursive', (_, dirPath, extLower) => {
  const results = [];
  function walk(dir) {
    try {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).isDirectory()) { walk(full); }
          else if (!extLower || name.toLowerCase().endsWith(extLower)) { results.push(full); }
        } catch {}
      }
    } catch {}
  }
  walk(dirPath);
  return results;
});

ipcMain.handle('fs:readFile', (_, filePath) => {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
});

ipcMain.handle('fs:writeFile', (_, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf8'); return true; } catch { return false; }
});

// after window.confirm() / alert() (native dialogs) Electron on Windows keeps the page from taking keyboard input in text boxes until the window loses and regains focus
let findKeys = false, findText = '';                    // findKeys: the find bar is open and takes Enter / Shift+Enter / Esc; findText: what is searched
function findStep(forward) {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (wc && findText) wc.findInPage(findText, { forward, findNext: true, matchCase: false });
}
ipcMain.on('find:keys', (_e, on) => { findKeys = !!on; });
ipcMain.handle('find:run', (_e, { text, forward, next }) => {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!wc) return { ok: false };
  findText = String(text || '');
  if (!text) { wc.stopFindInPage('clearSelection'); return { ok: true }; }
  // Electron: findNext must be OMITTED for a new search - an explicit findNext:false gives no result at all (no found-in-page: the bar shows no matches and its arrows stay disabled);
  // findNext:true = the next / previous match of the search that is going on (measured with Electron 44: the matches 1,2,3,4 of four hits)
  const opts = { forward: forward !== false, matchCase: false };
  if (next) opts.findNext = true;
  wc.findInPage(String(text), opts);
  return { ok: true };
});
ipcMain.handle('find:stop', () => { findText = ''; findKeys = false; if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.stopFindInPage('clearSelection'); return { ok: true }; });
ipcMain.on('app:refocus', () => {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  w.blur(); w.focus(); w.webContents.focus();
});
ipcMain.handle('shell:openFile', (_, filePath) => {
  shell.openPath(filePath);
});

ipcMain.handle('shell:openExternal', (_, url) => {
  shell.openExternal(url);
});

// ── sdxml → msxml converter ───────────────────────────────────────────────────
const { convertDirectory: sdxmlConvertDir } = require('./sdxmlToMsxml');
const { parseRnefFile } = require('./rnefParser');

ipcMain.handle('sdxml:convert', async (event, { inputDir, outputPath, recursive }) => {
  try {
    const result = sdxmlConvertDir(inputDir, outputPath, (current, total, file) => {
      event.sender.send('sdxml:progress', { current, total, file });
    }, !!recursive);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Cartridge helpers ─────────────────────────────────────────────────────────
// Strip trailing ".bin" from a cartridge directory name for use as a logical identifier.
const cartName = (dirName) => dirName.replace(/\.bin$/i, '');

// ── Cartridge discovery ──────────────────────────────────────────────────────
ipcMain.handle('medscan:listCartridges', () => {
  const s = getStore();
  const medscanDir = s.get('medscanDir');
  if (!medscanDir) return [];
  try {
    return fs.readdirSync(medscanDir)
      .filter(name => name.endsWith('.bin') && fs.statSync(path.join(medscanDir, name)).isDirectory())
      .map(name => ({ name: cartName(name), path: path.join(medscanDir, name) }));
  } catch { return []; }
});

// ── NLP Run ──────────────────────────────────────────────────────────────────
const activeRuns = new Map();
// Stop must end EVERY process of a run (cartridges and rules run in parallel, conceptscan_llm has worker processes): all running processes of a run are kept here, and a stopped run starts no further step
const runProcs = new Map();                                        // runId -> Set of the running child processes
const stoppedRuns = new Set();
function trackProc(runId, proc) {
  activeRuns.set(runId, proc);
  if (!runProcs.has(runId)) runProcs.set(runId, new Set());
  const set = runProcs.get(runId); set.add(proc);
  proc.on('close', () => set.delete(proc));
  if (stoppedRuns.has(runId)) killTree(proc);                      // started just as Stop was pressed
}
function killTree(p) {
  try { if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { windowsHide: true }); else p.kill(); } catch { try { p.kill(); } catch {} }
}

// ── Pure function: build command objects from run parameters ─────────────────
// xmlFormat: 'pubmed' | 'pmc' | 'sciencedirect' | 'consyn' | 'html'
// Determines which locscan input mode is used for .xml files.
// .nxml always → pmctext:   .msxml/.sdxml always → msxml:
function buildCommandObjects({ inputs, cartridges, outputDir, organism, license, userDict, bwFilter, cooccurrence, xmlFormat = 'pubmed' }) {
  // .xml files: format tells locscan how to parse them
  const xmlFiles   = inputs.filter(f => path.extname(f).toLowerCase() === '.xml');
  // .msxml/.sdxml: always msxml: mode regardless of format selection
  const msxmlFiles = inputs.filter(f => ['.msxml', '.sdxml'].includes(path.extname(f).toLowerCase()));
  // .nxml: always pmctext: mode
  const nxmlFiles  = inputs.filter(f => path.extname(f).toLowerCase() === '.nxml');
  // .html — converted to msxml: before locscan; treated same as msxml here
  const htmlFiles  = inputs.filter(f => path.extname(f).toLowerCase() === '.html');

  const commands = [];
  for (const cartridge of cartridges) {
    const cartShort = path.basename(cartridge.path).replace('.bin', '').toLowerCase();
    const locscan   = path.join(cartridge.path, process.platform === 'win32' ? 'locscan.exe' : 'locscan');

    const userDictArg = userDict ? [`-W${userDict}`] : [];
    const bwFilterArg = bwFilter ? [`-f${bwFilter}`] : [];
    const orgArgs     = organism ? [`-Q${organism}`] : [];
    const baseFlags   = ['-w', '-t', license, ...userDictArg, ...bwFilterArg, ...orgArgs];
    const extractFlag = cooccurrence ? 'allpats+coocr:c2rern:' : 'allpats:c2rern:';

    // ── .xml files: mode depends on xmlFormat selection ──────────────────────
    if (xmlFiles.length > 0) {
      if (xmlFormat === 'pubmed') {
        // Batch mode: pipe file list via stdin → single output file
        const outBase = path.join(outputDir, `pubmed.${cartShort}`);
        commands.push({
          exe: locscan,
          args: [...baseFlags, 'pmxmlfiles:-', `${extractFlag}${outBase}.rnef`],
          stdinLines: xmlFiles,
          stderrFile: `${outBase}.log`,
        });
      } else if (xmlFormat === 'pmc') {
        // JATS/PMC XML stored with .xml extension — per-file pmctext: mode
        for (const inp of xmlFiles) {
          const base = path.join(outputDir, path.basename(inp, '.xml'));
          commands.push({
            exe: locscan,
            args: [...baseFlags, `pmctext:${inp}`, `${extractFlag}${base}.${cartShort}.rnef`],
            stderrFile: `${base}.${cartShort}.log`,
          });
        }
      } else if (xmlFormat === 'sciencedirect') {
        // ScienceDirect XML — per-file msxml: mode
        for (const inp of xmlFiles) {
          const base = path.join(outputDir, path.basename(inp, '.xml'));
          commands.push({
            exe: locscan,
            args: [...baseFlags, `msxml:${inp}`, `${extractFlag}${base}.${cartShort}.rnef`],
            stderrFile: `${base}.${cartShort}.log`,
          });
        }
      } else if (xmlFormat === 'consyn') {
        // Consyn XML — batch mode: pipe full file list via stdin, single output per cartridge
        const outBase = path.join(outputDir, `consyn.${cartShort}`);
        commands.push({
          exe: locscan,
          args: [...baseFlags, 'elstextfiles:-', `${extractFlag}${outBase}.rnef`],
          stdinLines: xmlFiles,
          stderrFile: `${outBase}.log`,
        });
      }
    }

    // ── .msxml / .sdxml — always msxml: mode ─────────────────────────────────
    for (const inp of msxmlFiles) {
      const base = path.join(outputDir, path.basename(inp, path.extname(inp)));
      commands.push({ exe: locscan, args: [...baseFlags, `msxml:${inp}`, `${extractFlag}${base}.${cartShort}.rnef`],
                      stderrFile: `${base}.${cartShort}.log` });
    }

    // ── .nxml — always pmctext: mode ─────────────────────────────────────────
    for (const inp of nxmlFiles) {
      const base = path.join(outputDir, path.basename(inp, '.nxml'));
      commands.push({ exe: locscan, args: [...baseFlags, `pmctext:${inp}`, `${extractFlag}${base}.${cartShort}.rnef`],
                      stderrFile: `${base}.${cartShort}.log` });
    }
  }

  // Attach the canonical string representation to each object
  return commands.map(c => ({
    ...c,
    cmdStr: [c.exe, ...c.args].join(' ') + (c.stdoutFile ? ` >${c.stdoutFile}` : ''),
  }));
}

// ── Shared: execute a command object and stream events ───────────────────────
function execCommand(cmd, runId, send, outputDir) {
  return new Promise((resolve) => {
    send('cmd', { cmd: cmd.cmdStr });

    const proc = cmd._shellLine
      ? spawn(cmd._shellLine, { shell: true, cwd: outputDir })
      : spawn(cmd.exe, cmd.args, { cwd: outputDir });

    trackProc(runId, proc);

    // stdin: pipe file list for pmxmlfiles:- / elstextfiles:- mode
    if (cmd.stdinLines && cmd.stdinLines.length > 0) {
      // Attach error handler BEFORE writing — prevents uncaught EPIPE/EOF if
      // the child process closes its stdin end early (e.g. after reading all paths).
      proc.stdin.on('error', () => {});
      proc.stdin.write(cmd.stdinLines.join('\n') + '\n', () => {
        proc.stdin.end();
      });
    }

    // stdout
    if (cmd.stdoutFile && !cmd._shellLine) {
      // shell:true with > in cmdStr handles redirect itself; only pipe when not shell
      const outStream = fs.createWriteStream(cmd.stdoutFile);
      proc.stdout.pipe(outStream);
      proc.stdout.on('data', d => send('stdout', d.toString()));
    } else {
      proc.stdout.on('data', d => send('stdout', d.toString()));
    }

    const stderrChunks = [];
    proc.stderr.on('data', d => { send('stderr', d.toString()); stderrChunks.push(d); });

    proc.on('close', code => {
      if (cmd.stderrFile && !cmd._shellLine && stderrChunks.length > 0) {
        fs.writeFileSync(cmd.stderrFile, Buffer.concat(stderrChunks));
      }
      send('cmdDone', { code, cmd: cmd.cmdStr });
      resolve();
    });
    proc.on('error', err => { send('error', err.message); resolve(); });
  });
}

// ── Run NLP commands with a bounded number in parallel (Settings → "Max parallel cartridges") ───
// Default 2. Each command is one MedScan/locscan process (one per cartridge, or per cartridge × input file).
async function runCommandsLimited(commands, runId, send, outputDir) {
  const limit = Math.max(1, parseInt(getStore().get('maxParallelCartridges')) || 2);
  if (commands.length > 1) send('info', `Running ${commands.length} command(s), at most ${limit} in parallel (NLP Runner → Max parallel cartridges)`);
  let next = 0;
  const worker = async () => {
    while (next < commands.length) {
      const cmd = commands[next++];
      await execCommand(cmd, runId, send, outputDir);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, commands.length) }, worker));
}

// ── medscan:buildCommands — returns command objects + strings without running ─
ipcMain.handle('medscan:buildCommands', async (event, params) => {
  try {
    const commands = buildCommandObjects(params);
    return { ok: true, commands };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── "Create intermediate files": the stdout of every step of a cartridge's pipeline, for the MSXML input of the run ─────────────
// The pipeline of locscan's `msxml:` input is  MEDSCAN -Imsxml | PROTGLUE | CONCEPTSCAN  (locscan.ini); PROTGLUE may hold several steps (CellEffect: cellscan | reglue,
// GeneticVariant: rescan | gvarscan | reglue ...). Like the Pipeline screen, each step is run on its own and its stdout kept: <Cartridge>.<step>
//   medscan → .ms, reglue → .rg, conceptscan → .cs, cellscan → .cl, rescan → .rs, gvarscan → .gv, ambtag → .at (a tool used several times is numbered: .rg1 .rg2 ...).
// With several MSXML inputs the name starts with the input's name: <input>.<Cartridge>.<step>. The normal run (the .rnef files) is not changed by this.
const STEP_EXT = { medscan: 'ms', reglue: 'rg', conceptscan: 'cs', cellscan: 'cl', rescan: 'rs', gvarscan: 'gv', ambtag: 'at' };
// triple = { kind:'local'|'provider', model, prompts:{<cartridge name>: edited prompt text} } -> the conceptscan step of every cartridge is run by conceptscan_llm instead
// onRecord(rec): called as soon as one (cartridge, input) has finished its steps (not awaited), so its rules can run while the other cartridges are still working.
// Every job also writes <input>.<cartridge>.log into outputDir (what the steps wrote to stderr), as the normal run does.
async function runIntermediateSteps({ cartridges, msxmlPaths, outputDir, stageDir = outputDir, organism, license, userDict, runId, send, triple = null, onRecord = null }) {
  let llmExe = '';
  if (triple) {
    llmExe = llmTriple.findExe(getStore(), path.join(__dirname, '..', '..'));
    if (!llmExe) { send('error', 'Triplefication by LLM: conceptscan_llm (conceptscan.exe) not found - set its path in Settings -> Local LLM settings.'); return []; }
    send('info', `Triplefication: ${triple.kind === 'local' ? 'local LLM ' + triple.model : 'LLM provider ' + (getStore().get('llmProviderName') || '')} via ${llmExe}`);
  }
  const jobs = [], produced = [];                                  // produced: [{ cartridge, msx, base, files:[paths], ms, cs }] — what each (cartridge, input) wrote
  for (const cartridge of cartridges) for (const msx of msxmlPaths) jobs.push({ cartridge, msx });
  const limit = Math.max(1, parseInt(getStore().get('maxParallelCartridges')) || 2);
  const NLC = String.fromCharCode(10);
  send('info', `Creating intermediate files (${STEP_EXT.medscan}, ${STEP_EXT.reglue}, ${STEP_EXT.conceptscan} …) for ${cartridges.length} cartridge(s) × ${msxmlPaths.length} input file(s)`);
  // LLM progress: conceptscan_llm writes "[llm] <done> <total>" to stderr after every sentence the LLM answered (CSLLM_PROGRESS=1); the sums over all jobs go to the Runner as 'llm-progress'
  const llmProg = new Map(); let llmT0 = 0, llmFinished = 0;
  const sendLlm = () => {
    const sum = { done: 0, total: 0, cached: 0, sentences: 0, single: 0, none: 0, nopair: 0 };
    for (const p of llmProg.values()) for (const k of Object.keys(sum)) sum[k] += p[k] || 0;
    send('llm-progress', { ...sum, started: llmProg.size, finished: llmFinished, cartridges: jobs.length, t0: llmT0 });
  };
  const runStep = (cartPath, exe, args, stdinFile, stdoutFile, exeOverride = '', env = undefined, onLlm = null, log = null) => new Promise((resolve) => {
    const exePath = exeOverride || path.join(cartPath, process.platform === 'win32' && !exe.endsWith('.exe') ? exe + '.exe' : exe);
    let proc;
    try { proc = spawn(exePath, args, { cwd: cartPath, ...(env ? { env } : {}) }); } catch (e) { send('error', `${exe}: ${e.message}`); return resolve(-1); }
    trackProc(runId, proc);
    const input = fs.createReadStream(stdinFile), output = fs.createWriteStream(stdoutFile);
    input.on('error', () => {}); proc.stdin.on('error', () => {});
    input.pipe(proc.stdin); proc.stdout.pipe(output);
    let carry = '';
    const NL = String.fromCharCode(10);
    proc.stderr.on('data', d => {
      if (!onLlm) { send('stderr', d.toString()); if (log) log(d.toString()); return; }
      carry += d.toString();
      const ls = carry.split(NL); carry = ls.pop();
      const rest = [];
      for (const l of ls) {                                                                             // the counter lines are not log text
        let m = /^\[llm\] (\d+) (\d+)(?: (\d+))?/.exec(l);
        if (m) { onLlm({ done: Number(m[1]), total: Number(m[2]), cached: Number(m[3] || 0) }); continue; }
        m = /^\[llm-info\] sentences=(\d+) eligible=(\d+) single=(\d+) none=(\d+) nopair=(\d+)/.exec(l);
        if (m) { onLlm({ sentences: Number(m[1]), single: Number(m[3]), none: Number(m[4]), nopair: Number(m[5]) }); if (log) log(l + NL); continue; }
        rest.push(l);
      }
      if (rest.length) { send('stderr', rest.join(NL) + NL); if (log) log(rest.join(NL) + NL); }
    });
    proc.on('error', e => { send('error', `${exe}: ${e.message}`); output.end(); resolve(-1); });
    proc.on('close', code => { if (carry.trim()) { send('stderr', carry); if (log) log(carry); } output.end(() => resolve(code ?? 0)); });
  });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !stoppedRuns.has(runId)) {
      const { cartridge, msx } = jobs[next++];
      try {
        const abbrevs = (parsePipelineIni(path.join(cartridge.path, 'locscan.ini')).abbreviations) || {};
        const expand = (str) => str.replace(/\$\{([A-Z0-9]+)\}/g, (_, k) => abbrevs[k] || '');
        const vars = { organism: organism || 'Mammal', license: license || '', userDict: userDict || '' };
        const medscan = expand(abbrevs['MEDSCAN'] || './medscan -p -T -Lext -Aadv -s tlim -P dmrg -Q$Q -Oc. -Of -t$t -H msdata -W$W -b msbatch');
        const glue = expand(abbrevs['PROTGLUE'] || './reglue -b prgl.rgbatch').split('|').map(s => s.trim()).filter(Boolean);
        const concept = expand(abbrevs['CONCEPTSCAN'] || './conceptscan -t$t -O2 -H csdata');
        const steps = [{ cmd: medscan, extra: ['-Imsxml'] }, ...glue.map(g => ({ cmd: g, extra: [] })), { cmd: concept, extra: [] }].map(s => {
          const parts = s.cmd.trim().split(/\s+/); const exe = parts[0].replace(/^\.\//, '');
          return { exe, args: [...parsePipelineCmdArgs(s.cmd, vars), ...s.extra] };
        });
        const count = {}; steps.forEach(s => { count[s.exe] = (count[s.exe] || 0) + 1; });
        const seen = {};
        const inBase = path.basename(msx, path.extname(msx));
        const base = msxmlPaths.length === 1 ? cartridge.name : `${inBase}.${cartridge.name}`;
        let prev = msx;
        const logFile = path.join(outputDir, `${inBase}.${path.basename(cartridge.path).replace('.bin', '').toLowerCase()}.log`);
        try { fs.writeFileSync(logFile, ''); } catch { /* no log file: the Execution Log still has everything */ }
        const log = (t) => { try { fs.appendFileSync(logFile, t.endsWith(NLC) ? t : t + NLC); } catch {} };
        const rec = { cartridge, msx, base, files: [], ms: null, cs: null, log }; produced.push(rec);
        log(`${new Date().toISOString()} ${cartridge.name}: ${path.basename(msx)}`);
        for (const st of steps) {
          if (stoppedRuns.has(runId)) break;
          seen[st.exe] = (seen[st.exe] || 0) + 1;
          if (st.exe === 'conceptscan') rec.msout = prev;                  // what goes into conceptscan: the markup the -Imsout rules read
          const ext = (STEP_EXT[st.exe] || st.exe) + (count[st.exe] > 1 ? seen[st.exe] : '');
          const out = path.join(stageDir, `${base}.${ext}`);
          let code;
          if (llmExe && st.exe === 'conceptscan') {                     // the LLM writes the same pseudo-sentences; its prompt (edited in the Runner, else the default) is a file next to the results
            let promptFile = '';
            const edited = triple.prompts && triple.prompts[cartridge.name];
            if (edited && edited.trim()) { promptFile = path.join(stageDir, `${cartridge.name}.prompt.txt`); fs.writeFileSync(promptFile, edited, 'utf8'); }
            const env = llmTriple.buildEnv(getStore(), triple, cartridge.path, promptFile);
            send('info', `  ${cartridge.name}: conceptscan_llm, ${promptFile ? 'edited prompt (' + path.basename(promptFile) + ')' : 'default prompt'}`);
            log(`conceptscan_llm, ${promptFile ? 'edited prompt' : 'default prompt'}`);
            const jobKey = cartridge.name + '|' + msx;
            if (!llmT0) llmT0 = Date.now();
            llmProg.set(jobKey, { done: 0, total: 0 }); sendLlm();
            code = await runStep(cartridge.path, st.exe, st.args, prev, out, llmExe, { ...env, CSLLM_PROGRESS: '1' }, (u) => { llmProg.set(jobKey, { ...(llmProg.get(jobKey) || {}), ...u }); sendLlm(); }, log);
            const pr = llmProg.get(jobKey); if (pr) pr.done = pr.total; llmFinished++; sendLlm();
          } else code = await runStep(cartridge.path, st.exe, st.args, prev, out, '', undefined, null, log);
          let size = 0; try { size = fs.statSync(out).size; } catch {}
          send('info', `  ${path.basename(out)} — ${st.exe} exit ${code}, ${size} bytes`);
          log(`${path.basename(out)} — ${st.exe} exit ${code}, ${size} bytes`);
          rec.files.push(out); if (st.exe === 'medscan') rec.ms = out; if (st.exe === 'conceptscan') rec.cs = out;
          if (code !== 0 && size === 0) { send('warn', `${cartridge.name}: step ${st.exe} failed — later steps skipped`); break; }
          prev = out;
        }
        if (onRecord && !stoppedRuns.has(runId)) onRecord(rec);        // its rules can start now
      } catch (e) { send('error', `${cartridge.name}: intermediate files failed: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return produced;
}

// ── "Rules split output": one RNEF file per rule of allpats() ───────────────────────────────────────────────────────────────
// locscan writes ONE .rnef for `allpats:c2rern:<file>` — every rule of allpats=$(a+b+c ...) in [output] of locscan.ini is run on the same data and the results are merged.
// Here each rule (one .grbatch, e.g. bmcs1 = msgrep -Icsout -H grdata/biomarkers/cs1 -b bmcs1.grbatch | xf2rn) is run on its own on the intermediate files made by
// runIntermediateSteps — -Imsout rules on the file that goes into conceptscan (<Cartridge>.rg / the last glue file), all others on <Cartridge>.cs, as in the Pipeline screen — followed by the same c2rern converter chain, into
//   <input>.<cartridge>.<rule>.rnef
// Arguments of one program of a rule line: the locscan variables are filled ($t license, $Q organism, $W user dictionary) and every token that keeps an unset variable
// (-f$f -D$D -S$S -A$A ... ) is dropped. Unlike parsePipelineCmdArgs this keeps the bare flags of the converters (rn2rn -c, -R TextPath, -u, -l ...).
function ruleArgs(segment, { organism, license, userDict }) {
  const val = { t: license || '', Q: organism || 'Mammal', W: userDict || '' };
  const out = [];
  for (const tok0 of segment.trim().split(/\s+/).slice(1)) {
    if (!tok0 || /^-[wvq]$/.test(tok0)) continue;
    let empty = false;
    const tok = tok0.replace(/\$\{?([tQW])\}?/g, (_, k) => { if (!val[k]) empty = true; return val[k]; });
    if (empty || /\$/.test(tok)) continue;
    out.push(tok);
  }
  return out;
}
async function runSplitRules({ produced, outputDir, organism, license, userDict, cooccurrence, runId, send }) {
  const tasks = [];
  for (const rec of produced) {
    const cartPath = rec.cartridge.path, cartShort = path.basename(cartPath).replace('.bin', '').toLowerCase();
    let ini; try { ini = parsePipelineIni(path.join(cartPath, 'locscan.ini')); } catch (e) { send('error', `${rec.cartridge.name}: ${e.message}`); continue; }
    const ab = ini.abbreviations || {}, outp = ini.output || {};
    const expand = (str) => str.replace(/\$\{([A-Z0-9]+)\}/g, (_, k) => ab[k] || '');
    const rules = (outp.allpats || '').replace(/^\$\(/, '').replace(/\)$/, '').split('+').map(x => x.trim()).filter(Boolean);
    if (cooccurrence && outp.coocr) rules.push('coocr');
    const conv = outp['c2rern:'] || '';
    const inBase = path.basename(rec.msx, path.extname(rec.msx));
    for (const rule of rules) {
      if (!outp[rule]) { send('warn', `${rec.cartridge.name}: rule "${rule}" of allpats is not defined in [output] — skipped`); continue; }
      const line = expand(outp[rule] + ' ' + conv);
      const fmt = (line.match(/-I\s*(msout|csout)/i) || [, 'msout'])[1].toLowerCase();       // msgrep's default input format is msout
      const input = fmt === 'msout' ? (rec.msout || rec.ms) : rec.cs;       // -Imsout: the markup that goes into conceptscan (after the glue stages), -Icsout: what conceptscan wrote
      if (!input || !fs.existsSync(input)) { send('warn', `${rec.cartridge.name}.${rule}: no ${fmt} file — skipped`); continue; }
      const vars = { organism: organism || 'Mammal', license: license || '', userDict: userDict || '' };
      const segs = line.split('|').map(x => x.trim()).filter(Boolean).map(sg => ({ exe: sg.split(/\s+/)[0].replace(/^\.\//, ''), args: ruleArgs(sg, vars) }));
      tasks.push({ name: `${rec.cartridge.name}.${rule}`, cartPath, segs, input, out: path.join(outputDir, `${inBase}.${cartShort}.${rule}.rnef`), log: rec.log || null });
    }
  }
  send('info', `Rules split output: ${tasks.length} rule(s) → one .rnef each`);
  const runChain = (t) => new Promise((resolve) => {
    const procs = [];
    for (const sg of t.segs) {
      const exePath = path.join(t.cartPath, process.platform === 'win32' && !sg.exe.endsWith('.exe') ? sg.exe + '.exe' : sg.exe);
      if (!fs.existsSync(exePath)) { send('warn', `${t.name}: ${path.basename(exePath)} not found in the cartridge — rule skipped`); return resolve(-1); }
      try { procs.push(spawn(exePath, sg.args, { cwd: t.cartPath })); } catch (e) { send('warn', `${t.name}: ${e.message}`); procs.forEach(p => { try { p.kill(); } catch {} }); return resolve(-1); }
    }
    procs.forEach(p => trackProc(runId, p));
    const input = fs.createReadStream(t.input), output = fs.createWriteStream(t.out);
    input.on('error', () => {}); procs[0].stdin.on('error', () => {});
    input.pipe(procs[0].stdin);
    procs.forEach((p, i) => { if (i + 1 < procs.length) { p.stdout.pipe(procs[i + 1].stdin); procs[i + 1].stdin.on('error', () => {}); } p.stderr.on('data', d => { send('stderr', d.toString()); if (t.log) t.log(d.toString()); }); p.on('error', e => send('warn', `${t.name}: ${e.message}`)); });
    procs[procs.length - 1].stdout.pipe(output);
    procs[procs.length - 1].on('close', code => output.end(() => resolve(code ?? 0)));
  });
  const limit = Math.max(1, parseInt(getStore().get('maxParallelCartridges')) || 2);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !stoppedRuns.has(runId)) {
      const t = tasks[next++];
      const code = await runChain(t);
      let size = 0; try { size = fs.statSync(t.out).size; } catch {}
      send('info', `  ${path.basename(t.out)} — exit ${code}, ${size} bytes`);
      if (t.log) t.log(`${path.basename(t.out)} — exit ${code}, ${size} bytes`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

// ── medscan:run ───────────────────────────────────────────────────────────────
ipcMain.handle('medscan:run', async (event, { inputs, cartridges, outputDir, organism, license, userDict, bwFilter, cooccurrence, xmlFormat = 'pubmed', keepMsxml = false, intermediateFiles = false, splitRules = false }) => {
  const runId = Date.now().toString();
  stoppedRuns.delete(runId); runProcs.delete(runId);
  // Triplefication by an LLM: locscan runs its own conceptscan inside the pipeline, so the steps are run one by one (as for "Rules split output") with conceptscan_llm in place of
  // conceptscan, and the rules are applied to the .cs it wrote: one .rnef per rule. The .cs (the LLM's triples) is kept next to them.
  const llmTriple_ = storedTriple();                              // the choice of the Triplefication panel (shared with the Pipeline screen)
  if (llmTriple_) splitRules = true;
  const send = (type, data) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('run:event', { runId, type, data });
  };
  if (llmTriple_) clearLlmCacheForRun((t) => send('info', t));

  const xmlFiles   = inputs.filter(f => path.extname(f).toLowerCase() === '.xml');
  const msxmlFiles = inputs.filter(f => ['.msxml', '.sdxml'].includes(path.extname(f).toLowerCase()));
  const nxmlFiles  = inputs.filter(f => path.extname(f).toLowerCase() === '.nxml');
  const htmlFiles  = inputs.filter(f => path.extname(f).toLowerCase() === '.html');
  const unknown    = inputs.filter(f => !['.xml','.msxml','.sdxml','.nxml','.html'].includes(path.extname(f).toLowerCase()));

  // "Create intermediate files" / "Rules split output": run the pipeline steps on their own for the MSXML inputs; true = skip the normal combined run (split mode writes one .rnef per rule instead)
  const stagedPhase = async (msxmlPaths) => {
    if (!intermediateFiles && !splitRules) return false;
    // without "Create intermediate files" the steps (.ms, .rg, .cs ...) are only plumbing for the rules: they are written to a temporary folder, not to the output directory, and the folder is removed at the end
    let stageDir = outputDir;
    if (!intermediateFiles) { try { stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nlpm-stage-')); } catch (e) { send('warn', 'No temporary folder (' + e.message + '): the intermediate files are written to the output directory and deleted after the run'); } }
    const produced = [];
    try {
      // each cartridge's rules run as soon as its own steps are done (its .rnef files and .log appear while the others are still working); one cartridge's rules at a time
      let splitChain = Promise.resolve();
      const onRecord = splitRules ? (rec) => { splitChain = splitChain.then(() => runSplitRules({ produced: [rec], outputDir, organism, license, userDict, cooccurrence, runId, send })).catch(e => send('error', `${rec.cartridge.name}: rules failed: ${e.message}`)); } : null;
      produced.push(...await runIntermediateSteps({ cartridges, msxmlPaths, outputDir, stageDir, organism, license, userDict, runId, send, triple: llmTriple_, onRecord }));
      await splitChain;
    } finally {
      if (!intermediateFiles) {
        let ok = false;
        for (let k = 0; k < 5 && !ok; k++) {
          try {
            if (stageDir !== outputDir) fs.rmSync(stageDir, { recursive: true, force: true });
            else for (const r of produced) for (const f of r.files) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
            ok = true;
          } catch (e) { await new Promise(res => setTimeout(res, 300)); }                              // (Windows: a file a process has just closed may still be locked for a moment)
        }
        if (!ok) send('warn', 'Could not delete the temporary files in ' + stageDir);
      }
    }
    return splitRules;
  };

  const formatLabel = { pubmed: 'PubMed', pmc: 'PubMed Central', sciencedirect: 'ScienceDirect', consyn: 'Consyn', html: 'HTML', msxml: 'MedScan msxml' }[xmlFormat] || xmlFormat;
  send('start', { inputs, cartridges, outputDir });
  unknown.forEach(f => send('warn', `Skipping ${path.basename(f)} — unrecognised extension "${path.extname(f)}"`));
  send('info', `Input: ${xmlFiles.length} .xml (format: ${formatLabel}), ${msxmlFiles.length} .msxml/.sdxml, ${nxmlFiles.length} .nxml, ${htmlFiles.length} .html`);

  // ── Keep intermediate .msxml: PubMed / PMC two-phase (convert once → msxml, keep it) ──────
  // Creating the .msxml is the slow step for big batches; with the checkbox on, the file is written to
  // the output directory and is never deleted, so it can be re-run quickly with input format "MedScan (msxml)".
  if ((keepMsxml || intermediateFiles || splitRules) && (xmlFormat === 'pubmed' || xmlFormat === 'pmc')) {
    const convFiles = xmlFormat === 'pubmed' ? xmlFiles : [...xmlFiles, ...nxmlFiles];
    const binDir  = cartridges[0].path;
    const exeName = xmlFormat === 'pubmed' ? 'msxml' : 'pmctext';
    const exe     = path.join(binDir, process.platform === 'win32' ? exeName + '.exe' : exeName);
    if (convFiles.length > 0 && fs.existsSync(exe)) {
      const keepMsxmlPath = path.join(outputDir, `${xmlFormat}.msxml`);
      const tempList      = path.join(outputDir, `_${xmlFormat}_list_${runId}.txt`);
      fs.writeFileSync(tempList, convFiles.join('\n') + '\n');
      const convArgs = xmlFormat === 'pubmed'
        ? ['-w', '-T', '-Ipmxml', '-l', tempList, '-o', keepMsxmlPath]
        : ['-w', '-A', '-T', '-l', tempList, '-o', keepMsxmlPath];
      const shellCmd = `"${exe}" ${convArgs.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
      send('info', `Phase 1/2 — converting ${convFiles.length} file(s) to .msxml via ${exeName}…`);
      send('cmdList', { commands: [shellCmd] });
      await new Promise((resolve) => {
        const proc = spawn(exe, convArgs, { cwd: binDir });
        trackProc(runId, proc);
        proc.stderr.on('data', d => send('stderr', d.toString()));
        proc.on('close', code => { send('info', `${exeName} exit code: ${code}`); resolve(); });
        proc.on('error', err => { send('error', `${exeName}: ${err.message}`); resolve(); });
      });
      try { fs.unlinkSync(tempList); } catch {}
      const size = (() => { try { return fs.statSync(keepMsxmlPath).size; } catch { return 0; } })();
      send('info', `${exeName} output size: ${size} bytes`);
      if (size > 0) {
        send('info', `Phase 2/2 — running ${cartridges.length} cartridge(s) in parallel against ${path.basename(keepMsxmlPath)}…`);
        const phase2Cmds = buildCommandObjects({
          inputs: [keepMsxmlPath], cartridges, outputDir, organism, license, userDict, bwFilter, cooccurrence,
          xmlFormat: 'sciencedirect', // .msxml → msxml: mode
        });
        send('cmdList', { commands: phase2Cmds.map(c => c.cmdStr) });
        if (!(await stagedPhase([keepMsxmlPath]))) await runCommandsLimited(phase2Cmds, runId, send, outputDir);
        if (keepMsxml) send('info', `Kept intermediate file: ${keepMsxmlPath}`);
        else { try { fs.unlinkSync(keepMsxmlPath); } catch {} }
        const outputFiles = [];
        try { outputFiles.push(...fs.readdirSync(outputDir).filter(f => f.endsWith('.rnef')).map(f => path.join(outputDir, f))); } catch {}
        send('done', { outputFiles });
        activeRuns.delete(runId);
        return runId;
      }
      send('warn', `${exeName} produced empty output — falling back to the normal run (no .msxml kept)`);
      try { fs.unlinkSync(keepMsxmlPath); } catch {}
    } else if (convFiles.length > 0) {
      send('warn', `${exeName} not found in ${binDir} — running without the intermediate .msxml`);
    }
  }
  // ── ScienceDirect XML → MSXML (sdxmlToMsxml.js), then all cartridges in parallel ──────────
  // ScienceDirect .sdxml / .xml are NOT MSXML: they must be converted first. With "Keep intermediate
  // .msxml file" the result is kept as sciencedirect.msxml in the output directory (reusable via the
  // "MedScan (msxml)" input format); otherwise it is a temp file removed after the run.
  if (xmlFormat === 'sciencedirect') {
    const sdFiles = [...xmlFiles, ...inputs.filter(f => path.extname(f).toLowerCase() === '.sdxml')];
    if (sdFiles.length > 0) {
      const msxmlPath = keepMsxml
        ? path.join(outputDir, 'sciencedirect.msxml')
        : path.join(outputDir, `_sciencedirect_${runId}.msxml`);
      send('info', `Phase 1/2 — converting ${sdFiles.length} ScienceDirect XML file(s) to MSXML…`);
      let conv = null;
      try {
        let lastReport = 0;
        conv = await require('./sdxmlToMsxml').convertFiles(sdFiles, msxmlPath, (i, n) => {
          if (i - lastReport >= 1000 || i === n) { lastReport = i; send('info', `  converted ${i} / ${n}`); }
        });
      } catch (e) {
        send('error', `ScienceDirect → MSXML conversion failed: ${e.message}`);
      }
      if (conv) {
        send('info', `ScienceDirect → MSXML: ${conv.converted} converted, ${conv.errors.length} failed`);
        conv.errors.slice(0, 5).forEach(er => send('warn', `${er.file}: ${er.error}`));
      }
      if (conv && conv.converted > 0) {
        send('info', `Phase 2/2 — running ${cartridges.length} cartridge(s) in parallel against ${path.basename(msxmlPath)}…`);
        const phase2Cmds = buildCommandObjects({
          inputs: [msxmlPath], cartridges, outputDir, organism, license, userDict, bwFilter, cooccurrence,
          xmlFormat: 'sciencedirect', // .msxml → msxml: mode
        });
        send('cmdList', { commands: phase2Cmds.map(c => c.cmdStr) });
        if (!(await stagedPhase([msxmlPath]))) await runCommandsLimited(phase2Cmds, runId, send, outputDir);
        if (keepMsxml) send('info', `Kept intermediate file: ${msxmlPath}`);
        else { try { fs.unlinkSync(msxmlPath); } catch {} }
      } else {
        send('error', 'No ScienceDirect file could be converted to MSXML.');
        try { fs.unlinkSync(msxmlPath); } catch {}
      }
      const outputFiles = [];
      try { outputFiles.push(...fs.readdirSync(outputDir).filter(f => f.endsWith('.rnef')).map(f => path.join(outputDir, f))); } catch {}
      send('done', { outputFiles });
      activeRuns.delete(runId);
      return runId;
    }
  }
  if (keepMsxml && xmlFormat === 'msxml') {
    send('info', 'Input is already .msxml — nothing to keep.');
  }

  // ── Consyn optimisation: elstext.exe once → all cartridges in parallel ──────
  if (xmlFormat === 'consyn' && xmlFiles.length > 0) {
    const binDir   = cartridges[0].path;
    const elstext  = path.join(binDir, process.platform === 'win32' ? 'elstext.exe' : 'elstext');
    const hasElstext = fs.existsSync(elstext);

    let usedTwoPhase = false;

    if (hasElstext) {
      // Write file list to a temp text file so the shell can redirect it to elstext stdin.
      // Using cmd /c "prog" < file is more reliable than Node's proc.stdin.write on Windows.
      const tempList  = path.join(outputDir, `_consyn_list_${runId}.txt`);
      // Keep mode: stable, discoverable name; otherwise a throw-away temp file
      const tempMsxml = keepMsxml ? path.join(outputDir, 'consyn.msxml') : path.join(outputDir, `_consyn_${runId}.msxml`);
      fs.writeFileSync(tempList, xmlFiles.join('\n') + '\n');

      // elstext reads the file list with -l and writes MSXML with -o (-T/-A add the title/abstract sections,
      // as in the locscan.ini ELSTXT abbreviation). Without -l it was given no input files.
      const elsArgs  = ['-w', '-T', '-A', '-l', tempList, '-o', tempMsxml];
      const shellCmd = `"${elstext}" ${elsArgs.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
      send('info', `Phase 1/2 — converting ${xmlFiles.length} XML files via elstext.exe…`);
      send('cmdList', { commands: [shellCmd] });

      await new Promise((resolve) => {
        const proc = spawn(elstext, elsArgs, { cwd: outputDir });
        trackProc(runId, proc);
        proc.stderr.on('data', d => send('stderr', d.toString()));
        proc.on('close', (code) => { send('info', `elstext.exe exit code: ${code}`); resolve(); });
        proc.on('error', err => { send('error', `elstext: ${err.message}`); resolve(); });
      });

      try { fs.unlinkSync(tempList); } catch {}

      const msxmlSize = (() => { try { return fs.statSync(tempMsxml).size; } catch { return 0; } })();
      send('info', `elstext output size: ${msxmlSize} bytes`);

      if (msxmlSize > 0) {
        // Phase 2: all cartridges in parallel against the single converted msxml
        send('info', `Phase 2/2 — running ${cartridges.length} cartridge(s) against ${path.basename(tempMsxml)}…`);
        const phase2Cmds = buildCommandObjects({
          inputs: [tempMsxml], cartridges, outputDir, organism, license, userDict, bwFilter, cooccurrence,
          xmlFormat: 'sciencedirect',  // .msxml extension → msxml: mode
        });
        send('cmdList', { commands: phase2Cmds.map(c => c.cmdStr) });
        if (!(await stagedPhase([tempMsxml]))) await runCommandsLimited(phase2Cmds, runId, send, outputDir);
        if (keepMsxml) send('info', `Kept intermediate file: ${tempMsxml}`);
        else { try { fs.unlinkSync(tempMsxml); } catch {} }
        usedTwoPhase = true;
      } else {
        send('warn', 'elstext.exe produced empty output — falling back to parallel elstextfiles:- mode');
        try { fs.unlinkSync(tempMsxml); } catch {}
      }
    }

    if (!usedTwoPhase) {
      // Fallback: run all cartridges in parallel, each converts independently
      if (!hasElstext) send('info', 'elstext.exe not found — running cartridges in parallel with elstextfiles:-');
      const commands = buildCommandObjects({ inputs, cartridges, outputDir, organism, license, userDict, bwFilter, cooccurrence, xmlFormat });
      send('cmdList', { commands: commands.map(c => c.cmdStr) });
      await runCommandsLimited(commands, runId, send, outputDir);
    }

    const outputFiles = [];
    try {
      const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.rnef'));
      outputFiles.push(...files.map(f => path.join(outputDir, f)));
    } catch {}
    send('done', { outputFiles });
    activeRuns.delete(runId);
    return runId;
  }
  // ── HTML: convert all .html files once via htmltext.py → temp msxml,
  //          then run all cartridges in parallel against that single file ────────
  if (xmlFormat === 'html' && htmlFiles.length > 0) {
    const htmltextPy = path.join(app.getAppPath(), '..', 'htmltext.py');
    if (!fs.existsSync(htmltextPy)) {
      send('error', `htmltext.py not found at ${htmltextPy} — run "Deploy HTML Converter to Cartridges" in Settings`);
      send('done', { outputFiles: [] });
      activeRuns.delete(runId);
      return runId;
    }

    // Name intermediate files after the input directory (e.g. BCEv6.msxml → BCEv6.standard.rnef)
    const inputDirName = path.basename(path.dirname(htmlFiles[0]));
    const tempList  = path.join(outputDir, `${inputDirName}_list_${runId}.txt`);
    const tempMsxml = path.join(outputDir, `${inputDirName}.msxml`);
    fs.writeFileSync(tempList, htmlFiles.join('\n') + '\n');

    const phase1DisplayCmd = `py "${htmltextPy}" -w -T -A -l "${tempList}" -o "${tempMsxml}"`;
    send('info', `Phase 1/2 — converting ${htmlFiles.length} HTML file(s) via htmltext.py…`);
    send('cmdList', { commands: [phase1DisplayCmd] });

    await new Promise((resolve) => {
      // Spawn py directly to avoid cmd /c quoting issues (quoted paths passed as-is to Python)
      const proc = spawn('py', [htmltextPy, '-w', '-T', '-A', '-l', tempList, '-o', tempMsxml], { cwd: outputDir });
      trackProc(runId, proc);
      proc.stderr.on('data', d => send('stderr', d.toString()));
      proc.on('close', code => { send('info', `htmltext.py exit code: ${code}`); resolve(); });
      proc.on('error', err => { send('error', `htmltext.py: ${err.message}`); resolve(); });
    });

    try { fs.unlinkSync(tempList); } catch {}

    const msxmlSize = (() => { try { return fs.statSync(tempMsxml).size; } catch { return 0; } })();
    send('info', `htmltext.py output: ${msxmlSize} bytes`);

    if (msxmlSize > 0) {
      send('info', `Phase 2/2 — running ${cartridges.length} cartridge(s) in parallel…`);
      const phase2Cmds = buildCommandObjects({
        inputs: [tempMsxml], cartridges, outputDir, organism, license, userDict, bwFilter, cooccurrence,
        xmlFormat: 'sciencedirect', // .msxml → msxml: mode
      });
      send('cmdList', { commands: phase2Cmds.map(c => c.cmdStr) });
      if (!(await stagedPhase([tempMsxml]))) await runCommandsLimited(phase2Cmds, runId, send, outputDir);
      if (keepMsxml) send('info', `Kept intermediate file: ${tempMsxml}`);
      else { try { fs.unlinkSync(tempMsxml); } catch {} }
    } else {
      send('error', 'htmltext.py produced empty output. Check that HTML files are named by DOI (e.g. 10.1016_j.example.2024.123456.html).');
      try { fs.unlinkSync(tempMsxml); } catch {}
    }

    const outputFiles = [];
    try { outputFiles.push(...fs.readdirSync(outputDir).filter(f => f.endsWith('.rnef')).map(f => path.join(outputDir, f))); } catch {}
    send('done', { outputFiles });
    activeRuns.delete(runId);
    return runId;
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const commands = buildCommandObjects({ inputs, cartridges, outputDir, organism, license, userDict, bwFilter, cooccurrence, xmlFormat });

  send('cmdList', { commands: commands.map(c => c.cmdStr) });

  const outputFiles = [];
  let skipNormal = false;
  if ((intermediateFiles || splitRules) && msxmlFiles.length) skipNormal = await stagedPhase(msxmlFiles);
  else if (intermediateFiles || splitRules) send('warn', 'Create intermediate files / Rules split output: this input format has no MSXML stage here — use input format "MedScan (.msxml)" or PubMed / PMC / ScienceDirect / Consyn / HTML.');
  if (!skipNormal) await runCommandsLimited(commands, runId, send, outputDir);

  try {
    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.rnef'));
    outputFiles.push(...files.map(f => path.join(outputDir, f)));
  } catch {}

  send('done', { outputFiles });
  activeRuns.delete(runId);
  return runId;
});

// ── medscan:runCustom — run user-edited command lines ────────────────────────
// customLines: string[] — one edited command per line
// originals:   command objects from buildCommands (with stdinLines etc.)
// Lines matching their original cmdStr use the original object (preserves stdin);
// changed lines are run via shell (handles > redirects natively).
ipcMain.handle('medscan:runCustom', async (event, { customLines, originals, outputDir }) => {
  const runId = Date.now().toString();
  const send = (type, data) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('run:event', { runId, type, data });
  };

  send('start', { inputs: [], cartridges: [], outputDir });
  send('info', `Running ${customLines.length} custom command(s)`);
  send('cmdList', { commands: customLines });

  const outputFiles = [];
  for (let i = 0; i < customLines.length; i++) {
    const line   = customLines[i].trim();
    if (!line) continue;
    const orig   = originals?.[i];
    const useOrig = orig && line === orig.cmdStr;

    let cmd;
    if (useOrig) {
      cmd = orig;
    } else {
      // Run via shell; preserve stdin for pmxmlfiles:- if orig has it
      cmd = {
        cmdStr:     line,
        _shellLine: line,
        stdinLines: (line.includes('pmxmlfiles:-') && orig?.stdinLines) ? orig.stdinLines : null,
      };
    }
    await execCommand(cmd, runId, send, outputDir);
  }

  try {
    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.rnef'));
    outputFiles.push(...files.map(f => path.join(outputDir, f)));
  } catch {}

  send('done', { outputFiles });
  activeRuns.delete(runId);
  return runId;
});

ipcMain.handle('medscan:stopRun', (_, runId) => {
  stoppedRuns.add(runId);                                          // no further step / cartridge / rule of this run is started
  const set = runProcs.get(runId);
  if (set) for (const p of [...set]) killTree(p);
  const proc = activeRuns.get(runId);
  if (proc && !(set && set.has(proc))) killTree(proc);
  runProcs.delete(runId); activeRuns.delete(runId);
});

// ── medscan:mapDict — dict:- alias mapping via locscan ────────────────────────
// Input:  { aliases: [{id, alias}], organism, license, cartridgeBinPath }
// Runs:   <cartridgeBinPath>\locscan -w -t <license> -Q<organism> -O0m -k0 dict:<tmpfile>.txt
//         Writes aliases to a temp file; locscan reads it via dict: file mode.
//         No -W on the command line (locscan.ini handles user dict).
// Output: parsed { mapped: [{id, alias, msIds}], unmapped: [{id, alias}] }
ipcMain.handle('medscan:mapDict', async (_, { aliases, organism, license, cartridgeBinPath }) => {
  let tmpFile = null;
  try {
    if (!cartridgeBinPath || typeof cartridgeBinPath !== 'string') {
      return { ok: false, error: 'No cartridge path provided.' };
    }
    // Same as NLP runner: locscan.exe lives inside the .bin folder
    const locscanExe = path.join(cartridgeBinPath, process.platform === 'win32' ? 'locscan.exe' : 'locscan');
    if (!fs.existsSync(locscanExe)) {
      return { ok: false, error: `locscan not found at: ${locscanExe}` };
    }
    const cwd = path.dirname(cartridgeBinPath); // medscanDir (parent of .bin)

    const lic = license || getStore().get('medscanLicense') || '';
    const org = organism || 'Mammal';

    // Write aliases to a temp file — dict:{file}.txt mode (no stdin, no -W)
    tmpFile = path.join(os.tmpdir(), `medscan_import_${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 10)}.txt`);
    const fileContent = aliases.map(({ id, alias }) => `${id}\t${alias}`).join('\n') + '\n';
    fs.writeFileSync(tmpFile, fileContent, 'utf8');

    const licArgs = lic ? ['-t', lic] : [];
    const args = ['-w', ...licArgs, `-Q${org}`, '-O0m', '-k0', `dict:${tmpFile}`];

    const mkDebug = (outputSample = '', stderr = '') => ({
      exe: locscanExe,
      cmdLine: `"${locscanExe}" ${args.join(' ')}`,
      cwd,
      inputFileSample: fileContent.split('\n').slice(0, 5).join('\n'),
      outputSample,
      stderr,
    });
    // Build a map from id → alias so we can recover it from output lines
    const inputMap = new Map(aliases.map(({ id, alias }) => [String(id), alias]));

    // Spawn locscan — reads aliases from temp file, no stdin needed
    const result = await new Promise((resolve) => {
      let proc;
      try { proc = spawn(locscanExe, args, { cwd }); }
      catch (e) { return resolve({ output: '', stderr: e.message, code: -1 }); }
      const out = [], err = [];
      proc.stdout.on('data', d => out.push(d));
      proc.stderr.on('data', d => err.push(d));
      proc.on('error', e => resolve({ output: Buffer.concat(out).toString('utf8'), stderr: e.message, code: -1 }));
      proc.on('close', code => resolve({ output: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: code ?? 0 }));
    });

    // Surface stderr/exit errors so the UI can report them
    if (result.code !== 0 && !result.output) {
      return { ok: false, error: `locscan exited with code ${result.code}. Stderr: ${result.stderr || '(empty)'}`, _debug: mkDebug('', result.stderr) };
    }

    // Output format per line: "{id}:{id}\t{tagged_alias}"
    // tagged_alias for FULLY MAPPED:   ID{id1,id2,...=alias_text}
    // tagged_alias for NOT MAPPED:     alias_text (no ID{} wrapper)
    // Fully mapped = col1 starts with ID{, ends with }, no extra { inside
    // (extra { would mean locscan split the phrase into multiple sub-entities)
    const mapped   = [];
    const unmapped = [];
    for (const line of result.output.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      // Separator between "{in}:{out}" and the tagged text may be a tab or plain whitespace
      const sepM   = t.match(/^(\S+)\s+([\s\S]*)$/);
      const cols   = sepM ? [sepM[1], sepM[2]] : [t];
      // col0 is "{inputId}:{outputId}" — extract the input id (part before first ':')
      const lineId = String(cols[0] || '').split(':')[0].trim();
      if (!inputMap.has(lineId)) continue;           // skip locscan header/footer noise
      const alias  = inputMap.get(lineId);           // recover original alias from input
      const col1   = (cols[1] || '').trim();
      const isFullyMapped = /^ID\{[^{}]*\}$/.test(col1);
      if (isFullyMapped) {
        // Inner format: "id1,id2,...=alias_text" — extract only the numeric IDs
        const inner  = col1.slice(3, -1);            // strip "ID{" and "}"
        const eqPos  = inner.indexOf('=');
        const idsStr = eqPos >= 0 ? inner.slice(0, eqPos) : inner;
        // Exact multiples of 1,000,000 are NLP noun-group markers, not mapping IDs
        const msIds  = idsStr.split(',').map(s => s.trim()).filter(s => s && !(/^\d+$/.test(s) && Number(s) % 1000000 === 0));
        mapped.push({ id: lineId, alias, msIds });
      } else {
        unmapped.push({ id: lineId, alias });
      }
    }

    const outputSample = result.output.split('\n').filter(l => l.trim()).slice(0, 10).join('\n');
    const dbg = mkDebug(outputSample, result.stderr);

    // Fallback: if locscan produced no output but ran OK, treat all aliases as unmapped
    if (mapped.length === 0 && unmapped.length === 0 && aliases.length > 0) {
      return { ok: true, mapped: [], unmapped: aliases.map(a => ({ id: a.id, alias: a.alias })), warn: 'locscan produced no output — treating all aliases as new.', _debug: dbg };
    }

    return { ok: true, mapped, unmapped, _debug: dbg };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
  }
});

// Organism dictionaries available in a cartridge: one <Organism>.msbatch file per organism
ipcMain.handle('medscan:listOrganisms', (_, cartridgeBinPath) => {
  try {
    return fs.readdirSync(cartridgeBinPath)
      .filter(n => /\.msbatch$/i.test(n))
      .map(n => n.replace(/\.msbatch$/i, ''))
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
});

// ── Deploy Dictionaries (backup + export + compile) ───────────────────────────
// cols values:
//   'alias_match' → per-cartridge entity file (medscan_id TAB alias [TAB match])
//   'name_urn'    → ObjectNames file (medscan_id TAB name TAB urn)
//   'xword'       → simple xword file (xword [TAB flags])
//   'xword_flags' → two-column xword file always including flags (xword TAB flags)
//   'spelling'    → two-column file (canonical TAB spellings)
//   'bracketstop' → section-aware file (# comment / word TAB flag / word)
//
// binDir: true  → written once to <medscanDir>/bin/msdata/ (shared across all cartridges)
// binDir: false → written to each selected cartridge's msdata/ or xfdata/
const DEPLOY_FILE_MAP = [
  // ── Per-cartridge entity files ──────────────────────────────────────────────
  { table: 'curnames',       file: 'curNames.tab.e',       dir: 'msdata', hasOrganism: true,  cols: 'alias_match', matchCol: true  },
  { table: 'exactliteral',   file: 'ExactLiteral.tab.e',   dir: 'msdata', hasOrganism: true,  cols: 'alias_match', matchCol: true  },
  { table: 'keywords',       file: 'keywords.tab.e',       dir: 'msdata', hasOrganism: true,  cols: 'alias_match', matchCol: false },
  { table: 'chemnames',      file: 'chemNames.tab.e',      dir: 'msdata', hasOrganism: false, cols: 'alias_match', matchCol: false, binDir: true  },
  { table: 'celldictionary', file: 'cellDictionary.tab.e', dir: 'msdata', hasOrganism: true,  cols: 'alias_match', matchCol: true  },
  { table: 'casdictionary',  file: 'CASDictionary.tab.e',  dir: 'msdata', hasOrganism: true,  cols: 'alias_match', matchCol: true  },
  { table: 'userdict',       file: 'User.tab',             dir: 'msdata', hasOrganism: true,  cols: 'alias_match', matchCol: false },
  { table: 'objectnames',    file: 'ObjectNames.tab',      dir: 'xfdata', hasOrganism: true,  cols: 'name_urn',    matchCol: false },
  // combNames: CellEffect.bin only
  { table: 'combnames',      file: 'combNames.tab.e',      dir: 'msdata', hasOrganism: true,  cols: 'alias_match', matchCol: true,  cartridgeFilter: ['CellEffect'] },
  // rsmap: SNP-to-protein map — written to GeneticVariant.bin/gsdata/ only
  { table: 'rsmap', file: 'rsmap.tab', dir: 'gsdata', cols: 'rsmap', cartridgeFilter: ['GeneticVariant'] },
  // ── Shared xword / term-control files → written once to bin/msdata/ ────────
  { table: 'xwords',         file: 'xwords.tab',       dir: 'msdata', cols: 'xword',       binDir: true },
  { table: 'xwords_cells',   file: 'xwords_cells.tab', dir: 'msdata', cols: 'xword',       binDir: true },
  { table: 'xwords_cas',     file: 'xwords_CAS.tab',   dir: 'msdata', cols: 'xword',       binDir: true },
  { table: 'xwords_comb',    file: 'xwords_comb.tab',  dir: 'msdata', cols: 'xword_flags', binDir: true },
  { table: 'spelling',       file: 'spelling.tab',     dir: 'msdata', cols: 'spelling',    binDir: true },
  { table: 'bracketstop',    file: 'bracketstop.tab',  dir: 'msdata', cols: 'bracketstop', binDir: true },
];

// ── Memory-safe export of a big alias table to cartridge files ───────────────────
// The old code loaded every row of a table (curnames ≈ 1.4M rows, several tables × 3 cartridges in
// parallel) into JS objects and built giant strings → "JavaScript heap out of memory".
// This pages by primary key (indexed), appends lines per organism to a temp file, and finally sorts
// ONE organism file at a time (lines only, no row objects), so memory stays small and bounded.
const EXPORT_PAGE_SIZE = 50000;
const _exportCollator = new Intl.Collator();
const _compareExportLines = (a, b) => {
  const ia = parseInt(a, 10), ib = parseInt(b, 10);
  if (ia !== ib) return (ia || 0) - (ib || 0);          // NLP ID first (numeric)
  return _exportCollator.compare(a, b);                  // then alias text
};
async function exportTablePaged({ dbq, buildQuery, rowToLine, finalPathFor, splitByOrg, organismsSet }) {
  const tmpFiles = new Map();   // organism ('' = none) → temp file path
  let lastId = 0, total = 0;
  for (;;) {
    const { text, values } = buildQuery(lastId, EXPORT_PAGE_SIZE);
    const res = await dbq(text, values);
    if (!res.rows) throw new Error('query failed');
    if (res.rows.length === 0) break;
    const chunks = new Map();
    for (const row of res.rows) {
      const orgs = splitByOrg ? (row.organisms?.length > 0 ? row.organisms : ['']) : [''];
      const line = rowToLine(row);
      for (const org of orgs) {
        if (org && organismsSet) organismsSet.add(org);
        let arr = chunks.get(org);
        if (!arr) { arr = []; chunks.set(org, arr); }
        arr.push(line);
      }
    }
    for (const [org, lines] of chunks) {
      let tmp = tmpFiles.get(org);
      if (!tmp) {
        tmp = finalPathFor(org) + '.tmp';
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.writeFileSync(tmp, '');
        tmpFiles.set(org, tmp);
      }
      fs.appendFileSync(tmp, lines.join('\n') + '\n', 'utf8');
    }
    total += res.rows.length;
    lastId = res.rows[res.rows.length - 1].id;
    if (res.rows.length < EXPORT_PAGE_SIZE) break;
  }
  // Sort + finalize one organism file at a time
  for (const [org, tmp] of tmpFiles) {
    const lines = fs.readFileSync(tmp, 'utf8').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.sort(_compareExportLines);
    fs.writeFileSync(finalPathFor(org), lines.join('\n'), 'utf8');
    fs.unlinkSync(tmp);
  }
  return { total, orgCount: tmpFiles.size };
}

ipcMain.handle('medscan:deployDicts', async (event, { cartridges, medscanDir }) => {
  const send = (type, data) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('deploy:event', { type, data });
  };
  const t0 = Date.now();
  const fmtElapsed = () => {
    const sec = Math.round((Date.now() - t0) / 1000);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
    return h > 0 ? `${h}h ${m}m ${r}s` : m > 0 ? `${m}m ${r}s` : `${r}s`;
  };

  try {
    const pool = await getPool();
    const dbq  = (sql, params = []) => pool.query(sql, params);

    // ── Step 1: Backup ──────────────────────────────────────────────────────
    send('step', { n: 1, msg: 'Creating backup of current dictionary files…' });

    const date      = new Date().toISOString().slice(0, 19).replace(/T/, '_').replace(/:/g, '-');
    const backupDir = path.join(medscanDir, 'DictionaryBackup');
    fs.mkdirSync(backupDir, { recursive: true });
    const zipPath = path.join(backupDir, `backup_${date}.zip`);
    const tmpDir  = path.join(backupDir, `_tmp_${date}`);

    let backedUpCount = 0;
    for (const cart of cartridges) {
      const cartBase = path.basename(cart.path);
      for (const subdir of ['msdata', 'xfdata']) {
        const srcDir = path.join(cart.path, subdir);
        if (!fs.existsSync(srcDir)) continue;
        const destDir = path.join(tmpDir, cartBase, subdir);
        fs.mkdirSync(destDir, { recursive: true });
        for (const f of fs.readdirSync(srcDir)) {
          const srcFile = path.join(srcDir, f);
          if (fs.statSync(srcFile).isFile()) {
            fs.copyFileSync(srcFile, path.join(destDir, f));
            backedUpCount++;
          }
        }
      }
    }
    send('log', `Collected ${backedUpCount} files for backup.`);

    // PowerShell Compress-Archive (available on Windows 10+)
    await new Promise((resolve, reject) => {
      const ps = `Compress-Archive -Path '${tmpDir}\\*' -DestinationPath '${zipPath}' -Force`;
      exec(`powershell -NoProfile -Command "${ps}"`, (err, _stdout, stderr) => {
        if (err) reject(new Error(`Backup zip failed: ${stderr || err.message}`));
        else resolve();
      });
    });
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    send('backup_done', { zipPath, count: backedUpCount });
    send('log', `✓ Backup saved to: ${zipPath}`);

    // ── Step 2: Export from DB ───────────────────────────────────────────────
    send('step', { n: 2, msg: 'Exporting dictionary data from database to cartridge files…' });

    const organismsSet = new Set();

    const sortRows = (rows) => [...rows].sort((a, b) => {
      const idDiff = (a.medscan_id || 0) - (b.medscan_id || 0);
      if (idDiff !== 0) return idDiff;
      return (a.alias || a.name || '').localeCompare(b.alias || b.name || '');
    });
    const rowToLine = (m) => (r) => {
      if (m.cols === 'xword')       return (r.flags ? `${r.xword}\t${r.flags}` : r.xword);
      if (m.cols === 'xword_flags') return `${r.xword}\t${r.flags || ''}`;
      if (m.cols === 'spelling')    return r.spellings ? `${r.canonical}\t${r.spellings}` : r.canonical;
      if (m.cols === 'rsmap')       return [r.medscan_id, r.protein_name, r.hgvs_code, r.urn || ''].join('\t');
      if (m.cols === 'name_urn')    return [r.medscan_id, r.alias, r.urn || ''].join('\t');
      return m.matchCol
        ? [r.medscan_id, r.alias, r.match || ''].join('\t')
        : [r.medscan_id, r.alias].join('\t');
    };

    // ── Export shared term-control files to bin/msdata/ (once) ─────────────────
    const binMsdata = path.join(medscanDir, 'bin', 'msdata');
    fs.mkdirSync(binMsdata, { recursive: true });

    for (const m of DEPLOY_FILE_MAP.filter(m => m.binDir)) {
      let content;
      if (m.table === 'chemnames') {
        // chemnames: global token table — no cartridges/organisms columns.
        const res = await dbq(
          `SELECT medscan_id, alias FROM chemnames WHERE (bdeleted IS NULL OR bdeleted = FALSE) ORDER BY alias`
        );
        if (!res.rows) { send('log', `✗ Query failed: chemnames`); continue; }
        content = res.rows.map(rowToLine(m)).join('\n');
        send('log', `✓ ${m.file} → bin/msdata/ (${res.rows.length} rows)`);
        const targetCarts = cartridges; // all cartridges
        fs.writeFileSync(path.join(binMsdata, m.file), content, 'utf8');
        for (const cart of targetCarts) {
          const cartMsdata = path.join(cart.path, 'msdata');
          fs.mkdirSync(cartMsdata, { recursive: true });
          fs.copyFileSync(path.join(binMsdata, m.file), path.join(cartMsdata, m.file));
        }
        continue;
      }
      if (m.cols === 'bracketstop') {
        // Reconstruct section-aware format: group rows by comment, emit # header per section
        const res = await dbq(
          `SELECT word, flag, comment FROM bracketstop ORDER BY comment NULLS FIRST, word`
        );
        if (!res.rows) { send('log', `✗ Query failed: bracketstop`); continue; }
        const lines = [];
        let lastComment = undefined;
        for (const r of res.rows) {
          if (r.comment !== lastComment) {
            if (r.comment) lines.push(`# ${r.comment}`);
            lastComment = r.comment;
          }
          lines.push(r.flag ? `${r.word}\t${r.flag}` : r.word);
        }
        content = lines.join('\n');
        send('log', `✓ ${m.file} → bin/msdata/ (${res.rows.length} entries)`);
      } else {
        // Only xwords_cells has a flags column; xwords / xwords_cas do not.
        const sqlCols = m.cols === 'xword_flags'                             ? 'xword, flags'
                      : m.cols === 'xword' && m.table === 'xwords_cells'    ? 'xword, flags'
                      : m.cols === 'xword'                                   ? 'xword'
                      : /* spelling */                                         'canonical, spellings';
        const orderCol = m.cols === 'spelling' ? 'canonical' : 'xword';
        const res = await dbq(`SELECT ${sqlCols} FROM "${m.table}" ORDER BY ${orderCol}`);
        if (!res.rows) { send('log', `✗ Query failed: ${m.table}`); continue; }
        content = res.rows.map(rowToLine(m)).join('\n');
        send('log', `✓ ${m.file} → bin/msdata/ (${res.rows.length} rows)`);
      }
      // Write to bin/msdata/ and duplicate into target cartridges' msdata/
      // (cartridgeFilter restricts which cartridges receive the file; absent = all cartridges)
      const targetCarts = m.cartridgeFilter
        ? cartridges.filter(c => m.cartridgeFilter.includes(c.name))
        : cartridges;
      fs.writeFileSync(path.join(binMsdata, m.file), content, 'utf8');
      for (const cart of targetCarts) {
        const cartMsdata = path.join(cart.path, 'msdata');
        fs.mkdirSync(cartMsdata, { recursive: true });
        fs.copyFileSync(path.join(binMsdata, m.file), path.join(cartMsdata, m.file));
      }
    }

    // ── Export per-cartridge entity files ────────────────────────────────────
    // Run with bounded concurrency — at most 3 cartridges at a time.
    const EXPORT_CONCURRENCY = 3;
    const perCartMaps = DEPLOY_FILE_MAP.filter(m => !m.binDir);
    for (let i = 0; i < cartridges.length; i += EXPORT_CONCURRENCY) {
      await Promise.all(cartridges.slice(i, i + EXPORT_CONCURRENCY).map(async (cart) => {
      for (const m of perCartMaps) {
        // Skip tables whose cartridgeFilter does not include this cartridge
        if (m.cartridgeFilter && !m.cartridgeFilter.includes(cart.name)) continue;
        try {
          if (m.cols === 'rsmap') {
            // rsmap: export to gsdata/ of the GeneticVariant cartridge — no per-organism split.
            const gsdataDir = path.join(cart.path, 'gsdata');
            const r = await exportTablePaged({
              dbq, rowToLine: rowToLine(m), splitByOrg: false, organismsSet: null,
              finalPathFor: () => path.join(gsdataDir, m.file),
              buildQuery: (lastId, lim) => ({
                text: `SELECT id, medscan_id, protein_name, hgvs_code, urn FROM rsmap
                       WHERE (bdeleted IS NULL OR bdeleted = FALSE) AND id > $1 ORDER BY id LIMIT ${lim}`,
                values: [lastId],
              }),
            });
            send('log', `✓ ${m.file} → ${cart.name}/gsdata/ (${r.total} rows)`);
            continue;
          }
          const aliasCol = m.table === 'keywords' ? 'keywords' : 'alias';
          const r = await exportTablePaged({
            dbq, rowToLine: rowToLine(m), splitByOrg: true, organismsSet,
            finalPathFor: (org) => path.join(cart.path, m.dir, `${org ? org + '.' : ''}${m.file}`),
            buildQuery: (lastId, lim) => m.cols === 'name_urn'
              ? { text: `SELECT id, medscan_id, name AS alias, urn, organisms FROM "${m.table}"
                          WHERE $1 = ANY(cartridges) AND id > $2 ORDER BY id LIMIT ${lim}`,
                  values: [cart.name, lastId] }
              : { text: `SELECT id, medscan_id, ${aliasCol} AS alias, match, organisms FROM "${m.table}"
                          WHERE $1 = ANY(cartridges) AND (bdeleted IS NULL OR bdeleted = FALSE) AND id > $2
                          ORDER BY id LIMIT ${lim}`,
                  values: [cart.name, lastId] },
          });
          send('log', `✓ ${m.file} → ${cart.name} (${r.total} rows, ${r.orgCount} organism(s))`);
        } catch (e) {
          send('log', `✗ Export failed: ${m.table} → ${cart.name}: ${e.message}`);
        }
      }
    }));
    } // end EXPORT_CONCURRENCY batch loop

    // ── Ontology → xfdata/Ontology.tab of every cartridge: Class TAB URN (the medscan_id column is not exported) ──
    try {
      const on = await dbq(`SELECT class, urn FROM ontology ORDER BY id`);
      const text = on.rows.map(r => `${r.class}\t${r.urn}`).join('\n') + (on.rows.length ? '\n' : '');
      for (const cart of cartridges) {
        fs.mkdirSync(path.join(cart.path, 'xfdata'), { recursive: true });
        fs.writeFileSync(path.join(cart.path, 'xfdata', 'Ontology.tab'), text, 'utf8');
      }
      send('log', `✓ Ontology.tab → xfdata of ${cartridges.length} cartridge(s) (${on.rows.length} rows)`);
    } catch (e) {
      send('log', `✗ Export failed: ontology: ${e.message}`);
    }

    const organisms = [...organismsSet];
    if (organisms.length === 0) organisms.push('Mammal');
    send('export_done', { organisms });
    send('log', `✓ Export complete. Organisms: ${organisms.join(', ')}`);

    // ── Step 3: Compile ──────────────────────────────────────────────────────
    send('step', { n: 3, msg: `Compiling dictionaries (${cartridges.length} cartridge(s) × ${organisms.length} organism(s))…` });

    const compileResults = [];
    // Cartridges run in parallel; organisms within each cartridge also run in parallel
    // (each organism compiles into its own separate files, so there are no conflicts).
    await Promise.all(cartridges.map(async (cart) => {
      const ttkconf  = path.join(cart.path, process.platform === 'win32' ? 'ttkconf.exe' : 'ttkconf');
      const cartBase = path.basename(cart.path);
      await Promise.all(organisms.map(async (org) => {
        const logFile = path.join(cart.path, `dict_compile_errors_${org}.txt`);
        send('log', `  Compiling ${cartBase} / ${org}…`);
        await new Promise((resolve) => {
          // Run via shell so that:
          //  • stdin is fully closed (shell does not inherit it)
          //  • 2> redirect matches original ttkconf usage
          const cmdLine = `"${ttkconf}" -Q ${org} recompdicts 2>"${logFile}"`;
          const proc = spawn(cmdLine, {
            shell: true,
            cwd: cart.path,
            stdio: ['ignore', 'pipe', 'ignore'], // stderr goes to file via redirect
          });
          proc.stdout.on('data', d => {
            const txt = d.toString().trimEnd();
            if (txt) send('log', `    ${txt}`);
          });
          proc.on('close', code => {
            send('log', `  ${code === 0 ? '✓' : '✗'} ${cartBase} / ${org} → exit ${code}`);
            compileResults.push({ cart: cart.name, cartPath: cart.path, org, code, logFile });
            resolve();
          });
          proc.on('error', err => {
            send('log', `  ✗ ${cartBase} / ${org}: ${err.message}`);
            compileResults.push({ cart: cart.name, cartPath: cart.path, org, code: -1, logFile, error: err.message });
            resolve();
          });
        });
      }));
    }));

    // ── Step 4: Check logs for *** lines ────────────────────────────────────
    const warnings = [];
    for (const r of compileResults) {
      if (!fs.existsSync(r.logFile)) continue;
      const content   = fs.readFileSync(r.logFile, 'utf8');
      const starLines = content.split('\n').filter(l => l.includes('***') && l.trim());
      if (starLines.length > 0) warnings.push({ cart: r.cart, org: r.org, lines: starLines });
    }

    send('log', `⏱ Total elapsed time: ${fmtElapsed()}`);
    send('done', { warnings });
    return { ok: true };

  } catch (e) {
    send('log', `⏱ Elapsed time before failure: ${fmtElapsed()}`);
    send('error', e.message);
    return { ok: false, error: e.message };
  }
});

// ── Patterns screen: "New relation" wizard (see relationBuilder.js) ───────────────
const relationBuilder = require('./relationBuilder');
// The REAL msout of the sentence of a ConceptScan markup: the sentence stages of locscan.ini before conceptscan (MEDSCAN | PROTGLUE) run again on the plain sentence — the markup that
// patterns of -Imsout folders read ('' when it cannot be produced).
const _msoutCache = new Map();
async function realMsout(cartPath, markup) {
  try {
    const msrc = (String(markup || '').match(/^msrc\t(.*)$/m) || [])[1];
    if (!msrc) return '';
    const text = msrc.replace(/ID\{[^=}]*=([^}]*)\}/g, '$1');                  // the plain sentence: ID{ids=word} → word
    const st = getStore();
    const license = st.get('medscanLicense') || '', userDict = st.get('userDict') || '';
    const key = [cartPath, text, license, userDict].join('');
    if (_msoutCache.has(key)) return _msoutCache.get(key);
    // the markup -Imsout rules read: the sentence stages of locscan.ini up to the one that goes into conceptscan (MEDSCAN | PROTGLUE)
    const r = await runSentencePipeline(cartPath, text, { organism: 'Mammal', license, userDict }, {}, () => {}, { markupOnly: true });
    const out = /^msrc	/m.test(r.msout) ? r.msout : '';
    if (_msoutCache.size > 50) _msoutCache.clear();
    _msoutCache.set(key, out);
    return out;
  } catch (_) { return ''; }
}
const relWrap = (fn) => async (_e, args) => {
  try { return { ok: true, ...(await fn(args)) }; }
  catch (e) { return { ok: false, error: e.message }; }
};
ipcMain.handle('relation:macroFiles', relWrap(({ cartPath, text, relationName }) => ({ files: relationBuilder.macroFileCandidates(cartPath, text, relationName) })));
ipcMain.handle('relation:macroInfo', relWrap(({ cartPath, name }) => ({ info: relationBuilder.macroInfo(cartPath, name) })));
ipcMain.handle('relation:editMacro', relWrap((a) => ({ result: relationBuilder.editMacro(a.cartPath, a) })));
ipcMain.handle('relation:renameMacro', relWrap((a) => ({ result: relationBuilder.renameMacro(a.cartPath, a) })));
ipcMain.handle('relation:findSetDefs', relWrap(({ cartPath, file, names }) => ({ defs: relationBuilder.findSetDefs(cartPath, file, names) })));
ipcMain.handle('relation:readFile', relWrap(({ cartPath, file }) => ({ file: relationBuilder.readMsgrepFile(cartPath, file) })));
ipcMain.handle('relation:saveFile', relWrap((a) => ({ saved: relationBuilder.saveMsgrepFile(a.cartPath, a) })));
ipcMain.handle('relation:checkFile', relWrap(async (a) => ({ check: await relationBuilder.checkMsgrepFile(a.cartPath, a) })));
ipcMain.handle('relation:compileFolder', relWrap(async ({ cartPath, relDir, dryRun, onlyUsing }) => ({ result: await relationBuilder.compileFolder(cartPath, relDir, { dryRun: !!dryRun, onlyUsing }) })));
// "Recompile" (Pattern File Editor): every pattern folder of the given cartridges is rebuilt, several at once; progress goes to the window as 'relation:recompileProgress'
let recompileRun = null;
ipcMain.handle('relation:recompilePlan', relWrap(async ({ cartPaths }) => ({ plan: await relationBuilder.recompileAll(cartPaths, { dryRun: true }) })));
ipcMain.handle('relation:recompileAll', async (event, { cartPaths, concurrency }) => {
  if (recompileRun) return { ok: false, error: 'A recompile is already running.' };
  const cancel = { cancelled: false };
  recompileRun = cancel;
  const send = (p) => { try { event.sender.send('relation:recompileProgress', p); } catch (_) {} };
  try { return { ok: true, result: await relationBuilder.recompileAll(cartPaths, { concurrency, cancel, progress: send }) }; }
  catch (e) { return { ok: false, error: e.message }; }
  finally { recompileRun = null; }
});
ipcMain.handle('relation:recompileCancel', () => { if (recompileRun) recompileRun.cancelled = true; return { ok: true }; });
ipcMain.handle('relation:addMacro', relWrap((a) => ({ result: relationBuilder.addMacro(a.cartPath, a) })));
ipcMain.handle('relation:findMacros', relWrap(({ cartPath, query, max, exact }) => ({ macros: relationBuilder.macroLocations(cartPath, relationBuilder.findMacrosWith(cartPath, query, max, !!exact)) })));
ipcMain.handle('relation:warmMacros', relWrap(({ cartPaths }) => ({ files: relationBuilder.warmMacros(cartPaths) })));
ipcMain.handle('relation:macroDefs', relWrap(({ cartPath, file, names, max }) => ({ defs: relationBuilder.macroDefinitions(cartPath, file, names, max) })));
ipcMain.handle('relation:testPattern', relWrap(async (a) => ({ result: relationBuilder.testPattern(a.cartPath, { ...a, markupMs: a.markupMs || await realMsout(a.cartPath, a.markup), license: getStore().get('medscanLicense') || '' }) })));
ipcMain.handle('relation:otherCartridges', relWrap(({ cartPath, name }) => ({ carts: relationBuilder.otherCartridgeSets(cartPath, name) })));
ipcMain.handle('relation:viewSet', relWrap(({ cartPath, name, id }) => ({ view: relationBuilder.viewExistingSet(cartPath, name, id) })));
ipcMain.handle('relation:findExtracting', relWrap(async ({ cartPath, markup, relation, props, regulator, target }) => relationBuilder.findExtracting(cartPath, { markup, relation, props, regulator, target, markupMs: await realMsout(cartPath, markup), license: getStore().get('medscanLicense') || '' })));
ipcMain.handle('relation:frameFolders', relWrap(({ cartPath, relation, props, regulator, target }) => (relationBuilder.frameFolders(cartPath, { relation, props, regulator, target }))));
ipcMain.handle('relation:relationMatches', relWrap(({ cartPath, relation, regulator, target }) => relationBuilder.relationMatches(cartPath, { relation, regulator, target })));
ipcMain.handle('relation:fixMacros', relWrap(({ cartPath, patterns, glued }) => ({ fixes: relationBuilder.fixMacroPatterns(cartPath, patterns, glued || []) })));
ipcMain.handle('relation:findUsed', relWrap(({ cartPath, outputName, csout, msout, xml }) => relationBuilder.findUsedPatterns(cartPath, { outputName, csout, msout, xml, license: getStore().get('medscanLicense') || '' })));
ipcMain.handle('relation:existingSets', relWrap(({ cartPath, name }) => ({ sets: relationBuilder.findExistingSets(cartPath, name) })));
ipcMain.handle('relation:macroPrompt', relWrap(({ cartPath, sentence, relation }) => relationBuilder.macroPrompt(cartPath, sentence, relation)));
ipcMain.handle('relation:suggestContext', relWrap(({ cartPath, markup, sentence }) => relationBuilder.suggestContext(cartPath, markup, sentence)));
ipcMain.handle('relation:frameCheck', relWrap(({ cartPath, types, carts }) => relationBuilder.frameCheck(cartPath, types, carts)));
ipcMain.handle('relation:types',    relWrap(({ carts }) => ({ types: relationBuilder.listRelationTypes(carts) })));
ipcMain.handle('relation:patternsFor', relWrap(({ carts, name }) => ({ rows: relationBuilder.findRelationPatterns(carts, name) })));
ipcMain.handle('relation:info',     relWrap(({ cartPath }) => relationBuilder.getInfo(cartPath)));
ipcMain.handle('relation:entities', relWrap(({ cartPath, name }) => ({ entities: relationBuilder.readRelationEntities(cartPath, name) })));
ipcMain.handle('relation:declare',  relWrap(({ cartPath, name, directional }) => relationBuilder.declareRelation(cartPath, { name, directional })));
ipcMain.handle('relation:revert',   relWrap(({ cartPath, name }) => relationBuilder.revertDeclaration(cartPath, name)));
ipcMain.handle('relation:validate', relWrap(({ cartPath, ...o }) => ({ result: relationBuilder.validatePattern(cartPath, o) })));
ipcMain.handle('relation:generate', relWrap(({ cartPath, ...o }) => ({ result: relationBuilder.generateFiles(cartPath, o) })));
ipcMain.handle('relation:compile',  relWrap(async ({ cartPath, ...o }) => ({ result: await relationBuilder.compileRelation(cartPath, o) })));

// ── NLP Filter file management ────────────────────────────────────────────────
function getNLPFiltersDir() {
  const medscanDir = getStore().get('medscanDir');
  if (!medscanDir) return null;
  // Store NLPfilters alongside the MEDSCAN directory
  return path.join(path.dirname(medscanDir), 'NLPfilters');
}

ipcMain.handle('filter:getDir', () => {
  const d = getNLPFiltersDir();
  if (d) fs.mkdirSync(d, { recursive: true });
  return d;
});

ipcMain.handle('filter:list', () => {
  const d = getNLPFiltersDir();
  if (!d) return [];
  try {
    fs.mkdirSync(d, { recursive: true });
    return fs.readdirSync(d)
      .filter(f => f.toLowerCase().endsWith('.txt'))
      .map(f => ({ name: f, path: path.join(d, f) }));
  } catch { return []; }
});

ipcMain.handle('filter:read', (_, filePath) => {
  try { return { ok: true, content: fs.readFileSync(filePath, 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('filter:write', (_, { filePath, content }) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('filter:create', (_, name) => {
  const d = getNLPFiltersDir();
  if (!d) return { ok: false, error: 'MedScan directory not configured.' };
  fs.mkdirSync(d, { recursive: true });
  const safeName = name.endsWith('.txt') ? name : name + '.txt';
  const filePath = path.join(d, safeName);
  if (fs.existsSync(filePath)) return { ok: false, error: 'File already exists.' };
  fs.writeFileSync(filePath, '', 'utf8');
  return { ok: true, path: filePath, name: safeName };
});

ipcMain.handle('medscan:listBackups', async (_, { medscanDir }) => {
  try {
    const backupDir = path.join(medscanDir, 'DictionaryBackup');
    if (!fs.existsSync(backupDir)) return { ok: true, backups: [] };
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const full = path.join(backupDir, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, mtimeMs: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    return { ok: true, backups: files };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('medscan:restoreBackup', async (event, { zipPath, medscanDir }) => {
  const send = (type, data) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('deploy:event', { type, data });
  };
  try {
    send('log', `Restoring from: ${zipPath}`);
    // Use .NET ZipFile to:
    //  1. Collect the cartridge directories present in the zip.
    //  2. Wipe those cartridges' msdata/ and xfdata/ on disk BEFORE extracting,
    //     so files absent from the backup (e.g. organism-specific tab files from
    //     a newer install) don't survive the restore and pollute dict:refresh.
    //  3. Extract every entry and restore its original LastWriteTime from the zip
    //     (Expand-Archive stamps today, which would corrupt created_at/updated_at).
    const zp  = zipPath.replace(/'/g, "''");
    const msd = medscanDir.replace(/'/g, "''");
    const ps = [
      `Add-Type -Assembly 'System.IO.Compression.FileSystem'`,
      `$zip = [System.IO.Compression.ZipFile]::OpenRead('${zp}')`,
      // Collect unique top-level cartridge directory names from zip entries
      `$cartDirs = @{}`,
      `foreach ($e in $zip.Entries) {`,
      `  $parts = $e.FullName -split '[/\\\\]'`,
      `  if ($parts.Length -ge 2 -and $parts[0] -ne '') { $cartDirs[$parts[0]] = 1 }`,
      `}`,
      // Wipe msdata/ and xfdata/ inside those cartridges before extracting
      `foreach ($cart in $cartDirs.Keys) {`,
      `  foreach ($sub in @('msdata','xfdata')) {`,
      `    $d = Join-Path '${msd}' (Join-Path $cart $sub)`,
      `    if (Test-Path $d) { Remove-Item -Path (Join-Path $d '*') -Recurse -Force -ErrorAction SilentlyContinue }`,
      `  }`,
      `}`,
      // Extract entries with original timestamps
      `foreach ($entry in $zip.Entries) {`,
      `  if ($entry.Name -eq '') { continue }`,
      `  $dest = Join-Path '${msd}' $entry.FullName`,
      `  $dir  = Split-Path $dest -Parent`,
      `  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }`,
      `  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)`,
      `  (Get-Item $dest).LastWriteTime = $entry.LastWriteTime.DateTime`,
      `}`,
      `$zip.Dispose()`,
    ].join('; ');
    await new Promise((resolve, reject) => {
      exec(`powershell -NoProfile -Command "${ps}"`, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      });
    });
    send('log', `✓ Restore complete.`);
    send('restore_done', { zipPath });
    return { ok: true };
  } catch (e) {
    send('error', e.message);
    return { ok: false, error: e.message };
  }
});

// ── RNEF XML Parser ──────────────────────────────────────────────────────────

ipcMain.handle('rnef:parse', async (event, filePath) => {
  try {
    const medscanDir = getStore().get('medscanDir');
    const urnMap = await loadUrnMap(medscanDir);
    // Streaming parser (rnefParser.js): no DOM, no whole-file string, no big IPC payload of raw XML.
    // Returns compact relation rows; the coloured sentence segments are built in the renderer on demand.
    const t0 = Date.now();
    const relations = await parseRnefFile(
      filePath,
      (urn) => urnMap.get(urn) || null,
      (done, total) => { if (!event.sender.isDestroyed()) event.sender.send('rnef:progress', { done, total }); }
    );
    console.log(`[rnef:parse] ${relations.length} relations in ${Date.now() - t0} ms`);
    return { ok: true, relations, file: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── RNEF filtered export ─────────────────────────────────────────────────────
ipcMain.handle('rnef:exportRnef', async (_, { filePath, filterTypes, filterNode, filterNodeTypes, defaultName }) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    const fnLc        = filterNode ? filterNode.toLowerCase() : '';
    // Normalise to Sets for O(1) lookup; empty = no filter
    const typeSet     = new Set((filterTypes     || []).map(t => t.toLowerCase()));
    const nodeTypeSet = new Set((filterNodeTypes || []).map(t => t.toLowerCase()));

    // Walk all <resnet> blocks, keep those that match all active filters
    const resnetRe = /(<resnet(?:\s[^>]*)?> *)([\s\S]*?)(<\/resnet>)/g;
    const kept = [];
    let rm;
    while ((rm = resnetRe.exec(content)) !== null) {
      const openTag  = rm[1];
      const body     = rm[2];
      const closeTag = rm[3];
      const full     = openTag + body + closeTag;

      // Collect node names and nodeTypes from this resnet block
      const nodeRe = /<node\s([^>]*)>([\s\S]*?)<\/node>/g;
      let nm;
      const nodeNames = [], nodeTypes = [];
      while ((nm = nodeRe.exec(body)) !== null) {
        const nodeBody = nm[2];
        const attrRe = /<attr\s[^>]*name="([^"]+)"[^>]*value="([^"]+)"/g;
        let am;
        while ((am = attrRe.exec(nodeBody)) !== null) {
          if (am[1] === 'Name')     nodeNames.push(am[2].toLowerCase());
          if (am[1] === 'NodeType') nodeTypes.push(am[2].toLowerCase());
        }
      }

      // Collect ControlTypes from this resnet block
      const ctrlTypes = [];
      const ctrlRe = /<attr\s[^>]*name="ControlType"[^>]*value="([^"]+)"/g;
      let ct;
      while ((ct = ctrlRe.exec(body)) !== null) ctrlTypes.push(ct[1].toLowerCase());

      const passType     = typeSet.size === 0     || ctrlTypes.some(t => typeSet.has(t));
      const passNode     = !fnLc                  || nodeNames.some(n => n.includes(fnLc));
      const passNodeType = nodeTypeSet.size === 0 || nodeTypes.some(t => nodeTypeSet.has(t));

      if (passType && passNode && passNodeType) kept.push(full);
    }

    // Reconstruct: preserve the XML declaration + root element wrapper
    // Find everything before the first <resnet> and after the last </resnet>
    const firstResnet = content.search(/<resnet[\s>]/);
    const lastResnetEnd = content.lastIndexOf('</resnet>') + '</resnet>'.length;
    const header = firstResnet > 0 ? content.slice(0, firstResnet) : '<?xml version="1.0" encoding="UTF-8"?>\n<batch>\n';
    const footer = lastResnetEnd < content.length ? content.slice(lastResnetEnd) : '\n</batch>';

    const outputContent = header + kept.join('\n') + footer;

    const { canceled, filePath: outPath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export filtered RNEF',
      defaultPath: defaultName || filePath.replace(/\.rnef$/i, '_filtered.rnef'),
      filters: [{ name: 'RNEF File', extensions: ['rnef', 'xml'] }],
    });
    if (canceled || !outPath) return { ok: false, canceled: true };

    fs.writeFileSync(outPath, outputContent, 'utf8');
    return { ok: true, filePath: outPath, kept: kept.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Excel / CSV export ───────────────────────────────────────────────────────
// A table of the Results viewer that is not an RNEF file (the sentences of the Reader): Excel (.xlsx) or CSV, by the file name the user chooses.
// columns: [{ key, label, width }], rows: [{ <key>: value }]
ipcMain.handle('table:export', async (_e, { title, columns, rows, defaultName }) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export table', defaultPath: defaultName || 'table.xlsx',
      filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }, { name: 'CSV File', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    if (/\.csv$/i.test(filePath)) {
      const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const lines = [columns.map(c => esc(c.label)).join(',')];
      for (const r of rows) lines.push(columns.map(c => esc(r[c.key])).join(','));
      fs.writeFileSync(filePath, '﻿' + lines.join('\r\n'), 'utf8');           // BOM: Excel reads it as UTF-8
      return { ok: true, filePath };
    }
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'NLPmanager';
    const ws = wb.addWorksheet(String(title || 'Table').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Table');
    ws.columns = columns.map(c => ({ header: c.label, key: c.key, width: c.width || 20 }));
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    // the sentence with its entities in colour (sentenceSegs: { text, rgb | color, bold })
    const hex2 = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0').toUpperCase();
    const runs = (segs) => segs.map(g => (g.rgb ? { text: g.text, font: { bold: true, color: { argb: 'FF' + hex2(g.rgb[0] * 0.75) + hex2(g.rgb[1] * 0.75) + hex2(g.rgb[2] * 0.75) } } }
      : g.color ? { text: g.text, font: { bold: !!g.bold, color: { argb: 'FF' + String(g.color).replace('#', '').toUpperCase() } } }
      : { text: g.text, font: { color: { argb: g.dim ? 'FF888888' : 'FF000000' } } }));
    for (const r of rows) {
      const row = ws.addRow(columns.reduce((o, c) => { o[c.key] = r[c.key] == null ? '' : r[c.key]; return o; }, {}));
      if (Array.isArray(r.sentenceSegs) && r.sentenceSegs.length && columns.some(c => c.key === 'sentence')) row.getCell('sentence').value = { richText: runs(r.sentenceSegs) };
      if (Array.isArray(r.markupSegs) && r.markupSegs.length && columns.some(c => c.key === 'markup')) row.getCell('markup').value = { richText: runs(r.markupSegs) };
    }
    ws.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: 'top', wrapText: true }; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    await wb.xlsx.writeFile(filePath);
    return { ok: true, filePath };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('results:exportExcel', async (_, { relations, defaultName }) => {
  // Large datasets: rich-text Excel has a per-cell limit; offer CSV instead
  if (relations.length > 20000) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Large Export',
      message: `This export contains ${relations.length.toLocaleString()} rows.\n\nExcel with color formatting is not reliable above 20,000 rows.\n\nExport as plain CSV instead?`,
      buttons: ['Yes — export CSV', 'No — cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) return { ok: false, canceled: true };

    // CSV export
    const base = (defaultName || 'relations.xlsx').replace(/\.xlsx$/i, '');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export to CSV',
      defaultPath: base + '.csv',
      filters: [{ name: 'CSV File', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };

    try {
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const headers = ['Relation Type','Directional','Node 1','Node 1 Type','Node 1 Elsevier NLP ID',
                       'Node 2','Node 2 Type','Node 2 Elsevier NLP ID','PMID','Sentence','Sentence with Markup'];
      const lines = [headers.map(esc).join(',')];
      for (const r of relations) {
        const sentence = (r.segments || []).map(s => s.text).join('');
        lines.push([
          r.type, r.isDirect ? 'Yes' : 'No',
          r.node1, r.node1Type, r.node1Ids.join('; '),
          r.node2, r.node2Type, r.node2Ids.join('; '),
          r.pmid, sentence, r.msrc || '',
        ].map(esc).join(','));
      }
      fs.writeFileSync(filePath, '﻿' + lines.join('\r\n'), 'utf8'); // BOM for Excel UTF-8
      return { ok: true, filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Normal Excel export
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export to Excel',
    defaultPath: defaultName || 'relations.xlsx',
    filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'NLPmanager';
    const ws = wb.addWorksheet('Relations');

    // ARGB colors (FF = fully opaque)
    const C = {
      n1Dir:   'FFF38BA8', // red   – regulator
      n2Dir:   'FFA6E3A1', // green – target
      n1Indir: 'FFCBA6F7', // purple
      n2Indir: 'FFFAB387', // orange
      both:    'FFF9E2AF', // yellow
      dim:     'FF888888', // gray – other entities
      muted:   'FF999999',
    };

    // Column definitions
    ws.columns = [
      { header: 'Relation Type',          key: 'type',      width: 24 },
      { header: 'Directional',            key: 'dir',       width: 13 },
      { header: 'Node 1',                 key: 'n1',        width: 28 },
      { header: 'Node 1 Type',            key: 'n1t',       width: 18 },
      { header: 'Node 1 Elsevier NLP ID',       key: 'n1id',      width: 18 },
      { header: 'Node 2',                 key: 'n2',        width: 28 },
      { header: 'Node 2 Type',            key: 'n2t',       width: 18 },
      { header: 'Node 2 Elsevier NLP ID',       key: 'n2id',      width: 18 },
      { header: 'PMID',                   key: 'pmid',      width: 14 },
      { header: 'Sentence',               key: 'sent',      width: 90 },
      { header: 'Sentence with Markup',   key: 'markup',    width: 90 },
      // relations of the Reader: effect, properties, the symbolic form and the paragraph
      ...(relations.some(r => r.extra) ? [{ header: 'Effect', key: 'eff', width: 11 }, { header: 'Properties', key: 'props', width: 34 }, { header: 'Symbolic form', key: 'sym', width: 70 }, { header: 'Paragraph', key: 'para', width: 11 }] : []),
    ];

    // Style header row
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    ws.getRow(1).height = 20;

    for (const r of relations) {
      const colors = r.isDirect
        ? { n1: C.n1Dir,   n2: C.n2Dir   }
        : { n1: C.n1Indir, n2: C.n2Indir };

      const row = ws.addRow({
        type:  r.type,
        dir:   r.isDirect ? 'Yes' : 'No',
        n1:    r.node1,
        n1t:   r.node1Type,
        n1id:  r.node1Ids.join(', '),
        n2:    r.node2,
        n2t:   r.node2Type,
        n2id:  r.node2Ids.join(', '),
        pmid:  r.pmid,
        sent:  '',
        markup: r.msrc || '',
        ...(r.extra ? { eff: r.extra.effect, props: r.extra.properties, sym: r.extra.symbolic, para: r.extra.paragraph } : {}),
      });

      // Node 1 – colored name
      if (r.node1) {
        row.getCell('n1').value = { richText: [
          { text: r.node1, font: { bold: true, color: { argb: colors.n1 } } },
        ]};
      }

      // Node 2 – colored name
      if (r.node2) {
        row.getCell('n2').value = { richText: [
          { text: r.node2, font: { bold: true, color: { argb: colors.n2 } } },
        ]};
      }

      // Sentence – rich text segments
      if (r.segments?.length) {
        const richText = r.segments.map(seg => {
          switch (seg.role) {
            case 'node1': return { text: seg.text, font: { bold: true, color: { argb: colors.n1 } } };
            case 'node2': return { text: seg.text, font: { bold: true, color: { argb: colors.n2 } } };
            case 'both':  return { text: seg.text, font: { bold: true, color: { argb: C.both }    } };
            case 'other': return { text: seg.text, font: { color: { argb: C.dim } } };
            default:      return { text: seg.text };
          }
        }).filter(rt => rt.text);
        if (richText.length) row.getCell('sent').value = { richText };
      }

      // Markup and sentence wrap
      row.getCell('sent').alignment   = { wrapText: true, vertical: 'top' };
      row.getCell('markup').alignment = { wrapText: true, vertical: 'top' };
    }

    // Freeze header
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    await wb.xlsx.writeFile(filePath);
    return { ok: true, filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Literature Download ───────────────────────────────────────────────────────
const NCBI_BASE  = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const SD_SEARCH  = 'https://api.elsevier.com/content/search/sciencedirect';
const SD_ARTICLE = 'https://api.elsevier.com/content/article/pii';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Reusable HTTPS agent that skips certificate verification.
// Needed in corporate environments where a proxy presents its own CA certificate
// that is not in Node's built-in trust store.
const _httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Robust HTTP(S) request using Node's built-in modules (no global fetch dependency).
// Follows up to 5 redirects, returns { status, headers, body }.
function httpRequest(urlStr, { method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const doRequest = (url, redirectsLeft) => {
      const parsed  = new URL(url);
      const mod     = parsed.protocol === 'https:' ? https : http;
      const bodyBuf = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
      const opts = {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method,
        agent:    parsed.protocol === 'https:' ? _httpsAgent : undefined,
        headers: {
          'User-Agent': 'NLPmanager/1.0',
          ...headers,
          ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
        },
      };
      const req = mod.request(opts, (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
          return doRequest(next, redirectsLeft - 1);
        }
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeout, () => { req.destroy(); reject(new Error(`Request timed out: ${url}`)); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    };
    doRequest(urlStr, 5);
  });
}

async function ncbiGet(url) {
  const r = await httpRequest(url, { headers: { 'Accept': '*/*' } });
  if (r.status < 200 || r.status >= 300) throw new Error(`NCBI error ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`);
  return r.body.toString('utf8');
}

// NCBI JSON responses sometimes embed raw ASCII control characters (0x00–0x1F)
// inside string values (e.g. in querytranslation, article titles).
// Control characters are never valid inside JSON strings, so strip them all.
// Removing structural whitespace is also safe — JSON parsers don't require it.
function parseNcbiJson(str) {
  const cleaned = str.replace(/[\x00-\x1F\x7F]/g, '');
  return JSON.parse(cleaned);
}

let _literatureAbort = false;
ipcMain.handle('literature:stop', () => { _literatureAbort = true; return { ok: true }; });

ipcMain.handle('literature:testApiKey', async (_, { apikey }) => {
  try {
    const bodyStr = JSON.stringify({ qs: 'test', display: { offset: 0, show: 1 } });
    const r = await httpRequest(SD_SEARCH, {
      method: 'PUT',
      headers: {
        'X-ELS-APIKey':  apikey,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: bodyStr,
    });
    if (r.status === 200 || r.status === 206) return { ok: true };
    return { ok: false, status: r.status, message: r.body.toString('utf8').slice(0, 300) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});

ipcMain.handle('literature:download', async (event, { query, searchName, source, outputDir, apikey, ncbiApiKey, consynBearerToken }) => {
  _literatureAbort = false;
  const send = (type, data) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('literature:event', { type, data });
  };

  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const apiKeyParam = ncbiApiKey ? `&api_key=${encodeURIComponent(ncbiApiKey)}` : '';

    // Lightweight count-only call — no history session opened (rettype=count).
    const ncbiGetCount = async (db, term) => {
      const body = await ncbiGet(
        `${NCBI_BASE}/esearch.fcgi?db=${db}&term=${encodeURIComponent(term)}&rettype=count&retmode=json${apiKeyParam}`
      );
      return parseInt(parseNcbiJson(body).esearchresult.count, 10);
    };

    // Collect unique IDs for a query.
    // Small results (≤10 000): single esearch. Large: one esearch per year,
    // IDs merged into a Set to deduplicate cross-year overlaps.
    const YEAR_SPLIT_THRESHOLD = 10000;
    const collectUniqueIds = async (db, term = query) => {
      const totalCount = await ncbiGetCount(db, term);
      if (!totalCount) return [];

      if (totalCount <= YEAR_SPLIT_THRESHOLD) {
        send('log', `Found ${totalCount.toLocaleString()} article(s). Collecting IDs…`);
        const body = await ncbiGet(
          `${NCBI_BASE}/esearch.fcgi?db=${db}&term=${encodeURIComponent(term)}&retmax=${totalCount}&retmode=json${apiKeyParam}`
        );
        return parseNcbiJson(body).esearchresult.idlist || [];
      }

      // Large result set — scan one year at a time and deduplicate
      const currentYear = new Date().getFullYear();
      send('log', `Found ${totalCount.toLocaleString()} article(s) — splitting by year (1965–${currentYear})…`);
      send('log', '');   // placeholder replaced in-place below

      const seenIds = new Set();
      for (let year = 1965; year <= currentYear; year++) {
        await sleep(ncbiApiKey ? 150 : 400);
        const yearTerm = `(${term}) AND (${year}/01/01[PDat]:${year}/12/31[PDat])`;
        const body = await ncbiGet(
          `${NCBI_BASE}/esearch.fcgi?db=${db}&term=${encodeURIComponent(yearTerm)}&retmax=10000&retmode=json${apiKeyParam}`
        );
        const yearIds = parseNcbiJson(body).esearchresult.idlist || [];
        if (!yearIds.length) { send('log_replace', `  Scanning ${year}…`); continue; }
        const before = seenIds.size;
        for (const id of yearIds) seenIds.add(id);
        send('log_replace',
          `  ${year}: ${yearIds.length.toLocaleString()} found, ${(seenIds.size - before).toLocaleString()} new` +
          `  [unique: ${seenIds.size.toLocaleString()}]`
        );
      }
      send('log_replace', `  Unique articles: ${seenIds.size.toLocaleString()}`);
      return [...seenIds];
    };

    // Fetch a batch of records by ID list via direct GET — no WebEnv/epost needed.
    // Retries on 500/503 with exponential backoff.
    const ncbiEfetchIds = async (db, idBatch, rettype, batchNum) => {
      const url =
        `${NCBI_BASE}/efetch.fcgi?db=${db}&id=${idBatch.join(',')}&rettype=${rettype}&retmode=xml${apiKeyParam}`;
      let delay = 2000;
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await httpRequest(url, { headers: { 'Accept': '*/*' }, timeout: 60000 });
        if (r.status >= 200 && r.status < 300) return r.body.toString('utf8');
        if (r.status !== 500 && r.status !== 503)
          throw new Error(`NCBI error ${r.status}: ${r.body.toString('utf8').slice(0, 400)}`);
        send('log', `  ⚠ Batch ${batchNum} got ${r.status}, retrying in ${delay / 1000}s…`);
        await sleep(delay);
        delay *= 2;
      }
      throw new Error(`NCBI error 500 after 4 attempts — server overloaded, try again later`);
    };

    // ── PubMed ──────────────────────────────────────────────────────────────
    if (source === 'pubmed') {
      send('log', 'Searching PubMed…');
      const ids = await collectUniqueIds('pubmed');
      if (!ids.length) { send('no_results', {}); return { ok: true }; }

      send('log', `Downloading ${ids.length.toLocaleString()} article(s) in batches of 200…`);
      await sleep(2000);   // cooldown after year-scan burst before first efetch
      const BATCH = 200;
      const articleRe = /<PubmedArticle[\s\S]*?<\/PubmedArticle>/g;
      let saved = 0;

      // Stream directly to file — never hold all articles in memory at once
      const outPath = path.join(outputDir, searchName ? `${searchName}_pubmed.xml` : 'pubmed_results.xml');
      const ws = fs.createWriteStream(outPath, { encoding: 'utf8' });
      ws.write('<?xml version="1.0" encoding="UTF-8"?>\n<PubmedArticleSet>\n');

      for (let i = 0; i < ids.length; i += BATCH) {
        if (_literatureAbort) { send('log', 'Download stopped.'); break; }
        if (i > 0) await sleep(ncbiApiKey ? 500 : 1000);
        const batch = ids.slice(i, i + BATCH);
        const batchNum = Math.floor(i / BATCH) + 1;
        let xml;
        try {
          xml = await ncbiEfetchIds('pubmed', batch, 'xml', batchNum);
        } catch (e) {
          send('log', `  ✗ Batch ${batchNum}: ${e.message}`);
          continue;
        }
        articleRe.lastIndex = 0;
        let m;
        while ((m = articleRe.exec(xml)) !== null) {
          ws.write(m[0] + '\n');
          saved++;
        }
        send('progress', { saved, total: ids.length });
      }

      ws.write('</PubmedArticleSet>');
      await new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));
      send('done', { saved, source: 'PubMed', ext: '.xml' });
    }

    // ── PubMed Central ───────────────────────────────────────────────────────
    else if (source === 'pmc') {
      send('log', 'Searching PubMed Central for open access articles…');
      // Restrict to open access so that full-text NXML is available
      const pmcQuery = `(${query}) AND open access[filter]`;
      const ids = await collectUniqueIds('pmc', pmcQuery);
      if (!ids.length) { send('no_results', {}); return { ok: true }; }

      send('log', `Downloading ${ids.length.toLocaleString()} article(s) in batches of 50…`);
      await sleep(2000);
      const BATCH = 50;
      const articleRe = /<article[\s\S]*?<\/article>/g;
      let saved = 0;

      // Stream into split files — each capped at 500 MB
      const MAX_FILE_BYTES = 500 * 1024 * 1024;
      const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<pmc-articleset>\n';
      const XML_FOOTER = '</pmc-articleset>';

      let fileIdx   = 1;
      let bytesInFile = 0;
      let fileCount = 1;   // will be updated as we open new files

      const pmcBase = searchName ? `${searchName}_pmc` : 'pmc_results';
      const pmcFilePath = (n) =>
        path.join(outputDir, `${pmcBase}_${String(n).padStart(3, '0')}.nxml`);

      let ws = fs.createWriteStream(pmcFilePath(fileIdx), { encoding: 'utf8' });
      ws.write(XML_HEADER);
      bytesInFile = Buffer.byteLength(XML_HEADER, 'utf8');

      const rollover = async () => {
        ws.write(XML_FOOTER);
        await new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));
        fileIdx++;
        ws = fs.createWriteStream(pmcFilePath(fileIdx), { encoding: 'utf8' });
        ws.write(XML_HEADER);
        bytesInFile = Buffer.byteLength(XML_HEADER, 'utf8');
        send('log', `  Started file ${fileIdx} (${pmcFilePath(fileIdx)})`);
      };

      for (let i = 0; i < ids.length; i += BATCH) {
        if (_literatureAbort) { send('log', 'Download stopped.'); break; }
        if (i > 0) await sleep(ncbiApiKey ? 500 : 1000);
        const batch = ids.slice(i, i + BATCH);
        const batchNum = Math.floor(i / BATCH) + 1;
        let xml;
        try {
          xml = await ncbiEfetchIds('pmc', batch, 'xml', batchNum);
        } catch (e) {
          send('log', `  ✗ Batch ${batchNum}: ${e.message}`);
          continue;
        }
        articleRe.lastIndex = 0;
        let m;
        while ((m = articleRe.exec(xml)) !== null) {
          const articleBytes = Buffer.byteLength(m[0], 'utf8') + 1; // +1 for '\n'
          if (bytesInFile + articleBytes + Buffer.byteLength(XML_FOOTER, 'utf8') > MAX_FILE_BYTES) {
            await rollover();
          }
          ws.write(m[0] + '\n');
          bytesInFile += articleBytes;
          saved++;
        }
        send('progress', { saved, total: ids.length });
      }

      ws.write(XML_FOOTER);
      await new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));
      send('done', { saved, source: 'PubMed Central', ext: '.xml', files: fileIdx });
    }

    // ── ScienceDirect ────────────────────────────────────────────────────────
    else if (source === 'sciencedirect') {
      if (!apikey) {
        send('error', 'Elsevier API key is required for ScienceDirect. Configure it in Settings.');
        return { ok: false };
      }

      send('log', 'Searching ScienceDirect…');
      const sdAuthHeaders = {
        'X-ELS-APIKey':  apikey,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      };

      const PAGE_SIZE = 100;
      let allPiis    = [];
      let offset     = 0;
      let totalFound = null;

      while (true) {
        if (_literatureAbort) { send('log', 'Download stopped.'); break; }
        const r = await httpRequest(SD_SEARCH, {
          method:  'PUT',
          headers: sdAuthHeaders,
          body:    JSON.stringify({ qs: query, display: { offset, show: PAGE_SIZE } }),
        });
        if (r.status !== 200) throw new Error(`ScienceDirect search failed (${r.status}): ${r.body.toString('utf8').slice(0, 200)}`);
        const json = JSON.parse(r.body.toString('utf8'));

        // totalResults may be a string or integer; try common field names across API versions
        if (totalFound === null) {
          const raw = json.totalResults ?? json['total-results'] ?? json.total ?? null;
          totalFound = raw !== null ? parseInt(raw, 10) || 0 : null;
          if (totalFound === 0) { send('no_results', {}); return { ok: true }; }
        }

        const results = json.results || json.entries || [];
        if (!results.length) break;

        const newPiis = results.map(res => res.pii).filter(Boolean);
        allPiis.push(...newPiis);
        offset += results.length;

        const countLabel = totalFound !== null ? `${allPiis.length} / ${totalFound}` : `${allPiis.length}`;
        send('log_replace', `Searching ScienceDirect… ${countLabel} PIIs collected`);

        // Stop when the page was shorter than requested (last page)
        if (results.length < PAGE_SIZE) break;
        await sleep(1000);
      }

      if (!allPiis.length) { send('no_results', {}); return { ok: true }; }
      const totalLabel = totalFound !== null ? `${totalFound}` : '?';
      send('log', `Found ${totalLabel} result(s), downloading ${allPiis.length} article(s)…`);

      let saved = 0;
      const SD_CONCURRENCY = 10;
      const piiQueue = [...allPiis];
      const totalPiis = allPiis.length;

      const sdWorker = async () => {
        while (true) {
          if (_literatureAbort) break;
          const pii = piiQueue.shift();
          if (pii === undefined) break;
          try {
            const r = await httpRequest(`${SD_ARTICLE}/${encodeURIComponent(pii)}`, {
              headers: { 'X-ELS-APIKey': apikey, 'Accept': 'text/xml' },
            });
            if (r.status === 429) {
              // Rate-limited — put back and let the worker pause before retrying
              piiQueue.unshift(pii);
              await sleep(3000);
              continue;
            }
            if (r.status !== 200) { send('log', `  ✗ ${pii}: HTTP ${r.status}`); continue; }
            const safePii = pii.replace(/[^\w-]/g, '_');
            const sdFileName = searchName ? `${searchName}_sd_${safePii}.sdxml` : `${safePii}.sdxml`;
            fs.writeFileSync(path.join(outputDir, sdFileName), r.body.toString('utf8'), 'utf8');
            saved++;
            send('progress', { saved, total: totalPiis });
            send('log', `  ✓ ${sdFileName}`);
          } catch (e) {
            send('log', `  ✗ ${pii}: ${e.message}`);
          }
        }
      };

      // Start workers staggered by 100 ms to avoid a burst on the first tick
      const workerPromises = [];
      for (let i = 0; i < SD_CONCURRENCY; i++) {
        workerPromises.push(sdWorker());
        if (i < SD_CONCURRENCY - 1) await sleep(100);
      }
      await Promise.all(workerPromises);

      send('done', { saved, source: 'ScienceDirect', ext: '.sdxml' });
    }

    // ── Elsevier Consyn ──────────────────────────────────────────────────────
    else if (source === 'consyn') {
      // Accept token from call args OR from stored settings (login flow saves it there)
      const token = consynBearerToken || getStore().get('consynBearerToken') || '';
      if (!token) {
        send('error', 'Not logged in to Consyn — click "Login to Consyn" in Settings.');
        return { ok: false };
      }

      const consynHeaders = {
        'Authorization': `Bearer ${token}`,
        'Cookie':        `auth-token=${token}`,
        'User-Agent':    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':        'application/json, text/plain, */*',
        'Origin':        'https://consyn.elsevier.com',
        'Referer':       'https://consyn.elsevier.com/consyn/batch',
      };

      // Build list of Atom feed URLs.
      // Prefer auto-discovery via /api/batches (always returns a fresh key).
      // Fall back to a directly-pasted URL in the query field.
      const userId = getStore().get('consynUserId') || '';
      let atomUrls = [];

      if (userId) {
        send('log', `Fetching Consyn batches for user "${userId}"…`);
        const batchResp = await httpRequest('https://consyn.elsevier.com/api/batches', {
          method:  'POST',
          headers: { ...consynHeaders, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ userId }),
          timeout: 30000,
        });
        if (batchResp.status === 401) {
          send('error', 'Consyn session expired — click "Login to Consyn" in Settings to refresh.');
          return { ok: false };
        }
        if (batchResp.status !== 200) {
          throw new Error(`Consyn batches request failed (${batchResp.status}): ${batchResp.body.toString('utf8').slice(0, 200)}`);
        }
        const batchJson = JSON.parse(batchResp.body.toString('utf8'));
        const batches   = [].concat(batchJson.batches?.batch || []);
        for (const b of batches) {
          if (b.atomFeed) {
            atomUrls.push(`https://consyn.elsevier.com/api/atom?userId=${encodeURIComponent(userId)}&bulk=yes&key=${encodeURIComponent(b.atomFeed)}`);
          }
        }
        send('log', `Found ${batches.length} batch(es).`);
      } else {
        // Fallback: use URL pasted in query field
        const pastedUrl = query.trim();
        if (!pastedUrl) {
          send('error', 'Set your Consyn User ID in Settings (e.g. "ayuryev"), or paste an Atom Feed URL in the query field.');
          return { ok: false };
        }
        atomUrls = [pastedUrl];
      }

      // Parse all Atom feeds and collect ZIP entries
      const entryRe = /<entry[\s\S]*?<\/entry>/g;
      const linkRe  = /<link[^>]+href="([^"]+)"/;
      const titleRe = /<title[^>]*>([^<]+)<\/title>/;
      const allEntries = [];

      for (const atomUrl of atomUrls) {
        send('log', `Fetching feed…`);
        const feedResp = await httpRequest(atomUrl, { headers: consynHeaders });
        if (feedResp.status !== 200) {
          const msg = feedResp.status === 401
            ? 'Consyn session expired — click "Login to Consyn" in Settings.'
            : `Consyn feed request failed (${feedResp.status}): ${feedResp.body.toString('utf8').slice(0, 200)}`;
          throw new Error(msg);
        }
        const feedText = feedResp.body.toString('utf8');
        let em;
        while ((em = entryRe.exec(feedText)) !== null) {
          const lm = em[0].match(linkRe);
          const tm = em[0].match(titleRe);
          if (lm && tm) allEntries.push({ url: lm[1], filename: tm[1].trim() });
        }
      }

      if (!allEntries.length) { send('no_results', {}); return { ok: true }; }
      send('log', `Found ${allEntries.length} ZIP file(s), downloading…`);

      let saved = 0;
      for (let i = 0; i < allEntries.length; i++) {
        if (_literatureAbort) { send('log', 'Download stopped.'); break; }
        const { url: fileUrl, filename } = allEntries[i];
        const outPath = path.join(outputDir, filename);

        if (fs.existsSync(outPath)) {
          send('log', `  – ${filename} (already exists, skipped)`);
          saved++;
          send('progress', { saved, total: allEntries.length });
          continue;
        }

        try {
          const r = await httpRequest(fileUrl, { headers: consynHeaders, timeout: 300000 });
          if (r.status !== 200) {
            send('log', `  ✗ ${filename}: HTTP ${r.status}`);
            continue;
          }
          fs.writeFileSync(outPath, r.body);
          saved++;
          send('progress', { saved, total: allEntries.length });
          send('log', `  ✓ ${filename} (${(r.body.length / 1024 / 1024).toFixed(1)} MB)`);
        } catch (e) {
          send('log', `  ✗ ${filename}: ${e.message}`);
        }
      }
      send('done', { saved, source: 'Consyn', ext: '' });
    }

    return { ok: true };
  } catch (e) {
    send('error', e.message);
    return { ok: false, error: e.message };
  }
});

// ── DB proxy ─────────────────────────────────────────────────────────────────
// pgPool is set by startEmbeddedPostgres() before the window opens.
let pgPool = null;

async function getPool() {
  // Wait up to 15 seconds for the pool to be initialised by startEmbeddedPostgres
  for (let i = 0; i < 30; i++) {
    if (pgPool) return pgPool;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Database not ready after 15 s — check console for startup errors.');
}

ipcMain.handle('db:query', async (_, sql, params) => {
  try {
    const pool = await getPool();
    const result = await pool.query(sql, params || []);
    return { ok: true, rows: result.rows, rowCount: result.rowCount, fields: result.fields ? result.fields.map(f => f.name) : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Array-mode query: returns rows as arrays instead of objects so duplicate column
// names (e.g. SELECT a.id, b.id FROM ...) are preserved with correct positional values.
ipcMain.handle('db:queryArray', async (_, sql, params) => {
  try {
    const pool = await getPool();
    const result = await pool.query({ text: sql, values: params || [], rowMode: 'array' });
    return {
      ok: true,
      rows: result.rows,           // array of arrays
      rowCount: result.rowCount,
      fields: result.fields ? result.fields.map(f => f.name) : null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Bulk insert: streams rows into a table in one transaction using multi-value INSERTs.
// args: { table, columns: string[], rows: any[][], onConflict?: string }
// Rows are processed in batches of BATCH_SIZE to stay under the PG 65535-param limit.
ipcMain.handle('db:bulkInsert', async (_, { table, columns, rows, onConflict, _viaCasRoute }) => {
  if (!rows || rows.length === 0) return { ok: true, rowCount: 0 };
  // CASDictionary must only be written through addToCasDictionary() (chemNames token check + approval)
  if (table === 'casdictionary' && !_viaCasRoute)
    return { ok: false, error: 'Direct bulk insert into casdictionary is not allowed — use addToCasDictionary().' };
  const pool = await getPool();
  const client = await pool.connect();
  const nc = columns.length;
  const BATCH_SIZE = Math.floor(65000 / nc); // max rows per INSERT staying under param limit
  const conflict = onConflict || 'ON CONFLICT DO NOTHING';
  const colList = columns.map(c => `"${c}"`).join(', ');
  let total = 0;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL synchronous_commit = off");
    await client.query("SET LOCAL maintenance_work_mem = '256MB'");
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map((_, ri) =>
        `(${columns.map((_, ci) => `$${ri * nc + ci + 1}`).join(', ')})`
      ).join(', ');
      await client.query(
        `INSERT INTO "${table}" (${colList}) VALUES ${placeholders} ${conflict}`,
        batch.flat()
      );
      total += batch.length;
    }
    await client.query('COMMIT');
    return { ok: true, rowCount: total };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
});

// Run ANALYZE on one or more tables to refresh planner statistics after bulk loads.
ipcMain.handle('db:analyze', async (_, tables) => {
  try {
    const pool = await getPool();
    for (const t of tables)
      await pool.query(`ANALYZE "${t}"`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Fill cartridges column on all term control tables ─────────────────────────
// Sets every row in every xwords term control table to the full list of available
// cartridges. (spelling and bracketstop have no cartridges column — they are always global.)
ipcMain.handle('db:fillAllCartridges', async () => {
  try {
    const medscanDir = getStore().get('medscanDir');
    if (!medscanDir) return { ok: false, error: 'Elsevier NLP directory not configured.' };
    const pool = await getPool();
    const allCarts = fs.readdirSync(medscanDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.toLowerCase().endsWith('.bin'))
      .map(e => cartName(e.name));
    if (allCarts.length === 0) return { ok: false, error: 'No cartridges found in the configured directory.' };
    // xwords_comb is CellEffect-only — filter to that subset rather than all cartridges.
    const cellEffectCarts = allCarts.filter(c => c === 'CellEffect');
    // spelling and bracketstop have no cartridges column — skip them here.
    const TERM_CTRL_TABLES = ['xwords', 'xwords_cells', 'xwords_cas'];
    for (const tbl of TERM_CTRL_TABLES) {
      try { await pool.query(`UPDATE "${tbl}" SET cartridges = $1`, [allCarts]); } catch {}
    }
    if (cellEffectCarts.length > 0) {
      try { await pool.query(`UPDATE xwords_comb SET cartridges = $1`, [cellEffectCarts]); } catch {}
    }
    return { ok: true, cartridges: allCarts };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('db:vacuum', async () => {
  try {
    const pool = await getPool();
    // Tables that accumulate significant bloat from batch imports and deletes
    const tables = [
      'curnames', 'exactliteral', 'celldictionary', 'casdictionary',
      'keywords', 'userdict', 'objectnames', 'combnames',
    ];
    const freed = [];
    for (const t of tables) {
      // Size before
      const before = await pool.query(`SELECT pg_total_relation_size($1) AS sz`, [t]);
      const szBefore = Number(before.rows[0].sz);
      // VACUUM FULL rewrites the entire table + all its indexes, reclaiming dead row space
      await pool.query(`VACUUM FULL "${t}"`);
      // ANALYZE updates planner statistics (REINDEX is redundant — VACUUM FULL already rebuilds indexes)
      await pool.query(`ANALYZE "${t}"`);
      const after = await pool.query(`SELECT pg_total_relation_size($1) AS sz`, [t]);
      const szAfter = Number(after.rows[0].sz);
      freed.push({ table: t, before: szBefore, after: szAfter });
    }
    const totalBefore = freed.reduce((s, r) => s + r.before, 0);
    const totalAfter  = freed.reduce((s, r) => s + r.after,  0);
    return { ok: true, freed, totalBefore, totalAfter };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('db:resetPool', () => {
  // With embedded PG the pool config is fixed; just end and recreate
  if (pgPool) {
    pgPool.end().catch(() => {});
    const { Pool } = require('pg');
    pgPool = new Pool({ host: 'localhost', port: PG_PORT, database: PG_DATABASE, user: PG_USER, password: PG_PASSWORD });
  }
  return true;
});

// Rebuild organisms_lookup from the alias tables.
// Runs once on first migrate (when the table is empty) and after every restore.
// Uses LIMIT per table so it never scans millions of rows — organism values are a
// small controlled vocabulary and a sample of 50 000 rows per table captures all of them.
async function rebuildOrganismsLookup(pool) {
  const ORGANISM_TABLES = ['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict','combnames'];
  const orgSql = ORGANISM_TABLES
    .map(t => `SELECT DISTINCT unnest(organisms) AS org FROM (SELECT organisms FROM "${t}" WHERE organisms IS NOT NULL AND organisms <> '{}' LIMIT 50000) _s`)
    .join(' UNION ');
  await pool.query(`
    TRUNCATE TABLE organisms_lookup;
    INSERT INTO organisms_lookup (name)
    SELECT DISTINCT org FROM (${orgSql}) t
    WHERE org IS NOT NULL AND org <> '';
  `);
}

// Rebuild cartridges_lookup — distinct cartridge names across all alias tables.
// rsmap has no cartridges column (routed to GeneticVariant via cartridgeFilter at deploy time).
async function rebuildCartridgesLookup(pool) {
  const CART_TABLES = ['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict','combnames','objectnames'];
  const cartSql = CART_TABLES
    .map(t => `SELECT DISTINCT unnest(cartridges) AS cart FROM (SELECT cartridges FROM "${t}" WHERE cartridges IS NOT NULL AND cartridges <> '{}' LIMIT 50000) _s`)
    .join(' UNION ');
  await pool.query(`
    TRUNCATE TABLE cartridges_lookup;
    INSERT INTO cartridges_lookup (name)
    SELECT DISTINCT cart FROM (${cartSql}) t
    WHERE cart IS NOT NULL AND cart <> '';
  `);
}

// Rebuild match_opts_lookup — distinct (table_name, match_value) pairs for the match dropdown.
// Limits each table to 50 000 rows; match is a small controlled vocabulary so this captures all values.
async function rebuildMatchOptsLookup(pool) {
  const MATCH_TABLES = ['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict','combnames'];
  const unionSql = MATCH_TABLES
    .map(t => `SELECT '${t}' AS table_name, match AS match_value FROM (SELECT match FROM "${t}" WHERE match IS NOT NULL AND match <> '' LIMIT 50000) _s`)
    .join(' UNION ALL ');
  await pool.query(`
    TRUNCATE TABLE match_opts_lookup;
    INSERT INTO match_opts_lookup (table_name, match_value)
    SELECT DISTINCT table_name, match_value FROM (${unionSql}) t
    ON CONFLICT DO NOTHING;
  `);
  // rsmap uses hgvs_code as its match field
  await pool.query(`
    INSERT INTO match_opts_lookup (table_name, match_value)
    SELECT DISTINCT 'rsmap', hgvs_code FROM rsmap
    WHERE hgvs_code IS NOT NULL AND hgvs_code <> ''
    LIMIT 50000
    ON CONFLICT DO NOTHING;
  `);
}

ipcMain.handle('db:migrate', async () => {
  try {
    const pool = await getPool();
    const migrationSQL = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8');
    await pool.query(migrationSQL);
    // Populate lookup tables on first run (tables just created → empty).
    const [orgR, matchR, cartR] = await Promise.all([
      pool.query('SELECT COUNT(*) AS c FROM organisms_lookup'),
      pool.query('SELECT COUNT(*) AS c FROM match_opts_lookup'),
      pool.query('SELECT COUNT(*) AS c FROM cartridges_lookup'),
    ]);
    if (Number(orgR.rows[0].c)   === 0) await rebuildOrganismsLookup(pool);
    if (Number(matchR.rows[0].c) === 0) await rebuildMatchOptsLookup(pool);
    if (Number(cartR.rows[0].c)  === 0) await rebuildCartridgesLookup(pool);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Database Backup / Restore ─────────────────────────────────────────────────

// Single source of truth — defined at the top of this file.
const BACKUP_TABLES = TABLES_FOR_BACKUP;

// Backup format: newline-delimited JSON (NDJSON).
// Line 1: header  { version, created }
// Each subsequent line: { table, row } — one row per line.
// This avoids ever holding the full dataset in a single string.
//
// Large tables (rsmap) are written to a companion file <base>-rsmap.nlpdb so the
// main backup stays small enough to zip and email.

// Dump all rows of `tbl` from `pool` into a temporary NDJSON file.
// Returns { tmpPath, rows } on success; throws on error.
// FETCH 2000 rows per round-trip to minimise PG cursor overhead.
async function backupTableToTempFile(pool, tbl) {
  const tmpPath = path.join(os.tmpdir(), `nlpbk_${tbl}_${process.pid}.ndjson`);
  const stream  = fs.createWriteStream(tmpPath, { encoding: 'utf8' });
  let rows = 0, fetchMs = 0, jsonMs = 0;                 // timing: waiting for PostgreSQL / JSON.stringify + write
  const t0 = Date.now();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hasId = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'id'`,
      [tbl.toLowerCase()]
    );
    const orderBy = hasId.rows.length > 0 ? 'ORDER BY id' : '';
    await client.query(`DECLARE backup_cur CURSOR FOR SELECT * FROM "${tbl}" ${orderBy}`);
    while (true) {
      const tf = Date.now();
      const { rows: fetched } = await client.query('FETCH 2000 FROM backup_cur');
      fetchMs += Date.now() - tf;
      if (fetched.length === 0) break;
      const tj = Date.now();
      for (const row of fetched) {
        stream.write(JSON.stringify({ table: tbl, row }) + '\n');
        rows++;
      }
      jsonMs += Date.now() - tj;
    }
    await client.query('CLOSE backup_cur');
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    stream.destroy();
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  } finally {
    client.release();
  }

  await new Promise((resolve, reject) => {
    stream.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  let bytes = 0; try { bytes = fs.statSync(tmpPath).size; } catch {}
  return { tmpPath, rows, bytes, ms: Date.now() - t0, fetchMs, jsonMs };
}

// Create a gzip-compressed write stream to a file path.
// Returns { writeStream, fileStream } — write to writeStream; wait for fileStream 'finish' to confirm flush.
function createGzipWriteStream(filePath) {
  const fileStream  = fs.createWriteStream(filePath);
  const writeStream = zlib.createGzip({ level: 6 });
  writeStream.pipe(fileStream);
  return { writeStream, fileStream };
}

// Create a readable stream from filePath, automatically decompressing if the file ends in .gz.
function createReadStream(filePath) {
  const raw = fs.createReadStream(filePath);
  if (filePath.endsWith('.gz')) {
    const gunzip = zlib.createGunzip();
    raw.pipe(gunzip);
    return gunzip;
  }
  return raw;
}

ipcMain.handle('db:backup', async () => {
  const startedAt = new Date();
  let startMs     = Date.now();   // reset below, once the user has chosen the save location

  const sendProgress = (data) => {
    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    try { mainWindow.webContents.send('db:backup-progress', { ...data, elapsedSec }); } catch {}
  };

  const tempFiles    = {}; // tbl → { tmpPath, rows }
  const skippedTables = []; // tables that failed to back up

  try {
    const { canceled, filePath: outPath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Database Backup',
      defaultPath: `nlpmanager-backup-${startedAt.toISOString().slice(0,10)}.nlpdb.gz`,
      filters: [
        { name: 'NLPmanager Database (compressed)', extensions: ['nlpdb.gz'] },
        { name: 'NLPmanager Database (uncompressed)', extensions: ['nlpdb'] },
      ],
    });
    if (canceled || !outPath) return { ok: false, canceled: true };
    startMs = Date.now();   // elapsed time counts from here — not while the user was choosing the file name

    const pool    = await getPool();
    const created = startedAt.toISOString();

    // ── Phase 1: dump all tables in parallel (up to 6 concurrent PG cursors) ──
    // Biggest table first (rsmap always first, then by data size): the restore reads the file in this order, so the biggest tables start loading
    // first; the parallel dump below starts with them too. A restore accepts any table order.
    let backupOrder = [...BACKUP_TABLES];
    try {
      const sz = await pool.query(
        `SELECT lower(c.relname) AS t, pg_table_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind = 'r' AND lower(c.relname) = ANY($1)`, [BACKUP_TABLES]);
      const bytes = Object.fromEntries(sz.rows.map(r => [r.t, Number(r.bytes)]));
      backupOrder.sort((a, b) => (b === 'rsmap') - (a === 'rsmap') || (bytes[b] || 0) - (bytes[a] || 0));
    } catch (e) { console.warn('[Backup] table sizes unavailable, default order:', e.message); }
    console.log('[Backup] table order: ' + backupOrder.join(', '));
    sendProgress({ phase: 'start', startedAt: created, tables: backupOrder });

    const CONCURRENCY = 6;
    const queue = [...backupOrder];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const tbl = queue.shift();
        if (!tbl) break;
        sendProgress({ phase: 'dumping', table: tbl });
        try {
          const result = await backupTableToTempFile(pool, tbl);
          tempFiles[tbl] = result;
          sendProgress({ phase: 'dumped', table: tbl, rows: result.rows });
        } catch (e) {
          console.warn(`[Backup] Skipping table ${tbl}:`, e.message);
          skippedTables.push({ table: tbl, error: e.message });
          sendProgress({ phase: 'skip', table: tbl, error: e.message });
        }
      }
    });
    await Promise.all(workers);
    const dumpMs = Date.now() - startMs;

    // ── Phase 2: merge temp files into final output (gzip or plain) ──────────
    const mergeT0 = Date.now();
    sendProgress({ phase: 'merging' });

    const gz = outPath.endsWith('.gz');
    let writeStream, fileStream;
    if (gz) {
      ({ writeStream, fileStream } = createGzipWriteStream(outPath));
    } else {
      writeStream = fileStream = fs.createWriteStream(outPath, { encoding: 'utf8' });
    }

    writeStream.write(JSON.stringify({ version: 2, created }) + '\n');
    let totalRows = 0;
    for (const tbl of backupOrder) {
      const entry = tempFiles[tbl];
      if (!entry) continue;
      totalRows += entry.rows;
      // Stream temp file into the output (no extra memory pressure).
      await new Promise((resolve, reject) => {
        const src = fs.createReadStream(entry.tmpPath, { encoding: 'utf8' });
        src.on('data', chunk => { if (!writeStream.write(chunk)) src.pause(); });
        writeStream.on('drain', () => src.resume());
        src.on('end', resolve);
        src.on('error', reject);
      });
      // Clean up temp file immediately after merge.
      try { fs.unlinkSync(entry.tmpPath); } catch {}
    }

    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
      writeStream.end();
    });

    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    // timing log: where the time goes (dump = PostgreSQL + JSON per table, in parallel; merge = re-read + gzip, one thread)
    const mergeMs = Date.now() - mergeT0;
    let outBytes = 0; try { outBytes = fs.statSync(outPath).size; } catch {}
    const rawBytes = Object.values(tempFiles).reduce((n, e) => n + (e.bytes || 0), 0);
    const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
    const timing = { dumpMs, mergeMs, rawBytes, outBytes, tables: Object.fromEntries(Object.entries(tempFiles).map(([t, e]) => [t, { rows: e.rows, bytes: e.bytes, ms: e.ms, fetchMs: e.fetchMs, jsonMs: e.jsonMs }])) };
    console.log('[Backup timing] dump ' + dumpMs + ' ms (6 tables at a time), merge+' + (gz ? 'gzip' : 'copy') + ' ' + mergeMs + ' ms, ndjson ' + mb(rawBytes) + ' → file ' + mb(outBytes) + ', total ' + (Date.now() - startMs) + ' ms');
    for (const [t, e] of Object.entries(timing.tables).sort((a, b) => b[1].ms - a[1].ms)) console.log('[Backup timing]   ' + t.padEnd(24) + String(e.rows).padStart(10) + ' rows  ' + mb(e.bytes).padStart(10) + '  ' + String(e.ms).padStart(7) + ' ms  (PostgreSQL FETCH ' + e.fetchMs + ' ms, JSON+write ' + e.jsonMs + ' ms)');
    sendProgress({ phase: 'done', totalRows, elapsedSec, skippedTables });
    return { ok: true, filePath: outPath, totalRows, startedAt: created, elapsedSec, skippedTables, timing };
  } catch (e) {
    // Clean up any temp files on error.
    for (const { tmpPath } of Object.values(tempFiles)) {
      try { if (tmpPath) fs.unlinkSync(tmpPath); } catch {}
    }
    return { ok: false, error: e.message };
  }
});

// ── Phase 1: stream NDJSON into per-table temp files (no whole-file buffering) ──
// Returns { header, tableOrder, tempFiles: { tbl → tmpPath } }
async function splitNdjsonToTempFiles(filePath) {
  const tmpDir = os.tmpdir();
  let header = null;
  const tableOrder = [];
  const tempFiles  = {}; // tbl → tmpPath
  const streams    = {}; // tbl → WriteStream

  await new Promise((resolve, reject) => {
    const rl = require('readline').createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });
    let paused = false;
    rl.on('line', (line) => {
      if (!line.trim()) return;
      // A row line is {"table":"<name>","row":{…}} (written by the backup): cut the table name and the row text out as strings —
      // no JSON.parse / JSON.stringify per row (that was most of the time for 15M rows). Anything else is parsed the slow way.
      let table, rowText;
      const P = '{"table":"', SEP = '","row":';
      if (header && line.startsWith(P)) {
        const e = line.indexOf(SEP, P.length);
        if (e > 0 && line.endsWith('}')) { table = line.slice(P.length, e); rowText = line.slice(e + SEP.length, -1); }
      }
      if (table === undefined) {
        let obj;
        try { obj = JSON.parse(line); } catch { return; }
        if (!header) { header = obj; return; }
        table = obj.table; rowText = JSON.stringify(obj.row);
      }
      if (!streams[table]) {
        const tmpPath = path.join(tmpDir, `nlprs_${table}_${process.pid}.ndjson`);
        streams[table]  = fs.createWriteStream(tmpPath, { encoding: 'utf8' });
        tempFiles[table] = tmpPath;
        tableOrder.push(table);
      }
      // Back-pressure: when the disk can't keep up, pause reading until the stream drains
      // (otherwise gigabytes of pending writes accumulate in memory).
      // Only ONE drain listener per pause: readline keeps emitting the lines of the chunk it already
      // read after pause(), and registering a listener for each of them triggered MaxListenersExceeded.
      const ws = streams[table];
      if (!ws.write(rowText + '\n') && !paused) {
        paused = true;
        rl.pause();
        ws.once('drain', () => { paused = false; rl.resume(); });
      }
    });
    rl.on('close', async () => {
      // Close all open write streams before resolving.
      const closes = Object.values(streams).map(s => new Promise((res, rej) => {
        s.end(); s.on('finish', res); s.on('error', rej);
      }));
      try { await Promise.all(closes); resolve(); } catch (e) { reject(e); }
    });
    rl.on('error', reject);
  });

  if (!header || !header.version) throw new Error('Invalid or empty backup file.');
  return { header, tableOrder, tempFiles };
}

// ── Phase 2: restore one table from its temp file ──────────────────────────────
// STREAMS the temp file: reads a bounded batch of rows, INSERTs it, repeats. (The old version pushed every
// row of the table into one JS array first — rsmap has ~10M rows / 2.7 GB of JSON, so the heap ran out.)
// The table is TRUNCATEd right before the first batch is written.
// The table's indexes (primary key and indexes that back a constraint excluded) are dropped after the TRUNCATE and rebuilt once after the load:
// maintaining 4–7 indexes row by row was most of the insert time. Rebuilt in a finally — a failed restore never leaves a table without them
// (and schema.sql, run at the start of every restore, re-creates missing ones as well).
async function dropTableIndexes(pool, tbl, dropped) {
  const r = await pool.query(
    `SELECT i.schemaname, i.indexname, i.indexdef FROM pg_indexes i
      WHERE i.schemaname = current_schema() AND lower(i.tablename) = lower($1)
        AND i.indexname NOT IN (SELECT ic.relname FROM pg_constraint c JOIN pg_class ic ON ic.oid = c.conindid WHERE c.conindid <> 0)`, [tbl]);
  for (const x of r.rows) {
    await pool.query(`DROP INDEX IF EXISTS "${x.schemaname}"."${x.indexname}"`);
    dropped.push(x.indexdef);
  }
}
// Index builds run side by side: at most INDEX_SLOTS at once across the WHOLE restore (every table shares the slots), each with INDEX_MEM of sort memory
// (default 64 MB) — so the memory stays bounded (4 × 512 MB) however many tables finish at the same time. A table's slot waits do not hold a connection.
const INDEX_SLOTS = 4, INDEX_MEM = '512MB';
let indexBusy = 0;
const indexWait = [];
const acquireIndexSlot = () => (indexBusy < INDEX_SLOTS ? (indexBusy++, Promise.resolve()) : new Promise(r => indexWait.push(r)));   // a released slot is handed on directly
const releaseIndexSlot = () => { const w = indexWait.shift(); if (w) w(); else indexBusy--; };
async function recreateTableIndexes(pool, dropped, stats) {
  if (!dropped.length) return;
  const t0 = Date.now();
  let firstError = null;
  await Promise.all(dropped.splice(0).map(async (def) => {
    await acquireIndexSlot();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL maintenance_work_mem = '${INDEX_MEM}'`);       // only for this build — the pooled connection keeps its setting
      await client.query(def.replace(/^CREATE (UNIQUE )?INDEX /i, m => m + 'IF NOT EXISTS '));
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection already unusable */ }
      if (!firstError) firstError = e;
    } finally { client.release(); releaseIndexSlot(); }
  }));
  if (stats) stats.idxMs = Date.now() - t0;
  if (firstError) throw firstError;
}
async function restoreTableFromTempFile(pool, tbl, tmpPath, onBatch, stats) {
  const dropped = [];
  let n;
  try { n = await restoreTableData(pool, tbl, tmpPath, onBatch, dropped, stats); }
  finally {
    if (stats) stats.nIdx = dropped.length;
    await recreateTableIndexes(pool, dropped, stats);
  }
  return n;
}
async function restoreTableData(pool, tbl, tmpPath, onBatch, droppedIdx, stats) {
  const rl = require('readline').createInterface({
    input: fs.createReadStream(tmpPath, { encoding: 'utf8', highWaterMark: 1024 * 1024 }),
    crlfDelay: Infinity,
  });

  let cols = null, colList = '', maxBatch = 1000;
  let batch = [];
  let inserted = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const values = [];
    const placeholders = batch.map((row, bi) =>
      '(' + cols.map((c, ci) => { values.push(row[c]); return '$' + (bi * cols.length + ci + 1); }).join(',') + ')'
    );
    await pool.query(`INSERT INTO "${tbl}" (${colList}) VALUES ${placeholders.join(',')}`, values);
    inserted += batch.length;
    batch = [];
    if (onBatch) onBatch(inserted);
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!cols) {
      // A backup may come from another schema version: restore only the columns this table has now.
      const have = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND lower(table_name) = lower($1)`, [tbl]);
      const known = new Set(have.rows.map(r => r.column_name));
      cols = Object.keys(row).filter(c => !known.size || known.has(c));
      const dropped = Object.keys(row).filter(c => !cols.includes(c));
      if (dropped.length) console.warn(`[Restore] ${tbl}: backup columns not in current schema are ignored: ${dropped.join(', ')}`);
      if (!cols.length) return 0;
      colList = cols.map(c => `"${c}"`).join(',');
      // PG allows 65535 parameters per statement → rows per INSERT = 60000 / columns (max 5000)
      maxBatch = Math.max(1, Math.min(5000, Math.floor(60000 / cols.length)));
      await pool.query(`TRUNCATE TABLE "${tbl}" RESTART IDENTITY CASCADE`);
      await dropTableIndexes(pool, tbl, droppedIdx);
    }
    batch.push(row);
    if (batch.length >= maxBatch) await flush();
  }
  await flush();
  if (!cols) return 0;

  if (cols.includes('id')) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('${tbl}','id'), COALESCE(MAX(id),0)+1, false) FROM "${tbl}"`
    ).catch(() => {});
  }
  return inserted;
}

// ── Streaming restore ────────────────────────────────────────────────────────
// One pass over the backup: gunzip → lines → table sections (the backup writes table after table) → one inserter per table that loads while the
// file is still being read. No temp files and no second parse pass; a table is finished (setval, index rebuild) as soon as its section ends,
// while the next sections are read. The reader waits when a table's queue is full or when 6 tables are in flight.

// Loads the rows of ONE table: collects row texts into batches and runs up to 3 multi-row INSERTs of that table at once.
function makeTableInserter(pool, tbl) {
  const BATCH_WORKERS = 3, MAX_QUEUED = 6;
  const stats = {}, dropped = [], queue = [], waiters = [];
  const t0 = Date.now();
  let cols = null, colList = '', maxBatch = 1000, buf = [], inserted = 0, active = 0, error = null, initP = null, ready = false;
  const wake = () => { for (const w of waiters.splice(0)) w(); };
  const waitForChange = () => new Promise(r => waiters.push(r));

  // first row: which columns to restore (a backup may come from another schema version), TRUNCATE, drop the indexes
  const init = async (firstText) => {
    const row = JSON.parse(firstText);
    const have = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND lower(table_name) = lower($1)`, [tbl]);
    const known = new Set(have.rows.map(r => r.column_name));
    cols = Object.keys(row).filter(c => !known.size || known.has(c));
    const ignored = Object.keys(row).filter(c => !cols.includes(c));
    if (ignored.length) console.warn(`[Restore] ${tbl}: backup columns not in current schema are ignored: ${ignored.join(', ')}`);
    if (!cols.length) return;
    colList = cols.map(c => `"${c}"`).join(',');
    maxBatch = Math.max(1, Math.min(5000, Math.floor(60000 / cols.length)));      // PG allows 65535 parameters per statement
    await pool.query(`TRUNCATE TABLE "${tbl}" RESTART IDENTITY CASCADE`);
    await dropTableIndexes(pool, tbl, dropped);
  };

  const pump = () => {
    while (!error && queue.length && active < BATCH_WORKERS) {
      const texts = queue.shift();
      active++;
      (async () => {
        try {
          const values = [];
          const ph = texts.map((t, bi) => {
            const row = JSON.parse(t);
            return '(' + cols.map((c, ci) => { values.push(row[c]); return '$' + (bi * cols.length + ci + 1); }).join(',') + ')';
          });
          await pool.query(`INSERT INTO "${tbl}" (${colList}) VALUES ${ph.join(',')}`, values);
          inserted += texts.length;
        } catch (e) { if (!error) error = e; }
        active--; wake(); pump();
      })();
    }
  };

  const add = (text) => {
    if (error || !cols.length) return undefined;
    buf.push(text);
    if (buf.length < maxBatch) return undefined;
    queue.push(buf); buf = []; pump();
    if (queue.length < MAX_QUEUED) return undefined;
    return (async () => { while (queue.length >= MAX_QUEUED && !error) await waitForChange(); })();      // back-pressure on the reader
  };

  // returns a promise only when the reader has to wait
  const push = (text) => {
    if (error) return undefined;
    if (ready) return add(text);
    if (!initP) initP = init(text).then(() => { ready = true; }, (e) => { error = e; });
    return initP.then(() => (error ? undefined : add(text)));
  };

  const finish = async () => {
    try {
      if (initP) await initP;
      if (!error && cols && cols.length && buf.length) { queue.push(buf); buf = []; pump(); }
      while (!error && (queue.length || active)) await waitForChange();
      while (active) await waitForChange();
      if (error) throw error;
      if (!cols || !cols.length) return { rows: 0, stats };
      if (cols.includes('id')) {
        await pool.query(`SELECT setval(pg_get_serial_sequence('${tbl}','id'), COALESCE(MAX(id),0)+1, false) FROM "${tbl}"`).catch(() => {});
      }
      return { rows: inserted, stats };
    } finally {
      stats.nIdx = dropped.length;
      try { await recreateTableIndexes(pool, dropped, stats); } finally { stats.ms = Date.now() - t0; }
    }
  };

  return { push, finish };
}

// Reads the backup once and restores it table by table. Resolves when every table is finished; onStart(table) / onDone(table, result, error) report progress.
// Throws an error with code 'NONCONTIGUOUS' if a table's rows are not in one block (then the caller falls back to the temp-file restore).
async function restoreStreaming(pool, filePath, { concurrency = 6, onStart, onDone }) {
  const input = createReadStream(filePath);
  const rl = require('readline').createInterface({ input, crlfDelay: Infinity });
  let readErr = null;
  input.on('error', (e) => { readErr = e; rl.close(); });

  const running = new Set(), closed = new Set();
  let cur = null, curName = null, header = false;
  const P = '{"table":"', SEP = '","row":';

  const closeCur = () => {
    if (!cur) return;
    const name = curName, ins = cur;
    closed.add(name); cur = null; curName = null;
    const p = ins.finish()
      .then((r) => onDone(name, r, null), (e) => onDone(name, null, e))
      .finally(() => running.delete(p));
    running.add(p);
  };

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      // a row line is {"table":"<name>","row":{…}}: cut the table name and the row text out as strings (no JSON.parse per row here)
      let table, rowText;
      if (header && line.startsWith(P)) {
        const e = line.indexOf(SEP, P.length);
        if (e > 0 && line.endsWith('}')) { table = line.slice(P.length, e); rowText = line.slice(e + SEP.length, -1); }
      }
      if (table === undefined) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!header) { header = true; continue; }
        table = obj.table; rowText = JSON.stringify(obj.row);
      }
      if (table !== curName) {
        if (closed.has(table)) throw Object.assign(new Error(`rows of table ${table} are not in one block`), { code: 'NONCONTIGUOUS' });
        closeCur();                                                              // the previous table finishes in the background
        while (running.size + 1 > concurrency) await Promise.race(running);
        cur = makeTableInserter(pool, table); curName = table;
        onStart(table);
      }
      const w = cur.push(rowText);
      if (w) await w;
    }
  } catch (e) {
    closeCur();
    await Promise.all([...running]);
    throw e;
  } finally {
    try { input.destroy(); } catch { /* already closed */ }
  }
  closeCur();
  await Promise.all([...running]);
  if (readErr) throw readErr;
}

ipcMain.handle('db:restore', async () => {
  let startMs = Date.now();   // reset below, once the user has chosen the file
  const sendProgress = (data) => {
    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    try { mainWindow.webContents.send('db:restore-progress', { ...data, elapsedSec }); } catch {}
  };

  const tempFiles      = {};
  const skippedTables  = [];
  try {
    const lastDir = getStore().get('lastRestoreDir') || '';
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Open Database Backup',
      ...(lastDir && fs.existsSync(lastDir) ? { defaultPath: lastDir } : {}),
      properties: ['openFile'],
      filters: [
        { name: 'NLPmanager Database', extensions: ['nlpdb.gz', 'nlpdb'] },
      ],
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    try { getStore().set('lastRestoreDir', path.dirname(filePaths[0])); } catch { /* optional */ }
    startMs = Date.now();   // elapsed time counts from here — not while the user was browsing for the file

    const pool = await getPool();

    // Ensure all tables exist on this machine before restoring.
    const schemaFile = app.isPackaged
      ? path.join(process.resourcesPath, 'db', 'schema.sql')
      : path.join(__dirname, '../../db/schema.sql');
    await pool.query(fs.readFileSync(schemaFile, 'utf8'));

    // ── Phases 1+2: read the backup ONCE and load every table while the file is still being read (streaming) ──
    sendProgress({ phase: 'reading', startedAt: new Date().toISOString() });
    const tmark = { split0: Date.now() }, tbl_ms = {}, vac_ms = {};          // timing log
    let totalRows = 0, streamed = false;
    sendProgress({ phase: 'inserting', tables: [] });
    try {
      await restoreStreaming(pool, filePaths[0], {
        concurrency: 6,
        onStart: (t) => sendProgress({ phase: 'restoring', table: t }),
        onDone: (t, r, err) => {
          if (err) {
            console.warn(`[Restore] Error restoring ${t}:`, err.message);
            skippedTables.push({ table: t, error: err.message });
            sendProgress({ phase: 'skip', table: t, error: err.message });
          } else {
            tbl_ms[t] = { rows: r.rows, ms: r.stats.ms || 0, idxMs: r.stats.idxMs || 0, nIdx: r.stats.nIdx || 0 };
            totalRows += r.rows;
            sendProgress({ phase: 'restored', table: t, rows: r.rows });
          }
        },
      });
      streamed = true;
    } catch (e) {
      if (e.code !== 'NONCONTIGUOUS') throw e;
      console.warn('[Restore] the backup mixes the rows of its tables — falling back to the temp-file restore (' + e.message + ')');
      skippedTables.length = 0; totalRows = 0; for (const k of Object.keys(tbl_ms)) delete tbl_ms[k];
    }
    tmark.insert0 = streamed ? tmark.split0 : Date.now();

    // ── Fallback: stream NDJSON into per-table temp files, then restore all tables in parallel (up to 6 workers) ──
    const CONCURRENCY = 6;
    let tableOrder = [];
    if (!streamed) {
      const sp = await splitNdjsonToTempFiles(filePaths[0]);
      tableOrder = sp.tableOrder; Object.assign(tempFiles, sp.tempFiles);
      tmark.insert0 = Date.now();
      sendProgress({ phase: 'inserting', tables: tableOrder });
    }
    // biggest tables first (by the size of their temp file)
    const sizeOf = (t) => { try { return fs.statSync(tempFiles[t]).size; } catch { return 0; } };
    const queue   = [...tableOrder].sort((a, b) => sizeOf(b) - sizeOf(a));

    const workers = Array.from({ length: streamed ? 0 : CONCURRENCY }, async () => {
      while (true) {
        const tbl = queue.shift();
        if (!tbl) break;
        sendProgress({ phase: 'restoring', table: tbl });
        const tt = Date.now();
        try {
          const stats = {};
          const rows = await restoreTableFromTempFile(pool, tbl, tempFiles[tbl], null, stats);
          tbl_ms[tbl] = { rows, ms: Date.now() - tt, idxMs: stats.idxMs || 0, nIdx: stats.nIdx || 0 };
          totalRows += rows;
          sendProgress({ phase: 'restored', table: tbl, rows });
        } catch (e) {
          console.warn(`[Restore] Error restoring ${tbl}:`, e.message);
          skippedTables.push({ table: tbl, error: e.message });
          sendProgress({ phase: 'skip', table: tbl, error: e.message });
        } finally {
          try { fs.unlinkSync(tempFiles[tbl]); } catch {}
        }
      }
    });
    await Promise.all(workers);

    // ── Phase 3: rebuild derived lookup tables ────────────────────────────────
    tmark.lookups0 = Date.now();
    sendProgress({ phase: 'lookups' });
    await rebuildOrganismsLookup(pool);
    await rebuildMatchOptsLookup(pool);
    await rebuildCartridgesLookup(pool);
    tmark.vacuum0 = Date.now();

    // ── Phase 4: VACUUM FULL + ANALYZE (reclaim space from batch INSERT bloat) ──
    const VACUUM_TABLES = [
      'curnames', 'exactliteral', 'celldictionary', 'casdictionary',
      'keywords', 'userdict', 'objectnames', 'combnames', 'rsmap',
    ];
    for (const t of VACUUM_TABLES) {
      sendProgress({ phase: 'vacuum', table: t });
      try {
        // no VACUUM FULL: the table was just TRUNCATEd and filled by INSERTs only — there is no dead space to give back (it rewrote every table and rebuilt its indexes: ~3 min)
        const tv = Date.now(), tv2 = tv;
        await pool.query(`ANALYZE "${t}"`);
        vac_ms[t] = { vacuumMs: tv2 - tv, analyzeMs: Date.now() - tv2 };
      } catch (e) {
        console.warn(`[Restore] VACUUM FULL ${t} failed:`, e.message);
      }
    }

    const elapsedSec = Math.round((Date.now() - startMs) / 1000);
    // timing log: read+split (one thread: gunzip, JSON.parse, JSON.stringify), insert (6 tables at a time), lookups, VACUUM FULL + ANALYZE (one table after the other)
    const now = Date.now();
    console.log('[Restore timing] ' + (streamed ? 'streamed (read + insert together) ' : 'read+split ' + (tmark.insert0 - tmark.split0) + ' ms, insert ') + (tmark.lookups0 - tmark.insert0) + ' ms, lookups ' + (tmark.vacuum0 - tmark.lookups0) + ' ms, vacuum+analyze ' + (now - tmark.vacuum0) + ' ms, total ' + (now - startMs) + ' ms');
    for (const [t, e] of Object.entries(tbl_ms).sort((a, b) => b[1].ms - a[1].ms)) console.log('[Restore timing]   insert ' + t.padEnd(20) + String(e.rows).padStart(10) + ' rows  ' + String(e.ms).padStart(7) + ' ms  (of it ' + e.idxMs + ' ms rebuilding ' + e.nIdx + ' indexes)');
    for (const [t, e] of Object.entries(vac_ms).sort((a, b) => b[1].vacuumMs - a[1].vacuumMs)) console.log('[Restore timing]   vacuum ' + t.padEnd(20) + String(e.vacuumMs).padStart(7) + ' ms (VACUUM FULL), ' + e.analyzeMs + ' ms (ANALYZE)');
    const timing = { splitMs: tmark.insert0 - tmark.split0, insertMs: tmark.lookups0 - tmark.insert0, lookupsMs: tmark.vacuum0 - tmark.lookups0, vacuumMs: now - tmark.vacuum0, tables: tbl_ms, vacuum: vac_ms };
    sendProgress({ phase: 'done', totalRows, elapsedSec, skippedTables });
    return { ok: true, totalRows, elapsedSec, skippedTables, timing };
  } catch (e) {
    for (const tmpPath of Object.values(tempFiles)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    return { ok: false, error: e.message };
  }
});

// ── Retokenize existing aliases with updated tokenization rules ───────────────
ipcMain.handle('db:retokenize', async () => {
  try {
    const { ALL_XWORDS_TABLES, exactLiteralTokenized, buildSeparatorSet, setSpellingMap,
            normalizeForTableSync, tokenizeForTableSync } = await _tok();
    const pool = await getPool();

    // Load ALL xwords tables so we can build the global separator set.
    const loadXw = async (tbl) => {
      try {
        const r = await pool.query(`SELECT xword FROM ${tbl} ORDER BY xword LIMIT 5000`);
        return new Set(r.rows.map(x => x.xword.toLowerCase()));
      } catch { return new Set(); }
    };
    const xwCache = {};
    await Promise.all([
      Promise.all(ALL_XWORDS_TABLES.map(async t => { xwCache[t] = await loadXw(t); })),
      (async () => {
        try {
          const sr = await pool.query('SELECT canonical, spellings FROM spelling LIMIT 20000');
          if (sr.rows.length > 0) {
            const map = new Map();
            for (const row of sr.rows) {
              const canonical = (row.canonical || '').trim().toLowerCase();
              const variants  = (row.spellings  || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
              for (const v of variants) { if (v && v !== canonical) map.set(v, canonical); }
            }
            setSpellingMap(map);
          }
        } catch { /* spelling table absent — skip */ }
      })(),
    ]);
    const separatorSet = buildSeparatorSet(xwCache);
    const xwMap = {
      xwords:        xwCache['xwords']        || new Set(),
      xwords_cells:  xwCache['xwords_cells']  || new Set(),
      xwords_cas:    xwCache['xwords_cas']    || new Set(),
      xwords_comb:   xwCache['xwords_comb']   || new Set(),
    };

    // processTable: recompute tokenized + normalized for every row using the canonical
    // normalizeForTableSync / tokenizeForTableSync from shared/tokenizer.js — the same
    // functions the renderer's normalizeForTable calls. This guarantees the stored
    // `normalized` column always matches what searchAlias queries.
    const processTable = async (tbl) => {
      const rows = await pool.query(
        `SELECT id, alias, match, tokenized, normalized FROM ${tbl}`
      );
      const updates = rows.rows
        .map(r => {
          let newTok, newNorm;
          if (tbl === 'exactliteral') {
            // exactliteral: verbatim for 'l' match, Phase-1 with empty xwords otherwise.
            newTok  = exactLiteralTokenized(r.alias, r.match);
            newNorm = exactLiteralTokenized(r.alias, r.match);
          } else {
            newTok  = tokenizeForTableSync(r.alias, tbl, xwMap, separatorSet, r.match || '');
            newNorm = normalizeForTableSync(r.alias, tbl, xwMap, separatorSet, r.match || '');
          }
          return { id: r.id, oldTok: r.tokenized, newTok, oldNorm: r.normalized, newNorm };
        })
        .filter(u => u.newTok !== u.oldTok || u.newNorm !== u.oldNorm);

      if (updates.length > 0) {
        const ids      = updates.map(u => u.id);
        const newToks  = updates.map(u => u.newTok);
        const newNorms = updates.map(u => u.newNorm);
        await pool.query(
          `UPDATE ${tbl} t SET tokenized = v.tok, normalized = v.norm, updated_at = NOW()
           FROM unnest($1::bigint[], $2::text[], $3::text[]) AS v(rid, tok, norm)
           WHERE t.id = v.rid`,
          [ids, newToks, newNorms]
        );
      }
      return { tbl, count: updates.length };
    };

    // Tables to retokenize. chemnames has no tokenized/normalized/match columns — excluded.
    const tablesToProcess = [
      'curnames', 'userdict', 'celldictionary', 'casdictionary', 'combnames', 'exactliteral',
    ];
    const results = await Promise.all(
      tablesToProcess.map(tbl => processTable(tbl))
    );

    const tableResults = {};
    let totalUpdated = 0;
    for (const { tbl, count } of results) {
      tableResults[tbl] = count;
      totalUpdated += count;
    }

    // ── Sync chemNames tokens from CASdictionary ─────────────────────────────
    // Collect every word-like token (containing ≥1 [a-z] char) from casdictionary
    // tokenized forms, then insert any that are absent from chemNames.
    // This mirrors what ensureChemNamesTokens does during batch import and handleSave.
    let chemNamesAdded = 0;
    try {
      const casRows = await pool.query(
        `SELECT tokenized FROM casdictionary
         WHERE tokenized IS NOT NULL AND tokenized != ''
           AND (bdeleted IS NULL OR bdeleted = FALSE)`
      );
      const allTokens = [...new Set(
        casRows.rows.flatMap(r =>
          r.tokenized.split(/\s+/).filter(Boolean)
            .map(t => t.toLowerCase())
            .filter(t => /[a-z]/.test(t))
        )
      )];
      if (allTokens.length > 0) {
        // Check in chunks of 500 to avoid large array parameter issues
        const existing = new Set();
        const CHUNK = 500;
        for (let ci = 0; ci < allTokens.length; ci += CHUNK) {
          const batch = allTokens.slice(ci, ci + CHUNK);
          const chkRes = await pool.query(
            `SELECT lower(alias) AS alias FROM chemnames
             WHERE lower(alias) = ANY($1)`,   // deleted rows count as present: only a user may undelete
            [batch]
          );
          if (chkRes.rows) chkRes.rows.forEach(r => existing.add(r.alias));
        }
        const missing  = allTokens.filter(t => !existing.has(t));
        for (const token of missing) {
          const msId = token.length < 6 ? 1000000 : 1000001;
          await pool.query(
            `INSERT INTO chemnames (medscan_id, alias, created_at, updated_at)
             VALUES ($1, $2, NOW(), NOW())
             ON CONFLICT (medscan_id, alias) DO NOTHING`,
            [msId, token]
          );
        }
        chemNamesAdded = missing.length;
      }
    } catch (e) {
      // Non-fatal — chemNames sync failure doesn't abort the retokenize result
      console.warn('[retokenize] chemNames sync error:', e.message);
      chemNamesAdded = -1; // sentinel: error occurred
    }

    // After a mass UPDATE every old row version becomes a dead tuple — VACUUM
    // removes dead tuples and cleans dead index entries so the next conflict-
    // search self-join can use the index without checking liveness on every hit.
    // ANALYZE then refreshes planner statistics.  Both are non-critical so we
    // run them in parallel and ignore errors.
    // NOTE: VACUUM cannot run inside a transaction; pool2 gives a fresh connection.
    const pool2 = await getPool();
    const analyzeTables = tablesToProcess;
    await Promise.allSettled(analyzeTables.map(tbl => pool2.query(`VACUUM ANALYZE "${tbl}"`)));

    // ── Sync rsmap.normalized ──────────────────────────────────────────────────
    let rsmapNormUpdated = 0;
    try {
      const rnRes = await pool.query(`
        UPDATE rsmap SET normalized = lower(protein_name || ' ' || hgvs_code), updated_at = NOW()
        WHERE normalized IS DISTINCT FROM lower(protein_name || ' ' || hgvs_code)
          AND (bdeleted IS NULL OR bdeleted = FALSE)
      `);
      rsmapNormUpdated = rnRes.rowCount ?? 0;
    } catch (e) {
      console.warn('[retokenize] rsmap normalize error:', e.message);
    }

    return { ok: true, totalUpdated, tableResults, chemNamesAdded, rsmapNormUpdated };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Clean ObjectNames ─────────────────────────────────────────────────────────
// 1) Deletes rows whose medscan_id has no aliases in any dictionary table
// 2) Deletes duplicate rows that share the same medscan_id AND urn (keeps lowest id)
ipcMain.handle('db:cleanObjectNames', async () => {
  try {
    const pool = await getPool();
    // 1) Delete rows with sentinel URN prefix 'urn:agi-__nlp_ids__:' — these were written by a
    //    batch-import bug and are always invalid. Safe to delete unconditionally because no valid
    //    entity type produces this prefix. Done first so they don't count as orphans below.
    const sentinelRes = await pool.query(
      `DELETE FROM objectnames
       WHERE urn >= 'urn:agi-__nlp_ids__:'
         AND urn <  'urn:agi-__nlp_ids__;'`
    );
    const sentinelDeleted = sentinelRes.rowCount ?? 0;

    // 2) Delete orphans — ObjectNames rows with no active alias in any dict table.
    //    Uses NOT EXISTS per table (index scan on medscan_id) instead of NOT IN + UNION
    //    which forces a sequential scan and is O(n*m).
    const orphanRes = await pool.query(
      `DELETE FROM objectnames o
       WHERE NOT EXISTS (SELECT 1 FROM curnames       WHERE medscan_id = o.medscan_id AND (bdeleted IS NULL OR bdeleted = FALSE))
         AND NOT EXISTS (SELECT 1 FROM exactliteral   WHERE medscan_id = o.medscan_id AND (bdeleted IS NULL OR bdeleted = FALSE))
         AND NOT EXISTS (SELECT 1 FROM celldictionary WHERE medscan_id = o.medscan_id AND (bdeleted IS NULL OR bdeleted = FALSE))
         AND NOT EXISTS (SELECT 1 FROM casdictionary  WHERE medscan_id = o.medscan_id AND (bdeleted IS NULL OR bdeleted = FALSE))
         AND NOT EXISTS (SELECT 1 FROM chemnames      WHERE medscan_id = o.medscan_id AND (bdeleted IS NULL OR bdeleted = FALSE))
         AND NOT EXISTS (SELECT 1 FROM rsmap           WHERE medscan_id = o.medscan_id AND (bdeleted IS NULL OR bdeleted = FALSE))
         AND NOT EXISTS (SELECT 1 FROM keywords       WHERE medscan_id = o.medscan_id AND (bdeleted IS NULL OR bdeleted = FALSE))
         AND NOT EXISTS (SELECT 1 FROM userdict       WHERE medscan_id = o.medscan_id AND (bdeleted IS NULL OR bdeleted = FALSE))
         AND NOT EXISTS (SELECT 1 FROM combnames     WHERE medscan_id = o.medscan_id AND (bdeleted IS NULL OR bdeleted = FALSE))`
    );
    const orphansDeleted = orphanRes.rowCount ?? 0;

    // 3) Delete exact duplicate rows — same medscan_id AND same urn, keep lowest id.
    //    Uses window function instead of self-join (self-join is O(n²) on large tables).
    const dupRes = await pool.query(
      `DELETE FROM objectnames
       WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY medscan_id, urn ORDER BY id) AS rn
           FROM objectnames
         ) t WHERE rn > 1
       )`
    );
    const dupsDeleted = dupRes.rowCount ?? 0;

    // 4) Resolve virus-range (5M–6M) duplicates.
    //    For each medscan_id with multiple ObjectNames rows, the row with the LOWEST id
    //    is the canonical original record and is always left untouched.
    //    Every higher-id row is an interloper, handled one of two ways:
    //      (A) Name matches a curnames alias at the same medscan_id
    //          → reassign both the ObjectNames row and the curnames row to a fresh gap ID.
    //      (B) No curnames alias match (added by a separate ObjectNames file import)
    //          → delete the phantom ObjectNames row outright.

    const { min: VIRUS_MIN, max: VIRUS_MAX } = (await _ent()).rangeOf('Virus');          // the Virus ID range from the shared table

    // a) Collect all non-canonical ObjectNames rows in the virus range
    const virusDupRes = await pool.query(`
      WITH dup_groups AS (
        SELECT medscan_id, MIN(id) AS canonical_on_id
        FROM objectnames
        WHERE medscan_id BETWEEN ${VIRUS_MIN} AND ${VIRUS_MAX}
        GROUP BY medscan_id
        HAVING COUNT(*) > 1
      )
      SELECT o.id AS on_id, o.medscan_id, o.name AS on_name, o.urn AS on_urn
      FROM dup_groups dg
      JOIN objectnames o ON o.medscan_id = dg.medscan_id AND o.id > dg.canonical_on_id
      ORDER BY o.id
    `);

    let virusFixed = 0;
    let virusPhantomDeleted = 0;

    if (virusDupRes.rows.length > 0) {
      // b) For each interloper, check for a matching curnames alias
      const interlopers = virusDupRes.rows;
      const interloperOnIds = interlopers.map(r => Number(r.on_id));

      // Find which interloper ObjectNames rows have a matching curnames alias.
      // Join via the objectnames table (already indexed on medscan_id) to avoid giant VALUES lists.
      const cnMatchRes = await pool.query(`
        SELECT DISTINCT ON (o.id)
          o.id AS o_id, c.id AS cn_id
        FROM objectnames o
        JOIN curnames c ON c.medscan_id = o.medscan_id
                       AND LOWER(c.alias) = LOWER(o.name)
                       AND (c.bdeleted IS NULL OR c.bdeleted = FALSE)
        WHERE o.id = ANY($1)
        ORDER BY o.id, c.id
      `, [interloperOnIds]);

      const cnMatchMap = new Map(cnMatchRes.rows.map(r => [Number(r.o_id), Number(r.cn_id)]));

      const withCurnames    = interlopers.filter(r => cnMatchMap.has(Number(r.on_id)));
      const withoutCurnames = interlopers.filter(r => !cnMatchMap.has(Number(r.on_id)));

      // c) Delete phantom interlopers (no curnames match)
      if (withoutCurnames.length > 0) {
        const phantomIds = withoutCurnames.map(r => Number(r.on_id));
        await pool.query(
          `DELETE FROM objectnames WHERE id = ANY($1)`,
          [phantomIds]
        );
        virusPhantomDeleted = withoutCurnames.length;
      }

      // d) Reassign interlopers that have a curnames match to fresh gap IDs
      if (withCurnames.length > 0) {
        const usedRes = await pool.query(`
          SELECT DISTINCT medscan_id AS id FROM curnames      WHERE medscan_id BETWEEN ${VIRUS_MIN} AND ${VIRUS_MAX}
          UNION
          SELECT DISTINCT medscan_id FROM exactliteral        WHERE medscan_id BETWEEN ${VIRUS_MIN} AND ${VIRUS_MAX}
          UNION
          SELECT DISTINCT medscan_id FROM celldictionary      WHERE medscan_id BETWEEN ${VIRUS_MIN} AND ${VIRUS_MAX}
          UNION
          SELECT DISTINCT medscan_id FROM casdictionary       WHERE medscan_id BETWEEN ${VIRUS_MIN} AND ${VIRUS_MAX}
          UNION
          SELECT DISTINCT medscan_id FROM keywords            WHERE medscan_id BETWEEN ${VIRUS_MIN} AND ${VIRUS_MAX}
          UNION
          SELECT DISTINCT medscan_id FROM userdict            WHERE medscan_id BETWEEN ${VIRUS_MIN} AND ${VIRUS_MAX}
          UNION
          SELECT DISTINCT medscan_id FROM objectnames         WHERE medscan_id BETWEEN ${VIRUS_MIN} AND ${VIRUS_MAX}
          ORDER BY id
        `);
        const usedSet = new Set(usedRes.rows.map(r => Number(r.id)));
        const needed  = withCurnames.length;
        const gapIds  = [];
        for (let probe = VIRUS_MIN; probe <= VIRUS_MAX && gapIds.length < needed; probe++) {
          if (!usedSet.has(probe)) { gapIds.push(probe); usedSet.add(probe); }
        }
        if (gapIds.length < needed)
          throw new Error(`Virus range exhausted: need ${needed} gap IDs, found ${gapIds.length}`);

        for (let i = 0; i < withCurnames.length; i++) {
          const { on_id } = withCurnames[i];
          const cn_id = cnMatchMap.get(Number(on_id));
          const newId = gapIds[i];
          await pool.query(`UPDATE objectnames SET medscan_id = $1 WHERE id = $2`, [newId, on_id]);
          await pool.query(`UPDATE curnames    SET medscan_id = $1 WHERE id = $2`, [newId, cn_id]);
          virusFixed++;
        }
      }
    }

    // 5) Clean up stranded aliases in the virus range (5M–6M) across ALL alias tables.
    //    Two passes per table:
    //    Pass A – MOVE: alias text matches an ObjectNames.name at a DIFFERENT medscan_id
    //             → update the alias row to that correct medscan_id.
    //    Pass B – DELETE: alias text matches NO ObjectNames.name anywhere AND the
    //             medscan_id's canonical ObjectNames name is different from the alias
    //             → the alias is a leftover batch-import artifact with no valid home.

    // 'keywords' excluded: term control table, not an alias table.
    const VIRUS_ALIAS_TABLES = [
      { tbl: 'curnames',       col: 'alias'    },
      { tbl: 'exactliteral',   col: 'alias'    },
      { tbl: 'celldictionary', col: 'alias'    },
      { tbl: 'casdictionary',  col: 'alias'    },
      { tbl: 'userdict',       col: 'alias'    },
    ];

    let virusAliasesMoved = 0;

    for (const { tbl, col } of VIRUS_ALIAS_TABLES) {
      // Pass A: move aliases to the medscan_id whose ObjectNames has a virtaxid URN
      // (urn:agi-virtaxid:NNNNN are the canonical records; urn:agi-virus:... are bogus).
      // Move any alias whose text matches a virtaxid ObjectNames name at a different ID,
      // unless the alias is already sitting at a virtaxid ID with the same name.
      const moveRes = await pool.query(`
        WITH correct AS (
          SELECT DISTINCT ON (a.id)
            a.id AS alias_id, o.medscan_id AS correct_msid
          FROM ${tbl} a
          JOIN objectnames o
            ON LOWER(o.name) = LOWER(a.${col})
           AND o.medscan_id != a.medscan_id
           AND o.urn LIKE 'urn:agi-virtaxid:%'
          WHERE a.medscan_id BETWEEN ${VIRUS_MIN} AND ${VIRUS_MAX}
            AND (a.bdeleted IS NULL OR a.bdeleted = FALSE)
            AND NOT EXISTS (
              -- already at a virtaxid record with this name — nothing to do
              SELECT 1 FROM objectnames o2
              WHERE o2.medscan_id = a.medscan_id
                AND LOWER(o2.name) = LOWER(a.${col})
                AND o2.urn LIKE 'urn:agi-virtaxid:%'
            )
          ORDER BY a.id, o.id
        )
        UPDATE ${tbl} a
        SET medscan_id = c.correct_msid
        FROM correct c
        WHERE a.id = c.alias_id
        RETURNING a.id
      `);
      virusAliasesMoved += moveRes.rowCount ?? 0;

    }

    // 6) Find remaining conflicts — same medscan_id but different URNs or Names
    const conflictRes = await pool.query(`
      SELECT
        medscan_id,
        array_agg(id       ORDER BY id) AS ids,
        array_agg(name     ORDER BY id) AS names,
        array_agg(COALESCE(urn, '') ORDER BY id) AS urns
      FROM objectnames
      GROUP BY medscan_id
      HAVING COUNT(DISTINCT COALESCE(urn, '')) > 1
          OR COUNT(DISTINCT name) > 1
      ORDER BY medscan_id
      LIMIT 2000
    `);
    const conflicts = conflictRes.rows.map(r => ({
      medscanId: Number(r.medscan_id),
      ids:   r.ids.map(Number),
      names: r.names,
      urns:  r.urns,
    }));

    // 7) Sync objectnames.organisms + objectnames.cartridges — set both to the
    //    union of values found in active alias rows across all dictionary tables.
    //    Fixes stale values caused by Edit Record only updating alias table rows.
    const onSyncRes = await pool.query(`
      UPDATE objectnames o
      SET
        organisms  = COALESCE(sub.orgs,  '{}'),
        cartridges = COALESCE(sub.carts, '{}')
      FROM (
        SELECT medscan_id,
               array_agg(DISTINCT org  ORDER BY org)  FILTER (WHERE org  IS NOT NULL AND org  <> '') AS orgs,
               array_agg(DISTINCT cart ORDER BY cart) FILTER (WHERE cart IS NOT NULL AND cart <> '') AS carts
        FROM (
          SELECT medscan_id, unnest(organisms) AS org, unnest(cartridges) AS cart FROM curnames       WHERE (bdeleted IS NULL OR bdeleted = FALSE)
          UNION ALL
          SELECT medscan_id, unnest(organisms),        unnest(cartridges)        FROM exactliteral   WHERE (bdeleted IS NULL OR bdeleted = FALSE)
          UNION ALL
          SELECT medscan_id, unnest(organisms),        unnest(cartridges)        FROM celldictionary WHERE (bdeleted IS NULL OR bdeleted = FALSE)
          UNION ALL
          SELECT medscan_id, unnest(organisms),        unnest(cartridges)        FROM casdictionary  WHERE (bdeleted IS NULL OR bdeleted = FALSE)
          UNION ALL
          SELECT medscan_id, unnest(organisms),        unnest(cartridges)        FROM keywords       WHERE (bdeleted IS NULL OR bdeleted = FALSE)
          UNION ALL
          SELECT medscan_id, unnest(organisms),        unnest(cartridges)        FROM userdict       WHERE (bdeleted IS NULL OR bdeleted = FALSE)
          UNION ALL
          SELECT medscan_id, unnest(organisms),        unnest(cartridges)        FROM combnames      WHERE (bdeleted IS NULL OR bdeleted = FALSE)
        ) _t
        GROUP BY medscan_id
      ) sub
      WHERE sub.medscan_id = o.medscan_id
        AND (sub.orgs  IS DISTINCT FROM o.organisms
          OR sub.carts IS DISTINCT FROM o.cartridges)
    `);
    const orgsSynced = onSyncRes.rowCount ?? 0;

    return { ok: true, orphansDeleted, dupsDeleted, sentinelDeleted, virusFixed, virusPhantomDeleted, virusAliasesMoved, orgsSynced, conflicts };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Deduplicate alias tables ──────────────────────────────────────────────────
// Removes duplicate aliases within each dictionary table.
// Duplicates are defined as rows sharing the same medscan_id and normalized form
// (Phase-2: stemmed + spelling-normalised).
// Differences in match flag, cartridges, or organisms are ignored — the row with a
// match flag is preferred; within that, the lowest id (oldest) is kept.
ipcMain.handle('db:deduplicateAliases', async () => {
  try {
    const pool = await getPool();
    const results = [];
    // Tables and the column that defines the "canonical" form.
    // 'normalized' = Phase-2 (stemmed) form — 'TMX 67' and 'tmx67' both normalise
    // to 'tmx 67' and are redundant in the same record.
    const TABLES = [
      { table: 'curnames',       dedupCol: 'normalized' },
      { table: 'exactliteral',   dedupCol: 'normalized' },
      { table: 'celldictionary', dedupCol: 'normalized' },
      { table: 'casdictionary',  dedupCol: 'normalized' },
      // chemnames handled separately below (no match column)
      // { table: 'chemnames', ... }
      { table: 'userdict',       dedupCol: 'normalized' },
    ];
    for (const { table, dedupCol } of TABLES) {
      const res = await pool.query(`
        WITH cte AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY medscan_id, COALESCE(${dedupCol}, alias)
                   ORDER BY
                     -- Keep the alias that has a match flag (e, l, …) over one without
                     CASE WHEN match IS NOT NULL AND match <> '' THEN 0 ELSE 1 END,
                     id
                 ) AS rn
          FROM ${table}
          WHERE (bdeleted IS NULL OR bdeleted = FALSE)   -- bDeleted rows are never compared and never removed
        )
        DELETE FROM ${table}
        USING cte
        WHERE ${table}.id = cte.id AND cte.rn > 1
      `);
      const deleted = res.rowCount ?? 0;
      results.push({ table, deleted });
    }
    // chemnames: dedup by (medscan_id, alias) — no match column.
    try {
      const chemDedupRes = await pool.query(`
        WITH cte AS (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY medscan_id, alias ORDER BY id) AS rn
          FROM chemnames
          WHERE (bdeleted IS NULL OR bdeleted = FALSE)
        )
        DELETE FROM chemnames USING cte WHERE chemnames.id = cte.id AND cte.rn > 1
      `);
      results.push({ table: 'chemnames', deleted: chemDedupRes.rowCount ?? 0 });
    } catch (e) { console.warn('[dedup] chemnames:', e.message); }
    // rsmap: dedup by (medscan_id, protein_name, hgvs_code) — no alias/match columns.
    try {
      const rsmapDedupRes = await pool.query(`
        WITH cte AS (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY medscan_id, protein_name, hgvs_code ORDER BY id) AS rn
          FROM rsmap
          WHERE (bdeleted IS NULL OR bdeleted = FALSE)
        )
        DELETE FROM rsmap USING cte WHERE rsmap.id = cte.id AND cte.rn > 1
      `);
      results.push({ table: 'rsmap', deleted: rsmapDedupRes.rowCount ?? 0 });
    } catch (e) { console.warn('[dedup] rsmap:', e.message); }

    const total = results.reduce((s, r) => s + r.deleted, 0);

    // After a mass DELETE every removed row becomes a dead tuple — VACUUM removes
    // dead tuples and cleans index bloat so the next conflict self-join is fast.
    // ANALYZE then refreshes planner statistics.  Non-critical; run in parallel.
    await Promise.allSettled(
      TABLES.map(({ table }) => pool.query(`VACUUM ANALYZE "${table}"`))
    );

    return { ok: true, total, results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Dictionary refresh ────────────────────────────────────────────────────────

// Map from base filename to { table, type }
const DICT_FILE_MAP = {
  'curNames.tab.e':       { table: 'curnames',          type: 'entity' },
  'ExactLiteral.tab.e':   { table: 'exactliteral',      type: 'entity' },
  'cellDictionary.tab.e': { table: 'celldictionary',    type: 'entity' },
  'CASDictionary.tab.e':  { table: 'casdictionary',     type: 'entity' },
  'chemNames.tab.e':      { table: 'chemnames',         type: 'entity' },
  'keywords.tab.e':       { table: 'keywords',          type: 'entity' },
  'User.tab':             { table: 'userdict',          type: 'entity' },
  'combNames.tab.e':      { table: 'combnames',         type: 'entity' },
  'xwords.tab':           { table: 'xwords',       type: 'xwords' },
  'xwords_cells.tab':     { table: 'xwords_cells', type: 'xwords' },
  'xwords_CAS.tab':       { table: 'xwords_cas',   type: 'xwords' },
  'xwords_comb.tab':      { table: 'xwords_comb',  type: 'xwords' },
  'bracketstop.tab':      { table: 'bracketstop',   type: 'bracketstop' },
  'spelling.tab':         { table: 'spelling',      type: 'xwords' },
  'ObjectNames.tab':      { table: 'objectnames',       type: 'objectnames' },
  'rsmap.tab':             { table: 'rsmap',             type: 'rsmap'       },
};

function parseTabFilename(name) {
  if (DICT_FILE_MAP[name]) return { organism: null, base: name };
  const dotIdx = name.indexOf('.');
  if (dotIdx > 0) {
    const rest = name.substring(dotIdx + 1);
    if (DICT_FILE_MAP[rest]) return { organism: name.substring(0, dotIdx), base: rest };
  }
  return null;
}

function readTabLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .replace(/^﻿/, '')          // strip BOM
    .split('\n')
    .map(l => l.replace(/\r$/, '')) // strip CR
    .filter(l => l.length > 0);
}

async function readTabLinesAsync(filePath) {
  const text = await fs.promises.readFile(filePath, 'utf8');
  return text
    .replace(/^﻿/, '')
    .split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(l => l.length > 0);
}

// Encode a JS string[] as a PostgreSQL array literal, e.g. {"foo","bar with \"quotes\""}.
// Used so we can pass text[] column values as plain text parameters to UNNEST.
function toPgArrayLiteral(arr) {
  if (!arr || arr.length === 0) return '{}';
  return '{' + arr.map(s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',') + '}';
}

// Single-query bulk insert using UNNEST — far faster than batched VALUES for large tables.
// colTypes: array of PG type strings matching columns (e.g. ['int8','text','text[]']).
// Columns typed 'text[]' are serialised as PG array literals so they can be passed as
// plain text[] params (UNNEST of text[][] would unnest to text, not text[]).
// Processes rows in chunks of chunkSize to avoid transposing millions of rows at once.
async function unnestInsert(pool, table, columns, colTypes, rows, chunkSize = 50000, onConflict = '') {
  if (rows.length === 0) return 0;

  // Pre-compute the query template (same for every chunk)
  const unnestExpr = columns.map((_, i) => {
    const pgType = colTypes[i] === 'text[]' ? 'text' : colTypes[i];
    return `$${i + 1}::${pgType}[]`;
  }).join(', ');
  const selectList = columns.map((col, i) =>
    colTypes[i] === 'text[]' ? `${col}::text[]` : col
  ).join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(', ')})
               SELECT ${selectList} FROM UNNEST(${unnestExpr}) AS t(${columns.join(', ')})
               ${onConflict}`;

  let total = 0;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);

    // Transpose chunk into per-column arrays; serialise text[] values as PG literals
    const colArrays = columns.map((_, ci) => {
      if (colTypes[ci] === 'text[]') {
        return chunk.map(r => toPgArrayLiteral(r[ci]));
      }
      return chunk.map(r => r[ci]);
    });

    await pool.query(sql, colArrays);
    total += chunk.length;
  }
  return total;
}

async function batchInsert(pool, table, columns, rows, chunkSize = 500) {
  let total = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params = [];
    const placeholders = chunk.map(row =>
      '(' + columns.map((_, ci) => { params.push(row[ci]); return `$${params.length}`; }).join(',') + ')'
    ).join(',');
    await pool.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${placeholders}`, params);
    total += chunk.length;
  }
  return total;
}

// Scan all entity msdata files and return the max medscan_id in [min, max] range.
// Used as fallback when the DB hasn't been populated yet.
ipcMain.handle('dict:getMaxIdInRange', async (_, min, max) => {
  try {
    const medscanDir = getStore().get('medscanDir');
    if (!medscanDir) return { ok: false, error: 'Elsevier NLP directory not configured.' };
    const carts = fs.readdirSync(medscanDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.toLowerCase().endsWith('.bin')).map(e => e.name);
    let globalMax = null;
    for (const cartName of carts) {
      const msdataDir = path.join(medscanDir, cartName, 'msdata');
      let files; try { files = fs.readdirSync(msdataDir); } catch { continue; }
      for (const filename of files) {
        const parsed = parseTabFilename(filename);
        if (!parsed) continue;
        const mapping = DICT_FILE_MAP[parsed.base];
        if (!mapping || mapping.type !== 'entity') continue;
        const lines = readTabLines(path.join(msdataDir, filename));
        for (const line of lines) {
          const id = parseInt(line.split('\t')[0]);
          if (!isNaN(id) && id >= min && id <= max) {
            if (globalMax === null || id > globalMax) globalMax = id;
          }
        }
      }
    }
    return { ok: true, maxId: globalMax };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('dict:getLatestDate', async () => {
  try {
    const medscanDir = getStore().get('medscanDir');
    if (!medscanDir) return { ok: false, error: 'Elsevier NLP directory not configured in Settings.' };
    let latestMs = 0;
    const carts = fs.readdirSync(medscanDir, { withFileTypes: true }).filter(e => e.isDirectory() && e.name.toLowerCase().endsWith('.bin'));
    for (const cart of carts) {
      for (const sub of ['msdata', 'xfdata']) {
        const dir = path.join(medscanDir, cart.name, sub);
        let files; try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith('.tab') && !f.endsWith('.tab.e')) continue;
          try {
            const stat = fs.statSync(path.join(dir, f));
            if (stat.mtimeMs > latestMs) latestMs = stat.mtimeMs;
          } catch {}
        }
      }
    }
    return { ok: true, date: latestMs ? new Date(latestMs).toISOString() : null };
  } catch (e) { return { ok: false, error: e.message }; }
});

async function refreshDictsFromDir(medscanDir, send) {
  try {
    const { makeNormalizer, makeCombTokenizer, makeTokenizer, TABLE_XWORDS, ALL_XWORDS_TABLES, NO_STEM_TABLES, exactLiteralTokenized, buildSeparatorSet, setSpellingMap } = await _tok();
    const pool = await getPool();

    // 1. Clear all dictionary tables in parallel.
    // Derived from TABLES_FOR_BACKUP (single source of truth), minus config-only tables
    // that are not populated from cartridge files and must not be wiped on refresh.
    // xwords / spelling / bracketstop are NOT pre-truncated here — they are truncated
    // only if we actually find replacement data on disk (see inserts below), so a
    // missing .tab file never silently wipes existing DB content.
    const REFRESH_SKIP = new Set([
      'entity_types', 'proteinclasses', 'ontology',
      'xwords', 'xwords_cells', 'xwords_cas', 'xwords_comb',
      'spelling', 'bracketstop',
    ]);
    const tablesToClear = TABLES_FOR_BACKUP.filter(t => !REFRESH_SKIP.has(t));

    // Entity tables get UNLOGGED before bulk-load so inserts skip WAL entirely,
    // then restored to LOGGED afterward (which checkpoints the data to disk).
    const ENTITY_TBLS = ['curnames','exactliteral','celldictionary','casdictionary',
                         'chemnames','keywords','userdict','combnames','objectnames','rsmap'];
    send('Switching entity tables to UNLOGGED for fast bulk insert…');
    await Promise.all(ENTITY_TBLS.map(t => pool.query(`ALTER TABLE "${t}" SET UNLOGGED`).catch(() => {})));

    // Drop all non-unique indexes on entity tables before the bulk load.
    // PostgreSQL must maintain every index on every insert; dropping them first
    // then recreating in one pass after the data is in is far faster.
    // Unique indexes (_unique_key, _pkey) are kept — ON CONFLICT needs them.
    send('Dropping non-unique indexes on entity tables…');
    const savedIndexDefs = [];
    for (const tbl of ENTITY_TBLS) {
      const res = await pool.query(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = $1
          AND indexname NOT LIKE '%_unique_key'
          AND indexname NOT LIKE '%_pkey'
        ORDER BY indexname
      `, [tbl]);
      for (const { indexname, indexdef } of res.rows) {
        savedIndexDefs.push(indexdef);
        await pool.query(`DROP INDEX IF EXISTS "${indexname}"`);
      }
    }
    send(`  Dropped ${savedIndexDefs.length} indexes.`);

    const importStartTime = Date.now();
    send('Clearing dictionary tables…');
    await Promise.all(tablesToClear.map(t => pool.query(`TRUNCATE "${t}"`)));
    send('Tables cleared. Scanning cartridges…');

    const allDirs = fs.readdirSync(medscanDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
    // Cartridge names come from directories ending in .bin
    const carts = allDirs.filter(n => n.toLowerCase().endsWith('.bin'));
    const allCartNames = carts.map(c => cartName(c));

    // 2. Import xwords / bracketstop / spelling tables.
    //    The shared "bin" directory (no .bin suffix) contains the master copies of all
    //    xwords / bracketstop / spelling files.  Each cartridge's msdata/ may also carry
    //    copies; we scan all of them and deduplicate by value.
    //    Every word belongs to ALL cartridges by definition.
    send(`Importing xwords tables… (cartridges: ${allCartNames.join(', ')})`);

    const now = new Date(); // shared timestamp for all inserts in this restore run

    // xwordsAccum: { table → Map<word, flags|null> }   (dedup; keep first flags seen)
    const xwordsAccum = {};
    // bracketstopAccum: { table → Map<"word\tflag\tcomment", {word,flag,comment}> }
    const bracketstopAccum = {};
    // chemNamesAccum: Set<alias> — global token table, shared like xwords
    const chemNamesAccum = new Map(); // medscan_id+alias → [medscan_id, alias]

    // Scan: the shared "bin" directory + every cartridge's own directory
    const xwordScanDirs = allDirs.filter(n => n === 'bin' || n.toLowerCase().endsWith('.bin'));

    await Promise.all(xwordScanDirs.map(async (cartDir) => {
      const msdataDir = path.join(medscanDir, cartDir, 'msdata');
      let files; try { files = await fs.promises.readdir(msdataDir); } catch { return; }
      await Promise.all(files.map(async (filename) => {
        const parsed = parseTabFilename(filename);
        if (!parsed || !DICT_FILE_MAP[parsed.base]) return;
        const { table, type } = DICT_FILE_MAP[parsed.base];
        const lines = await readTabLinesAsync(path.join(msdataDir, filename));

        if (type === 'entity' && table === 'chemnames') {
          for (const line of lines) {
            const cols = line.split('\t');
            const medscan_id = parseInt(cols[0]);
            if (isNaN(medscan_id)) continue;
            const alias = (cols[1] || '').toLowerCase();
            if (!alias) continue;
            const key = `${medscan_id}\t${alias}`;
            if (!chemNamesAccum.has(key)) chemNamesAccum.set(key, [medscan_id, alias, now, now]);
          }
        } else if (type === 'xwords') {
          if (!xwordsAccum[table]) xwordsAccum[table] = new Map();
          for (const line of lines) {
            const [word, flags] = line.split('\t');
            if (!word) continue;
            if (!xwordsAccum[table].has(word)) xwordsAccum[table].set(word, flags || null);
          }
        } else if (type === 'bracketstop') {
          if (!bracketstopAccum[table]) bracketstopAccum[table] = new Map();
          let currentComment = '';
          for (const line of lines) {
            if (!line.trim()) continue;
            if (line.startsWith('#')) { currentComment = line.slice(1).trim(); continue; }
            const [word, flag] = line.split('\t');
            if (!word) continue;
            const key = `${word}\t${flag || ''}\t${currentComment}`;
            if (!bracketstopAccum[table].has(key))
              bracketstopAccum[table].set(key, { word, flag: flag || null, comment: currentComment });
          }
        }
      }));
    }));

    // Insert xwords tables.
    // spelling and bracketstop have no cartridges column (global tables — always exported to all cartridges).
    // xwords* still carry cartridges for per-cartridge filtering.
    // We truncate here (not upfront) so tables are only cleared when replacement data exists.
    for (const [table, wordMap] of Object.entries(xwordsAccum)) {
      if (!wordMap || wordMap.size === 0) continue;
      await pool.query(`TRUNCATE "${table}"`);
      let rows, cols, types;
      if (table === 'spelling') {
        // No cartridges column — spelling is always global.
        rows  = [...wordMap.entries()].map(([word, flags]) => [word, flags]);
        cols  = ['canonical', 'spellings'];
        types = ['text', 'text'];
      } else if (table === 'xwords_comb' || table === 'xwords_cells') {
        rows  = [...wordMap.entries()].map(([word, flags]) => [word, flags, allCartNames]);
        cols  = ['xword', 'flags', 'cartridges'];
        types = ['text', 'text', 'text[]'];
      } else {
        rows  = [...wordMap.entries()].map(([word]) => [word, allCartNames]);
        cols  = ['xword', 'cartridges'];
        types = ['text', 'text[]'];
      }
      await unnestInsert(pool, table, cols, types, rows);
      send(`  ${table}: ${rows.length} words imported`);
    }

    // Insert bracketstop table — no cartridges column (global, exported to all cartridges).
    // Truncate only if replacement data was found, to avoid silently wiping existing rows.
    for (const [table, entryMap] of Object.entries(bracketstopAccum)) {
      if (!entryMap || entryMap.size === 0) continue;
      await pool.query(`TRUNCATE "${table}"`);
      const rows = [...entryMap.values()].map(({ word, flag, comment }) => [word, flag, comment]);
      await unnestInsert(pool, table, ['word', 'flag', 'comment'], ['text', 'text', 'text'], rows);
      send(`  ${table}: ${rows.length} entries imported`);
    }

    // Insert chemnames — global token table, read once from bin/msdata/ like xwords.
    if (chemNamesAccum.size > 0) {
      const chemRows = [...chemNamesAccum.values()];
      chemNamesAccum.clear();
      const ENTITY_COLS_CHEM_LOCAL  = ['medscan_id', 'alias', 'created_at', 'updated_at'];
      const ENTITY_TYPES_CHEM_LOCAL = ['int8', 'text', 'timestamptz', 'timestamptz'];
      const n = await unnestInsert(pool, 'chemnames', ENTITY_COLS_CHEM_LOCAL, ENTITY_TYPES_CHEM_LOCAL, chemRows, 50000, 'ON CONFLICT DO NOTHING');
      send(`  chemnames: ${n.toLocaleString()} rows imported`);
    }

    // 3. Build per-table tokenizers using the shared tokenizer module.
    //    Load all distinct xwords tables in parallel, then build one tokenizer per table.
    const loadXw = async (tbl) => {
      try {
        const r = await pool.query(`SELECT xword FROM ${tbl} ORDER BY xword LIMIT 5000`);
        return new Set(r.rows.map(x => x.xword.toLowerCase()));
      } catch { return new Set(); }
    };
    // Load ALL xwords tables + spelling map in parallel.
    const [xwPairs] = await Promise.all([
      Promise.all(ALL_XWORDS_TABLES.map(async t => [t, await loadXw(t)])),
      (async () => {
        try {
          const sr = await pool.query('SELECT canonical, spellings FROM spelling LIMIT 20000');
          if (sr.rows.length > 0) {
            const map = new Map();
            for (const row of sr.rows) {
              const canonical = (row.canonical || '').trim().toLowerCase();
              const variants  = (row.spellings  || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
              for (const v of variants) { if (v && v !== canonical) map.set(v, canonical); }
            }
            setSpellingMap(map);
          }
        } catch { /* spelling table absent — skip */ }
      })(),
    ]);
    const xwSets = Object.fromEntries(xwPairs);
    // Global separator set = union of single-char entries across all xwords tables.
    const separatorSet = buildSeparatorSet(xwSets);
    // Phase-1 tokenizers (no stemming) → 'tokenized' column.
    const tokenizers = Object.fromEntries(
      Object.entries(TABLE_XWORDS).map(([dictTbl, xwTbl]) => [
        dictTbl, makeTokenizer(xwSets[xwTbl] || new Set(), { separatorSet }),
      ])
    );
    // Phase-2 normalizers (full pipeline with stemming) → 'normalized' column.
    const normalizers = Object.fromEntries(
      Object.entries(TABLE_XWORDS).map(([dictTbl, xwTbl]) => {
        const factory  = dictTbl === 'combnames' ? makeCombTokenizer : makeNormalizer;
        const stemming = !NO_STEM_TABLES.has(dictTbl);
        return [dictTbl, factory(xwSets[xwTbl] || new Set(), { stemming, separatorSet })];
      })
    );
    // Fallback tokenizers for tables not in TABLE_XWORDS (empty xwords).
    const tokPlain  = makeTokenizer(new Set(), { separatorSet });   // Phase-1 fallback
    const normPlain = makeNormalizer(new Set(), { separatorSet });  // Phase-2 fallback
    // Cached Phase-1 tokenizer for exactliteral non-literal rows (empty xwords).
    const exactLitPhase1Tok = makeTokenizer(new Set(), { separatorSet });
    // exactliteral bypasses xwords — handled inline (alias stored verbatim)

    // scanCartridge is no longer used — replaced by readTableAllCarts (table-at-a-time).
    async function scanCartridge(cartDirName) {
      const localAccum = {};   // { tbl → Map<key, row> }
      const localObj   = new Map();
      const cartId     = cartName(cartDirName); // logical name without .bin

      // msdata entity files
      const msdataDir = path.join(medscanDir, cartDirName, 'msdata');
      let files; try { files = await fs.promises.readdir(msdataDir); } catch { return { localAccum, localObj }; }

      const combTokSigns = makeCombTokenizer(xwSets['xwords_comb'] || new Set(), { preserveSigns: true });
      await Promise.all(files.map(async (filename) => {
        const parsed = parseTabFilename(filename);
        if (!parsed) return;
        const mapping = DICT_FILE_MAP[parsed.base];
        if (!mapping || mapping.type !== 'entity') return;
        // chemnames is a global file (binDir) — import it once separately, not per-cartridge.
        if (mapping.table === 'chemnames') return;
        const { organism } = parsed;
        const tbl = mapping.table;
        const tok1Fn  = tokenizers[tbl]  || tokPlain;   // Phase-1 → 'tokenized' column
        const norm2Fn = normalizers[tbl] || normPlain;  // Phase-2 → 'normalized' column
        const filePath = path.join(msdataDir, filename);
        const fileMtime = await fs.promises.stat(filePath).then(s => s.mtime).catch(() => new Date());
        const lines = await readTabLinesAsync(filePath);

        if (!localAccum[tbl]) localAccum[tbl] = new Map();
        const accum = localAccum[tbl];

        for (const line of lines) {
          const cols = line.split('\t');
          const medscan_id = parseInt(cols[0]);
          if (isNaN(medscan_id)) continue;
          const alias = cols[1] || '';
          if (!alias) continue;
          const match = cols[2] || null;
          // Phase-1 → 'tokenized' column: split + xwords filter, no stemming.
          // exactliteral literal rows: keep verbatim; non-literal: Phase-1 with empty xwords.
          const tokenized = (tbl === 'exactliteral')
            ? ((match || '').includes('l') ? alias : exactLitPhase1Tok(alias))
            : tok1Fn(alias);
          // Phase-2 → 'normalized' column: full pipeline with stemming.
          const normalized = (tbl === 'exactliteral')
            ? exactLiteralTokenized(alias, match)
            : (tbl === 'combnames' && match === 'c')
            ? combTokSigns(alias)
            : norm2Fn(alias);
          const key = `${medscan_id}\t${alias}`;
          const existing = accum.get(key);
          if (existing) {
            existing.carts.add(cartId);
            if (organism) existing.orgs.add(organism);
            if (fileMtime < existing.fileMtime) existing.fileMtime = fileMtime;
          } else {
            accum.set(key, { medscan_id, alias, match: match || null, tokenized, normalized,
              carts: new Set([cartId]), orgs: organism ? new Set([organism]) : new Set(),
              fileMtime });
          }
        }
      }));

      // xfdata ObjectNames
      const xfdataDir = path.join(medscanDir, cartDirName, 'xfdata');
      let xfFiles; try { xfFiles = await fs.promises.readdir(xfdataDir); } catch { return { localAccum, localObj }; }

      await Promise.all(xfFiles.map(async (filename) => {
        const parsed = parseTabFilename(filename);
        if (!parsed || parsed.base !== 'ObjectNames.tab') return;
        const { organism } = parsed;
        const filePath = path.join(xfdataDir, filename);
        const fileMtime = await fs.promises.stat(filePath).then(s => s.mtime).catch(() => new Date());
        const lines = await readTabLinesAsync(filePath);
        for (const line of lines) {
          const cols = line.split('\t');
          const medscan_id = parseInt(cols[0]);
          if (isNaN(medscan_id)) continue;
          const name = cols[1] || '';
          const urn  = cols[2] || null;
          const key  = urn || `${medscan_id}\t${name}`;
          const existing = localObj.get(key);
          if (existing) {
            existing.carts.add(cartId);
            if (organism) existing.orgs.add(organism);
            if (fileMtime < existing.fileMtime) existing.fileMtime = fileMtime;
          } else {
            localObj.set(key, { medscan_id, name, urn,
              carts: new Set([cartId]), orgs: organism ? new Set([organism]) : new Set(),
              fileMtime });
          }
        }
      }));

      return { localAccum, localObj };
    }

    // 4. Import one dictionary table at a time.
    // For each table: read its files from ALL cartridges and organisms in parallel,
    // accumulate into one Map (merging carts/orgs sets for duplicate aliases),
    // bulk-INSERT into the already-cleared DB, then free memory before moving on.
    // Peak memory = one table's unique aliases (~same as a single cartridge, since
    // cartridges are highly redundant).

    const ENTITY_COLS    = ['medscan_id', 'alias',    'match', 'tokenized', 'normalized', 'cartridges', 'organisms', 'created_at', 'updated_at'];
    const ENTITY_TYPES   = ['int8', 'text', 'text', 'text', 'text', 'text[]', 'text[]', 'timestamptz', 'timestamptz'];
    const ENTITY_COLS_KW  = ['medscan_id', 'keywords', 'match', 'cartridges', 'organisms', 'created_at', 'updated_at'];
    const ENTITY_TYPES_KW = ['int8', 'text', 'text', 'text[]', 'text[]', 'timestamptz', 'timestamptz'];
    const OBJ_COLS  = ['medscan_id', 'name', 'urn', 'cartridges', 'organisms', 'created_at', 'updated_at'];
    const OBJ_TYPES = ['int8', 'text', 'text', 'text[]', 'text[]', 'timestamptz', 'timestamptz'];

    const stats = {};

    // Helper: read one table's file (base filename, e.g. 'curNames.tab.e') from all
    // cartridge msdata dirs in parallel and accumulate into a Map.
    // Returns Map<key, { medscan_id, alias, match, tokenized, normalized, carts, orgs, fileMtime }>
    const readTableAllCarts = async (baseFile, tbl) => {
      const accum = new Map();
      const isKw = tbl === 'keywords';
      const tok1Fn  = tokenizers[tbl]  || tokPlain;
      const norm2Fn = normalizers[tbl] || normPlain;
      const combTokSigns = makeCombTokenizer(xwSets['xwords_comb'] || new Set(), { preserveSigns: true });
      const exactLitPhase1TokLocal = makeTokenizer(new Set(), { separatorSet });

      await Promise.all(carts.map(async (cartDirName) => {
        const cartId  = cartName(cartDirName);
        const msdataDir = path.join(medscanDir, cartDirName, 'msdata');
        let files; try { files = await fs.promises.readdir(msdataDir); } catch { return; }

        await Promise.all(files.map(async (filename) => {
          const parsed = parseTabFilename(filename);
          if (!parsed || parsed.base !== baseFile) return;
          const { organism } = parsed;
          const filePath = path.join(msdataDir, filename);
          const fileMtime = await fs.promises.stat(filePath).then(s => s.mtime).catch(() => new Date());
          const lines = await readTabLinesAsync(filePath);

          for (const line of lines) {
            const cols = line.split('\t');
            const medscan_id = parseInt(cols[0]);
            if (isNaN(medscan_id)) continue;
            const alias = cols[isKw ? 1 : 1] || '';
            if (!alias) continue;
            const match = cols[2] || null;
            const tokenized = (tbl === 'exactliteral')
              ? ((match || '').includes('l') ? alias : exactLitPhase1TokLocal(alias))
              : tok1Fn(alias);
            const normalized = (tbl === 'exactliteral')
              ? exactLiteralTokenized(alias, match)
              : (tbl === 'combnames' && match === 'c')
              ? combTokSigns(alias)
              : norm2Fn(alias);
            const key = `${medscan_id}\t${alias}\t${match || ''}`;
            const existing = accum.get(key);
            if (existing) {
              existing.carts.add(cartId);
              if (organism) existing.orgs.add(organism);
              if (fileMtime < existing.fileMtime) existing.fileMtime = fileMtime;
            } else {
              accum.set(key, { medscan_id, alias, match: match || null, tokenized, normalized,
                carts: new Set([cartId]), orgs: organism ? new Set([organism]) : new Set(), fileMtime });
            }
          }
        }));
      }));
      return accum;
    };

    // Helper: read ObjectNames from all cartridges xfdata dirs in parallel.
    const readObjectNamesAllCarts = async () => {
      const accum = new Map();
      await Promise.all(carts.map(async (cartDirName) => {
        const cartId = cartName(cartDirName);
        const xfdataDir = path.join(medscanDir, cartDirName, 'xfdata');
        let files; try { files = await fs.promises.readdir(xfdataDir); } catch { return; }
        await Promise.all(files.map(async (filename) => {
          const parsed = parseTabFilename(filename);
          if (!parsed || parsed.base !== 'ObjectNames.tab') return;
          const { organism } = parsed;
          const filePath = path.join(xfdataDir, filename);
          const fileMtime = await fs.promises.stat(filePath).then(s => s.mtime).catch(() => new Date());
          const lines = await readTabLinesAsync(filePath);
          for (const line of lines) {
            const cols = line.split('\t');
            const medscan_id = parseInt(cols[0]);
            if (isNaN(medscan_id)) continue;
            const name = cols[1] || '';
            const urn  = cols[2] || null;
            if (!name) continue;
            const key = urn || `${medscan_id}\t${name}`;
            const existing = accum.get(key);
            if (existing) {
              existing.carts.add(cartId);
              if (organism) existing.orgs.add(organism);
              if (fileMtime < existing.fileMtime) existing.fileMtime = fileMtime;
            } else {
              accum.set(key, { medscan_id, name, urn, carts: new Set([cartId]),
                orgs: organism ? new Set([organism]) : new Set(), fileMtime });
            }
          }
        }));
      }));
      return accum;
    };

    // Process entity tables one at a time: read all cartridges for one table in parallel
    // (fast I/O), accumulate into a Map, bulk-insert, free memory, then move to next table.
    // Peak memory = one table's data at a time. (Fully parallel OOMs on large installs.)
    const entityTables = DEPLOY_FILE_MAP.filter(m => !m.binDir && m.cols !== 'rsmap' && m.cols !== 'name_urn');

    for (const m of entityTables) {
      send(`Importing ${m.table} from all cartridges…`);
      const accum = await readTableAllCarts(m.file, m.table);
      if (!accum.size) { send(`    ${m.table}: 0 rows`); continue; }

      const isKw = m.table === 'keywords';
      const cols  = isKw ? ENTITY_COLS_KW : ENTITY_COLS;
      const types = isKw ? ENTITY_TYPES_KW : ENTITY_TYPES;
      const rows  = [...accum.values()].map(r => {
        const ts = r.fileMtime || now;
        return isKw
          ? [r.medscan_id, r.alias, r.match, [...r.carts], [...r.orgs], ts, ts]
          : [r.medscan_id, r.alias, r.match, r.tokenized, r.normalized ?? null, [...r.carts], [...r.orgs], ts, ts];
      });
      accum.clear();
      const n = await unnestInsert(pool, m.table, cols, types, rows, 50000, 'ON CONFLICT DO NOTHING');
      stats[m.table] = n;
      send(`    ${m.table}: ${n.toLocaleString()} rows inserted`);
    }

    // ObjectNames: read all cartridges → bulk insert → free.
    {
      send('Importing objectnames from all cartridges…');
      const accum = await readObjectNamesAllCarts();
      if (accum.size > 0) {
        const rows = [...accum.values()].map(r => {
          const ts = r.fileMtime || now;
          return [r.medscan_id, r.name, r.urn, [...r.carts], [...r.orgs], ts, ts];
        });
        accum.clear();
        const n = await unnestInsert(pool, 'objectnames', OBJ_COLS, OBJ_TYPES, rows, 50000, 'ON CONFLICT DO NOTHING');
        stats['objectnames'] = n;
        send(`    objectnames: ${n.toLocaleString()} rows inserted`);
      }
    }

    // 4b. Import rsmap from GeneticVariant.bin/gsdata/rsmap.tab (if present).
    {
      const gvCart = carts.find(c => c.toLowerCase().includes('geneticvariant'));
      if (gvCart) {
        const rsmapPath = path.join(medscanDir, gvCart, 'gsdata', 'rsmap.tab');
        if (fs.existsSync(rsmapPath)) {
          send(`Importing rsmap from ${gvCart}/gsdata/rsmap.tab…`);
          const lines = await readTabLinesAsync(rsmapPath);
          // Deduplicate by (medscan_id, protein_name, hgvs_code) before inserting —
          // the source file may contain duplicate keys which would cause ON CONFLICT DO UPDATE
          // to fail ("cannot affect row a second time") when two dupes land in the same batch.
          const rsmapAccum = new Map();
          let rsmapParsed = 0;
          for (const line of lines) {
            const cols = line.split('\t');
            const medscan_id = parseInt(cols[0]);
            if (isNaN(medscan_id)) continue;
            const protein_name = cols[1] || '';
            const hgvs_code   = cols[2] || '';
            const urn         = cols[3] || null;
            if (!protein_name || !hgvs_code) continue;
            rsmapParsed++;
            const key = `${medscan_id}\t${protein_name}\t${hgvs_code}`;
            if (!rsmapAccum.has(key)) {
              const normalized = (protein_name + ' ' + hgvs_code).toLowerCase();
              rsmapAccum.set(key, [medscan_id, protein_name, hgvs_code, urn, normalized, now, now]);
            }
          }
          if (rsmapAccum.size > 0) {
            const rsmapUnique = rsmapAccum.size;
            const rsmapRows = [...rsmapAccum.values()];
            rsmapAccum.clear();
            const RSMAP_COLS  = ['medscan_id','protein_name','hgvs_code','urn','normalized','created_at','updated_at'];
            const RSMAP_TYPES = ['int8','text','text','text','text','timestamptz','timestamptz'];
            const n = await unnestInsert(pool, 'rsmap', RSMAP_COLS, RSMAP_TYPES, rsmapRows, 50000, 'ON CONFLICT DO NOTHING');
            stats['rsmap'] = n;
            const rsmapDups = rsmapParsed - rsmapUnique;
            const dupMsg = rsmapDups > 0 ? `, ${rsmapDups.toLocaleString()} duplicates skipped` : '';
            send(`  rsmap: ${n.toLocaleString()} rows inserted${dupMsg}`);
          }
        }
      }
    }

    // 5. Restore WAL logging on entity tables (checkpoints the unlogged data to disk).
    send('Restoring WAL logging on entity tables…');
    await Promise.all(ENTITY_TBLS.map(t => pool.query(`ALTER TABLE "${t}" SET LOGGED`).catch(() => {})));

    // 6. Recreate the non-unique indexes we dropped before the bulk load.
    if (savedIndexDefs.length > 0) {
      send(`Recreating ${savedIndexDefs.length} indexes…`);
      for (const indexdef of savedIndexDefs) {
        await pool.query(indexdef).catch(e => send(`  Index warning: ${e.message}`));
      }
      send('Indexes rebuilt.');
    }

    // Invalidate URN map cache so next RNEF parse uses fresh data
    urnMapCachePromise = null;

    const summary = Object.entries(stats).map(([t, n]) => `${t}: ${n.toLocaleString()}`).join(', ');
    const elapsedMs = Date.now() - importStartTime;
    const elapsedTotalSec = Math.round(elapsedMs / 1000);
    const hh = String(Math.floor(elapsedTotalSec / 3600)).padStart(2, '0');
    const mm = String(Math.floor((elapsedTotalSec % 3600) / 60)).padStart(2, '0');
    const ss = String(elapsedTotalSec % 60).padStart(2, '0');
    send(`Done in ${hh}:${mm}:${ss}. ${summary}`);
    return { ok: true, stats };
  } catch (e) {
    send(`ERROR: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

ipcMain.handle('dict:refresh', async (event) => {
  const send = (msg) => { try { event.sender.send('dict:progress', msg); } catch {} };
  const medscanDir = getStore().get('medscanDir');
  if (!medscanDir) return { ok: false, error: 'Elsevier NLP directory not configured.' };
  return refreshDictsFromDir(medscanDir, send);
});

ipcMain.handle('dict:listBackups', async () => {
  try {
    const medscanDir = getStore().get('medscanDir');
    if (!medscanDir) return { ok: false, error: 'MEDSCAN directory not configured.' };
    const backupDir = path.join(medscanDir, 'DictionaryBackup');
    if (!fs.existsSync(backupDir)) return { ok: true, backups: [] };
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.zip') && f.startsWith('backup_'))
      .sort()
      .reverse(); // newest first
    return {
      ok: true,
      backups: files.map(f => ({
        name: f,
        path: path.join(backupDir, f),
        // Parse date from filename: backup_2026-08-31_21-28-29.zip
        date: f.replace('backup_', '').replace('.zip', '').replace(/_(\d{2}-\d{2}-\d{2})$/, ' $1').replace(/-/g, (m, o) => o > 9 ? ':' : '-'),
      })),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('dict:restoreFromBackupFile', async (event, { zipPath }) => {
  const send = (msg) => { try { event.sender.send('dict:progress', msg); } catch {} };
  const tmpDir = path.join(path.dirname(zipPath), `_restore_${Date.now()}`);
  try {
    send(`Extracting backup: ${path.basename(zipPath)}…`);
    await new Promise((resolve, reject) => {
      const ps = `Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force`;
      exec(`powershell -NoProfile -Command "${ps}"`, (err, _stdout, stderr) => {
        if (err) reject(new Error(`Extract failed: ${stderr || err.message}`));
        else resolve();
      });
    });
    send('Extraction complete. Starting dictionary restore…');
    return await refreshDictsFromDir(tmpDir, send);
  } catch (e) {
    send(`ERROR: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ── Pipeline helpers ───────────────────────────────────────────────────────────

/** Parse locscan.ini into { sectionName: { key: value } } */
function parsePipelineIni(iniPath) {
  const content = fs.readFileSync(iniPath, 'utf8');
  const sections = {};
  let current = null;
  for (let line of content.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1].toLowerCase();
      sections[current] = sections[current] || {};
      continue;
    }
    if (current) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        sections[current][key] = val;
      }
    }
  }
  return sections;
}

/**
 * Parse an abbreviation command string into args array (omitting the exe token at index 0).
 * Expands $Q, $t, $W with actual values; strips internal locscan vars (-w$w -v$v -q$q etc.)
 */
function parsePipelineCmdArgs(cmdStr, { organism, license, userDict }) {
  const tokens = cmdStr.trim().split(/\s+/).filter(Boolean);
  const args = [];
  const SKIP = new Set(['-w', '-v', '-q']); // bare flags from internal locscan vars
  // Value-requiring flags that should be omitted when value is empty
  const VALUE_FLAGS = new Set(['j','J','U','Q','f','N','O','E','t','D','S','V','g','I','c','C','W','k','R']);

  for (let i = 1; i < tokens.length; i++) { // start at 1 to skip exe name
    let tok = tokens[i];

    // Skip $-prefixed internal locscan variable flags: -w$w, -v$v, -q$q etc.
    if (/^-[wvq]\$[wvq]$/.test(tok)) continue;
    if (/^-[OEJDSVIGR]\$[a-zA-Z]$/.test(tok)) continue; // -O$O, -E$E, etc. with empty val
    // Skip known empty-value flags: -k$k, -f$f, -N$N, -j$j, -J$J, -U$U, -p$p, -A$A, -z$z
    if (/^-[kfNjJUpAzI]\$[a-zA-Z]$/.test(tok)) continue;

    // Expand ${rq} and ${rudq} — will be handled outside
    if (tok === '${rq}' || tok === '${rudq}') continue;

    // Expand known user vars
    tok = tok
      .replace(/\$\{?Q\}?/g, organism || 'Mammal')
      .replace(/\$\{?t\}?/g, license  || '')
      .replace(/\$\{?W\}?/g, userDict || '');

    // Remove remaining $VAR patterns (internal locscan vars)
    tok = tok.replace(/\$\{?\w+\}?/g, '');
    tok = tok.trim();

    if (!tok) continue;

    // Skip bare flags that require values (e.g., '-t' with no license)
    if (/^-([a-zA-Z])$/.test(tok)) {
      const f = tok[1];
      if (VALUE_FLAGS.has(f)) continue;
    }

    if (SKIP.has(tok)) continue;
    args.push(tok);
  }
  return args;
}

/** Pipeline logs: one file per step (command, exit code, stderr, stdout) of the LAST pipeline run of a cartridge, in <userData>/pipeline-logs/<cartridge>. */
function pipeLogDir(cartridgePath) { return path.join(app.getPath('userData'), 'pipeline-logs', path.basename(cartridgePath)); }
function makePipeLog(cartridgePath) {
  const dir = pipeLogDir(cartridgePath);
  try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  let n = 0;
  return (name, exe, args, res, input) => {
    try {
      n++;
      const f = path.join(dir, String(n).padStart(2, '0') + '-' + String(name).replace(/[^\w.-]/g, '_') + '.log');
      fs.writeFileSync(f, [
        'Time:    ' + new Date().toISOString(), 'Cwd:     ' + cartridgePath, 'Command: ' + [exe, ...(args || [])].join(' '),
        'Exit:    ' + (res && res.code), 'Input:   ' + (input != null ? 'the .input.txt file of the same name (stdin of this command)' : '(none)'), '', '---- stderr ----', (res && res.stderr) || '', '', '---- stdout ----', (res && res.output) || '', '',
      ].join('\r\n'));
      if (input != null) fs.writeFileSync(f.replace(/\.log$/, '.input.txt'), String(input));
    } catch (_) {}
  };
}
ipcMain.handle('pipeline:openLogs', async (_, cartridgePath) => {
  const dir = pipeLogDir(cartridgePath);
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  const err = await shell.openPath(dir);
  return { ok: !err, dir, error: err || '', empty: fs.readdirSync(dir).length === 0 };
});

/** Run a single process, writing stdinData to its stdin, returning { output, stderr, code }. */
function runProcCapture(exeName, args, cwd, stdinData, opts = {}) {      // opts.exe / opts.env: another program (conceptscan_llm) in place of the one in the cartridge folder
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const exeFile = isWin && !exeName.endsWith('.exe') ? exeName + '.exe' : exeName;
    const exePath = opts.exe || path.join(cwd, exeFile);
    let proc;
    if (opts.run && opts.run.cancelled) return resolve({ output: '', stderr: 'cancelled', code: -1 });
    try {
      proc = spawn(exePath, args, { cwd, ...(opts.env ? { env: opts.env } : {}) });
    } catch (e) {
      return resolve({ output: '', stderr: e.message, code: -1 });
    }
    if (opts.run) { (opts.run.procs = opts.run.procs || new Set()).add(proc); proc.on('close', () => opts.run.procs.delete(proc)); }       // the Reader's Stop kills what is running (killRun)
    const out = [], err = [];
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => { err.push(d); if (opts.onStderr) { try { opts.onStderr(d.toString('utf8')); } catch (_) { /* a listener must not stop the run */ } } });
    proc.on('error', e => resolve({ output: Buffer.concat(out).toString('utf8'), stderr: e.message, code: -1 }));
    proc.on('close', code => resolve({
      output: Buffer.concat(out).toString('utf8'),
      stderr:  Buffer.concat(err).toString('utf8'),
      code: code ?? 0,
    }));
    if (stdinData != null) {
      try { proc.stdin.write(stdinData); proc.stdin.end(); }
      catch (_) { try { proc.stdin.end(); } catch (_2) {} }
    } else {
      try { proc.stdin.end(); } catch (_) {}
    }
  });
}

// ── pipeline:readIni — return parsed pipeline steps for a cartridge ────────────
ipcMain.handle('pipeline:readIni', (_, cartridgePath) => {
  try {
    const iniPath = path.join(cartridgePath, 'locscan.ini');
    if (!fs.existsSync(iniPath)) return { ok: false, error: 'locscan.ini not found' };
    const ini = parsePipelineIni(iniPath);
    const abbrevs = ini.abbreviations || {};
    const outputSection = ini.output || {};
    const protglue = abbrevs['PROTGLUE'] || abbrevs['protglue'] || '';
    const hasCellScan = protglue.toLowerCase().includes('cellscan');
    // Parse allpats
    const allpatsVal = outputSection['allpats'] || '';
    const inner = allpatsVal.replace(/^\$\(/, '').replace(/\)$/, '');
    const patterns = inner ? inner.split('+').map(p => p.trim()).filter(p => p && outputSection[p]) : [];
    return { ok: true, hasCellScan, patterns };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── pipeline:getUrnEntries ─────────────────────────────────────────────────────
ipcMain.handle('pipeline:getUrnEntries', async (_, { cartridgePath }) => {
  try {
    const medscanDir = path.dirname(cartridgePath);
    const urnMap = await loadUrnMap(medscanDir);
    return [...urnMap.entries()]; // [[urn, mscanId], ...]
  } catch {
    return [];
  }
});

// ── locscan.ini interpreter ────────────────────────────────────────────────────────────────────────────────────
// The pipeline of a cartridge is what its locscan.ini says, not a shape assumed by the app:
//   [input]   sentence:=${MEDSCAN} -a -- ${rq} | ${PROTGLUE} | ${CONCEPTSCAN}     the stages that turn a sentence into markup
//   [output]  allpats=$(a+b+…)  and  a=${MSGREP} -Icsout -H grdata/… -b a.grbatch | ${XF2RN} | …   one command per .grbatch, every stage of it
// ${NAME} of [abbreviations] is replaced (nested ones too), the locscan variables ($Q organism, $t license, $W user dictionary, the others from [defaults]) are filled in,
// a token whose variable is empty is dropped, ${rq} is the sentence. The markup that -Imsout rules read is the stream that goes INTO the conceptscan stage (what the
// glue stages — reglue, cellscan, gvarscan … — made of the MedScan output: "SMAC" "/" "DIABLO" are one entity there); -Icsout rules read what conceptscan wrote.
function expandIniText(text, abbrevs) {
  let t = String(text || '');
  for (let i = 0; i < 8; i++) {
    const n = t.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(abbrevs, k) ? abbrevs[k] : m));
    if (n === t) break;
    t = n;
  }
  return t;
}
/** the stages of "a | b | c" ("|" inside quotes does not split) */
function splitIniPipe(text) {
  const out = [];
  let cur = '', q = '';
  for (const c of String(text || '')) {
    if (q) { cur += c; if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}
/** the words of one stage; a "quoted phrase" is one word (without the quotes) */
function iniTokens(stage) {
  const toks = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(stage)) !== null) toks.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return toks;
}
/** { exe, args, text } of one stage */
function iniStage(stageText, vars, defaults, sentence) {
  const val = (k) => {
    if (vars[k]) return vars[k];
    const d = (defaults && defaults[k]) || '';
    const env = /^\$([A-Za-z_]\w*)$/.exec(d);
    if (env) return process.env[env[1]] || '';
    return d.startsWith('<') ? '' : d;                  // "<LCNUM": read from a file by locscan — the license comes from the Settings here
  };
  const toks = iniTokens(stageText);
  const args = [];
  for (const tok of toks.slice(1)) {
    if (tok === '${rq}' || tok === '${rudq}') { args.push(sentence); continue; }
    if (!tok.includes('$')) { args.push(tok); continue; }
    let empty = false;
    const t = tok.replace(/\$\{?([A-Za-z])\}?/g, (m, k) => { const v = val(k); if (!v) empty = true; return v; });
    if (empty || t.includes('$') || !t) continue;
    args.push(t);
  }
  return { exe: (toks[0] || '').replace(/^\.[\\/]/, ''), args, text: stageText };
}
const iniExeBase = (exe) => exe.replace(/\.exe$/i, '').toLowerCase();
const fmtStage = (st) => [st.exe, ...st.args].join(' ');
/** the folder an output rule reads: the -H of its msgrep stage */
function ruleFolder(stages) {
  for (const st of stages) {
    const i = st.args.findIndex(a => /^-H/.test(a));
    if (i >= 0) return st.args[i].length > 2 ? st.args[i].slice(2) : (st.args[i + 1] || '');
  }
  return '';
}

/**
 * Runs a sentence through the pipeline of a cartridge as its locscan.ini defines it.
 *   hooks: { onStart({ name, label, folder? }), onDone({ name, label, folder?, output, stderr, code, stepType, cmd }) }
 *   opts:  { markupOnly: true — only the stages up to what goes into conceptscan (all of them when there is no conceptscan stage): → { msout },
 *            input: { key, stdin, fallback } — another [input] entry than sentence:= (msxml:= for an MSXML document on stdin, msxmlO1:= for medscan -O1 markup) }
 * → { msout, csout, rnefParts: [{ name, folder, xml, stderr }], allStderr }
 */
async function runSentencePipeline(cartridgePath, sentence, { organism, license, userDict }, hooks = {}, plog = () => {}, opts = {}) {
  const iniPath = path.join(cartridgePath, 'locscan.ini');
  if (!fs.existsSync(iniPath)) throw new Error('locscan.ini not found in cartridge directory.');
  const ini = parsePipelineIni(iniPath);
  const abbrevs = ini.abbreviations || {}, defaults = ini.defaults || {}, inputSec = ini.input || {}, outputSec = ini.output || {};
  const vars = { Q: organism || 'Mammal', t: license || '', W: userDict || '' };
  const inKey = opts.input ? opts.input.key : 'sentence:';
  const sentenceDef = inputSec[inKey] || (opts.input && opts.input.fallback);
  if (!sentenceDef) throw new Error(`locscan.ini has no "${inKey}=" line in [input].`);
  const stages = splitIniPipe(expandIniText(sentenceDef, abbrevs)).map(s => iniStage(s, vars, defaults, sentence));
  let allStderr = '';
  const collect = (s) => { if (s) allStderr += (allStderr ? '\n' : '') + s; };
  const LABELS = { medscan: 'MedScan (sentence markup)', conceptscan: 'ConceptScan', cellscan: 'CellScan' };
  // Triplefication (the choice of the Triplefication panel, one for the whole app): when an LLM is chosen, its conceptscan_llm writes the pseudo-sentences instead of the conceptscan of the cartridge
  const tr = opts.useTriple && !opts.markupOnly ? pipelineTriple(cartridgePath) : null;
  const seen = {};
  let prev = opts.input && opts.input.stdin != null ? opts.input.stdin : null, msout = null, csout = '';
  for (const st of stages) {
    const base = iniExeBase(st.exe);
    seen[base] = (seen[base] || 0) + 1;
    const name = base + (seen[base] > 1 ? String(seen[base]) : '');
    const llm = !!tr && base === 'conceptscan';
    const label = llm ? tr.label : LABELS[base] || (base.charAt(0).toUpperCase() + base.slice(1)) + (seen[base] > 1 ? ' ' + seen[base] : '');
    if (opts.markupOnly && base === 'conceptscan') break;
    if (hooks.onStart) hooks.onStart({ name, label });
    const t0 = Date.now();
    let llmEnv = tr && tr.env;
    if (llm && opts.onLlmProgress) llmEnv = { ...tr.env, CSLLM_PROGRESS: '1' };
    let carry = '';
    const onStderr = llm && opts.onLlmProgress ? (t) => {                 // "[llm] <done> <total>" after every sentence the LLM answered
      carry += t;
      const lines = carry.split(String.fromCharCode(10)); carry = lines.pop();
      for (const l of lines) { const m = /^\[llm\] (\d+) (\d+)/.exec(l); if (m) opts.onLlmProgress(Number(m[1]), Number(m[2])); }
    } : null;
    const res = await runProcCapture(st.exe, st.args, cartridgePath, prev, llm ? { exe: tr.exe, env: llmEnv, onStderr, run: opts.run } : { run: opts.run });
    if (opts.run && opts.run.cancelled) break;
    const ms = Date.now() - t0;                                // shown on the step in the Pipeline screen
    plog(name, st.exe, st.args, res, prev);
    collect(res.stderr);
    if (hooks.onDone) hooks.onDone({ name, label, output: res.output, stderr: res.stderr, code: res.code, stepType: 'markup', cmd: fmtStage(st), ms, ...(llm ? { llm: { cartridge: cartName(path.basename(cartridgePath)), cartridgePath } } : {}) });
    if (base === 'conceptscan') { msout = prev; csout = res.output; }
    prev = res.output;
  }
  if (opts.markupOnly) return { msout: prev || '', csout: '', rnefParts: [], allStderr };
  if (msout == null) msout = prev || '';                 // no conceptscan stage: what the last stage wrote
  if (!csout) csout = prev || '';

  // the output rules of allpats: every stage of the rule, in order (msgrep | xf2rn | maprn | rn2rn …), on the markup its -I names
  const allpats = String(outputSec['allpats'] || '').replace(/^\$\(/, '').replace(/\)$/, '');
  const rules = allpats ? allpats.split('+').map(p => p.trim()).filter(p => p && outputSec[p]) : [];
  const jobs = rules.map((rule) => {
    const rstages = splitIniPipe(expandIniText(outputSec[rule], abbrevs)).map(s => iniStage(s, vars, defaults, sentence));
    if (!rstages.length) return null;
    const fmt = (rstages.map(x => x.args.join(' ')).join(' | ').match(/-I\s*(msout|csout)/i) || [, 'msout'])[1].toLowerCase();       // msgrep: "-I ifmt Input format (msout or csout); defaults to msout"
    const source = fmt === 'msout' ? msout : csout;
    if (!source) return null;
    const folder = ruleFolder(rstages) || rule;
    if (hooks.onStart) hooks.onStart({ name: rule, label: `Pattern: ${folder}`, folder });
    return (async () => {
      const tRule = Date.now();
      let data = source, stderr = '', code = 0, last = null;
      for (let i = 0; i < rstages.length; i++) {
        const st = rstages[i];
        last = await runProcCapture(st.exe, st.args, cartridgePath, data, { run: opts.run });
        if (opts.run && opts.run.cancelled) break;
        plog(`${rule}-${iniExeBase(st.exe)}${rstages.filter(x => x.exe === st.exe).length > 1 ? i + 1 : ''}`, st.exe, st.args, last, i === 0 ? source : data);
        stderr += (stderr && last.stderr ? '\n' : '') + (last.stderr || '');
        code = last.code;
        data = last.output;
      }
      collect(stderr);
      if (hooks.onDone) hooks.onDone({ name: rule, label: `Pattern: ${folder}`, folder, output: data, stderr, code, stepType: 'pattern', cmd: rstages.map(fmtStage).join(' | '), ms: Date.now() - tRule });
      return { name: rule, folder, xml: data || '', stderr };
    })();
  }).filter(Boolean);
  const rnefParts = await Promise.all(jobs);
  return { msout, csout, rnefParts, allStderr };
}

// ── pipeline:run ───────────────────────────────────────────────────────────────
ipcMain.handle('pipeline:run', async (event, { cartridgePath, sentence, organism, license, userDict }) => {
  const send = (type, payload) => {
    try { event.sender.send('pipeline:event', { type, ...payload }); } catch (_) {}
  };
  try {
    if (!fs.existsSync(path.join(cartridgePath, 'locscan.ini'))) {
      send('error', { message: 'locscan.ini not found in cartridge directory.' });
      return { ok: false };
    }
    const plog = makePipeLog(cartridgePath);
    if (storedTriple()) clearLlmCacheForRun(null);
    await runSentencePipeline(cartridgePath, sentence, { organism, license, userDict }, {
      onStart: (d) => send('step_start', d),
      onDone:  (d) => send('step_done', d),
    }, plog, { useTriple: true });
    send('done', {});
    return { ok: true };
  } catch (err) {
    send('error', { message: err.message });
    return { ok: false, error: err.message };
  }
});

// ── runCartridgeSilent ─────────────────────────────────────────────────────────
// Runs the full pipeline for one cartridge without emitting step events.
// Returns { finalMarkupXml (what conceptscan wrote), msout (what goes into conceptscan), rnefParts: [{name, folder, xml, stderr}], allStderr }.
async function runCartridgeSilent(cartridgePath, sentence, organism, license, userDict, opts = {}) {
  const plog = opts.noLog ? (() => {}) : makePipeLog(cartridgePath);
  const r = await runSentencePipeline(cartridgePath, sentence, { organism, license, userDict }, {}, plog, { useTriple: !!opts.useTriple });
  return { finalMarkupXml: r.csout, msout: r.msout, rnefParts: r.rnefParts, allStderr: r.allStderr };
}

// ── pipeline:runAll ────────────────────────────────────────────────────────────
// Runs the full pipeline for every supplied cartridge in parallel.
// Emits pipeline:allEvent messages: cart_start, cart_done (per cart), all_done.
ipcMain.handle('pipeline:runAll', async (event, { cartridges, sentence, organism, license, userDict }) => {
  const send = (payload) => { try { event.sender.send('pipeline:allEvent', payload); } catch (_) {} };
  if (storedTriple()) clearLlmCacheForRun(null);
  await Promise.all((cartridges || []).map(async (cart) => {
    send({ type: 'cart_start', cartName: cart.name, cartPath: cart.path });
    try {
      const result = await runCartridgeSilent(cart.path, sentence, organism, license, userDict, { useTriple: true });
      send({ type: 'cart_done', cartName: cart.name, cartPath: cart.path, ...result });
    } catch (e) {
      send({ type: 'cart_done', cartName: cart.name, cartPath: cart.path, finalMarkupXml: '', rnefParts: [], allStderr: e.message, error: true });
    }
  }));
  send({ type: 'all_done' });
  return { ok: true };
});

// ── Reader screen ───────────────────────────────────────────────────────────────
// reader:fetchUrl   — the page / file behind a URL → { ok, url, contentType, kind: 'html' | 'pdf' | 'text', data (text, or base64 for a PDF) }
// reader:openFile   — "Upload": a file dialog, then the same shape as above (+ name)
// reader:markup / reader:relations — the document as MSXML: medscan -O1 markup once, then the full pipeline of every chosen cartridge (see below)
const readerKind = (contentType, name) => {
  const c = String(contentType || '').toLowerCase(), n = String(name || '').toLowerCase();
  if (c.includes('pdf') || /\.pdf($|\?)/.test(n)) return 'pdf';
  if (c.includes('html') || c.includes('xml') || /\.(x?html?|xml)($|\?)/.test(n)) return 'html';
  return 'text';
};
const readerDecode = (buf, contentType) => {
  let cs = (String(contentType || '').match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) { const head = Buffer.from(buf).subarray(0, 4096).toString('latin1'); cs = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8'; }
  try { return new TextDecoder(cs).decode(buf); } catch (_) { return new TextDecoder('utf-8').decode(buf); }
};
const READER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
/** characters of text a page gives without running scripts (what the Reader can analyze) */
const readerTextChars = (html) => String(html || '').replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim().length;
const readerLooksBlocked = (html) => /just a moment|checking your browser|enable javascript and cookies|are you a robot|captcha|access denied|attention required/i.test(String(html || '').slice(0, 6000)) && readerTextChars(html) < 4000;
/** the page as a browser shows it: loaded in a hidden window of the app (scripts run, cookies are kept), the document read after the scripts have filled it in */
async function readerRenderInWindow(url) {
  const win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:reader', backgroundThrottling: false } });
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('The page did not finish loading in 45 seconds.')), 45000);
      win.webContents.once('did-finish-load', () => { clearTimeout(to); resolve(); });
      win.webContents.on('did-fail-load', (_e, code, desc, _u, isMain) => { if (isMain && code !== -3) { clearTimeout(to); reject(new Error(desc || 'The page could not be loaded.')); } });
      win.loadURL(url, { userAgent: READER_UA }).catch(() => {});
    });
    // scripts that fill the page / redirects of a bot-check page: wait (up to ~20 s) until the page has text
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 2500 : 1000));
      let n = 0;
      try { n = await win.webContents.executeJavaScript('document.body ? document.body.innerText.length : 0'); } catch (_) { /* navigating */ }
      if (n >= 1500) break;
    }
    const html = await win.webContents.executeJavaScript('(document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "") + document.documentElement.outerHTML');
    return { html, url: win.webContents.getURL() || url };
  } finally { try { win.destroy(); } catch (_) { /* gone */ } }
}
ipcMain.handle('reader:fetchUrl', async (_e, rawUrl) => {
  try {
    let url = String(rawUrl || '').trim();
    if (!url) return { ok: false, error: 'No URL.' };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
    if (!/^https?:/i.test(url)) return { ok: false, error: 'Only http(s) addresses can be loaded.' };
    const { net } = require('electron');
    let res = null, fetchErr = '';
    try { res = await net.fetch(url, { redirect: 'follow', headers: { 'User-Agent': READER_UA, 'Accept': 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-US,en;q=0.9' } }); }
    catch (e) { fetchErr = e.message; }
    let contentType = res ? (res.headers.get('content-type') || '') : '', kind = res ? readerKind(contentType, res.url || url) : 'html';
    if (res && res.ok && kind !== 'html') {
      const buf = Buffer.from(await res.arrayBuffer());
      return { ok: true, url: res.url || url, contentType, kind, data: kind === 'pdf' ? buf.toString('base64') : readerDecode(buf, contentType), textChars: kind === 'pdf' ? 0 : buf.length };
    }
    let html = '', finalUrl = res ? (res.url || url) : url, rendered = false;
    if (res && res.ok) html = readerDecode(Buffer.from(await res.arrayBuffer()), contentType);
    // the server sent no readable page (a script-only page, a bot check, an error status): load it the way a browser does
    if (!res || !res.ok || readerTextChars(html) < 800 || readerLooksBlocked(html)) {
      try { const r = await readerRenderInWindow(url); if (readerTextChars(r.html) > readerTextChars(html)) { html = r.html; finalUrl = r.url; rendered = true; } }
      catch (e) { if (!html) return { ok: false, error: (res && !res.ok ? 'The server answered ' + res.status + ' ' + (res.statusText || '') + '; ' : fetchErr ? fetchErr + '; ' : '') + e.message }; }
    }
    if (!html) return { ok: false, error: 'The server answered ' + (res ? res.status : '?') + ' with no page.' };
    return { ok: true, url: finalUrl, contentType: 'text/html', kind: 'html', data: html, rendered, textChars: readerTextChars(html) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('reader:openFile', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Articles', extensions: ['pdf', 'html', 'htm', 'xhtml', 'xml', 'txt', 'text'] }, { name: 'All files', extensions: ['*'] }] });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const f = r.filePaths[0];
    const buf = fs.readFileSync(f);
    const kind = readerKind('', f);
    return { ok: true, name: path.basename(f), url: 'file:///' + f.replace(/\\/g, '/'), kind, data: kind === 'pdf' ? buf.toString('base64') : readerDecode(buf, '') };
  } catch (e) { return { ok: false, error: e.message }; }
});
const readerRuns = new Map();                      // sender id → { cancelled }
// reader:coref  { prompts: [text] } -> { ok, replies: [text] }: the Reader's "Resolve pronouns": one short question per pronoun, answered by the LLM chosen under Triplefication (conceptscan.exe --ask)
const corefProcs = new Map();                                       // sender id -> the running conceptscan.exe --ask (killed by Stop)
ipcMain.handle('reader:coref', async (event, { prompts }) => {
  try {
    // Pronoun resolution has its own LLM (Settings -> LLM Connector / Local LLM -> "Pronoun resolution (Reader)": the provider or the local model), whatever the Triplefication is
    const st = getStore(), ft = st.get('llmFunctionTargets') || {};
    const target = ft['reader.pronouns'] === 'api' ? 'api' : 'local';                // not chosen yet: local (the same default as shared/llmFunctions.js)
    let t;
    if (target === 'local') {
      const model = String(st.get('llmLocalModel') || '').trim();
      if (!model) return { ok: false, error: 'Pronoun resolution (Reader) uses the Local LLM, but no model is chosen: Settings -> Local LLM settings -> "Model for the functions set to Local LLM" (or set this function to the LLM provider).' };
      t = { kind: 'local', model };
    } else {
      const model = String(st.get('llmModel') || '').trim();
      if (!String(st.get('llmProviderUrl') || '').trim() || !model) return { ok: false, error: 'Pronoun resolution (Reader) uses the LLM provider, but Settings -> LLM Connector has no API Base URL / model (or set this function to the Local LLM).' };
      t = { kind: 'provider', model };
    }
    const exe = llmTriple.findExe(getStore(), path.join(__dirname, '..', '..'));
    if (!exe) return { ok: false, error: 'conceptscan_llm (conceptscan.exe) not found - set its path in Settings -> Local LLM settings.' };
    const env = llmTriple.buildEnv(getStore(), t, '', '');
    return await new Promise((resolve) => {
      const p = require('child_process').spawn(exe, ['--ask'], { env, windowsHide: true });
      let out = '', err = '';
      const timer = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, error: 'the LLM did not answer within 15 minutes' }); }, 15 * 60 * 1000);
      corefProcs.set(event.sender.id, p);
      p.stdout.on('data', d => { out += d.toString('utf8'); });
      p.stderr.on('data', d => {                                       // "[ask] <done> <total>" after every answer
        const t = d.toString('utf8'); err += t;
        const m = [...t.matchAll(/\[ask\] (\d+) (\d+)/g)].pop();
        if (m) { try { event.sender.send('reader:coref-progress', { done: +m[1], total: +m[2] }); } catch {} }
      });
      p.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
      p.on('close', code => {
        clearTimeout(timer);
        const killed = corefProcs.get(event.sender.id) === 'killed'; corefProcs.delete(event.sender.id);
        if (killed) return resolve({ ok: true, cancelled: true, replies: [] });
        if (code !== 0) return resolve({ ok: false, error: (err.trim().split(String.fromCharCode(10)).pop() || 'conceptscan.exe --ask failed') });
        try { const j = JSON.parse(out); resolve({ ok: true, replies: Array.isArray(j.replies) ? j.replies : [] }); } catch (e) { resolve({ ok: false, error: 'unreadable answer: ' + e.message }); }
      });
      p.stdin.on('error', () => {}); p.stdin.end(JSON.stringify({ prompts: (prompts || []).map(String) }));
    });
  } catch (e) { return { ok: false, error: e.message }; }
});
// Stop: the processes of the run are killed with their children (conceptscan_llm has worker processes), not only the next cartridges kept from starting
function killRun(run) {
  for (const p of [...(run.procs || [])]) {
    try { if (process.platform === 'win32' && p.pid) spawn('taskkill', ['/F', '/T', '/PID', String(p.pid)], { windowsHide: true }); else p.kill(); } catch { try { p.kill(); } catch {} }
  }
}
ipcMain.handle('reader:cancel', (event) => { const cp = corefProcs.get(event.sender.id); if (cp && cp !== 'killed') { corefProcs.set(event.sender.id, 'killed'); try { cp.kill(); } catch {} } const r = readerRuns.get(event.sender.id); if (r) { r.cancelled = true; killRun(r); } return { ok: true }; });
// The document as ONE MSXML text (a <section uri="info:reader/<block>"> per paragraph), in two steps so that the page can be highlighted at once:
//   reader:markup     medscan -O1 ([input] msxmlO1:=| ${MEDSCAN} -Imsxml -O1) run ONCE, with markupCartridge (Standard) → { o1 }: the sentences with their entities marked up (ID{ids=text})
//   reader:relations  the full pipeline of every chosen cartridge ([input] msxml:=… | ${CONCEPTSCAN} and every rule of allpats) → the relations (RNEF; TextRef says which paragraph);
//                     the result of each cartridge is sent as soon as it is ready ('reader:relations-part'), the call returns when all are done
const readerStart = (event) => {
  const st = getStore();
  const license = st.get('medscanLicense') || '', userDict = st.get('userDict') || '';
  if (!license) return { error: 'No NLP license key configured in Settings.' };
  const run = { cancelled: false };
  readerRuns.set(event.sender.id, run);
  return { run, st, vars: (organism) => ({ organism: organism || 'Mammal', license, userDict }) };
};
ipcMain.handle('reader:markup', async (event, { msxml, markupCartridge, organism }) => {
  const g = readerStart(event);
  if (g.error) return { ok: false, error: g.error };
  try {
    const r = await runSentencePipeline(markupCartridge.path, '', g.vars(organism), {}, () => {}, { markupOnly: true, run: g.run, input: { key: 'msxmlO1:', stdin: msxml, fallback: '| ${MEDSCAN} -Imsxml -O1' } });
    return { ok: true, o1: r.msout || '' };
  } catch (e) { return { ok: true, o1: '', error: e.message }; }
});
// The semantic triples of a ConceptScan output ("<\t#Main  NP1 & verb  NP2" lines under the msrc of their sentence): only the records that have some,
// and only the lines the Reader needs (mref / TextRef / TextMods / msrc / triples) → the part of the .cs the Reader draws the triples from.
function readerTriples(cs) {
  const out = [];
  let rec = null;
  const flush = () => { if (rec && rec.some(l => l.startsWith('<\t'))) out.push(rec.join('\n')); rec = null; };
  for (const line of String(cs || '').split(/\r?\n/)) {
    if (line.startsWith('mref\t')) { flush(); rec = ['mref\t0']; continue; }
    if (rec && /^(TextRef|TextMods|msrc|<)\t/.test(line)) rec.push(line);
  }
  flush();
  return out.join('\n');
}
ipcMain.handle('reader:relations', async (event, { msxml, cartridges, organism, triple, maxParallel }) => {
  const g = readerStart(event);
  if (g.error) return { ok: false, error: g.error };
  // Triplefication follows the user's setting (the Triplefication list of the NLP Runner / Pipeline screen and Settings -> Local LLM): an LLM chosen there extracts the triples in the Reader too, else conceptscan of the cartridges
  const useLlm = !!storedTriple();
  if (useLlm) clearLlmCacheForRun(null);
  const list = cartridges || [];
  const vars = g.vars(organism);
  let next = 0, done = 0;
  const limit = Math.max(1, parseInt(maxParallel) || parseInt(g.st.get('readerMaxParallel') ?? g.st.get('maxParallelCartridges')) || 2);        // the Reader's own setting (sent by the Reader), not the NLP Runner's
  const tick = (label) => { try { event.sender.send('reader:progress', { done, total: list.length, label, llm: useLlm }); } catch (_) {} };
  const llmProg = new Map();                                              // cartridge -> { done, total }: the sentences the LLM has answered / will be asked, all cartridges together
  const sendLlm = (name, d, t) => {
    llmProg.set(name, { done: d, total: t });
    let done2 = 0, total2 = 0; for (const v of llmProg.values()) { done2 += v.done; total2 += v.total; }
    try { event.sender.send('reader:llm-progress', { done: done2, total: total2, cartridges: llmProg.size }); } catch (_) {}
  };
  tick('');
  const worker = async () => {
    while (!g.run.cancelled) {
      const c = list[next++];
      if (!c) return;
      const part = { cartridge: c.name, rnefParts: [], triples: '', error: '', llm: null };
      const llmStat = { asked: 0, noPair: 0, failed: 0, kept: 0, firstError: '' };         // what the LLM did (the log of conceptscan_llm: CSLLM_DEBUG): sentences asked, without an entity pair, failed (a request that did not succeed), pseudo-sentence lines written
      const hooks = { onDone: (st) => {
        if (!st || !st.llm) return;
        const e = String(st.stderr || '');
        llmStat.asked += (e.match(/--- PROMPT:/g) || []).length; llmStat.noPair += (e.match(/--- no pair of entities/g) || []).length;
        for (const m of e.matchAll(/--- KEPT (\d+) pseudo-sentence/g)) llmStat.kept += Number(m[1]);
        const f = e.match(/conceptscan: warning: ([^\n]*)/g) || [];
        llmStat.failed += f.length; if (f.length && !llmStat.firstError) llmStat.firstError = f[0].replace(/^conceptscan: warning: /, '').slice(0, 200);
        part.llm = llmStat;
      } };
      try {
        const r = await runSentencePipeline(c.path, '', vars, hooks, () => {}, { useTriple: useLlm, run: g.run, onLlmProgress: useLlm ? (d, t) => sendLlm(c.name, d, t) : null, input: { key: 'msxml:', stdin: msxml, fallback: '| ${MEDSCAN} -Imsxml | ${PROTGLUE} | ${CONCEPTSCAN}' } });
        part.triples = readerTriples(r.csout);
        part.rnefParts = (r.rnefParts || []).filter(x => x.xml && x.xml.includes('<resnet')).map(x => ({ name: x.name, folder: x.folder, xml: x.xml }));
      } catch (e) { part.error = e.message; }
      done++;
      try { event.sender.send('reader:relations-part', part); } catch (_) {}
      tick(c.name);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length || 1) }, worker));
  readerRuns.delete(event.sender.id);
  return { ok: true, cancelled: g.run.cancelled };
});

// ── relation:sentenceMarkup ─────────────────────────────────────────────────────
// The wizard was opened without a sentence (Patterns → Add relation): the user pastes a test sentence, it runs through this cartridge's pipeline
// (MedScan … ConceptScan) and the final markup is what "Test pattern" runs the pattern on. Returns { markup }.
ipcMain.handle('relation:sentenceMarkup', relWrap(async ({ cartPath, sentence, organism, userDict }) => {
  const run = await runCartridgeSilent(cartPath, sentence, organism || 'Mammal', getStore().get('medscanLicense') || '', userDict || getStore().get('userDict') || '');
  if (!run.finalMarkupXml) throw new Error('The pipeline of this cartridge gave no markup for the sentence' + (run.allStderr ? ': ' + String(run.allStderr).trim().slice(0, 300) : '.'));
  return { markup: run.finalMarkupXml };
}));

// ── relation:otherCartridgeContexts ─────────────────────────────────────────────
// "Suggest pattern" found nothing in this cartridge: run the sentence through every sibling cartridge (MedScan … ConceptScan, in parallel) and
// return what each one marks up and which relation types it has rules for. Returns { carts: [{ name, path, markup, ctx }] }.
ipcMain.handle('relation:otherCartridgeContexts', relWrap(async ({ cartPath, sentence, organism, userDict, only }) => {
  const parent = path.dirname(cartPath);
  const sibs = fs.readdirSync(parent, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.length > 4 && d.name.toLowerCase().endsWith('.bin') && path.resolve(path.join(parent, d.name)) !== path.resolve(cartPath)
      && fs.existsSync(path.join(parent, d.name, 'nodetype.ini')) && fs.existsSync(path.join(parent, d.name, 'locscan.ini')))
    .map(d => ({ name: d.name.slice(0, -4), path: path.join(parent, d.name) }))
    .filter(c => !only || only.some(p => path.resolve(p) === path.resolve(c.path)));
  const license = getStore().get('medscanLicense') || '';
  const carts = (await Promise.all(sibs.map(async (c) => {
    try {
      const run = await runCartridgeSilent(c.path, sentence, organism || 'Mammal', license, userDict || getStore().get('userDict') || '');
      const markup = run.finalMarkupXml || '';
      if (!markup) return null;
      const { macros, macroNames, total, ...ctx } = relationBuilder.suggestContext(c.path, markup, sentence);
      return { ...c, markup, ctx };
    } catch (_) { return null; }
  }))).filter(Boolean);
  return { carts };
}));
