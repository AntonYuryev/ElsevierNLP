import React, { useState, useEffect, useRef } from 'react';

const SOURCES = [
  { value: 'pubmed',        label: 'PubMed',           ext: '.xml'   },
  { value: 'pmc',           label: 'PubMed Central',   ext: '.nxml'  },
  { value: 'sciencedirect', label: 'ScienceDirect',    ext: '.sdxml' },
  { value: 'consyn',        label: 'Elsevier Consyn',  ext: '.xml'   },
];

export default function LiteratureScreen({ litPush, isActive }) {
  const [query,         setQuery]         = useState('');
  const [searchName,    setSearchName]    = useState('');
  const [source,        setSource]        = useState('pubmed');
  const [consynAtomUrl, setConsynAtomUrl] = useState(''); // Atom feed URL override (Consyn only)
  const [outputDir,     setOutputDir]     = useState('');
  const [running,       setRunning]       = useState(false);
  const [log,           setLog]           = useState([]);
  const [progress,      setProgress]      = useState(null);  // { saved, total }
  const [done,          setDone]          = useState(null);   // { saved, source, ext }
  const [error,         setError]         = useState(null);
  const [noResults,     setNoResults]     = useState(false);
  const [searchOpening, setSearchOpening] = useState(false);
  const logRef = useRef(null);

  // Pre-fill Search Query when navigated from Dictionary "Find literature".
  // Depends on seq so it fires on every press even for the same query text.
  useEffect(() => {
    if (litPush?.text) setQuery(litPush.text);
  }, [litPush?.seq]);

  // Settings (for API keys + persisted download location).
  // Re-fetch every time the screen becomes active so changes saved in Settings are picked up.
  const [settings, setSettings] = useState({});
  useEffect(() => {
    if (!isActive) return;
    window.api.settings.get().then(s => {
      if (s) {
        setSettings(s);
        if (s.litOutputDir && !outputDir) setOutputDir(s.litOutputDir);
      }
    });
  }, [isActive]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const addLog         = (msg) => setLog(l => [...l, msg]);
  const replaceLastLog = (msg) => setLog(l => l.length ? [...l.slice(0, -1), msg] : [msg]);

  const handleBrowse = async () => {
    const dir = await window.api.dialog.openDir();
    if (dir) {
      setOutputDir(dir);
      window.api.settings.set({ litOutputDir: dir });
    }
  };

  // Open Consyn search in a browser window with the query pre-filled.
  // Query terms are reformatted from "Alias1" OR "Alias2" → all:"Alias1" OR all:"Alias2".
  const handleConsynSearch = async () => {
    if (!query.trim()) return;
    setSearchOpening(true);
    await window.api.consyn.openSearch(query.trim());
    setSearchOpening(false);
  };

  // Download ZIPs from batch feed (uses stored userId + /api/batches, or consynAtomUrl override).
  const handleDownload = async () => {
    if (!isConsyn && !query.trim()) return;
    if (!outputDir) return;

    setRunning(true);
    setLog([]);
    setProgress(null);
    setDone(null);
    setError(null);
    setNoResults(false);

    const off = window.api.literature.onEvent(ev => {
      if (ev.type === 'log')         addLog(ev.data);
      if (ev.type === 'log_replace') replaceLastLog(ev.data);
      if (ev.type === 'progress')    setProgress(ev.data);
      if (ev.type === 'no_results')  { setNoResults(true); setRunning(false); off(); }
      if (ev.type === 'done')        { setDone(ev.data);   setRunning(false); off(); }
      if (ev.type === 'error')       { setError(ev.data);  setRunning(false); off(); }
    });

    await window.api.literature.download({
      // For Consyn: pass consynAtomUrl as the query (atom URL override); userId read from store in handler
      query:             isConsyn ? consynAtomUrl.trim() : query.trim(),
      searchName:        searchName.trim(),
      source,
      outputDir,
      apikey:            settings.elsevierApiKey    || '',
      ncbiApiKey:        settings.ncbiApiKey        || '',
      consynBearerToken: settings.consynBearerToken || '',
    });
  };

  const isConsyn   = source === 'consyn';
  const sdSelected = source === 'sciencedirect';
  const missingSD  = sdSelected && !settings.elsevierApiKey;
  const missingCons = isConsyn  && !settings.consynBearerToken;

  // Consyn download enabled: session token present AND (userId stored OR atom URL pasted)
  const canConsynDownload = !missingCons && outputDir &&
    (settings.consynUserId || consynAtomUrl.trim());
  const canDownload = isConsyn
    ? canConsynDownload
    : !missingSD && outputDir && query.trim();

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Literature</h1>
      </div>

      {/* Config card */}
      <div className="card">
        <div className="card-header">Search Configuration</div>

        {/* Source selector always shown first */}
        <div className="form-group">
          <label>From</label>
          <select className="form-control" value={source} onChange={e => setSource(e.target.value)}>
            {SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}{s.ext ? ` (saves as ${s.ext})` : ''}</option>)}
          </select>
        </div>

        {/* ── Consyn: two separate fields ─────────────────────────────────────── */}
        {isConsyn ? (
          <>
            {/* Search Query — receives aliases from Dictionary "Find literature" */}
            <div className="form-group">
              <label>Search Query</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="form-control"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder='e.g. "BRCA1" OR "breast cancer gene 1"'
                  style={{ flex: 1 }}
                />
                <button
                  className="btn btn-secondary"
                  onClick={handleConsynSearch}
                  disabled={!query.trim() || searchOpening || missingCons}
                  style={{ whiteSpace: 'nowrap', minWidth: 140 }}
                  title="Open Consyn search with this query"
                >
                  {searchOpening ? <><span className="spinner" /> Opening…</> : '🔍 Open in Consyn'}
                </button>
              </div>
              <div className="text-xs text-muted mt-8">
                Populated automatically from Dictionary → Find literature.
                Terms are sent to Consyn as <code>all:"Term1" OR all:"Term2"</code>.
                The formatted query is also copied to your clipboard — if the search box doesn't auto-fill, just paste (Ctrl+V).
              </div>
            </div>

            {/* Atom Feed URL — for batch ZIP download */}
            <div className="form-group">
              <label>Atom Feed URL <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)' }}>(optional override)</span></label>
              <input
                className="form-control"
                value={consynAtomUrl}
                onChange={e => setConsynAtomUrl(e.target.value)}
                placeholder="Leave blank to auto-download all batches for your User ID"
              />
              <div className="text-xs text-muted mt-8">
                {settings.consynUserId
                  ? <>Will auto-download all batches for user <strong>{settings.consynUserId}</strong>. Paste a specific Atom Feed URL above to override.</>
                  : <>Set your <strong>User ID</strong> in Settings to enable auto-discovery, or paste an Atom Feed URL above.</>
                }
              </div>
            </div>
          </>
        ) : (
          /* ── Non-Consyn: single Search Query field ─────────────────────────── */
          <>
            <div className="form-group">
              <label>Search Query</label>
              <input
                className="form-control"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder='e.g. BRCA1 AND cancer AND "drug resistance"'
                onKeyDown={e => { if (e.key === 'Enter' && !running && query.trim() && outputDir) handleDownload(); }}
              />
            </div>

            <div className="form-group">
              <label>Search name <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>(optional)</span></label>
              <input
                className="form-control"
                value={searchName}
                onChange={e => setSearchName(e.target.value)}
                placeholder='e.g. BRCA1_cancer'
              />
              <div className="text-xs text-muted mt-8">
                Used as the base filename for saved results — e.g. <em>BRCA1_cancer_pubmed.xml</em>.
                Leave blank to use default names.
              </div>
            </div>
          </>
        )}

        {missingSD && (
          <div className="alert alert-warning" style={{ marginBottom: 12, fontSize: 12 }}>
            ⚠ ScienceDirect requires an Elsevier API key. Configure it in <strong>Settings → Elsevier API Credentials</strong>.
          </div>
        )}
        {missingCons && (
          <div className="alert alert-warning" style={{ marginBottom: 12, fontSize: 12 }}>
            ⚠ Consyn requires a session token. Click <strong>Login to Consyn</strong> in <strong>Settings → Elsevier Consyn Credentials</strong>.
          </div>
        )}

        <div className="form-group">
          <label>Download Location</label>
          <div className="input-group">
            <input className="form-control" value={outputDir} readOnly
              placeholder="Select a folder to save downloaded files…"
              style={{ cursor: 'default' }} />
            <button className="btn btn-secondary" onClick={handleBrowse}>Browse…</button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-primary"
            onClick={handleDownload}
            disabled={running || !canDownload}
            style={{ minWidth: 140 }}
          >
            {running ? <><span className="spinner" /> Downloading…</> : '⬇ Download'}
          </button>
          {running && (
            <button
              className="btn btn-danger"
              onClick={() => window.api.literature.stop()}
              style={{ minWidth: 100 }}
            >
              ⏹ Stop
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      {running && progress && (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, background: 'var(--border)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
              <div style={{
                height: '100%', background: 'var(--accent)',
                width: `${Math.round((progress.saved / progress.total) * 100)}%`,
                transition: 'width 0.3s',
              }} />
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
              {progress.saved} / {progress.total}
            </span>
          </div>
        </div>
      )}

      {/* Log */}
      {log.length > 0 && (
        <div ref={logRef} className="log-output mt-12"
          style={{ maxHeight: 260, overflowY: 'auto', fontSize: 11, marginTop: 12 }}>
          {log.map((l, i) => (
            <div key={i} style={{ color: l.startsWith('  ✗') ? 'var(--danger, #c33)' : 'inherit' }}>{l}</div>
          ))}
        </div>
      )}

      {/* Outcomes */}
      {noResults && (
        <div className="alert alert-warning mt-12" style={{ marginTop: 12 }}>
          Your search found no documents.
        </div>
      )}
      {done && (
        <div className="alert alert-success mt-12" style={{ marginTop: 12 }}>
          ✓ Download complete — {done.saved} file(s) saved to <span className="mono" style={{ fontSize: 11 }}>{outputDir}</span>
        </div>
      )}
      {error && (
        <div className="alert alert-danger mt-12" style={{ marginTop: 12, fontSize: 12 }}>
          ✗ {error}
        </div>
      )}
    </div>
  );
}
