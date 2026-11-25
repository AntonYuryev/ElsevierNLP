import ClearLlmCache from './ClearLlmCache';
import React, { useState, useEffect, useRef } from 'react';

// Who writes the semantic triples: the cartridge's conceptscan, the LLM provider of Settings -> LLM Connector, or a model of the local LLM port.
// ONE choice for the whole app: the NLP Runner and the Pipeline screen both show the choice (the screens stay mounted, so the panels talk through a window event),
// and the main process reads the choice and the template from the user's settings when it runs conceptscan - the panel only keeps them there.
//   settings.triplefication  = { kind:'conceptscan' } | { kind:'provider' } | { kind:'local', model }
//   settings.llmPairPrompts  = { <cartridge name>: the template edited by the user }   (only edits are stored; without one the default template is used)
// The LLM is asked once for every pair of entities of a sentence that a frame of the cartridge can extract; the template is the prompt of such a request.
// compact: only the Triplefication choice (the Pipeline screen: the template is viewed / edited on the ConceptScan (LLM) step of a run). Full: also the template box (the NLP Runner).
const SYNC = 'nlp-triple-sync';
const sync = (detail) => window.dispatchEvent(new CustomEvent(SYNC, { detail }));
const toValue = (t) => !t ? 'conceptscan' : t.kind === 'provider' ? 'provider' : t.kind === 'local' ? 'local' : 'conceptscan';      // 'local' = the ONE local model of Settings -> Local LLM ("Model for the functions set to Local LLM")
const toSpec = (v) => v === 'provider' ? { kind: 'provider' } : v === 'local' ? { kind: 'local' } : { kind: 'conceptscan' };

// the name of the connector configuration; an unnamed custom one shows its host
const providerName = (s) => {
  const n = (s.llmProviderName || '').trim();
  if (n && n !== 'Custom…') return n;
  try { return new URL(s.llmProviderUrl).host; } catch { return 'LLM provider'; }
};

export default function TripleficationPanel({ cartridges = [], disabled = false, compact = false }) {
  const [settings, setSettings] = useState(null);
  const [triple, setTriple] = useState('conceptscan');
  const [localLlm, setLocalLlm] = useState({ ok: false, models: [], error: '', port: 0 });
  const [tunnel, setTunnel] = useState({ state: 'closed', error: '' });          // the SSH tunnel: connected by itself after a restart (main process), a failure is shown here in red
  const [promptCart, setPromptCart] = useState(null);          // cartridge whose template is in the box; '' = "-- select --": the box is hidden; null = not chosen yet
  const [prompts, setPrompts] = useState({});                  // cartridge name -> text in the box
  const [defs, setDefs] = useState({});                        // cartridge name -> { text: its default template, answerLine: the line the program adds after every template } (only DiseaseFX asks for a change type)
  const [error, setError] = useState('');
  const saveTimer = useRef(null);
  const promptsRef = useRef(prompts); promptsRef.current = prompts;
  const defsRef = useRef(defs); defsRef.current = defs;
  const defOf = (n) => (defs[n] ? defs[n].text : null);
  const def = promptCart ? defOf(promptCart) : null;
  const answerLine = (promptCart && defs[promptCart]) ? defs[promptCart].answerLine : '';

  const readSettings = () => window.api.settings.get().then(s => {
    setSettings(s);
    setTriple(toValue(s.triplefication));
    setPrompts(s.llmPairPrompts || {});
  });

  useEffect(() => {
    readSettings();
    window.api.llm.localState().then(st => { if (st) setLocalLlm(st); });
    const offLocal = window.api.llm.onLocalUpdate(st => setLocalLlm(st));
    window.api.llm.tunnelState().then(st => { if (st) setTunnel(st); });
    const offTunnel = window.api.llm.onTunnelUpdate(st => setTunnel(st));
    const onSync = (e) => {                                      // the other screen's panel changed something
      const d = e.detail || {};
      if (d.triple !== undefined) { readSettings().then(() => setTriple(d.triple)); }          // the settings are read again first: a Local LLM choice needs the model of Settings -> Local LLM
      if (d.prompt) setPrompts(p => ({ ...p, [d.prompt.name]: d.prompt.text }));
      if (d.reload) readSettings();
    };
    window.addEventListener(SYNC, onSync);
    return () => { offLocal(); if (typeof offTunnel === "function") offTunnel(); window.removeEventListener(SYNC, onSync); };
  }, []);

  // A saved choice that cannot be used any more (the local port is closed or no longer has the model, the provider was removed) falls back to conceptscan - saved too, so that what the
  // screen says is what a run uses. Judged only after the first probe of the local port has answered.
  const providerOk = !!settings?.llmProviderUrl;
  const localModel = settings?.llmLocalModel || '';
  const unusable = (triple === 'local' && (!localModel || (!!localLlm.checkedAt && !localLlm.models.includes(localModel)))) || (triple === 'provider' && !!settings && !providerOk);
  // (no silent fall back to conceptscan any more: a choice that cannot be used is shown as such, and a run stops with a clear message)

  useEffect(() => {                                              // the cartridge of the box
    const names = cartridges.map(c => c.name);
    if (promptCart === '') return;                               // hidden by the user
    if (promptCart === null && !names.length) return;           // the cartridges are not loaded yet
    if (promptCart === null) { let hidden = false; try { hidden = localStorage.getItem('triple.tplHidden') === '1'; } catch { /* */ } setPromptCart(hidden ? '' : (names[0] || '')); return; }
    if (!names.includes(promptCart)) setPromptCart(names[0] || null);
  }, [cartridges.map(c => c.name).join('|')]);

  useEffect(() => {                                              // the default template of every cartridge in the list (it differs: only DiseaseFX has a change-type line)
    for (const c of cartridges) {
      if (defsRef.current[c.name]) continue;
      window.api.llm.defaultPrompt({ cartridge: c.name }).then(r => { if (r.ok) setDefs(d => ({ ...d, [c.name]: { text: r.text, answerLine: r.answerLine || '' } })); else setError(r.error); });
    }
  }, [cartridges.map(c => c.name).join('|')]);

  const llmOn = triple !== 'conceptscan';        // the template box only belongs to an LLM choice
  const choose = (v) => { setTriple(v); window.api.settings.set({ triplefication: toSpec(v) }); sync({ triple: v }); };

  // the box shows the template of the cartridge: the one edited by the user, else the default
  const isEdited = (n) => prompts[n] !== undefined && prompts[n].trim() !== '' && defOf(n) !== null && prompts[n] !== defOf(n);
  const persist = () => {                                        // only edits are stored: a text equal to the default (or empty) means "use the default"
    clearTimeout(saveTimer.current);
    const cur = promptsRef.current, ds = defsRef.current;
    window.api.settings.set({ llmPairPrompts: Object.fromEntries(Object.entries(cur).filter(([k, v]) => v && v.trim() !== '' && v !== (ds[k] ? ds[k].text : null))) });
  };
  const edit = (text) => {
    setPrompts(p => { const next = { ...p, [promptCart]: text }; promptsRef.current = next; return next; });
    clearTimeout(saveTimer.current); saveTimer.current = setTimeout(persist, 400);
    sync({ prompt: { name: promptCart, text } });
  };
  const useDefault = () => {
    setPrompts(p => { const next = { ...p }; delete next[promptCart]; promptsRef.current = next; return next; });
    persist(); sync({ reload: true });
  };

  return (
    <div style={{ marginBottom: 12 }}
      title="Who writes the semantic triples (the pseudo-sentences that the rules match). conceptscan = the cartridge's own program. An LLM: conceptscan_llm sends one request for every pair of entities the cartridge can extract. The choice is the same in the NLP Runner and the Pipeline screen.">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 500 }}>Triplefication</span>
        <span>{triple === 'conceptscan' ? 'conceptscan' : triple === 'provider' ? `${providerName(settings)}${settings.llmModel ? ` (${settings.llmModel})` : ''}` : (localModel || '(no model chosen)') + ' (local LLM)'}</span>
        {unusable && <span className="text-xs" style={{ color: 'var(--danger, #c33)' }}>{triple === 'local' ? (!localModel ? 'no model chosen in Settings → Local LLM' : `the local LLM has no model ${localModel} (tunnel closed?)`) : 'no LLM provider configured'} — a run will stop with an error</span>}
        <span className="text-xs text-muted">chosen in Settings → LLM Connector / Local LLM → "Which LLM for which function"</span>
      </div>
      <div className="text-xs text-muted" style={{ marginTop: 4 }}>
        {localLlm.ok ? `Local LLM port ${localLlm.port}: ${localLlm.models.length} model(s).` : `Local LLM port ${localLlm.port || ''} not reachable${localLlm.error ? ' (' + localLlm.error + ')' : ''} — connect the tunnel in Settings.`}
        {tunnel.state === 'starting' && ' Connecting the tunnel…'}
        {!providerOk && ' No LLM provider configured in Settings.'}
        {compact && llmOn && ' The template is viewed and edited on the ConceptScan (LLM) step of a run.'}
      </div>
      {llmOn && <div style={{ marginTop: 8 }}><ClearLlmCache disabled={disabled} /></div>}
      {tunnel.state === 'failed' && <div className="text-xs" style={{ marginTop: 4, color: 'var(--danger, #c33)' }}>✗ Tunnel: {tunnel.error}</div>}
      {!compact && llmOn && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 500 }}>Template for</span>
            <select className="form-control" style={{ width: 'auto', minWidth: 160 }} value={promptCart ?? ''} disabled={disabled} onChange={e => { setPromptCart(e.target.value); try { localStorage.setItem('triple.tplHidden', e.target.value === '' ? '1' : '0'); } catch { /* */ } }}>
              <option value="">-- select --</option>
              {cartridges.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            {promptCart && isEdited(promptCart) && <span className="text-xs" style={{ color: 'var(--accent)' }}>edited</span>}
            <button className="btn btn-secondary btn-sm" disabled={disabled || !promptCart || !isEdited(promptCart)} title="Throw the edits away: the default template is used again"
              onClick={useDefault}>Use default template</button>
          </div>
          {cartridges.length === 0 && <div className="text-xs text-muted">Select a cartridge to see its template.</div>}
          {promptCart === '' && cartridges.length > 0 && <div className="text-xs text-muted">The template is hidden: choose a cartridge to view or edit its template (the templates in use do not change).</div>}
          {error && <div className="alert alert-danger" style={{ marginBottom: 4 }}>{error}</div>}
          {promptCart && <>
          <textarea spellCheck={false} disabled={disabled || !promptCart || def === null}
            value={promptCart ? (prompts[promptCart] !== undefined ? prompts[promptCart] : (def ?? '')) : ''} onChange={e => edit(e.target.value)}
            onBlur={() => { if (promptCart && prompts[promptCart] !== undefined && prompts[promptCart].trim() === '') useDefault(); else persist(); }}
            style={{ width: '100%', height: 110, fontFamily: 'monospace', fontSize: 11, background: 'var(--surface)', color: 'var(--text)',
                     border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 8, resize: 'vertical', boxSizing: 'border-box' }} />
          <div className="text-xs text-muted" style={{ marginTop: 4 }}>
            The answer is a JSON array of triples with ONE structure: noun phrase 1 - predicate - noun phrase 2. The last line of the template tells the model its JSON shape; the program finds the three values by the meaning of the keys (a key with "predicate" / "verb" / "relation", the keys with 1 and 2). Each noun phrase must hold an entity that a frame of the cartridge can use (two entities of the SAME type in one noun phrase are not allowed; entities of different types are, and the frames of the cartridge decide which pair is a relation): that is how the program knows which two entities a triple links. It writes the pseudo-sentence "noun phrase 1 & predicate noun phrase 2"; the first triple is #Main, the others #NPRel. A template without a JSON line gets the default line added.
            {promptCart && !/\{\s*"[^"]+"\s*:/.test(prompts[promptCart] !== undefined ? prompts[promptCart] : (def ?? '')) && answerLine && <span> <b>This template has no JSON line</b>, so this one is added: <span className="mono" style={{ userSelect: 'text' }}>{answerLine}</span>{' '}
              <button className="btn btn-secondary btn-sm" disabled={disabled} onClick={() => edit((prompts[promptCart] !== undefined ? prompts[promptCart] : (def ?? '')).replace(/\s+$/, '') + String.fromCharCode(10) + answerLine)}>Add it to the template</button></span>}
          </div>
          <div className="text-xs text-muted" style={{ marginTop: 2 }}>
            One request is sent per sentence: this template (a line that asks for a JSON answer is added when it has none). To list the entities in the prompt write <code>{'${1:list of tagged entities}'}</code> (or <code>{'${entities}'}</code>) where the list should stand, e.g. <code>Target entities in sentence: {'${1:list of tagged entities}'}</code>: it becomes <code>["a", "b"]</code> - every entity a frame of the cartridge can use, in the order of the sentence; without the placeholder no list is sent. The sentence follows as plain text (no markup is sent). No worked examples.
            The template you edit is used from then on, for this cartridge, in the NLP Runner and the Pipeline screen.
          </div>
          </>}
        </div>
      )}
    </div>
  );
}
