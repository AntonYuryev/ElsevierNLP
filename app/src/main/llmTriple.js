'use strict';
// "Triplefication" by an LLM instead of conceptscan: the helpers behind Settings -> Local LLM settings and the NLP Runner.
// The LLM is called by conceptscan_llm (conceptscan.exe of C:\NLPmanager\conceptscan_llm\dist): it reads the same records as conceptscan and writes the same
// pseudo-sentences. Everything it needs is passed in the environment (CSLLM_*), so no key is ever written into a file or onto a command line.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const LOCAL_DEFAULTS = { port: 11434, maxWorkers: 4, timeout: 300, numCtx: 4096, cache: true, cacheMaxMb: 1024 };

// the settings of the "Local LLM settings" card, with defaults
function localSettings(store) {
  const n = (k, d) => { const v = parseInt(store.get(k)); return Number.isFinite(v) && v > 0 ? v : d; };
  return {
    port:       n('llmLocalPort', LOCAL_DEFAULTS.port),
    maxWorkers: n('llmLocalMaxWorkers', LOCAL_DEFAULTS.maxWorkers),
    timeout:    n('llmLocalTimeout', LOCAL_DEFAULTS.timeout),
    numCtx:     n('llmLocalNumCtx', LOCAL_DEFAULTS.numCtx),
    cache:      store.get('llmLocalCache') !== false,
    cacheMaxMb: (() => { const v = parseInt(store.get('llmLocalCacheMaxMb')); return Number.isFinite(v) && v >= 0 ? v : LOCAL_DEFAULTS.cacheMaxMb; })(),     // 0 = no limit
  };
}

// GET http://127.0.0.1:<port>/api/tags (Ollama) -> { ok, models:[names], error }; never throws
function probeLocalLlm(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/api/tags', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return finish({ ok: false, models: [], error: `HTTP ${res.statusCode}` });
        try {
          const models = (JSON.parse(body).models || []).map(m => m.name || m.model).filter(Boolean).sort();
          finish({ ok: true, models });
        } catch (e) { finish({ ok: false, models: [], error: 'not an Ollama answer: ' + e.message }); }
      });
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false, models: [], error: 'no answer within ' + Math.round(timeoutMs / 1000) + ' s' }); });
    req.on('error', e => finish({ ok: false, models: [], error: e.code === 'ECONNREFUSED' ? 'port ' + port + ' is closed' : e.message }));
  });
}

// where conceptscan_llm lives: Settings value, else next to the app (resources / ../conceptscan_llm/dist), else C:\NLPmanager
function findExe(store, appRoot) {
  const name = process.platform === 'win32' ? 'conceptscan.exe' : 'conceptscan';
  const cands = [store.get('conceptscanLlmExe')];
  for (const base of [process.resourcesPath, appRoot, path.join(appRoot || '', '..')]) {
    if (!base) continue;
    cands.push(path.join(base, 'conceptscan_llm', 'dist', name), path.join(base, 'conceptscan_llm', name));       // dist/: the folder build (conceptscan.exe + _internal)
  }
  return cands.find(p => p && fs.existsSync(p) && fs.statSync(p).isFile()) || '';
}

// the environment of one run. triple = { kind:'local'|'provider', model }. -> env object (merged with process.env) or throws
function buildEnv(store, triple, cartridgePath, promptFile) {
  const L = localSettings(store);
  const env = { ...process.env, CSLLM_WORKERS: String(L.maxWorkers), CSLLM_TIMEOUT: String(L.timeout),
                CSLLM_CACHE: L.cache ? '1' : '0', CSLLM_CACHE_MAX_MB: String(L.cacheMaxMb), CSLLM_CARTRIDGE: cartridgePath || '', CSLLM_PROMPT_FILE: promptFile || '' };
  try { env.CSLLM_CACHE_FILE = path.join(require('electron').app.getPath('userData'), 'conceptscan_llm_cache.sqlite'); } catch { /* not inside Electron (tests): next to the exe */ }
  if (triple.kind === 'local') {
    if (!triple.model) throw new Error('Triplefication is set to Local LLM, but no model is chosen: Settings -> Local LLM -> "Model for the functions set to Local LLM".');
    Object.assign(env, { CSLLM_BACKEND: 'ollama', CSLLM_URL: `http://127.0.0.1:${L.port}`, CSLLM_MODEL: triple.model, CSLLM_NUMCTX: String(L.numCtx) });
  } else if (triple.kind === 'provider') {
    const url = String(store.get('llmProviderUrl') || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    if (!url) throw new Error('Triplefication by the LLM provider: Settings -> LLM Connector has no API Base URL.');
    const model = String(triple.model || store.get('llmModel') || '').trim();
    if (!model) throw new Error('Triplefication by the LLM provider: Settings -> LLM Connector has no model.');
    Object.assign(env, {
      CSLLM_BACKEND: 'openai', CSLLM_URL: url, CSLLM_MODEL: model, CSLLM_APIKEY: String(store.get('llmApiKey') || ''),
      CSLLM_AUTHHEADER: String(store.get('llmAuthHeader') || ''), CSLLM_EXTRAHEADERS: String(store.get('llmExtraHeaders') || ''),
      CSLLM_TEMPERATURE: String(store.get('llmTemperature') ?? 0), CSLLM_TOPP: String(store.get('llmTopP') ?? 0.9),
    });
  } else throw new Error('unknown triplefication: ' + triple.kind);
  // the pronoun question edited by the user (Prompt dialog -> Pronoun prompt): a file of the temp folder, read by the exe
  const rp = String(store.get('llmReferentPrompt') || '').trim();
  if (rp) {
    try { const dir = path.join(require('os').tmpdir(), 'nlpmanager-llm'); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'pronoun.prompt.txt'); fs.writeFileSync(f, rp, 'utf8'); env.CSLLM_REFERENT_PROMPT_FILE = f; } catch { /* the built-in question is used */ }
  }
  // the exe must not pick up a stale config of a previous experiment for these
  for (const k of Object.keys(env)) if (k.startsWith('CSLLM_') && env[k] === '') delete env[k];
  return env;
}

// The template of the pairs mode, the same text as DEFAULT_PAIR_PROMPT of conceptscan_llm (a test compares them): it is a constant, so showing it needs no process.
// The prompt of a sentence is this template (no list of target entities is added).
const DEFAULT_PAIR_PROMPT = [
  "Focusing on ${1:list of tagged entities}",
  "Fill in the steps in order:",
  "1. \"noun_phrases\": every noun phrase of the sentence that contains one focus entity. Split appositives, coordinations and complex compound phrases so each noun phrase holds exactly one focus entity.",
  "2. \"triples\": for every pair of those noun phrases with a direct link in the sentence, the predicate (exact linking verb, adjective, relational noun or relational noun or passive verb phrase together with its agentive preposition, using only sentence words). NP1 comes before NP2 in the sentence. Include prepositional phrases if exist.",
  "Answer with JSON only: {\"triples\": [{\"NP1\": \"...\", \"Predicate\": \"...\", \"NP2\": \"...\"}]}",
].join(String.fromCharCode(10));

// the template of the cartridge's requests: the default one (the user's edited template is kept in the settings, per cartridge)
// The JSON answer line: the last line of the default template (PAIR_ANSWER_LINE of conceptscan.py - a test compares them). It can be edited; a template without such a line gets this one added.
const PAIR_ANSWER_LINE = 'Answer with a JSON array only: `[{"NP1": "...", "Predicate": "...", "NP2": "..."}]`';
const answerLine = () => PAIR_ANSWER_LINE;

// the default template: the instructions and, as its LAST line, the JSON answer line - all of it can be edited (one structure for every cartridge)
// The text of the program itself is the source (conceptscan.exe --show-pair-prompt): the template edited in conceptscan.py shows here after the exe was rebuilt.
// The constant above is the fallback when there is no exe or it does not answer. The answer is kept per exe file (its size and time).
const promptCache = new Map();
// the text a program option prints (--show-pair-prompt, --show-referent-prompt); fallback when there is no exe or it does not answer
function showFromExe(flag, exe, fallback) {
  if (!exe) return Promise.resolve(fallback);
  let key = flag + '|' + exe;
  try { const st = fs.statSync(exe); key += '|' + st.size + '|' + st.mtimeMs; } catch { return Promise.resolve(fallback); }
  if (promptCache.has(key)) return Promise.resolve(promptCache.get(key));
  return new Promise((resolve) => {
    let out = '', done = false;
    const finish = (t) => { if (done) return; done = true; if (t) promptCache.set(key, t); resolve(t || fallback); };
    let p;
    try { p = spawn(exe, [flag], { windowsHide: true }); } catch { finish(''); return; }
    const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } finish(''); }, 20000);
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.on('error', () => { clearTimeout(timer); finish(''); });
    p.on('close', code => { clearTimeout(timer); finish(code === 0 ? out.split(String.fromCharCode(13)).join('').trim() : ''); });
  });
}
function defaultPrompt(_cartridge, exe) { return showFromExe('--show-pair-prompt', exe, DEFAULT_PAIR_PROMPT); }

// The second request, only for a noun phrase that starts with a pronoun ("its deletion in beta-cells"): which entity does the pronoun refer to? Same text as DEFAULT_REFERENT_PROMPT of conceptscan_llm.
const DEFAULT_REFERENT_PROMPT = [
  'Sentence: ${sentence}',
  'Triple: NP1 "${np1}" - Predicate "${predicate}" - NP2 "${np2}"',
  'Entities of the sentence before "${pronoun}": ${candidates}',
  'What entity does "${pronoun}" refer to in this triple? Answer with one of the listed entities, copied exactly, or "none".',
].join(String.fromCharCode(10));
function defaultReferentPrompt(exe) { return showFromExe('--show-referent-prompt', exe, DEFAULT_REFERENT_PROMPT); }

// ── SSH tunnel to a remote Ollama server (PuTTY's plink with a .ppk key) ─────────────────────────────────────────────────────
// plink -batch -N -i <key.ppk> -P <ssh port> -L 127.0.0.1:<local>:127.0.0.1:<remote> user@host   (no shell: every value is one argument; the key file is only read by plink)
let tunnel = null;                                   // { proc, server, state:'starting'|'up'|'failed'|'closed', error, log }
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:@\-]*$/;     // host names, IPs and user names; a leading "-" would be taken for an option

function findPlink(store) {
  const cands = [store.get('plinkExe')];
  for (const d of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs')]) if (d) cands.push(path.join(d, 'PuTTY', 'plink.exe'));
  for (const d of String(process.env.PATH || '').split(path.delimiter)) if (d) cands.push(path.join(d, process.platform === 'win32' ? 'plink.exe' : 'plink'));
  return cands.find(p => p && fs.existsSync(p) && fs.statSync(p).isFile()) || '';
}

// Windows' own OpenSSH client (System32\OpenSSH\ssh.exe) or ssh on PATH: used for OpenSSH keys (.pem / id_rsa ...); PuTTY's plink for .ppk keys
function findSsh(store) {
  const cands = [store.get('sshExe')];
  if (process.env.SystemRoot) cands.push(path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe'));
  for (const d of String(process.env.PATH || '').split(path.delimiter)) if (d) cands.push(path.join(d, process.platform === 'win32' ? 'ssh.exe' : 'ssh'));
  return cands.find(p => p && fs.existsSync(p) && fs.statSync(p).isFile()) || '';
}

function tunnelState() {
  return tunnel ? { state: tunnel.state, client: tunnel.client || '', error: tunnel.error || '', server: tunnel.server && tunnel.server.name || '', host: tunnel.server && tunnel.server.host || '' } : { state: 'closed', error: '', server: '', host: '' };
}

function validateServer(sv) {
  const host = String(sv.host || '').trim(), user = String(sv.user || '').trim(), key = String(sv.key || '').trim();
  if (!host) return 'Enter the IP address or host name of the server.';
  if (!SAFE.test(host)) return 'The host name / IP address has characters that are not allowed.';
  if (!user) return 'Enter the user name.';
  if (!SAFE.test(user)) return 'The user name has characters that are not allowed.';
  if (!key) return 'Choose the private key (.ppk) file.';
  if (!fs.existsSync(key)) return 'The key file does not exist: ' + key;
  const n = (v) => parseInt(v);
  for (const [v, what] of [[sv.sshPort || 22, 'SSH port'], [sv.remotePort || 11434, 'remote Ollama port']]) if (!(n(v) > 0 && n(v) < 65536)) return `The ${what} is not a valid port.`;
  return '';
}

// starts the tunnel; resolves when the local port is open or plink has failed: { ok, error }
function startTunnel(store, server, localPort, onChange, spawnFn = spawn) {
  return new Promise((resolve) => {
    stopTunnel();
    const bad = validateServer(server);
    if (bad) return resolve({ ok: false, error: bad });
    const key = String(server.key).trim(), target = `${String(server.user).trim()}@${String(server.host).trim()}`;
    const fwd = `127.0.0.1:${localPort}:127.0.0.1:${parseInt(server.remotePort) || 11434}`, port = String(parseInt(server.sshPort) || 22);
    let exe, args, client;
    if (/\.ppk$/i.test(key)) {                                         // PuTTY key: plink
      client = 'plink'; exe = findPlink(store);
      if (!exe) return resolve({ ok: false, error: 'A .ppk key needs plink.exe (PuTTY), which was not found. Install PuTTY or set the path of plink.exe below - or use an OpenSSH key (.pem), which Windows ssh.exe takes.' });
      args = ['-batch', '-N', '-i', key, '-P', port, '-L', fwd, target];
    } else {                                                           // OpenSSH key: ssh.exe, no PuTTY needed
      client = 'ssh'; exe = findSsh(store);
      if (!exe) return resolve({ ok: false, error: 'ssh.exe (Windows OpenSSH client) not found. Add it under Settings -> Apps -> Optional features -> OpenSSH Client.' });
      args = ['-N', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'IdentitiesOnly=yes',
              '-i', key, '-p', port, '-L', fwd, target];
    }
    let proc;
    try { proc = spawnFn(exe, args, { windowsHide: true }); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const t = { proc, server, client, state: 'starting', error: '', log: '' };
    tunnel = t;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } onChange && onChange(tunnelState()); };
    const fail = (msg) => {
      t.state = 'failed';
      t.error = msg.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ') || 'plink stopped';
      if (client === 'plink' && /host key/i.test(t.log) && /not cached|does not match|cache/i.test(t.log)) t.error += '  - connect once with PuTTY to this server to accept its host key, then try again.';
      const badPerm = /UNPROTECTED PRIVATE KEY|bad permissions/i.test(t.log);
      if (badPerm) t.error += '  - Windows says other users can read the key file. Run in Command Prompt (cmd):  icacls "' + key + '" /inheritance:r /grant:r "%USERNAME%:R"';
      if (/Load key.*(invalid format|error in libcrypto)|invalid format/i.test(t.log)) t.error += '  - ssh.exe could not read this key: it must be in OpenSSH format (a .ppk goes through plink).';
      if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(t.log)) t.error += '  - the host key of the server changed: check with the server administrator before removing the old entry from known_hosts.';
      if (client === 'plink' && /passphrase|unable to use key|wrong passphrase/i.test(t.log)) t.error += '  - the key needs a passphrase: load it in Pageant or use a key without one.';
      if (client === 'ssh' && !badPerm && /Permission denied \(publickey/i.test(t.log)) t.error += '  - the server did not accept this key (wrong user name or key, or the key has a passphrase).';
      finish({ ok: false, error: t.error });
    };
    const take = (d) => { t.log += d.toString(); if (t.log.length > 4000) t.log = t.log.slice(-4000); };
    proc.stdout.on('data', take); proc.stderr.on('data', take);
    proc.on('error', e => fail(e.message));
    proc.on('close', () => { if (t.state === 'up') { t.state = 'closed'; onChange && onChange(tunnelState()); } else if (t.state === 'starting') fail(t.log); });
    // up = the local port accepts a connection (plink forwards only after the login worked)
    const started = Date.now();
    const poll = () => {
      if (settled || tunnel !== t) return;
      const sock = require('net').connect({ host: '127.0.0.1', port: localPort }, () => { sock.destroy(); if (!settled) { t.state = 'up'; finish({ ok: true, error: '' }); } });
      sock.on('error', () => { sock.destroy(); if (Date.now() - started > 20000) { try { proc.kill(); } catch {} fail(t.log || 'the tunnel did not come up within 20 s'); } else setTimeout(poll, 400); });
    };
    setTimeout(poll, 600);
  });
}

function stopTunnel() {
  if (!tunnel) return;
  const t = tunnel; tunnel = null;
  try { t.proc.kill(); } catch {}
}

module.exports = { DEFAULT_REFERENT_PROMPT, defaultReferentPrompt, DEFAULT_PAIR_PROMPT, PAIR_ANSWER_LINE, answerLine, findPlink, findSsh, tunnelState, validateServer, startTunnel, stopTunnel, LOCAL_DEFAULTS, localSettings, probeLocalLlm, findExe, buildEnv, defaultPrompt };
