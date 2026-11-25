'use strict';
// Before "npm run build": makes sure conceptscan_llm/dist/conceptscan.exe (the program the app starts for LLM triplefication; a folder build with its _internal folder) exists, was built from the current Python sources and runs;
// electron-builder then copies the folder into the installed app (package.json build.extraResources -> <install>/resources/conceptscan_llm/dist).
//   node scripts/prepare-llm.js            rebuild only when the exe is missing or older than a source file
//   node scripts/prepare-llm.js --rebuild  always rebuild
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const soft = process.argv.includes('--soft');      // npm run start:built: a problem only prints a warning, the app starts with the exe it has
const dir = path.join(__dirname, '..', '..', 'conceptscan_llm');
const LOG = path.join(__dirname, '..', '..', 'prepare-llm.log');      // the launcher runs this hidden: the problems are kept here too
const fail = (msg) => { console.error(msg); console.log('[progress-error] ' + msg.replace(/\s+/g, ' ')); try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch {} process.exit(soft ? 0 : 1); };
if (!fs.existsSync(dir)) fail('[prepare-llm] folder ' + dir + ' not found: LLM triplefication is not available');
const exeName = process.platform === 'win32' ? 'conceptscan.exe' : 'conceptscan';
const exe = path.join(dir, 'dist', exeName);          // the program: a FOLDER build (dist/: conceptscan.exe + _internal/): nothing is unpacked at a start, so it starts in a fraction of a second
// the hash of the program's sources: the same as conceptscan_version.source_hash() (sha1 of conceptscan*.py sorted by name, line ends normalised, first 10 hex digits)
function sourceHash() {
  const h = require('crypto').createHash('sha1');
  for (const f of fs.readdirSync(dir).filter(n => /^conceptscan.*\.py$/.test(n)).sort()) {
    const text = fs.readFileSync(path.join(dir, f)).toString('latin1').split('\r\n').join('\n');
    h.update(Buffer.concat([Buffer.from(f, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1'), Buffer.from([0])]));
  }
  return h.digest('hex').slice(0, 10);
}
const want = fs.existsSync(dir) ? sourceHash() : '';

// Not by file dates (a download or a copy gives every file a new date): the exe says which sources it was built from (--version) and that must be the sources on disk.
// Starting the exe is slow (a PyInstaller onefile unpacks 28 MB, 15-20 s with a virus scanner), so its answer is kept in dist\conceptscan.stamp.json together with the size and date of
// the exe it came from: the exe is started only when it is new or was replaced (a copy from another computer), not at every start of the app.
const stampOf = (e) => path.join(path.dirname(e), 'conceptscan.stamp.json');
function exeVersionText(e = exe) {
  if (!fs.existsSync(e)) return '';
  const STAMP = stampOf(e);
  const st = fs.statSync(e);
  try {
    const k = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    if (k.size === st.size && k.mtimeMs === st.mtimeMs && k.text) return k.text;
  } catch { /* no stamp yet */ }
  const r = spawnSync(e, ['--version'], { encoding: 'utf8' });
  const text = r.status === 0 ? (r.stdout || '').trim() : '';
  if (/sources [0-9a-f]{10}/.test(text)) { try { fs.writeFileSync(STAMP, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, text })); } catch { /* read-only folder: the exe is started next time */ } }
  return text;
}
function exeSources(e = exe) {
  const m = /sources ([0-9a-f]{10})/.exec(exeVersionText(e));
  return m ? m[1] : '';
}
function staleOf(e) {
  if (!fs.existsSync(e)) return 'missing';
  const have = exeSources(e);
  if (!have) return 'the exe does not report its version (older than the version stamp)';
  return have === want ? '' : 'the exe was built from sources ' + have + ', the sources on disk are ' + want;
}

// ── progress: the lines "[progress] <percent> <text>" on stdout. scripts/start-built.js shows them in a small window (the first start builds for minutes and would otherwise look frozen) ──
const progress = (pct, text) => console.log('[progress] ' + Math.round(pct) + ' ' + text);

// run a program; every line of its output goes to the console and to onLine. -> its exit code (null: it could not be started)
function runLines(cmd, args, cwd, onLine) {
  return new Promise(resolve => {
    let p;
    try { p = spawn(cmd, args, { cwd, windowsHide: true }); } catch { resolve(null); return; }
    let buf = '';
    const feed = (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); console.log(line); if (onLine) onLine(line); }
    };
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', () => resolve(null));
    p.on('close', code => { if (buf) { console.log(buf); if (onLine) onLine(buf); } resolve(code); });
  });
}

// The build environment (.venv-build: PyInstaller + boto3): made here when it is missing, from the first Python 3 that is found.
async function ensureVenv() {
  const venv = path.join(dir, '.venv-build', 'Scripts', 'python.exe');
  if (fs.existsSync(venv)) return venv;
  const cands = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of cands) {
    if (spawnSync(cmd, [...pre, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'], { encoding: 'utf8' }).status !== 0) continue;
    console.log('[prepare-llm] making the build environment .venv-build with', cmd, pre.join(' '));
    progress(3, 'Creating the Python environment (first start only)');
    if (await runLines(cmd, [...pre, '-m', 'venv', '.venv-build'], dir) !== 0) continue;
    progress(8, 'Installing PyInstaller and boto3 (first start only, needs the network)');
    let n = 0;
    const code = await runLines(venv, ['-m', 'pip', 'install', 'pyinstaller', 'boto3'], dir, (l) => {
      if (/^Collecting /.test(l)) { n++; progress(Math.min(25, 8 + n * 1.5), 'Downloading ' + l.slice(11).split(/[ =<>]/)[0] + ' (first start only)'); }
      else if (/^Installing collected packages/.test(l)) progress(27, 'Installing the packages');
      else if (/^Successfully installed/.test(l)) progress(30, 'Packages installed');
    });
    if (code === 0) return venv;
    console.error('[prepare-llm] pip could not install pyinstaller / boto3 (no network or package index?)');
    return '';
  }
  console.error('[prepare-llm] no Python 3.9+ found (tried ' + cands.map(c => c[0]).join(', ') + ')');
  return '';
}

// The build: PyInstaller --onedir into build/out/conceptscan, then its content is copied into dist/ (the single-file exe is not built any more: it unpacked 27 MB at every start, 5-30 s).
function pyinstallerArgs() {
  return ['-m', 'PyInstaller', '--onedir', '--noconfirm', '--name', 'conceptscan', '--distpath', path.join('build', 'out'), '--workpath', path.join('build', 'work'), '--specpath', path.join('build', 'work'),
          'conceptscan.py', '--paths', '.', '--collect-data', 'botocore', '--hidden-import', 'boto3', '--hidden-import', '_build_info'];
}
async function pyinstaller() {
  const py = await ensureVenv();
  if (!py) { fail('[prepare-llm] no build environment for conceptscan_llm (Python 3.9+ and the network are needed once): run conceptscan_llm/build.cmd'); return; }
  progress(32, 'Preparing the build');
  const stamp = spawnSync(py, ['conceptscan_version.py', '--write'], { cwd: dir, encoding: 'utf8' });      // _build_info.py: the sources hash and the time, bundled into the exe
  if (stamp.status !== 0) { fail('[prepare-llm] could not write _build_info.py: ' + (stamp.stderr || stamp.error)); return; }
  const args = pyinstallerArgs();
  console.log('[prepare-llm] building conceptscan_llm:', py, args.join(' '));
  let hooks = 0;
  const code = await runLines(py, args, dir, (l) => {
    if (/Analyzing .*conceptscan\.py/.test(l)) progress(35, 'Analysing the program');
    else if (/Processing (standard module|pre-safe-import-module) hook/.test(l)) { hooks++; progress(Math.min(70, 36 + hooks * 0.7), 'Analysing the libraries'); }
    else if (/Looking for dynamic libraries/.test(l)) progress(74, 'Collecting the libraries');
    else if (/Building PYZ/.test(l)) progress(82, 'Packing the program');
    else if (/Building EXE/.test(l)) progress(88, 'Building conceptscan.exe');
    else if (/Building COLLECT/.test(l)) progress(92, 'Assembling the program folder');
  });
  if (code !== 0) { fail('[prepare-llm] PyInstaller failed (see above; python: ' + py + ').' + (soft && fs.existsSync(exe) ? ' Starting with the existing (older) conceptscan.exe.' : '')); return; }
  // the finished folder replaces the content of dist/ (the exe, _internal and the version stamp of the old build)
  progress(95, 'Copying the program into place');
  const out = path.join(dir, 'build', 'out', 'conceptscan'), dist = path.join(dir, 'dist');
  try {
    fs.mkdirSync(dist, { recursive: true });
    for (const n of [exeName, '_internal', 'conceptscan.stamp.json']) fs.rmSync(path.join(dist, n), { recursive: true, force: true });
    fs.cpSync(out, dist, { recursive: true });
  } catch (e) { fail('[prepare-llm] could not copy the new build into ' + dist + ' (is conceptscan.exe running?): ' + e.message); }
}

(async () => {
const why = process.argv.includes('--rebuild') ? '--rebuild' : staleOf(exe);
if (why) {
  console.log('[prepare-llm] rebuilding (' + why + ')');
  progress(1, 'Building the LLM program');
  await pyinstaller();
  progress(97, 'Checking the new program (its first start can take a while)');
} else console.log('[prepare-llm] conceptscan.exe is up to date');

const got = fs.existsSync(exe) ? exeSources() : '';
if (got !== want) fail('[prepare-llm] conceptscan.exe is built from sources ' + (got || '(unknown)') + ' but the sources on disk are ' + want + ' - it is out of date');
console.log('[prepare-llm] ok: ' + exe + ' - ' + exeVersionText());
if (why) progress(100, 'The LLM program is ready');
})();
