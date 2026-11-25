import ClearLlmCache from '../components/ClearLlmCache';
import React, { useState, useEffect } from 'react';
import { parseExtraHeaders } from '../../shared/llm';
import { LLM_FUNCTIONS, llmTargetOf } from '../../shared/llmFunctions';

// ── LLM provider catalogue ────────────────────────────────────────────────────
const LLM_PROVIDERS = [
  { name: 'Google Gemini',              url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { name: 'OpenAI GPT',                 url: 'https://api.openai.com/v1' },
  { name: 'Anthropic Claude',           url: 'https://api.anthropic.com' },
  { name: 'MetaAI Llama (Replicate)',   url: 'https://api.replicate.com/v1' },
  { name: 'MetaAI Llama (Together AI)', url: 'https://api.together.xyz/v1' },
  { name: 'Groq LLaMA',                url: 'https://api.groq.com/openai/v1' },
  { name: 'Custom…',                    url: '' },
];

// Fetch the model list from the provider's API.
// OpenAI-compatible providers expose GET /models.
// Anthropic uses a different base path + auth header.
// Returns { models: string[], noModelList: boolean }
async function fetchLlmModels(providerUrl, apiKey, authHeader = '', extraHeaders = '', model = '') {
  const isAnthropic = providerUrl.includes('anthropic.com');
  const isReplicate = providerUrl.includes('replicate.com');

  // Anthropic models endpoint
  if (isAnthropic) {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return { models: (data.data || []).map(m => m.id).sort(), noModelList: false };
  }

  // Replicate lists models differently — just return a curated Llama list
  if (isReplicate) {
    return {
      noModelList: false,
      models: [
        'meta/llama-3.1-405b-instruct',
        'meta/llama-3.1-70b-instruct',
        'meta/llama-3.1-8b-instruct',
        'meta/llama-3-70b-instruct',
        'meta/llama-3-8b-instruct',
      ],
    };
  }

  // OpenAI-compatible: try GET /models first, fall back to a minimal chat completion
  // probe if the gateway doesn't support it (e.g. Portkey returns 400/404/405).
  // Both calls go via main-process IPC to avoid CORS.
  const authHeaders = {
    ...parseExtraHeaders(extraHeaders),
    ...(authHeader ? { [authHeader]: apiKey } : { Authorization: `Bearer ${apiKey}` }),
  };
  const base = providerUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');     // the full endpoint may be given: do not append the path twice

  // 1. Try GET /models
  try {
    const data = await window.api.llm.fetch({ url: `${base}/models`, headers: authHeaders, method: 'GET' });
    const models = (data.data || data.models || []).map(m => m.id || m.name || m).filter(Boolean);
    return { models: models.sort(), noModelList: models.length === 0 };
  } catch (e) {
    // HTTP status may be buried inside "Error invoking remote method 'llm:fetch': Error: HTTP 400:…"
    const status = parseInt(e.message?.match(/HTTP (\d+)/)?.[1] || '0');
    if (status === 401 || status === 403) throw new Error(`Auth failed (${status}): ${e.message}`);
    if (status === 0) throw new Error(`Connection failed: ${e.message}`);
    // 400/404/405/5xx → gateway reachable but /models not supported; probe with a minimal chat call.
  }

  // 2. Probe with a minimal chat completion — gateway reachable if we get any HTTP response.
  try {
    await window.api.llm.fetch({
      url: `${base}/chat/completions`,
      headers: authHeaders,
      body: {
        model: model || 'test',
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: 1,
      },
    });
  } catch (e) {
    const status = parseInt(e.message?.match(/HTTP (\d+)/)?.[1] || '0');
    if (status === 401 || status === 403) throw new Error(`Auth failed (${status}): ${e.message}`);
    if (status === 0) throw new Error(`Connection failed: ${e.message}`);
    // the gateway says a header is missing (e.g. Portkey: "x-portkey-provider header is required") → real calls would fail the same way
    if (status === 400 && /header/i.test(e.message) && /required|missing/i.test(e.message)) throw new Error(`The gateway rejected the request — it needs to know the provider: put it in the Model name (@provider-slug/model-name) or add a header under "Extra headers". ${e.message}`);
    // Any other HTTP status (400, 404, 422…) means the gateway is up and auth passed → success.
  }
  return { models: [], noModelList: true };
}

const browse = async (setter, key, isDir) => {
  const val = isDir ? await window.api.dialog.openDir() : await window.api.dialog.openFile();
  if (val) setter(s => ({ ...s, [key]: val }));
};

// Which LLM answers each function of the app (shared/llmFunctions.js): the provider of "LLM Connector" or the local Ollama server of "Local LLM". Shown in both cards; one setting.
const TRIPLE_SYNC = 'nlp-triple-sync';                     // the Triplefication panels of the NLP Runner / Reader listen to this event
const tripleValue = (t) => !t ? 'conceptscan' : t.kind === 'provider' ? 'provider' : t.kind === 'local' ? 'local' : 'conceptscan';      // 'local' = the one local model of "Model for the functions set to Local LLM"
const tripleSpec = (v) => v === 'provider' ? { kind: 'provider' } : v === 'local' ? { kind: 'local' } : { kind: 'conceptscan' };

function LlmFunctionRoutes({ settings, set, localModels }) {
  const provider = settings.llmProviderName || 'LLM provider';
  const tripleNow = tripleValue(settings.triplefication);
  const [tripleMsg, setTripleMsg] = useState('');
  const chooseTriple = async (v) => {
    set('triplefication', tripleSpec(v)); setTripleMsg('');
    await window.api.settings.set({ triplefication: tripleSpec(v) });
    const back = await window.api.settings.get();                         // what the main process really holds: runs use that
    if (tripleValue(back && back.triplefication) !== v) { setTripleMsg("Not saved: the app's main process did not keep the choice - restart NLPmanager and choose again."); return; }
    window.dispatchEvent(new CustomEvent(TRIPLE_SYNC, { detail: { triple: v } }));
  };
  const model = settings.llmLocalModel || '';
  const setAll = (v) => set('llmFunctionTargets', Object.fromEntries(LLM_FUNCTIONS.map(f => [f.id, v])));
  const setOne = (id, v) => set('llmFunctionTargets', { ...Object.fromEntries(LLM_FUNCTIONS.map(f => [f.id, llmTargetOf(settings, f.id)])), [id]: v });
  const groups = [...new Set(LLM_FUNCTIONS.map(f => f.group))];
  const nLocal = LLM_FUNCTIONS.filter(f => llmTargetOf(settings, f.id) === 'local').length;
  return (
    <div>
      <div className="text-xs text-muted" style={{ marginBottom: 8 }}>
        Choose for every function that asks an LLM whether <b>{provider}</b> (LLM Connector) or the <b>local LLM</b> (Local LLM{model ? <>, model <code>{model}</code></> : ', no model chosen yet'}) answers it.
        The same list is in both cards. Save Settings to apply. Requests to the local LLM are not counted against "Max LLM requests per day".
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAll('api')}>All → {provider}</button>
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => setAll('local')}>All → Local LLM</button>
        <span className="text-xs text-muted">{nLocal} of {LLM_FUNCTIONS.length} use the local LLM</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <tbody>
          <tr><td colSpan={2} style={{ paddingTop: 8, fontWeight: 600, color: 'var(--text-dim)' }}>Pipeline, NLP Runner, Reader</td></tr>
          <tr style={{ borderTop: '1px solid var(--border)' }}>
            <td style={{ padding: '5px 8px 5px 0', verticalAlign: 'top' }}>
              Triplefication (who writes the semantic triples)
              <div className="text-xs text-muted">conceptscan = the cartridge's own program. An LLM: conceptscan_llm sends one request for every pair of entities the cartridge can extract. Applied immediately; one choice for the Pipeline, the NLP Runner and the Reader. The template is edited in the NLP Runner (or viewed on the ConceptScan (LLM) step of a Pipeline run).</div>
            </td>
            <td style={{ padding: '5px 0', width: 260, verticalAlign: 'top' }}>
              <select className="form-control" value={tripleNow} onChange={e => chooseTriple(e.target.value)}>
                <option value="conceptscan">conceptscan</option>
                {settings.llmProviderUrl && <option value="provider">{provider}{settings.llmModel ? ` (${settings.llmModel})` : ''}</option>}
                <option value="local" disabled={!settings.llmLocalModel && tripleNow !== 'local'}>{settings.llmLocalModel ? `Local LLM (${settings.llmLocalModel})` : 'Local LLM (choose the model above first)'}</option>
              </select>
              {tripleMsg && <div className="text-xs" style={{ color: 'var(--danger, #c33)', marginTop: 3 }}>{tripleMsg}</div>}
            </td>
          </tr>
          {groups.map(g => (
            <React.Fragment key={g}>
              <tr><td colSpan={2} style={{ paddingTop: 8, fontWeight: 600, color: 'var(--text-dim)' }}>{g}</td></tr>
              {LLM_FUNCTIONS.filter(f => f.group === g).map(f => (
                <tr key={f.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '5px 8px 5px 0', verticalAlign: 'top' }}>
                    {f.name}
                    <div className="text-xs text-muted">{f.text}{f.grounding ? ' With Gemini this call uses Google Search grounding; the local LLM has none.' : ''}</div>
                  </td>
                  <td style={{ padding: '5px 0', width: 260, verticalAlign: 'top' }}>
                    <select className="form-control" value={llmTargetOf(settings, f.id)} onChange={e => setOne(f.id, e.target.value)}>
                      <option value="api">{provider} (LLM Connector)</option>
                      <option value="local">Local LLM{model ? ` (${model})` : ''}</option>
                    </select>
                  </td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SettingsScreen({ onAliasSearch, onEditRecord }) {
  const [tab, setTab] = useState(() => { try { return localStorage.getItem('settings.tab') || 'online'; } catch { return 'online'; } });
  const pickTab = (t) => { setTab(t); try { localStorage.setItem('settings.tab', t); } catch {} };
  const [deployStatus, setDeployStatus] = useState(null); // null | 'running' | { patched, skipped, errors }

  const handleDeployHtmlConverter = async () => {
    setDeployStatus('running');
    const r = await window.api.medscan.deployHtmlConverter();
    setDeployStatus(r);
  };

  const [settings, setSettings] = useState({
    medscanLicense: '',
    medscanDir: '',
    userDict: '',
    bwFilter: '',
    elsevierApiKey: '',
    centreeUrl: 'https://psgcentree.lifesciencepsg.com',
    centreeUser: '',
    centreePassword: '',
    centreeToken: '',
    centreeApiPrefix: '/api',
    ncbiApiKey: '',
    consynBearerToken: '',
    consynUserId: '',
    // LLM connector
    llmProviderName: '',
    llmProviderUrl:        '',
    llmApiKey:             '',
    llmAuthHeader:         '',
    llmExtraHeaders:       '',
    llmModel:              '',
    llmTemperature:        0.2,
    llmMaxRequestsPerDay:  1000,
    llmTopP:        0.9,
    // Local LLM settings
    llmLocalPort:       11434,
    llmLocalMaxWorkers: 4,
    llmLocalTimeout:    300,
    llmLocalNumCtx:     4096,
    llmLocalCache:      true,
    llmLocalCacheMaxMb: 1024,
    conceptscanLlmExe:  '',
    llmProfiles:        [],
    // remote LLM server (SSH tunnel)
    llmServer:          {},
    llmServers:         [],
    plinkExe:           '',
  });
  const [saved,         setSaved]         = useState(false);
  const [testingKey,    setTestingKey]    = useState(false);
  const [centreeTest,   setCentreeTest]   = useState(null);
  const [keyTestResult, setKeyTestResult] = useState(null); // { ok, message }
  const [consynLogging, setConsynLogging] = useState(false);
  const [consynResult,  setConsynResult]  = useState(null); // { ok, message }

  // LLM state
  const [llmModels,     setLlmModels]     = useState([]);
  const [llmTesting,    setLlmTesting]    = useState(false);
  const [llmTestResult, setLlmTestResult] = useState(null); // { ok, message }
  const [showLlmKey,    setShowLlmKey]    = useState(false);

  // named providers saved in the user's settings (one click to load); the connection must have been tested before a configuration can be saved
  const [customMode,   setCustomMode]   = useState(false);   // the "Custom…" entry is chosen: the user names the provider
  const [testedFor,    setTestedFor]    = useState('');      // fingerprint of the connection fields of the last successful test
  const [profileMsg,   setProfileMsg]   = useState('');
  const connKey = () => [settings.llmProviderUrl, settings.llmApiKey, settings.llmAuthHeader, settings.llmExtraHeaders].map(x => (x || '').trim()).join('\u0001');
  const profiles = settings.llmProfiles || [];
  const builtIn = (n) => LLM_PROVIDERS.some(p => p.name === n && p.url);
  const providerSelectValue = customMode ? 'Custom…' : (builtIn(settings.llmProviderName) || profiles.some(p => p.name === settings.llmProviderName)) ? settings.llmProviderName : (settings.llmProviderUrl ? 'Custom…' : '');
  const showCustomName = providerSelectValue === 'Custom…';
  const nameTaken = builtIn((settings.llmProviderName || '').trim()) || (settings.llmProviderName || '').trim() === 'Custom…';
  const canSaveProfile = showCustomName && !!(settings.llmProviderName || '').trim() && !nameTaken && testedFor !== '' && testedFor === connKey();
  const saveProfile = async () => {
    const name = settings.llmProviderName.trim();
    const entry = { name, url: settings.llmProviderUrl.trim(), apiKey: settings.llmApiKey || '', authHeader: settings.llmAuthHeader || '', extraHeaders: settings.llmExtraHeaders || '',
                    model: settings.llmModel || '', temperature: settings.llmTemperature ?? 0.2, topP: settings.llmTopP ?? 0.9 };
    const next = [...profiles.filter(p => p.name !== name), entry].sort((a, b) => a.name.localeCompare(b.name));
    set('llmProfiles', next);
    await window.api.settings.set({ llmProfiles: next, llmProviderName: entry.name, llmProviderUrl: entry.url, llmApiKey: entry.apiKey, llmAuthHeader: entry.authHeader,
                                    llmExtraHeaders: entry.extraHeaders, llmModel: entry.model, llmTemperature: entry.temperature, llmTopP: entry.topP });    // the saved provider is the current one
    window.dispatchEvent(new CustomEvent('nlp-triple-sync', { detail: { reload: true } }));
    setCustomMode(false); setProfileMsg(`Saved "${name}" - pick it in the Provider list to load it.`);
  };
  const deleteProfile = async (name) => {
    const next = profiles.filter(p => p.name !== name);
    set('llmProfiles', next);
    await window.api.settings.set({ llmProfiles: next });
    if (settings.llmProviderName === name) setSettings(s => ({ ...s, llmProviderName: '' }));
    setProfileMsg(`Deleted "${name}".`);
  };
  const selectProvider = (value) => {
    setLlmModels([]); setLlmTestResult(null); setTestedFor(''); setProfileMsg('');
    const prof = profiles.find(p => p.name === value);
    if (prof) {                                                   // a saved provider: all its fields in one click
      setCustomMode(false);
      setSettings(s => ({ ...s, llmProviderName: prof.name, llmProviderUrl: prof.url, llmApiKey: prof.apiKey, llmAuthHeader: prof.authHeader, llmExtraHeaders: prof.extraHeaders,
                          llmModel: prof.model, llmTemperature: prof.temperature, llmTopP: prof.topP }));
      if (prof.model) setLlmModels([prof.model]);
      // loading a saved provider makes it the current connector at once (the runs read the saved settings, not this page): the Triplefication lists show its name
      window.api.settings.set({ llmProviderName: prof.name, llmProviderUrl: prof.url, llmApiKey: prof.apiKey, llmAuthHeader: prof.authHeader, llmExtraHeaders: prof.extraHeaders,
                                llmModel: prof.model, llmTemperature: prof.temperature, llmTopP: prof.topP })
        .then(() => window.dispatchEvent(new CustomEvent('nlp-triple-sync', { detail: { reload: true } })));
      return;
    }
    if (value === 'Custom…') { setCustomMode(true); setSettings(s => ({ ...s, llmProviderName: builtIn(s.llmProviderName) || profiles.some(p => p.name === s.llmProviderName) ? '' : s.llmProviderName })); return; }
    setCustomMode(false);
    const bp = LLM_PROVIDERS.find(x => x.name === value);
    setSettings(s => ({ ...s, llmProviderName: value, llmProviderUrl: bp && bp.url ? bp.url : s.llmProviderUrl }));
  };

  // Local LLM (Ollama on a port, usually an SSH tunnel): what the app found at startup, and a re-probe
  const [localLlm,     setLocalLlm]     = useState({ ok: false, models: [], error: '', port: 0 });
  const [localBusy,    setLocalBusy]    = useState(false);
  const [exeFound,     setExeFound]     = useState('');
  useEffect(() => {
    window.api.llm.localState().then(st => { if (st) setLocalLlm(st); });
    window.api.llm.findExe().then(p => setExeFound(p || ''));
    return window.api.llm.onLocalUpdate(st => setLocalLlm(st));
  }, []);
  // Remote LLM server: the SSH tunnel (plink + .ppk key) that makes its Ollama port appear as the tunnel port above; configurations are saved by name in the user's settings
  const server = settings.llmServer || {};
  const servers = settings.llmServers || [];
  const setServer = (k, v) => { setSettings(s0 => ({ ...s0, llmServer: { ...(s0.llmServer || {}), [k]: v } })); setSrvMsg(''); };
  const [tunnel,    setTunnel]    = useState({ state: 'closed', error: '' });
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [srvMsg,    setSrvMsg]    = useState('');
  const [plinkFound, setPlinkFound] = useState('');
  useEffect(() => {
    window.api.llm.tunnelState().then(st => st && setTunnel(st));
    window.api.llm.findPlink().then(p0 => setPlinkFound(p0 || ''));
    return window.api.llm.onTunnelUpdate(st => setTunnel(st));
  }, []);
  const serverComplete = !!(server.host || '').trim() && !!(server.user || '').trim() && !!(server.key || '').trim();
  const serverName = (server.name || '').trim();
  const saveServer = async () => {
    const entry = { name: serverName, host: server.host.trim(), user: server.user.trim(), key: server.key.trim(), sshPort: parseInt(server.sshPort) || 22, remotePort: parseInt(server.remotePort) || 11434 };
    const next = [...servers.filter(x => x.name !== serverName), entry].sort((a, b) => a.name.localeCompare(b.name));
    setSettings(s0 => ({ ...s0, llmServers: next, llmServer: entry }));
    await window.api.settings.set({ llmServers: next, llmServer: entry });
    setSrvMsg(`Saved "${serverName}" - pick it in the list to load it.`);
  };
  const loadServer = (name) => {
    const x = servers.find(v => v.name === name);
    setSettings(s0 => ({ ...s0, llmServer: x ? { ...x } : {} })); setSrvMsg('');
  };
  const deleteServer = async () => {
    const next = servers.filter(x => x.name !== serverName);
    setSettings(s0 => ({ ...s0, llmServers: next, llmServer: {} }));
    await window.api.settings.set({ llmServers: next, llmServer: {} });
    setSrvMsg(`Deleted "${serverName}".`);
  };
  const connectTunnel = async () => {
    setTunnelBusy(true); setSrvMsg('');
    await window.api.settings.set({ llmLocalPort: settings.llmLocalPort, llmServer: server, plinkExe: settings.plinkExe });   // the tunnel uses the saved port and plink path
    const r = await window.api.llm.tunnelStart(server);
    setTunnel(r.state || { state: r.ok ? 'up' : 'failed', error: r.error });
    setTunnelBusy(false);
    if (!r.ok) setSrvMsg('');
  };
  const disconnectTunnel = async () => { setTunnelBusy(true); setTunnel(await window.api.llm.tunnelStop()); setTunnelBusy(false); };
  const probeLocal = async () => {
    setLocalBusy(true);
    await window.api.settings.set({ llmLocalPort: settings.llmLocalPort });      // the probe uses the saved port
    const st = await window.api.llm.localRefresh();
    setLocalLlm(st); setLocalBusy(false);
  };

  const handleTestLlm = async () => {
    setLlmTesting(true); setLlmTestResult(null); setLlmModels([]);
    try {
      const url        = settings.llmProviderUrl?.trim();
      const key        = settings.llmApiKey?.trim();
      const authHeader = settings.llmAuthHeader?.trim();
      if (!url) throw new Error('No provider URL configured.');
      if (!key) throw new Error('API key is required.');
      const { models, noModelList } = await fetchLlmModels(url, key, authHeader, settings.llmExtraHeaders, settings.llmModel?.trim());
      setTestedFor(connKey());
      if (noModelList) {
        // Gateway connected but doesn't expose /models — user must type model manually
        setLlmTestResult({ ok: true, message: 'Connected ✓ — this gateway doesn\'t list models. Type the model name manually.' });
      } else {
        setLlmModels(models);
        setSettings(s => ({ ...s, llmModel: models.includes(s.llmModel) ? s.llmModel : models[0] }));
        setLlmTestResult({ ok: true, message: `Connected — ${models.length} model${models.length !== 1 ? 's' : ''} available.` });
      }
    } catch (e) {
      setLlmTestResult({ ok: false, message: e.message });
    } finally {
      setLlmTesting(false);
    }
  };

  useEffect(() => {
    window.api.settings.get().then(s => {
      if (s) {
        // the saved connector has no usable name ("Custom…" / empty) but its URL, header and key are those of a saved provider: it IS that provider - show and keep its name
        const nm = (s.llmProviderName || '').trim();
        const known = LLM_PROVIDERS.some(p => p.name === nm && p.url) || (s.llmProfiles || []).some(p => p.name === nm);
        if (!known && s.llmProviderUrl) {
          const same = (s.llmProfiles || []).find(p => p.url === s.llmProviderUrl && (p.apiKey || '') === (s.llmApiKey || '') && (p.authHeader || '') === (s.llmAuthHeader || ''));
          if (same) {
            s.llmProviderName = same.name;
            window.api.settings.set({ llmProviderName: same.name }).then(() => window.dispatchEvent(new CustomEvent('nlp-triple-sync', { detail: { reload: true } })));
          }
        }
        setSettings(prev => ({ ...prev, ...s }));
        // Restore previously saved model in the dropdown list so it's selectable without re-testing
        if (s.llmModel) setLlmModels(prev => prev.includes(s.llmModel) ? prev : [s.llmModel]);
      }
    });
  }, []);

  const handleSave = async () => {
    // maxParallelCartridges is edited on the NLP Runner screen; don't overwrite it with a stale copy
    // (the Triplefication choice and the edited prompts are kept by the panel of the Runner / Pipeline screens: a stale copy here must not overwrite them)
    const { maxParallelCartridges, triplefication, llmPairPrompts, llmReferentPrompt, readerResolvePronouns, readerCorefN, ...rest } = settings;
    await window.api.settings.set(rest);
    window.dispatchEvent(new CustomEvent('nlp-triple-sync', { detail: { reload: true } }));     // the panels show the provider name / model of the connector
    setSaved(true);
  };

  const handleTestApiKey = async () => {
    setTestingKey(true);
    setKeyTestResult(null);
    const result = await window.api.literature.testApiKey({
      apikey: settings.elsevierApiKey || '',
    });
    setTestingKey(false);
    setKeyTestResult(result);
  };

  const set = (key, val) => setSettings(s => ({ ...s, [key]: val }));

  const handleConsynLogin = async () => {
    setConsynLogging(true);
    setConsynResult(null);
    const result = await window.api.consyn.login();
    setConsynLogging(false);
    if (result.ok) {
      // Token saved to store by main process; refresh settings state
      const fresh = await window.api.settings.get();
      if (fresh) setSettings(prev => ({ ...prev, consynBearerToken: fresh.consynBearerToken || '' }));
      setConsynResult({ ok: true, message: 'Logged in successfully.' });
    } else {
      setConsynResult({ ok: false, message: result.error || 'Login failed.' });
    }
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Settings</h1>
      </div>

      <div className="tabs"style={{ marginBottom: 12 }}>
        {[['online', 'Online LLM'], ['local', 'Local LLM'], ['functions', 'LLM functions'], ['ncbi', 'NCBI'], ['elsevier', 'Elsevier']].map(([k, n]) => (
          <div key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => pickTab(k)}>{n}</div>
        ))}
      </div>

      {tab === 'elsevier' && (<>

      <div className="card">
        <div className="card-header">Elsevier NLP Configuration</div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="form-group" style={{ flex: '0 1 160px', minWidth: 0 }}>
          <label>Elsevier NLP License Key (-t)</label>
          <input className="form-control" type="text" value={settings.medscanLicense}
            onChange={e => set('medscanLicense', e.target.value)} placeholder="e.g. RMGZQM" />
        </div>

        <div className="form-group" style={{ flex: '2 1 300px', minWidth: 0 }}>
          <label>Elsevier NLP Installation Directory</label>
          <div className="input-group">
            <input className="form-control" type="text" value={settings.medscanDir}
              onChange={e => set('medscanDir', e.target.value)}
              placeholder="e.g. D:\MEDSCAN\DevStandard10.bin" />
            <button className="btn btn-secondary" onClick={() => browse(setSettings, 'medscanDir', true)}>Browse</button>
          </div>
          <div className="text-xs text-muted mt-8">Contains cartridge .bin subdirectories</div>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={handleDeployHtmlConverter}
              disabled={deployStatus === 'running'}>
              {deployStatus === 'running' ? <><span className="spinner" /> Deploying…</> : '⚙ Deploy HTML Converter to Cartridges'}
            </button>
            {deployStatus && deployStatus !== 'running' && (
              <span style={{ fontSize: 12 }}>
                {deployStatus.errors.length > 0
                  ? <span style={{ color: 'var(--danger)' }}>✗ {deployStatus.errors.join('; ')}</span>
                  : <span style={{ color: 'var(--success, #a6e3a1)' }}>
                      ✓ Python packages installed, {deployStatus.patched.length} cartridge(s) patched
                      {deployStatus.skipped.length > 0 ? `, ${deployStatus.skipped.length} already up to date` : ''}
                    </span>
                }
              </span>
            )}
          </div>
        </div>

        <div className="form-group" style={{ flex: '2 1 300px', minWidth: 0 }}>
          <label>User Dictionary Directory (-W)</label>
          <div className="input-group">
            <input className="form-control" type="text" value={settings.userDict || ''}
              onChange={e => set('userDict', e.target.value)}
              placeholder="e.g. D:\MEDSCAN\user_dict" />
            <button className="btn btn-secondary" onClick={() => browse(setSettings, 'userDict', true)}>Browse</button>
          </div>
          <div className="text-xs text-muted mt-8">Optional. Passed as -W flag to locscan.</div>
        </div>
        </div>

      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">Elsevier API Credentials (ScienceDirect)</div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="form-group" style={{ flex: '0 1 420px', minWidth: 0 }}>
          <label>API Key (apikey)</label>
          <input className="form-control" type="password" value={settings.elsevierApiKey || ''}
            onChange={e => set('elsevierApiKey', e.target.value)}
            placeholder="Elsevier API key" />
        </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-secondary" onClick={handleTestApiKey}
            disabled={testingKey || !settings.elsevierApiKey} style={{ minWidth: 130 }}>
            {testingKey ? <><span className="spinner" /> Testing…</> : '🔑 Test API Key'}
          </button>
          {keyTestResult && (
            <span style={{ fontSize: 12, color: keyTestResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)',
                           display:'inline-flex', alignItems:'center', gap:4 }}>
              {keyTestResult.ok ? '✓ API key is valid' : `✗ ${keyTestResult.message || `Status ${keyTestResult.status}`}`}
              <button onClick={() => setKeyTestResult(null)} title="Dismiss"
                style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                         color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
            </span>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">SciBite CENtree</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div className="form-group" style={{ flex: '2 1 240px', minWidth: 0 }}>
          <label>Server URL</label>
          <input className="form-control" type="text" value={settings.centreeUrl || ''}
            onChange={e => set('centreeUrl', e.target.value)} placeholder="https://centree.example.com" />
        </div>
        <div className="form-group" style={{ flex: '1 1 140px', minWidth: 0 }}>
          <label>User name <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(or paste a token below)</span></label>
          <input className="form-control" type="text" value={settings.centreeUser || ''}
            onChange={e => set('centreeUser', e.target.value)} />
        </div>
        <div className="form-group" style={{ flex: '1 1 140px', minWidth: 0 }}>
          <label>Password</label>
          <input className="form-control" type="password" value={settings.centreePassword || ''}
            onChange={e => set('centreePassword', e.target.value)} />
        </div>
        <div className="form-group" style={{ flex: '1 1 140px', minWidth: 0 }}>
          <label>Bearer token</label>
          <input className="form-control" type="password" value={settings.centreeToken || ''}
            onChange={e => set('centreeToken', e.target.value)} placeholder="API token" />
        </div>
        <div className="form-group" style={{ flex: '0 1 110px', minWidth: 0 }}>
          <label>API path prefix</label>
          <input className="form-control" type="text" value={settings.centreeApiPrefix ?? '/api'}
            onChange={e => set('centreeApiPrefix', e.target.value)} />
        </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-secondary" disabled={!settings.centreeUrl}
            onClick={async () => {
              await window.api.settings.set({ centreeUrl: settings.centreeUrl, centreeToken: settings.centreeToken, centreeUser: settings.centreeUser, centreePassword: settings.centreePassword, centreeApiPrefix: settings.centreeApiPrefix });
              setCentreeTest(await window.api.centree.test());
            }}>
            Test CENtree connection
          </button>
          {centreeTest && <span style={{ fontSize: 12, color: centreeTest.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)' }}>{centreeTest.ok ? '✓ Connected' : `✗ ${centreeTest.error}`}</span>}
        </div>
      </div>
      </>)}

      {tab === 'ncbi' && (<>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">NCBI (PubMed / PubMed Central)</div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>NCBI API Key <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(optional — increases rate limit from 3 to 10 req/s)</span></label>
          <input className="form-control" type="password" value={settings.ncbiApiKey || ''}
            onChange={e => set('ncbiApiKey', e.target.value)}
            placeholder="NCBI API key (from https://www.ncbi.nlm.nih.gov/account/)" />
        </div>
      </div>
      </>)}

      {tab === 'elsevier' && (<>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">Elsevier Consyn Credentials</div>

        <div className="form-group">
          <label>User ID <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)' }}>(your Consyn username, e.g. ayuryev)</span></label>
          <input className="form-control" type="text" value={settings.consynUserId || ''}
            onChange={e => set('consynUserId', e.target.value)}
            placeholder="e.g. ayuryev" />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <button className="btn btn-primary" onClick={handleConsynLogin}
            disabled={consynLogging} style={{ minWidth: 160 }}>
            {consynLogging ? <><span className="spinner" /> Logging in…</> : '🔑 Login to Consyn'}
          </button>
          {settings.consynBearerToken
            ? <span style={{ fontSize: 12, color: 'var(--success, #2a9)' }}>✓ Session token stored</span>
            : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not logged in</span>
          }
          {consynResult && (
            <span style={{ fontSize: 12, color: consynResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)',
                           display:'inline-flex', alignItems:'center', gap:4 }}>
              {consynResult.ok ? '✓' : '✗'} {consynResult.message}
              <button onClick={() => setConsynResult(null)} title="Dismiss"
                style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                         color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
            </span>
          )}
        </div>
        <div className="text-xs text-muted" style={{ marginBottom: 12 }}>
          Opens an Elsevier sign-in window. After you log in, the session token is stored automatically
          and refreshed whenever it expires — no manual copying needed.
        </div>

        <details>
          <summary style={{ fontSize: 11, cursor: 'pointer', color: 'var(--text-muted)' }}>Manual token override</summary>
          <div className="form-group" style={{ marginTop: 8, marginBottom: 0 }}>
            <input className="form-control" type="password" value={settings.consynBearerToken || ''}
              onChange={e => set('consynBearerToken', e.target.value)}
              placeholder="Paste Bearer token from browser DevTools" />
          </div>
        </details>
      </div>
      </>)}

      {tab === 'online' && (<>

      {/* ── LLM Connector ──────────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">Online LLM</div>

        {/* Provider selector */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div className="form-group" style={{ width: 300, flexShrink: 0 }}>
          <label>Provider</label>
          <select className="form-control" value={providerSelectValue} onChange={e => selectProvider(e.target.value)}>
            <option value="">— select provider —</option>
            {LLM_PROVIDERS.filter(p => p.url).map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            {profiles.length > 0 && <optgroup label="My providers">
              {profiles.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </optgroup>}
            <option value="Custom…">Custom…</option>
          </select>
          {showCustomName && (
            <div style={{ marginTop: 8 }}>
              <label>Name of this provider</label>
              <input className="form-control" type="text" value={(builtIn(settings.llmProviderName) || settings.llmProviderName === 'Custom…' || profiles.some(p => p.name === settings.llmProviderName)) ? '' : (settings.llmProviderName || '')}
                onChange={e => { set('llmProviderName', e.target.value); setProfileMsg(''); }}
                placeholder="e.g. Company gateway (Portkey)" />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                <button className="btn btn-secondary btn-sm" disabled={!canSaveProfile} onClick={saveProfile}
                  title="Needs a name and a successful Test Connection with the current URL, key and headers">
                  💾 Save as "{(settings.llmProviderName || '').trim() || 'name'}"
                </button>
                <span className="text-xs text-muted">
                  {!(settings.llmProviderName || '').trim() || (settings.llmProviderName || '').trim() === 'Custom…' ? 'Give the provider a name, then test the connection.'
                    : nameTaken ? 'This name is already used by a built-in provider.'
                    : testedFor !== '' && testedFor === connKey() ? 'Connection tested - ready to save.'
                    : 'Test the connection first (below); saving unlocks when it succeeds.'}
                </span>
              </div>
            </div>
          )}
          {profileMsg && <div className="text-xs" style={{ marginTop: 4, color: 'var(--success, #2a9)' }}>{profileMsg}</div>}
          {profiles.some(p => p.name === providerSelectValue) && (
            <div style={{ marginTop: 6 }}>
              <button className="btn btn-secondary btn-sm" onClick={() => deleteProfile(providerSelectValue)}>🗑 Delete "{providerSelectValue}"</button>
              <span className="text-xs text-muted" style={{ marginLeft: 8 }}>Saved with its URL, key, headers, model and sampling in your settings.</span>
            </div>
          )}
        </div>

        {/* URL — shown always so user can inspect / override */}
        <div className="form-group" style={{ flex: 1, minWidth: 0 }}>
          <label>API Base URL</label>
          <input className="form-control" type="text"
            value={settings.llmProviderUrl || ''}
            onChange={e => { set('llmProviderUrl', e.target.value); setLlmModels([]); setLlmTestResult(null); }}
            placeholder="https://api.openai.com/v1" />
        </div>
        </div>

        {/* Credentials, written like the request header:  "<Auth Header>": "<API Key>" */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <div className="form-group" style={{ width: 300, flexShrink: 0 }}>
            <label>Auth Header <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)' }}>(optional)</span></label>
            <input className="form-control" type="text"
              value={settings.llmAuthHeader || ''}
              onChange={e => { set('llmAuthHeader', e.target.value); setLlmModels([]); setLlmTestResult(null); }}
              placeholder="e.g. x-portkey-api-key" />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
              The name the API key is sent under. Look for it in the provider's API / curl example, in a line like <code>"<b>x-portkey-api-key</b>": "MYkey"</code>. Blank = standard <code>Authorization: Bearer</code>.
            </div>
          </div>

          <span style={{ marginTop: 28, fontSize: 18, fontWeight: 600, color: 'var(--text-muted)' }}>:</span>

          <div className="form-group" style={{ flex: 1, minWidth: 0 }}>
            <label>API Key</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="form-control" type={showLlmKey ? 'text' : 'password'}
                value={settings.llmApiKey || ''}
                onChange={e => { set('llmApiKey', e.target.value); setLlmModels([]); setLlmTestResult(null); }}
                placeholder="Paste your API key here"
                style={{ flex: 1, fontFamily: showLlmKey ? 'monospace' : undefined }} />
              <button type="button" className="btn btn-secondary"
                style={{ padding: '0 10px', fontSize: 15, lineHeight: 1 }}
                title={showLlmKey ? 'Hide key' : 'Show key'}
                onClick={() => setShowLlmKey(v => !v)}>
                {showLlmKey ? '🙈' : '👁'}
              </button>
            </div>
          </div>
        </div>

        {/* Further request headers */}
        <div className="form-group">
          <label>Extra headers <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)' }}>(optional)</span></label>
          <textarea className="form-control" rows={2} spellCheck={false}
            value={settings.llmExtraHeaders || ''}
            onChange={e => { set('llmExtraHeaders', e.target.value); setLlmModels([]); setLlmTestResult(null); }}
            placeholder={'x-portkey-provider: <value from your API example>'}
            style={{ fontFamily: 'monospace', resize: 'vertical' }} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
            One header per line, written as <code>name: value</code> — the other headers of your API example, e.g. <code>"x-portkey-provider": "…"</code> or <code>"x-portkey-config": "…"</code>. Sent with every LLM request next to the key above.
          </div>
        </div>

        {/* Test + load models */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button className="btn btn-secondary"
            disabled={llmTesting || !settings.llmProviderUrl || !settings.llmApiKey}
            onClick={handleTestLlm} style={{ minWidth: 200 }}>
            {llmTesting
              ? <><span className="spinner" /> Connecting…</>
              : '🔌 Test Connection / Load Models'}
          </button>
          {llmTestResult && (
            <span style={{ fontSize: 12,
              color: llmTestResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)' }}>
              {llmTestResult.ok ? '✓' : '✗'} {llmTestResult.message}
            </span>
          )}
        </div>

        {/* Model picker — always a free-text input; datalist provides suggestions when models are loaded */}
        <div className="form-group">
          <label>Model</label>
          <input className="form-control" type="text" list="llm-models-list"
            value={settings.llmModel || ''}
            onChange={e => set('llmModel', e.target.value)}
            placeholder="Type or paste a model ID (or Test Connection to load suggestions)" />
          {llmModels.length > 0 && (
            <datalist id="llm-models-list">
              {llmModels.map(m => <option key={m} value={m} />)}
            </datalist>
          )}
        </div>

        {/* Temperature + Top-P */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Temperature</span>
              <strong style={{ fontFamily: 'monospace', fontSize: 12 }}>
                {Number(settings.llmTemperature ?? 0.2).toFixed(2)}
              </strong>
            </label>
            <input type="range" min="0" max="2" step="0.01"
              value={settings.llmTemperature ?? 0.2}
              onChange={e => set('llmTemperature', parseFloat(e.target.value))}
              style={{ width: '100%' }} />
            <div className="text-xs text-muted" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>0 — deterministic</span><span>2 — creative</span>
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Top-P (nucleus sampling)</span>
              <strong style={{ fontFamily: 'monospace', fontSize: 12 }}>
                {Number(settings.llmTopP ?? 0.9).toFixed(2)}
              </strong>
            </label>
            <input type="range" min="0" max="1" step="0.01"
              value={settings.llmTopP ?? 0.9}
              onChange={e => set('llmTopP', parseFloat(e.target.value))}
              style={{ width: '100%' }} />
            <div className="text-xs text-muted" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>0 — focused</span><span>1 — diverse</span>
            </div>
          </div>
        </div>

        {/* Max requests per day */}
        <div className="form-group" style={{ marginBottom: 0, marginTop: 16 }}>
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>Max LLM requests per day</span>
            <span className="text-xs text-muted">limits "Resolve by LLM" batch size</span>
          </label>
          <input type="number" min="1" max="100000" step="1"
            value={settings.llmMaxRequestsPerDay ?? 1000}
            onChange={e => set('llmMaxRequestsPerDay', Math.max(1, parseInt(e.target.value) || 1))}
            style={{ width: 120, textAlign: 'right' }} />
          <div className="text-xs text-muted" style={{ marginTop: 3 }}>
            Default: 1000. Adjust to match your model's daily quota (e.g. free-tier models may allow fewer).
          </div>
        </div>
      </div>
      </>)}

      {tab === 'local' && (<>

      {/* ── Local LLM settings ─────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">Local LLM</div>
        <div className="text-xs text-muted" style={{ marginBottom: 10 }}>
          An Ollama server on this machine or on the local network (usually reached through an SSH tunnel to 127.0.0.1). The app looks for it at startup and offers its models under Triplefication in the NLP Runner.
          Workers, timeout and cache also apply when the LLM provider above does the triplefication.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Tunnel port</label>
            <input className="form-control" type="number" min="1" max="65535" value={settings.llmLocalPort ?? 11434}
              onChange={e => set('llmLocalPort', e.target.value === '' ? '' : Math.max(1, parseInt(e.target.value) || 11434))} />
            <div className="text-xs text-muted">Default 11434</div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>max_workers</label>
            <input className="form-control" type="number" min="1" max="64" value={settings.llmLocalMaxWorkers ?? 4}
              onChange={e => set('llmLocalMaxWorkers', e.target.value === '' ? '' : Math.max(1, parseInt(e.target.value) || 4))} />
            <div className="text-xs text-muted">Sentences in parallel. Default 4</div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>timeout (seconds)</label>
            <input className="form-control" type="number" min="1" value={settings.llmLocalTimeout ?? 300}
              onChange={e => set('llmLocalTimeout', e.target.value === '' ? '' : Math.max(1, parseInt(e.target.value) || 300))} />
            <div className="text-xs text-muted">Per request. Default 300</div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Context window (tokens)</label>
            <input className="form-control" type="number" min="256" step="256" value={settings.llmLocalNumCtx ?? 4096}
              onChange={e => set('llmLocalNumCtx', e.target.value === '' ? '' : Math.max(256, parseInt(e.target.value) || 4096))} />
            <div className="text-xs text-muted">num_ctx, local models only. Default 4096</div>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>Max cache size (MB)</label>
            <input className="form-control" type="number" min="0" step="128" value={settings.llmLocalCacheMaxMb ?? 1024}
              onChange={e => set('llmLocalCacheMaxMb', e.target.value === '' ? '' : Math.max(0, parseInt(e.target.value) || 0))} />
            <div className="text-xs text-muted">Default 1024, 0 = no limit</div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label className="checkbox-item" style={{ margin: 0 }}>
            <input type="checkbox" checked={!!settings.llmLocalCache} onChange={e => set('llmLocalCache', e.target.checked)} />
            <span>Cache assertions</span>
          </label>
          <div className="text-xs text-muted">Default on: the same question (model, prompt and sentence) is not sent again; a new prompt or model asks the LLM again. Over the max size the OLDEST answers are deleted (checked when a run starts and after every 2,000 new answers); about 0.5–1 KB per sentence, so 1 GB holds roughly a million answers.</div>
          <div style={{ marginTop: 8 }}><ClearLlmCache now /></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" disabled={localBusy} onClick={probeLocal}>
            {localBusy ? <><span className="spinner" /> Checking…</> : '🔌 Check port / Load models'}
          </button>
          <span style={{ fontSize: 12, color: localLlm.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)' }}>
            {localLlm.ok ? `✓ port ${localLlm.port} is open - ${localLlm.models.length} model${localLlm.models.length !== 1 ? 's' : ''}: ${localLlm.models.join(', ') || '(none pulled)'}`
              : `✗ port ${localLlm.port || settings.llmLocalPort} not reachable${localLlm.error ? ' (' + localLlm.error + ')' : ''}`}
          </span>
        </div>
        <div className="form-group" style={{ marginTop: 14, marginBottom: 0 }}>
          <label>Model for the functions set to Local LLM</label>
          <select className="form-control" style={{ width: 'auto', minWidth: 260 }} value={settings.llmLocalModel || ''} onChange={e => { set('llmLocalModel', e.target.value); window.api.settings.set({ llmLocalModel: e.target.value }).then(() => window.dispatchEvent(new CustomEvent('nlp-triple-sync', { detail: { reload: true } }))); }}>
            <option value="">— choose a model —</option>
            {[...new Set([...(settings.llmLocalModel ? [settings.llmLocalModel] : []), ...(localLlm.models || [])])].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <div className="text-xs text-muted" style={{ marginTop: 3 }}>The models come from "Check port / Load models".</div>
        </div>
        {/* Remote LLM server */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Remote LLM server (SSH tunnel)</div>
          <div className="text-xs text-muted" style={{ marginBottom: 10 }}>
            For an Ollama server on another machine (e.g. a GPU server). Connecting forwards the Tunnel port above to the server's Ollama port, through <b>PuTTY's plink</b> for a <code>.ppk</code> key or <b>Windows' own ssh.exe</b> (nothing to install) for an OpenSSH key such as a <code>.pem</code>. The models then appear under Triplefication.
            The key stays where it is: only its path is stored. Keep it outside the NLPmanager folder (e.g. <code>D:\ssh</code>).
          </div>
          <div className="form-group">
            <label>Saved servers</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="form-control" style={{ width: 'auto', minWidth: 240 }} value={servers.some(x => x.name === serverName) ? serverName : ''}
                onChange={e => e.target.value ? loadServer(e.target.value) : setSettings(s0 => ({ ...s0, llmServer: {} }))}>
                <option value="">— new server —</option>
                {servers.map(x => <option key={x.name} value={x.name}>{x.name} ({x.user}@{x.host})</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" disabled={!serverName || !serverComplete} onClick={saveServer}
                title="Needs a name, host, user name and key file">💾 Save as "{serverName || 'name'}"</button>
              {servers.some(x => x.name === serverName) && <button className="btn btn-secondary btn-sm" onClick={deleteServer}>🗑 Delete</button>}
            </div>
            {srvMsg && <div className="text-xs" style={{ marginTop: 4, color: 'var(--success, #2a9)' }}>{srvMsg}</div>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Name of this configuration</label>
              <input className="form-control" type="text" value={server.name || ''} onChange={e => setServer('name', e.target.value)} placeholder="e.g. psgdev GPU (T4)" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>IP address or host name</label>
              <input className="form-control" type="text" value={server.host || ''} onChange={e => setServer('host', e.target.value)} placeholder="10.1.2.3 or gpu01.example.com" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Username</label>
              <input className="form-control" type="text" value={server.user || ''} onChange={e => setServer('user', e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>SSH port</label>
              <input className="form-control" type="number" min="1" max="65535" value={server.sshPort ?? 22} onChange={e => setServer('sshPort', e.target.value)} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Ollama port on the server</label>
              <input className="form-control" type="number" min="1" max="65535" value={server.remotePort ?? 11434} onChange={e => setServer('remotePort', e.target.value)} />
            </div>
          </div>
          <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
            <label>Private key (.ppk for PuTTY, or an OpenSSH key such as .pem)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="form-control" type="text" value={server.key || ''} onChange={e => setServer('key', e.target.value)} placeholder="D:\ssh\mykey.ppk  or  D:\ssh\mykey.pem" />
              <button className="btn btn-secondary" onClick={async () => { const v = await window.api.dialog.openFile(); if (v) setServer('key', v); }}>Browse…</button>
            </div>
            {/nlpmanager/i.test(server.key || '') && <div className="text-xs" style={{ marginTop: 3, color: 'var(--danger, #c33)' }}>This key is inside an NLPmanager folder - move it out, so it is never uploaded with the project.</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
            {tunnel.state === 'up' || tunnel.state === 'starting'
              ? <button className="btn btn-secondary" disabled={tunnelBusy} onClick={disconnectTunnel}>⏏ Disconnect tunnel</button>
              : <button className="btn btn-primary" disabled={tunnelBusy || !serverComplete} onClick={connectTunnel}>
                  {tunnelBusy ? <><span className="spinner" /> Connecting…</> : '🔗 Connect tunnel'}
                </button>}
            <span style={{ fontSize: 12, color: tunnel.state === 'up' ? 'var(--success, #2a9)' : tunnel.state === 'failed' ? 'var(--danger, #c33)' : 'var(--text-muted)' }}>
              {tunnel.state === 'up' ? `✓ tunnel up via ${tunnel.client === 'ssh' ? 'ssh.exe' : 'plink'}: ${tunnel.host} -> local port ${settings.llmLocalPort}`
                : tunnel.state === 'failed' ? `✗ ${tunnel.error}`
                : tunnel.state === 'starting' ? 'connecting…' : 'tunnel closed'}
            </span>
          </div>
          <div className="form-group" style={{ marginTop: 12, marginBottom: 0 }}>
            <label>plink.exe (PuTTY) - only needed for .ppk keys</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="form-control" type="text" value={settings.plinkExe || ''} onChange={e => set('plinkExe', e.target.value)}
                placeholder={plinkFound ? `automatic: ${plinkFound}` : 'not found - install PuTTY or browse to plink.exe'} />
              <button className="btn btn-secondary" onClick={() => browse(setSettings, 'plinkExe', false)}>Browse…</button>
            </div>
          </div>
        </div>

      </div>
      </>)}

      {tab === 'functions' && (<>

      {/* ── Which LLM for which function ───────────────────────────────── */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">LLM functions</div>
        <LlmFunctionRoutes settings={settings} set={set} localModels={localLlm.models} />
      </div>
      </>)}

      <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
        {saved && (
          <span style={{ fontSize: 12, color: 'var(--success, #2a9)', display:'inline-flex', alignItems:'center', gap:4 }}>
            ✓ Settings saved
            <button onClick={() => setSaved(false)} title="Dismiss"
              style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                       color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
          </span>
        )}
        <button className="btn btn-primary" onClick={handleSave} style={{ minWidth: 120 }}>
          Save Settings
        </button>
      </div>
    </div>
  );
}
