import React, { useState, useEffect } from 'react';

// "Clear LLM cache before each run": the question/answer cache of the LLM triplefication (conceptscan_llm_cache.sqlite). The choice is NOT stored: the main process keeps it in memory, so it is
// off again after every restart of the app (a forgotten ON would throw the answers away at every run). The cache itself is always filled (Settings → Local LLM → "Cache assertions", default on).
// Shown in the NLP Runner (Triplefication panel) and in Settings; both show the same value. now = also a "Clear now" button (Settings).
export default function ClearLlmCache({ now = false, disabled = false }) {
  const [on, setOn] = useState(false);
  const [info, setInfo] = useState({ bytes: 0, file: '' });
  const [msg, setMsg] = useState('');

  const read = () => window.api.llm.cacheState().then(s => { if (s) { setOn(!!s.clear); setInfo({ bytes: s.bytes || 0, file: s.file || '' }); } });
  useEffect(() => {
    read();
    const off = window.api.llm.onCacheFlag(v => setOn(!!v));
    return () => { if (typeof off === 'function') off(); };
  }, []);

  const toggle = async (v) => { setOn(v); await window.api.llm.cacheSetClear(v); };
  const clearNow = async () => {
    const r = await window.api.llm.cacheClearNow();
    setMsg(r && r.ok ? `Cache cleared (${Math.round((r.bytes || 0) / 1024).toLocaleString()} KB).` : `Could not clear the cache: ${r && r.error}`);
    read();
  };
  const kb = Math.round(info.bytes / 1024);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <label className="checkbox-item" style={{ margin: 0 }} title="Empties the LLM question/answer cache at the start of every run (NLP Runner, Reader, Pipeline) that uses an LLM, so every sentence is asked again. Off by default and off again after every restart of the app. The answers of the run are saved to the cache as always.">
        <input type="checkbox" checked={on} disabled={disabled} onChange={e => toggle(e.target.checked)} />
        <span style={on ? { color: 'var(--danger, #c33)', fontWeight: 600 } : undefined}>Clear LLM cache before each run</span>
      </label>
      <span className="text-xs text-muted">{on ? 'ON: every run starts with an empty cache (off again after a restart)' : `off: answers of earlier runs are reused (cache ${kb.toLocaleString()} KB)`}</span>
      {now && <button className="btn btn-secondary btn-sm" disabled={disabled} title={info.file} onClick={clearNow}>Clear LLM cache now</button>}
      {msg && <span className="text-xs text-muted">{msg}</span>}
    </div>
  );
}
