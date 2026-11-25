import React, { useState, useEffect, useRef } from 'react';
import TripleficationPanel from '../components/TripleficationPanel';

const mmss = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
// "1,234 of 5,000 sentences answered (25%) in 3 of 8 cartridges so far, 4.2 sentences/s, elapsed 4:52, about 14:10 left"
function llmLine(p, now = Date.now()) {
  if (!p) return '';
  const el = p.t0 ? Math.max(1, now - p.t0) : 0;
  const h = p.hist || [];
  const rate = h.length > 1 && h[h.length - 1].t > h[0].t ? (h[h.length - 1].done - h[0].done) / ((h[h.length - 1].t - h[0].t) / 1000) : 0;       // sentences per second over the last minute (the average of the whole run also counts the answers that came from the cache at once)
  const avg = el ? p.done / (el / 1000) : 0;
  const pct = p.total ? Math.floor(100 * p.done / p.total) : 0;
  const left = rate > 0 && p.total > p.done && p.finished < p.cartridges ? ', about ' + mmss((p.total - p.done) / rate * 1000) + ' left in the cartridges started so far' : '';
  return p.done.toLocaleString() + ' of ' + p.total.toLocaleString() + ' sentences answered (' + pct + '%), ' + p.finished + ' of ' + p.cartridges + ' cartridges finished, ' + (rate ? rate.toFixed(rate < 10 ? 1 : 0) + ' sentences/s now (average ' + avg.toFixed(avg < 10 ? 1 : 0) + '), ' : '') + 'elapsed ' + mmss(el) + left;
}
// which sentences go to the LLM: those with two or more marked-up entities that a frame of the cartridge can use as a pair; the others are skipped (all cartridges together: each reads the sentences with its own markup)
function llmDetail(p) {
  if (!p || !p.sentences) return '';
  const n = (x) => (x || 0).toLocaleString();
  const skipped = (p.single || 0) + (p.none || 0) + (p.nopair || 0);
  return 'Sentences read: ' + n(p.sentences) + ' — sent to the LLM (two or more marked-up entities that can form a pair): ' + n(p.total) + '; skipped: ' + n(skipped) + ' (a single marked-up entity: ' + n(p.single) + ', no entity: ' + n(p.none) + ', two or more entities but no pair the cartridge can use: ' + n(p.nopair) + ')'
    + (p.done ? '; answers so far: ' + n(p.cached) + ' from the cache, ' + n(Math.max(0, p.done - (p.cached || 0))) + ' from the LLM' : '');
}
export default function RunnerScreen({ onRunComplete }) {
  const [settings, setSettings] = useState(null);
  const [cartridges, setCartridges] = useState([]);
  const [selectedCartridges, setSelectedCartridges] = useState([]);
  const [inputMode,   setInputMode]   = useState('dir'); // 'dir' | 'files'
  const [xmlFormat,   setXmlFormat]   = useState('pubmed'); // 'pubmed'|'pmc'|'sciencedirect'|'consyn'|'html'|'msxml'
  const [keepMsxml,   setKeepMsxml]   = useState(false);    // keep the intermediate .msxml for fast reprocessing
  const [splitRules, setSplitRules] = useState(false);          // one .rnef per rule of allpats() instead of one combined file; not remembered
  const [intermediateFiles, setIntermediateFiles] = useState(false);   // stdout of every pipeline step (<Cartridge>.ms / .rg / .cs ...); not remembered: always off at start
  const [maxParallel, setMaxParallel] = useState(2);        // max locscan processes run at the same time
  const [inputDir, setInputDir] = useState('');
  const [inputFiles, setInputFiles] = useState([]);
  const [outputDir, setOutputDir] = useState('');
  const [organism, setOrganism] = useState('Mammal');
  const [cooccurrence, setCooccurrence] = useState(false);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [llmProg, setLlmProg] = useState(null);                 // LLM triplefication: { done, total, started, finished, cartridges, t0 } sentences answered so far (all cartridges together)
  const [, setClock] = useState(0);                          // redraws the elapsed time every second while a run is going
  const [preflightErrors, setPreflightErrors] = useState([]);
  const logRef = useRef(null);
  useEffect(() => { if (!running) return; const t = setInterval(() => setClock(c => c + 1), 1000); return () => clearInterval(t); }, [running]);
  const llmRef = useRef(null);
  const cleanupRef = useRef(null);
  // Custom command editing
  // cmdEditorOpen: bool — modal visible
  // cmdEditorText: string — textarea content while editing
  // customCmds: { lines: string[], originals: object[] } | null — saved custom commands
  const [cmdEditorOpen,  setCmdEditorOpen]  = useState(false);
  const [cmdEditorText,  setCmdEditorText]  = useState('');
  const [cmdEditorBusy,  setCmdEditorBusy]  = useState(false);
  const [customCmds,     setCustomCmds]     = useState(null);


  // BW Filter
  const [filterFile, setFilterFile] = useState(''); // active filter file path
  const [filterOpen, setFilterOpen] = useState(false);

  useEffect(() => {
    window.api.settings.get().then(s => {
      setSettings(s);
      if (s.lastInputDir)  setInputDir(s.lastInputDir);
      if (s.lastOutputDir) setOutputDir(s.lastOutputDir);
      if (s.xmlFormat)     setXmlFormat(s.xmlFormat);
      if (s.keepMsxml)     setKeepMsxml(true);
      if (s.maxParallelCartridges) setMaxParallel(s.maxParallelCartridges);
      refreshCartridges();
    });
    return () => { if (cleanupRef.current) cleanupRef.current(); };
  }, []);


  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const errorRef = useRef(null);

  const saveCartridgeSelection = (selected) => {
    window.api.settings.set({ selectedCartridgeNames: selected.map(c => c.name) });
  };

  const refreshCartridges = async () => {
    const [list, s] = await Promise.all([
      window.api.medscan.listCartridges(),
      window.api.settings.get(),
    ]);
    setCartridges(list);
    const savedNames = s?.selectedCartridgeNames;
    if (!Array.isArray(savedNames)) {
      // First launch: select all and persist
      setSelectedCartridges(list);
      saveCartridgeSelection(list);
    } else {
      // Restore saved selection, dropping any cartridges that no longer exist
      setSelectedCartridges(list.filter(c => savedNames.includes(c.name)));
    }
  };

  const addLog = (cls, text) => setLogs(l => [...l, { cls, text, id: Date.now() + Math.random() }]);

  const toggleCartridge = (c) => {
    setSelectedCartridges(sel => {
      const next = sel.find(s => s.name === c.name)
        ? sel.filter(s => s.name !== c.name)
        : [...sel, c];
      saveCartridgeSelection(next);
      return next;
    });
  };

  // Pre-run validation: check organism-specific files exist
  const preflight = async () => {
    const errors = [];
    const s = await window.api.settings.get();
    if (!s.medscanLicense) errors.push('No Elsevier NLP license key configured (Settings).');
    if (!s.medscanDir) errors.push('Elsevier NLP installation directory not configured (Settings).');
    if (selectedCartridges.length === 0) errors.push('No cartridges selected.');
    if (inputMode === 'dir' && !inputDir) errors.push('No input directory specified.');
    if (inputMode === 'files' && inputFiles.length === 0) errors.push('No input files selected.');
    if (!outputDir) {
      errors.push('No output directory specified.');
    } else {
      const outExists = await window.api.fs.exists(outputDir);
      if (!outExists) errors.push(`Output directory does not exist: ${outputDir}`);
    }

    // Organism file check
    if (organism && selectedCartridges.length > 0) {
      for (const cart of selectedCartridges) {
        const msdataFiles = await window.api.fs.listDir(`${cart.path}/msdata`);
        const msdataNames = msdataFiles.map(f => f.name);
        const required = [
          `${organism}.curNames.tab.e`,
          `${organism}.ExactLiteral.tab.e`,
          `${organism}.keywords.tab.e`,
        ];
        for (const req of required) {
          if (!msdataNames.includes(req)) {
            errors.push(`Missing organism file in ${cart.name}: ${req}`);
          }
        }
      }
    }
    return errors;
  };

  // Resolve input files list (dir scan or explicit list).
  // .xml is always included — the format dropdown controls how locscan parses them,
  // not whether they're picked up. Format-native extensions (.nxml, .sdxml) are
  // added on top so mixed directories work correctly.
  const resolveInputs = async () => {
    if (inputMode === 'dir') {
      if (xmlFormat === 'consyn') {
        // Consyn directories are 3 levels deep — find all .xml files recursively
        return window.api.fs.listDirRecursive(inputDir, '.xml');
      }
      if (xmlFormat === 'html') {
        // HTML files may be nested — find all .html files recursively
        return window.api.fs.listDirRecursive(inputDir, '.html');
      }
      if (xmlFormat === 'msxml') {
        // MedScan msxml (e.g. a kept intermediate file) — pick up .msxml in the folder
        const files = await window.api.fs.listDir(inputDir);
        return files.filter(f => !f.isDir && /\.msxml$/i.test(f.name)).map(f => `${inputDir}/${f.name}`);
      }
      const extraExt = { pmc: /\.nxml$/i, sciencedirect: /\.sdxml$/i }[xmlFormat];
      const files    = await window.api.fs.listDir(inputDir);
      return files
        .filter(f => !f.isDir && (/\.xml$/i.test(f.name) || (extraExt && extraExt.test(f.name))))
        .map(f => `${inputDir}/${f.name}`);
    }
    return inputFiles;
  };

  // "Edit Command" — build commands then open editor modal
  const handleEditCommand = async () => {
    const errors = await preflight();
    setPreflightErrors(errors);
    if (errors.length > 0) {
      setTimeout(() => errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      return;
    }
    const inputs = await resolveInputs();
    if (inputs.length === 0) {
      setPreflightErrors(['No input files found in the selected directory.']);
      return;
    }
    setCmdEditorBusy(true);
    const s = await window.api.settings.get();
    const result = await window.api.medscan.buildCommands({
      inputs,
      cartridges: selectedCartridges,
      outputDir,
      organism,
      license: s.medscanLicense,
      userDict: s.userDict || '',
      bwFilter: filterFile || '',
      cooccurrence,
      xmlFormat,
      keepMsxml,
    });
    setCmdEditorBusy(false);
    if (!result.ok) {
      setPreflightErrors([`Could not build commands: ${result.error}`]);
      return;
    }
    // Pre-fill editor with current custom text (if set) or the freshly-built commands
    const lines = customCmds ? customCmds.lines : result.commands.map(c => c.cmdStr);
    setCmdEditorText(lines.join('\n'));
    // Store originals for stdin preservation when running
    setCmdEditorOpen({ originals: result.commands });
  };

  // Save the edited command text and close modal
  const handleSaveCustomCmd = () => {
    const lines = cmdEditorText.split('\n').map(l => l.trim()).filter(Boolean);
    setCustomCmds({ lines, originals: cmdEditorOpen.originals });
    setCmdEditorOpen(false);
  };

  const handleRun = async () => {
    setLogs([]);
    const errors = await preflight();
    setPreflightErrors(errors);
    if (errors.length > 0) {
      setTimeout(() => errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      return;
    }

    const inputs = await resolveInputs();
    if (inputs.length === 0) {
      setPreflightErrors(['No input files found in the selected directory.']);
      return;
    }

    // Remove the previous run's listener first — it was never removed, so every extra run made each log
    // line appear twice, three times… (the run itself executes once: same run id / list file in the log).
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }

    setRunning(true); setLlmProg(null); llmRef.current = null;
    addLog('log-info', customCmds
      ? `Starting NLP run with custom command (${customCmds.lines.length} line(s))`
      : `Starting NLP run: ${inputs.length} file(s), ${selectedCartridges.length} cartridge(s)`
    );

    const cleanup = window.api.medscan.onRunEvent(({ type, data }) => {
      if (type === 'cmdList') {
        addLog('log-info', '── Commands to execute ──────────────────────────');
        data.commands.forEach(c => addLog('log-cmd', `$ ${c}`));
        addLog('log-info', '─────────────────────────────────────────────────');
      }
      else if (type === 'llm-progress') {
        const now = Date.now(), h = ((llmRef.current && llmRef.current.hist) || []).concat([{ t: now, done: data.done }]).filter(x => now - x.t <= 60000);   // the last minute: the speed NOW
        llmRef.current = { ...data, hist: h }; setLlmProg(llmRef.current);
      }
      else if (type === 'info') addLog('log-info', data)
      else if (type === 'warn') addLog('log-err', `⚠ ${data}`)
      else if (type === 'cmd') addLog('log-cmd', `\n▶ ${data.cmd}`);
      else if (type === 'stdout') addLog('log-info', data.trimEnd());
      else if (type === 'stderr') addLog('log-err', data.trimEnd());
      else if (type === 'cmdDone') addLog(data.code === 0 ? 'log-ok' : 'log-err', `Exit code: ${data.code}`);
      else if (type === 'error') addLog('log-err', `Error: ${data}`);
      else if (type === 'done') {
        addLog('log-ok', `\n✓ Run complete. Output files: ${data.outputFiles.length}`);
        if (llmRef.current) { addLog('log-info', 'LLM triplefication: ' + llmLine(llmRef.current)); if (llmRef.current.sentences) addLog('log-info', llmDetail(llmRef.current)); }
        setRunning(false);
        if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
        if (onRunComplete) onRunComplete(data.outputFiles);
      }
    });
    cleanupRef.current = cleanup;

    const s = await window.api.settings.get();
    let id;
    if (customCmds) {
      id = await window.api.medscan.runCustom({
        customLines: customCmds.lines,
        originals:   customCmds.originals,
        outputDir,
      });
    } else {
      id = await window.api.medscan.run({
        inputs,
        cartridges: selectedCartridges,
        outputDir,
        organism,
        license:    s.medscanLicense,
        userDict:   s.userDict || '',
        bwFilter:   filterFile || '',
        cooccurrence,
        xmlFormat,
        keepMsxml,
        intermediateFiles,
        splitRules,
      });
    }
    setRunId(id);
  };

  const handleStop = async () => {
    if (runId) await window.api.medscan.stopRun(runId);
    setRunning(false);
    addLog('log-err', '⏹ Run stopped by user.');
  };

  return (
    <div className="screen">
      {/* ── Command Editor Modal ─────────────────────────────────────────────── */}
      {cmdEditorOpen && (
        <div className="modal-backdrop">
          <div className="modal" style={{ maxWidth: 820, width: '90vw' }}>
            <div className="modal-title">Edit Command Lines</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
              One command per line. Changes take effect on next Run.
              Lines matching the auto-generated command are run natively (with stdin support for pmxmlfiles);
              modified lines are passed to the OS shell.
            </div>
            <textarea
              autoFocus
              value={cmdEditorText}
              onChange={e => setCmdEditorText(e.target.value)}
              spellCheck={false}
              style={{
                width: '100%', height: 320, fontFamily: 'monospace', fontSize: 11,
                background: 'var(--surface)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                padding: 10, resize: 'vertical', boxSizing: 'border-box',
              }}
            />
            <div className="modal-actions" style={{ marginTop: 12 }}>
              <button className="btn btn-secondary" onClick={() => setCmdEditorOpen(false)}>Cancel</button>
              <button className="btn btn-secondary" onClick={() => {
                // Reset to auto-generated (re-open would re-build; just clear custom)
                setCustomCmds(null);
                setCmdEditorOpen(false);
              }}>✕ Clear Custom &amp; Use Auto</button>
              <button className="btn btn-primary" onClick={handleSaveCustomCmd}>✓ Save</button>
            </div>
          </div>
        </div>
      )}

      <div className="screen-header">
        <h1 className="screen-title">NLP Runner</h1>
        <div className="flex gap-8">
          <button className="btn btn-secondary btn-sm" onClick={refreshCartridges}>↻ Refresh Cartridges</button>
        </div>
      </div>

      {preflightErrors.length > 0 && (
        <div className="alert alert-danger" ref={errorRef}>
          <strong>Cannot start run:</strong>
          <ul style={{ marginLeft: 16, marginTop: 4 }}>
            {preflightErrors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Input */}
          <div className="card">
            <div className="card-header">Input</div>
            <div className="tabs" style={{ marginBottom: 12 }}>
              <div className={`tab ${inputMode === 'dir' ? 'active' : ''}`} onClick={() => setInputMode('dir')}>Directory</div>
              <div className={`tab ${inputMode === 'files' ? 'active' : ''}`} onClick={() => setInputMode('files')}>Select Files</div>
            </div>

            <div className="form-group" style={{ marginBottom: 12 }}>
              <label>Input Format</label>
              <select className="form-control" value={xmlFormat} onChange={e => { setXmlFormat(e.target.value); window.api.settings.set({ xmlFormat: e.target.value }); }}>
                <option value="pubmed">PubMed XML (.xml)</option>
                <option value="pmc">PubMed Central XML (.nxml or .xml)</option>
                <option value="sciencedirect">ScienceDirect XML (.sdxml or .xml)</option>
                <option value="consyn">Consyn XML (.xml)</option>
                <option value="html">HTML (.html)</option>
                <option value="msxml">MedScan (.msxml)</option>
              </select>
            </div>
            <label className="checkbox-item" style={{ marginBottom: 12 }}
              title="Creating the .msxml file is the slow step for large batches. Keep it (written to the output directory) to re-run quickly with input format MedScan (.msxml).">
              <input type="checkbox" checked={keepMsxml}
                onChange={e => { setKeepMsxml(e.target.checked); window.api.settings.set({ keepMsxml: e.target.checked }); }} />
              <span>Keep intermediate .msxml file</span>
              {xmlFormat === 'msxml' && (
                <span className="text-xs text-muted" style={{ marginLeft: 6 }}>(input is already MSXML — nothing is created)</span>
              )}
            </label>
            {xmlFormat === 'html' && (
              <div className="alert alert-info" style={{ marginBottom: 12, fontSize: 12 }}>
                HTML files must be named by DOI, e.g. <strong>10.1016_j.example.2024.123456.html</strong> (replace the first <code>/</code> with <code>_</code>). The DOI is extracted from the filename automatically.
              </div>
            )}

            {inputMode === 'dir' ? (
              <div className="form-group">
                <label>Input Directory</label>
                <div className="input-group">
                  <input className="form-control" value={inputDir} onChange={e => setInputDir(e.target.value)} placeholder="Path to directory with XML files" />
                  <button className="btn btn-secondary" onClick={async () => {
                    const d = await window.api.dialog.openDir({ defaultPath: inputDir || undefined });
                    if (d) { setInputDir(d); window.api.settings.set({ lastInputDir: d }); }
                  }}>Browse</button>
                </div>
              </div>
            ) : (
              <div className="form-group">
                <label>Selected Files ({inputFiles.length})</label>
                <button className="btn btn-secondary w-full" onClick={async () => { const f = await window.api.dialog.openFiles(xmlFormat); if (f?.length) setInputFiles(f); }}>
                  📂 Select Files…
                </button>
                {inputFiles.length > 0 && (
                  <div style={{ marginTop: 8, maxHeight: 100, overflowY: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
                    {inputFiles.map(f => <div key={f} className="mono">{f}</div>)}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Output + Organism */}
          <div className="card">
            <div className="card-header">Output & Options</div>
            <div className="form-group">
              <label>Output Directory</label>
              <div className="input-group">
                <input className="form-control" value={outputDir} onChange={e => setOutputDir(e.target.value)} placeholder="Where to write RNEF XML results" />
                <button className="btn btn-secondary" onClick={async () => {
                  const d = await window.api.dialog.openDir({ defaultPath: outputDir || undefined });
                  if (d) { setOutputDir(d); window.api.settings.set({ lastOutputDir: d }); }
                }}>Browse</button>
              </div>
            </div>
            <div className="form-group">
              <label>Organism (-Q flag)</label>
              <input className="form-control" value={organism} onChange={e => setOrganism(e.target.value)} placeholder="e.g. Mammal, Human" />
              <div className="text-xs text-muted mt-8">Leave blank to omit -Q flag and skip organism file validation.</div>
            </div>
          </div>
        </div>

        {/* Right column: Cartridges */}
        <div className="card">
          <div className="card-header flex justify-between items-center">
            <span>Cartridges ({selectedCartridges.length} selected)</span>
            <div className="flex gap-8">
              <button className="btn btn-secondary btn-sm" onClick={() => { setSelectedCartridges(cartridges); saveCartridgeSelection(cartridges); }}>All</button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setSelectedCartridges([]); saveCartridgeSelection([]); }}>None</button>
            </div>
          </div>
          <label className="checkbox-item" style={{ padding: '6px 8px', marginBottom: 8, background: cooccurrence ? 'rgba(124,106,247,0.1)' : 'transparent', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
            <input type="checkbox" checked={cooccurrence} onChange={e => setCooccurrence(e.target.checked)} />
            <span style={{ fontWeight: 500 }}>Extract co-occurrence</span>
            <span className="text-xs text-muted" style={{ marginLeft: 4 }}>({cooccurrence ? 'allpats+coocr' : 'allpats'})</span>
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', marginBottom: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
            title="How many MedScan (locscan) processes run at the same time. Higher is faster but uses more memory — each process loads its cartridge's dictionaries.">
            <span style={{ fontWeight: 500 }}>Max parallel cartridges</span>
            <input type="number" min="1" max="16" step="1" value={maxParallel} disabled={running}
              onChange={e => { const v = Math.max(1, parseInt(e.target.value) || 1); setMaxParallel(v); window.api.settings.set({ maxParallelCartridges: v }); }}
              style={{ width: 70, textAlign: 'right' }} />
            <span className="text-xs text-muted">Default 2. Higher is faster but uses more memory.</span>
          </div>
          {cartridges.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📦</div>
              <div>No cartridges found.</div>
              <div className="text-sm mt-8">Set Elsevier NLP Installation Directory in Settings.</div>
            </div>
          ) : (
            <div className="checkbox-list">
              {cartridges.map(c => (
                <label key={c.name} className="checkbox-item">
                  <input type="checkbox" checked={!!selectedCartridges.find(s => s.name === c.name)} onChange={() => toggleCartridge(c)} />
                  <span>{c.name}</span>
                </label>
              ))}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
              <label className="checkbox-item" style={{ marginBottom: 12 }}
                title="Writes the stdout of every step of each cartridge's pipeline to the output directory, as in the Pipeline screen: <Cartridge>.ms (MedScan), .rg (reglue), .cs (ConceptScan); cartridges with extra steps also get .cl (cellscan), .rs (rescan), .gv (gvarscan), .at (ambtag). The steps are run once more on their own, so the run takes longer and the files can be large.">
                <input type="checkbox" checked={intermediateFiles} disabled={running}
                  onChange={e => setIntermediateFiles(e.target.checked)} />
                <span>Create intermediate files</span>
                <span className="text-xs text-muted" style={{ marginLeft: 6 }}>(&lt;Cartridge&gt;.ms, .rg, .cs … — runs each step once more)</span>
              </label>
              <label className="checkbox-item" style={{ marginBottom: 12 }}
                title="Instead of one combined .rnef per cartridge, writes one .rnef per rule of allpats() in the cartridge's locscan.ini (one per .grbatch): <input>.<cartridge>.<rule>.rnef. The pipeline steps are run once and each rule is applied to their output with the same converters as the combined file. Use with the MSXML stage of the input (MedScan .msxml, PubMed, PMC, ScienceDirect, Consyn, HTML).">
                <input type="checkbox" checked={splitRules} disabled={running}
                  onChange={e => setSplitRules(e.target.checked)} />
                <span>Rules split output</span>
                <span className="text-xs text-muted" style={{ marginLeft: 6 }}>(one .rnef per rule of allpats — replaces the combined file)</span>
              </label>
              <TripleficationPanel cartridges={selectedCartridges} disabled={running} />
          </div>
        </div>
      </div>

      {/* Run controls */}
      <div className="flex gap-12 items-center mt-16" style={{ flexWrap: 'wrap' }}>
        {!running ? (
          <button className="btn btn-primary" onClick={handleRun} disabled={cartridges.length === 0}>
            ▶ Run Elsevier NLP
          </button>
        ) : (
          <button className="btn btn-danger" onClick={handleStop}>
            ⏹ Stop
          </button>
        )}
        {!running && (
          <button className="btn btn-secondary" onClick={handleEditCommand} disabled={cmdEditorBusy || selectedCartridges.length === 0}>
            {cmdEditorBusy ? <><span className="spinner" /> Building…</> : '✎ Edit Command'}
          </button>
        )}
        <button className="btn btn-secondary" onClick={() => setFilterOpen(true)}>
          🔲 Filter
        </button>
        {filterFile && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
                         padding: '3px 10px', borderRadius: 'var(--radius)',
                         background: 'rgba(60,180,100,0.12)', color: 'var(--success,#2a9)',
                         border: '1px solid var(--success,#2a9)' }}>
            -f {filterFile.split(/[\\/]/).pop()}
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13, padding: 0 }}
              title="Remove filter" onClick={() => setFilterFile('')}>✕</button>
          </span>
        )}
        {customCmds && !running && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12,
                         padding: '3px 10px', borderRadius: 'var(--radius)',
                         background: 'rgba(124,106,247,0.15)', color: 'var(--accent)', border: '1px solid var(--accent)' }}>
            ⚡ Custom command active ({customCmds.lines.length} line{customCmds.lines.length !== 1 ? 's' : ''})
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13, padding: 0 }}
              title="Clear custom command and use auto-generated"
              onClick={() => setCustomCmds(null)}>✕</button>
          </span>
        )}
        {running && <div className="flex items-center gap-8"><span className="spinner" /><div className="text-muted text-sm"><div>{llmProg ? 'LLM triplefication: ' + llmLine(llmProg) : 'Processing…'}</div>{llmProg && llmProg.sentences > 0 && <div style={{ marginTop: 2 }}>{llmDetail(llmProg)}</div>}</div></div>}
      </div>

      {/* Filter Dialog */}
      {filterOpen && (
        <FilterDialog
          activeFilter={filterFile}
          onSelect={p => { setFilterFile(p); setFilterOpen(false); }}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {/* Log */}
      {(logs.length > 0 || running) && (
        <div style={{ marginTop: 16 }}>
          <div className="flex justify-between items-center mb-8">
            <span className="text-sm text-muted">Execution Log</span>
            {logs.length > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={() => {
                const text = logs.map(l => l.text).join('\n');
                navigator.clipboard.writeText(text);
              }}>⎘ Copy</button>
            )}
          </div>
          <div className="log-output" ref={logRef} style={{ minHeight: 80 }}>
            {logs.length === 0
              ? <span className="log-info">Waiting for Elsevier NLP output…</span>
              : logs.map(l => <div key={l.id} className={l.cls}>{l.text}</div>)
            }
          </div>
        </div>
      )}
    </div>
  );
}

// ── FilterDialog ──────────────────────────────────────────────────────────────
const NODE_TYPES = [
  'Protein','SmallMol','CellObject','Complex','CellProcesses',
  'Virus','Tissue','Organ','Diseases','CellType','CellLineName',
  'FunctionalClass','Treatment','ClinicalParameter','GeneticVariant','Pathogen',
];
const CONTROL_TYPES = [
  'Regulation','DirectRegulation','MolSyn','MolTransport','PromoterBinding',
  'Binding','Expression','MolSynthesis','CellExpression','Translocation',
  'miRNAEffect','GeneticChange','Biomarker','StateChange',
];
const EFFECTS = ['Positive','Negative','Unknown'];

const OPCODES = [
  { code: 'BlackNode',                 args: ['urn']                              },
  { code: 'WhiteNode',                 args: ['urn']                              },
  { code: 'BlackNtype',                args: ['nodeType']                         },
  { code: 'WhiteNtype',                args: ['nodeType']                         },
  { code: 'BlackCtype',                args: ['ctrlType']                         },
  { code: 'WhiteCtype',                args: ['ctrlType']                         },
  { code: 'BlackMref',                 args: ['mref']                             },
  { code: 'WhiteMref',                 args: ['mref']                             },
  { code: 'BlackPmidCtypeInOut',       args: ['pmid','ctrlType','urnIn','urnOut'] },
  { code: 'BlackMrefCtypeEffectInOut', args: ['mref','ctrlType','effect','urnIn','urnOut'] },
];

function UrnPicker({ label, value, onChange }) {
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy]       = useState(false);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    // Search objectnames (has explicit URNs)
    const r1 = await window.api.db.query(
      `SELECT name AS alias, urn FROM objectnames WHERE name ILIKE $1 AND urn IS NOT NULL LIMIT 15`,
      [`%${query}%`]
    );
    // Search curnames (form URN from medscan_id)
    const r2 = await window.api.db.query(
      `SELECT DISTINCT ON (medscan_id) alias, 'urn:agi-llid:' || medscan_id AS urn FROM curnames WHERE alias ILIKE $1 LIMIT 15`,
      [`%${query}%`]
    );
    const combined = [
      ...(r1.ok ? r1.rows : []),
      ...(r2.ok ? r2.rows : []),
    ].slice(0, 20);
    setResults(combined);
    setBusy(false);
  };

  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        <input className="form-control" style={{ fontSize: 11 }} value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="Search entity name…" />
        <button className="btn btn-secondary btn-sm" onClick={search} disabled={busy}>
          {busy ? <span className="spinner" /> : '🔍'}
        </button>
      </div>
      {results.length > 0 && (
        <div style={{ maxHeight: 100, overflowY: 'auto', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)', background: 'var(--surface)', marginBottom: 4 }}>
          {results.map((r, i) => (
            <div key={i}
              style={{ padding: '3px 8px', fontSize: 11, cursor: 'pointer',
                       borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none' }}
              onClick={() => { onChange(r.urn); setResults([]); setQuery(r.alias); }}
            >
              <span style={{ color: 'var(--text)' }}>{r.alias}</span>
              <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>{r.urn}</span>
            </div>
          ))}
        </div>
      )}
      <input className="form-control" style={{ fontSize: 11 }} value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="URN (e.g. urn:agi-llid:7124)" />
    </div>
  );
}

function FilterDialog({ activeFilter, onSelect, onClose }) {
  const [files,      setFiles]      = useState([]);
  const [openFile,   setOpenFile]   = useState(null);   // { name, path }
  const [content,    setContent]    = useState('');
  const [dirty,      setDirty]      = useState(false);
  const [newName,    setNewName]    = useState('');
  const [creating,   setCreating]   = useState(false);
  const [saveMsg,    setSaveMsg]    = useState('');

  // Instruction builder state
  const [opIdx,      setOpIdx]      = useState(0);
  const [argVals,    setArgVals]    = useState({});

  useEffect(() => { loadFiles(); }, []);

  const loadFiles = async () => {
    const list = await window.api.filter.list();
    setFiles(list);
    // If activeFilter is set and the file exists, open it
    if (activeFilter && list.some(f => f.path === activeFilter)) {
      openFilterFile(list.find(f => f.path === activeFilter));
    }
  };

  const openFilterFile = async (f) => {
    if (dirty && openFile) {
      if (!confirm('Discard unsaved changes?')) return;
    }
    const r = await window.api.filter.read(f.path);
    if (r.ok) { setOpenFile(f); setContent(r.content); setDirty(false); }
  };

  const saveFile = async () => {
    if (!openFile) return;
    const r = await window.api.filter.write(openFile.path, content);
    if (r.ok) { setDirty(false); setSaveMsg('Saved ✓'); }
  };

  const createFile = async () => {
    if (!newName.trim()) return;
    const r = await window.api.filter.create(newName.trim());
    if (r.ok) {
      await loadFiles();
      openFilterFile({ name: r.name, path: r.path });
      setCreating(false); setNewName('');
    } else alert(r.error);
  };

  const op = OPCODES[opIdx];

  const setArg = (k, v) => setArgVals(a => ({ ...a, [k]: v }));

  const buildLine = () => {
    const vals = op.args.map(a => (argVals[a] || '').trim());
    if (vals.some(v => !v)) return null;
    return op.code + '\t' + vals.join('\t');
  };

  const addInstruction = () => {
    const line = buildLine();
    if (!line) { alert('Please fill in all fields.'); return; }
    setContent(c => c + (c && !c.endsWith('\n') ? '\n' : '') + line + '\n');
    setDirty(true);
    setArgVals({});
  };

  const inp = { fontSize: 11 };

  const renderArgField = (argKey) => {
    if (argKey === 'urnIn')   return <UrnPicker key={argKey} label="Regulator URN (In)"  value={argVals.urnIn  || ''} onChange={v => setArg('urnIn',  v)} />;
    if (argKey === 'urnOut')  return <UrnPicker key={argKey} label="Target URN (Out)"    value={argVals.urnOut || ''} onChange={v => setArg('urnOut', v)} />;
    if (argKey === 'urn')     return <UrnPicker key={argKey} label="Node URN"             value={argVals.urn   || ''} onChange={v => setArg('urn',    v)} />;
    if (argKey === 'nodeType') return (
      <div key={argKey} style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Node Type</div>
        <select className="form-control" style={inp} value={argVals.nodeType || ''}
          onChange={e => setArg('nodeType', e.target.value)}>
          <option value="">— select —</option>
          {NODE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
    );
    if (argKey === 'ctrlType') return (
      <div key={argKey} style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Control Type</div>
        <select className="form-control" style={inp} value={argVals.ctrlType || ''}
          onChange={e => setArg('ctrlType', e.target.value)}>
          <option value="">— select —</option>
          {CONTROL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
    );
    if (argKey === 'effect') return (
      <div key={argKey} style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Effect</div>
        <select className="form-control" style={inp} value={argVals.effect || ''}
          onChange={e => setArg('effect', e.target.value)}>
          <option value="">— select —</option>
          {EFFECTS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
    );
    if (argKey === 'pmid') return (
      <div key={argKey} style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>PMID</div>
        <input className="form-control" style={inp} value={argVals.pmid || ''}
          onChange={e => setArg('pmid', e.target.value)} placeholder="e.g. 12345678" />
      </div>
    );
    if (argKey === 'mref') return (
      <div key={argKey} style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>mref (sentence reference)</div>
        <input className="form-control" style={inp} value={argVals.mref || ''}
          onChange={e => setArg('mref', e.target.value)} placeholder="e.g. info:pmid/12345678#S2.1" />
      </div>
    );
    return null;
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ maxWidth: 980, width: '96vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>BW Filter Files</span>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>✕ Close</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, flex: 1, minHeight: 0 }}>

          {/* ── File list ── */}
          <div style={{ borderRight: '1px solid var(--border)', paddingRight: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-dim)' }}>Filter Files</div>
            {files.length === 0 && <div className="text-muted text-sm">No filter files yet.</div>}
            {files.map(f => (
              <div key={f.path}
                style={{ padding: '5px 8px', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: 12,
                         background: openFile?.path === f.path ? 'var(--accent-light,rgba(124,106,247,0.15))' : 'transparent',
                         border: openFile?.path === f.path ? '1px solid var(--accent)' : '1px solid transparent' }}
                onClick={() => openFilterFile(f)}>
                {f.name}
              </div>
            ))}

            <div style={{ marginTop: 'auto', paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              {creating ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input className="form-control" style={{ fontSize: 11 }} value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && createFile()}
                    placeholder="filename (no .txt)" autoFocus />
                  <div className="flex gap-6">
                    <button className="btn btn-primary btn-sm" onClick={createFile}>Create</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => { setCreating(false); setNewName(''); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-secondary btn-sm w-full" onClick={() => setCreating(true)}>+ New Filter File</button>
              )}
            </div>
          </div>

          {/* ── Editor + builder ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
            {!openFile ? (
              <div className="empty-state" style={{ marginTop: 40 }}>
                <div className="empty-state-icon">🔲</div>
                <div>Select or create a filter file</div>
              </div>
            ) : (
              <>
                {/* Toolbar */}
                <div className="flex gap-8 items-center">
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{openFile.name}</span>
                  {dirty && <span style={{ fontSize: 11, color: 'var(--warning,#e90)' }}>● unsaved</span>}
                  {saveMsg && (
                    <span style={{ fontSize: 11, color: 'var(--success,#2a9)', display:'inline-flex', alignItems:'center', gap:3 }}>
                      {saveMsg}
                      <button onClick={() => setSaveMsg('')} title="Dismiss"
                        style={{ background:'none', border:'none', cursor:'pointer', fontSize:14, lineHeight:1,
                                 color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
                    </span>
                  )}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <button className="btn btn-secondary btn-sm" onClick={saveFile} disabled={!dirty}>💾 Save</button>
                    <button className="btn btn-primary btn-sm"
                      onClick={async () => { if (dirty) await saveFile(); onSelect(openFile.path); }}>
                      ✓ Use as -f argument
                    </button>
                  </div>
                </div>

                {/* Two-column: editor | instruction builder */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 10, flex: 1, minHeight: 0 }}>

                  {/* Text editor */}
                  <textarea
                    value={content}
                    onChange={e => { setContent(e.target.value); setDirty(true); }}
                    spellCheck={false}
                    style={{ fontFamily: 'monospace', fontSize: 11, resize: 'none',
                             background: 'var(--surface)', color: 'var(--text)',
                             border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                             padding: 8, minHeight: 320 }}
                  />

                  {/* Instruction builder */}
                  <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                                padding: 10, overflowY: 'auto', background: 'var(--bg)' }}>
                    <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>Add Instruction</div>

                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>Opcode</div>
                      <select className="form-control" style={{ fontSize: 11 }} value={opIdx}
                        onChange={e => { setOpIdx(Number(e.target.value)); setArgVals({}); }}>
                        {OPCODES.map((o, i) => <option key={o.code} value={i}>{o.code}</option>)}
                      </select>
                    </div>

                    {op.args.map(a => renderArgField(a))}

                    <button className="btn btn-primary btn-sm w-full" style={{ marginTop: 8 }} onClick={addInstruction}>
                      ＋ Add to file
                    </button>

                    {/* Quick reference */}
                    <div style={{ marginTop: 14, fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6,
                                  borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                      <strong>Black</strong> = drop matching relations<br/>
                      <strong>White</strong> = pass only explicitly listed<br/>
                      Later lines override earlier ones<br/>
                      Black overrides White for conflicts
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
