'use strict';
// npm run start:built: builds the screens (vite build) and, AT THE SAME TIME, makes sure conceptscan.exe is up to date (scripts/prepare-llm.js --soft);
// when both are finished the app starts. The time is that of the slower one, not the sum of the two.
// A failed vite build stops the start; a problem with conceptscan.exe only prints a warning (and goes to prepare-llm.log).
// When the LLM program has to be built (the first start on a computer, or after its sources changed: minutes) a small window shows the stage and a progress bar
// (scripts/setup-progress.ps1, Windows only; the stages are the "[progress] <percent> <text>" lines of prepare-llm.js). --no-gui: no window. --rebuild: build the LLM program again.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const STATUS = path.join(os.tmpdir(), 'nlpmanager-setup-progress.json');
let gui = null;
const writeStatus = (o) => { try { fs.writeFileSync(STATUS, JSON.stringify({ ...o, t: Date.now() })); } catch { /* the window just shows nothing new */ } };
const status = { pct: 0, text: 'Starting', done: false, error: '' };
function showWindow() {
  if (gui || process.platform !== 'win32' || process.argv.includes('--no-gui')) return;
  writeStatus(status);
  try { gui = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-STA', '-File', path.join(__dirname, 'setup-progress.ps1'), '-StatusFile', STATUS], { stdio: 'ignore' }); gui.on('error', () => { gui = null; }); }
  catch { gui = null; }
}
// the same progress in the command line that started the app: a text bar (redrawn in place in a terminal, a line per stage otherwise)
const t0 = Date.now();
let shown = 0, lastText = '', ticker = null;
function drawBar(final) {
  if (shown < status.pct) shown = Math.min(status.pct, shown + 1);
  if (final) shown = status.error ? shown : 100;
  const w = 30, n = Math.round(w * shown / 100), el = Math.round((Date.now() - t0) / 1000);
  const line = '[' + '#'.repeat(n) + '-'.repeat(w - n) + '] ' + String(Math.round(shown)).padStart(3) + '%  ' + status.text + '  (' + Math.floor(el / 60) + ':' + String(el % 60).padStart(2, '0') + ')';
  if (process.stdout.isTTY) process.stdout.write(String.fromCharCode(13) + line.padEnd(process.stdout.columns ? Math.min(process.stdout.columns - 1, 110) : 100) + (final ? String.fromCharCode(10) : ''));
  else if (final || status.text !== lastText) { console.log(line); lastText = status.text; }
}
function startBar() {
  if (ticker) return;
  console.log('Building the LLM program (conceptscan.exe): this takes a minute or more, it is needed once per update of its sources.');
  drawBar(false);
  ticker = setInterval(() => drawBar(false), 500);
}
function stopBar() { if (!ticker) return; clearInterval(ticker); ticker = null; drawBar(true); if (status.error) console.error('LLM program: ' + status.error); }
function onProgressLine(line) {
  let m = /^\[progress\] (\d+) (.*)$/.exec(line);
  if (m) { status.pct = Math.max(status.pct, +m[1]); status.text = m[2]; startBar(); showWindow(); writeStatus(status); return; }
  m = /^\[progress-error\] (.*)$/.exec(line);
  if (m) { status.error = m[1]; startBar(); showWindow(); writeStatus(status); }
}

const run = (cmd, args, tag, onLine) => new Promise(resolve => {
  const t0 = Date.now();
  const p = spawn(cmd, args, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', buf = '';
  const feed = (d) => {
    out += d;
    if (!onLine) return;
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
  };
  p.stdout.on('data', feed);
  p.stderr.on('data', feed);
  p.on('close', code => { if (onLine && buf) onLine(buf); resolve({ tag, code, out, secs: ((Date.now() - t0) / 1000).toFixed(1) }); });
});

(async () => {
  const llmArgs = ['scripts/prepare-llm.js', '--soft', ...(process.argv.includes('--rebuild') ? ['--rebuild'] : [])];
  const [llm, vite] = await Promise.all([
    run('node', llmArgs, 'conceptscan.exe', onProgressLine),
    run('npx', ['vite', 'build'], 'screens'),
  ]);
  stopBar();
  if (gui) { status.done = !status.error; writeStatus(status); }                 // an error stays on the screen until the user closes the window
  for (const r of [llm, vite]) console.log(`--- ${r.tag}: ${r.secs} s (exit ${r.code})\n${r.out.trim().split(/\r?\n/).filter(l => !l.startsWith('[progress')).slice(r.code ? -60 : -12).join('\n')}`);   // a failed build shows more, the error is above the stack
  if (vite.code !== 0) { console.error('vite build failed: the app is not started'); process.exit(vite.code || 1); }
  if (process.argv.includes('--no-start')) return;                  // only the two builds (a check)
  const app = spawn('npx', ['electron', '--js-flags=--max-old-space-size=8192', '.'], { cwd: root, shell: true, stdio: 'inherit' });
  app.on('close', code => process.exit(code || 0));
})();
