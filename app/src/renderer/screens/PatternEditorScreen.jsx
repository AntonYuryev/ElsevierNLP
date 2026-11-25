import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { warmMacros } from '../utils/warmMacros';
import RelationWizard from '../components/RelationWizard';
import RelationPatternsModal from '../components/RelationPatternsModal';
import FindMacroDialog from '../components/FindMacroDialog';
import CreateMacroDialog from '../components/CreateMacroDialog';
import FileEditorDialog from '../components/FileEditorDialog';

export default function PatternEditorScreen() {
  const [cartridges, setCartridges]         = useState([]);
  const [selectedCartridge, setSelected]    = useState(null);
  const [currentPath, setCurrentPath]       = useState('');  // absolute path currently shown
  const [breadcrumbs, setBreadcrumbs]       = useState([]); // [{label, path}]
  const [entries, setEntries]               = useState([]);
  const [loading, setLoading]               = useState(false);
  const [wizardCart, setWizardCart]         = useState(null);   // cartridge for which the New relation wizard is open
  const [relMsg, setRelMsg]                 = useState(null);
  const [showRelPatterns, setShowRelPatterns] = useState(false);
  const [showFindMacro, setShowFindMacro]   = useState(false);
  const [showCreateMacro, setShowCreateMacro] = useState(false);
  const [ctx, setCtx]                       = useState(null);   // right-click menu on a folder: { x, y, dir } (dir = path relative to the cartridge)
  const [compiling, setCompiling]           = useState(null);   // folder being compiled
  const [compRes, setCompRes]               = useState(null);   // { dir, jobs } | { dir, error }
  // "Recompile": every pattern folder of every cartridge, several at once
  const [recomp, setRecomp] = useState(null);   // { total, done, failed, running: [label], concurrency, finished?, result?, error? }
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!recomp || recomp.finished) return; const t = setInterval(() => setTick(x => x + 1), 1000); return () => clearInterval(t); }, [recomp && recomp.finished, !!recomp]);
  const fmtDur = (ms) => { const sec = Math.max(0, Math.round(ms / 1000)); if (sec < 60) return Math.max(5, Math.round(sec / 5) * 5) + ' s'; const m = Math.floor(sec / 60), r = sec % 60; return m >= 10 ? m + ' min' : m + ' min ' + String(Math.round(r / 10) * 10 % 60).padStart(2, '0') + ' s'; };
  // like tqdm: time left = (time per finished batch so far) x (batches left); the first batches are finished before an estimate is shown
  const etaText = (r) => {
    if (!r.startedAt) return '';
    const elapsed = Date.now() - r.startedAt;
    if (r.done < 1) return 'elapsed ' + fmtDur(elapsed) + ' — estimating the time left…';
    const left = elapsed / r.done * (r.total - r.done);
    return 'elapsed ' + fmtDur(elapsed) + ' — about ' + fmtDur(left) + ' left (done at ' + new Date(Date.now() + left).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')';
  };
  // only = one cartridge ({ name, path }): just its patterns are rebuilt (when only one of them was changed); no argument = all cartridges
  const recompile = async (only) => {
    const cartPaths = only ? [only.path] : cartridges.map(c => c.path);
    let plan;
    try { const r = await window.api.relation.recompilePlan({ cartPaths }); if (r.ok === false) throw new Error(r.error); plan = r.plan; }
    catch (e) { setRecomp({ error: e.message, finished: true }); return; }
    if (!plan.total) { setRecomp({ error: 'No pattern folders with a compile command found.', finished: true }); return; }
    if (!window.confirm('Recompile ' + plan.total + ' pattern batches ' + (only ? 'of ' + only.name : 'in ' + Object.keys(plan.byCartridge).length + ' cartridges') + ' (' + plan.concurrency + ' at a time)?\n\nUse this after DictionaryMacros.msgrep (or another shared macro file) changed. The old .grbatch files are replaced one by one; one that fails to compile is kept. It can take several minutes.')) return;
    setRecomp({ total: plan.total, done: 0, failed: 0, running: [], concurrency: plan.concurrency, label: only ? only.name : '' });
    const off = window.api.relation.onRecompileProgress((p) => {
      if (p.type === 'plan') setRecomp(r => r && { ...r, startedAt: Date.now() });
      if (p.type === 'start') setRecomp(r => r && { ...r, running: [...r.running, p.cartridge + ' ' + p.batch] });
      if (p.type === 'done') setRecomp(r => r && { ...r, done: p.done, failed: r.failed + (p.ok ? 0 : 1), running: r.running.filter(x => x !== p.cartridge + ' ' + p.batch) });
    });
    try {
      const r = await window.api.relation.recompileAll({ cartPaths });
      setRecomp(x => ({ ...x, running: [], finished: true, result: r.ok === false ? null : r.result, error: r.ok === false ? r.error : null }));
    } catch (e) { setRecomp(x => ({ ...x, running: [], finished: true, error: e.message })); }
    off();
  };

  useEffect(() => {
    if (!ctx) return;
    const close = () => setCtx(null);
    window.addEventListener('click', close); window.addEventListener('keydown', close); window.addEventListener('blur', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close); window.removeEventListener('blur', close); };
  }, [ctx]);

  // the folder as a path relative to the cartridge (absolute paths here use / after the cartridge path)
  const relOf = (abs) => abs.slice(selectedCartridge.path.length).replace(/^[\\/]+/, '');
  const openFolderMenu = (e, absDir) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, dir: relOf(absDir) }); };
  const compileDir = async (dir) => {
    setCtx(null); setCompRes(null); setCompiling(dir);
    try {
      const r = await window.api.relation.compileFolder({ cartPath: selectedCartridge.path, relDir: dir });
      setCompRes(r.ok === false ? { dir, error: r.error } : { dir, jobs: r.result.jobs });
    } catch (e) { setCompRes({ dir, error: e.message }); }
    setCompiling(null);
  };

  useEffect(() => {
    window.api.medscan.listCartridges().then(list => {
      setCartridges(list);
      if (list.length > 0) openCartridge(list[0]);
      warmMacros(list, list[0]);
    });
  }, []);

  const openCartridge = async (cart) => {
    setSelected(cart);
    const grdataPath = `${cart.path}/grdata`;
    await navigateTo(grdataPath, [{ label: `${cart.name} / grdata`, path: grdataPath }]);
  };

  const navigateTo = async (absPath, crumbs) => {
    setLoading(true);
    setCurrentPath(absPath);
    setBreadcrumbs(crumbs);
    // only folders and .msgrep pattern files are listed (no logs, .cmd files, …)
    const items = (await window.api.fs.listDir(absPath)).filter(f => f.isDir || /\.msgrep$/i.test(f.name));
    // Sort: dirs first, then files, both alphabetically
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    setEntries(items);
    setLoading(false);
  };

  const handleEnterDir = (dirName) => {
    const newPath = `${currentPath}/${dirName}`;
    const newCrumbs = [...breadcrumbs, { label: dirName, path: newPath }];
    navigateTo(newPath, newCrumbs);
  };

  const handleBreadcrumb = (crumb, idx) => {
    const newCrumbs = breadcrumbs.slice(0, idx + 1);
    navigateTo(crumb.path, newCrumbs);
  };

  // .msgrep files open in the app's own editor (spell-check, rules check); anything else in the system's editor
  const [editFile, setEditFile] = useState(null);                  // { cartPath, cartName, file } relative to the cartridge
  const handleOpen = (filename) => {
    if (/\.msgrep$/i.test(filename) && selectedCartridge) setEditFile({ cartPath: selectedCartridge.path, cartName: selectedCartridge.name, file: relOf(`${currentPath}/${filename}`) });
    else window.api.shell.openFile(`${currentPath}/${filename}`);
  };

  const getFileIcon = (name) => {
    if (name.endsWith('.pat') || name.endsWith('.grm')) return '📄';
    if (name.endsWith('.tab') || name.endsWith('.txt')) return '📋';
    if (name.endsWith('.e')) return '⚙';
    return '📄';
  };

  const getFileBadge = (name) => {
    if (name.endsWith('.pat')) return <span className="badge badge-accent">pattern</span>;
    if (name.endsWith('.grm')) return <span className="badge badge-warning">grammar</span>;
    if (name.endsWith('.tab')) return <span className="badge badge-success">table</span>;
    if (name.endsWith('.e'))   return <span className="badge badge-success">dict</span>;
    return <span className="text-muted text-xs">file</span>;
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Pattern File Editor</h1>
        <button className="btn btn-secondary" disabled={cartridges.length === 0} onClick={() => setShowRelPatterns(true)}
          title="Find all patterns that extract a relation type">
          Patterns for relations
        </button>
        <button className="btn btn-secondary" disabled={!selectedCartridge} onClick={() => setShowFindMacro(true)}
          title="Find the macros of the selected cartridge that contain a word">
          Find macro
        </button>
        <button className="btn btn-secondary" disabled={!selectedCartridge} onClick={() => setShowCreateMacro(true)}
          title="Create a new macro in one of the macro files of the selected cartridge — optionally in all cartridges at once">
          Create macro
        </button>
        <button className="btn btn-secondary" disabled={cartridges.length === 0 || (recomp && !recomp.finished)} onClick={() => recompile()}
          title="Recompile all patterns of ALL cartridges, several at once — needed after a macro file shared by all cartridges (DictionaryMacros.msgrep) was updated. After changing one cartridge use “Recompile <cartridge>” above its file list.">
          Recompile all
        </button>
      </div>
      {recomp && (
        <div className={'alert ' + (recomp.error || recomp.failed ? 'alert-danger' : recomp.finished ? 'alert-success' : 'alert-info')} style={{ marginBottom: 12, fontSize: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b style={{ flex: 1 }}>
              {!recomp.finished && <span className="spinner" style={{ marginRight: 6 }} />}
              Recompile{recomp.label ? ' ' + recomp.label : ''}: {recomp.error && !recomp.total ? recomp.error : recomp.finished
                ? (recomp.result?.cancelled ? 'stopped — ' : '') + recomp.done + ' of ' + recomp.total + ' batches rebuilt' + (recomp.failed ? ', ' + recomp.failed + ' failed' : '') + (recomp.result ? ' in ' + recomp.result.seconds + ' s' : '')
                : recomp.done + ' of ' + recomp.total + ' batches done (' + recomp.concurrency + ' at a time)' + (recomp.failed ? ', ' + recomp.failed + ' failed' : '')}
            </b>
            {!recomp.finished && <button className="btn btn-sm btn-secondary" onClick={() => window.api.relation.recompileCancel()} title="Batches already running finish; no new ones start">Stop</button>}
            {recomp.finished && <button onClick={() => setRecomp(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: 'inherit', opacity: 0.55 }}>×</button>}
          </div>
          {!recomp.finished && recomp.startedAt && <div style={{ marginTop: 3 }} data-tick={tick}>{etaText(recomp)}</div>}
          {!recomp.finished && recomp.running.length > 0 && <div className="text-muted" style={{ marginTop: 3 }}>running: {recomp.running.join(', ')}</div>}
          {recomp.error && recomp.total && <div style={{ marginTop: 3 }}>✗ {recomp.error}</div>}
          {recomp.result && recomp.result.results.filter(x => !x.ok).map((x, i) => <div key={i} style={{ marginTop: 3 }}>✗ <b>{x.cartridge}</b> <code>{x.batch}</code> — {x.message}</div>)}
          {recomp.result && recomp.result.skipped.length > 0 && <div className="text-muted" style={{ marginTop: 3 }}>skipped: {recomp.result.skipped.map(x => x.cartridge + ' (' + x.reason + ')').join('; ')}</div>}
        </div>
      )}
      {showCreateMacro && selectedCartridge && <CreateMacroDialog api={window.api.relation} cartPath={selectedCartridge.path} cartName={selectedCartridge.name} patternText="" relationName="" standalone onAdded={() => {}} onClose={() => setShowCreateMacro(false)} />}
      {editFile && <FileEditorDialog key={editFile.cartPath + editFile.file} cartPath={editFile.cartPath} cartName={editFile.cartName} file={editFile.file} onClose={() => setEditFile(null)} />}
      {showFindMacro && selectedCartridge && <FindMacroDialog api={window.api.relation} cartPath={selectedCartridge.path} cartName={selectedCartridge.name} onClose={() => setShowFindMacro(false)} />}
      {showRelPatterns && <RelationPatternsModal cartridges={cartridges} onClose={() => setShowRelPatterns(false)} />}

      <div className="alert alert-info" style={{ marginBottom: 16 }}>
        Pattern files open in the built-in editor (spell-check, rules check, Save &amp; Compile). A change takes effect in the next NLP run once its folder is compiled: <b>Save &amp; Compile</b> in the editor, right-click a folder → <b>Compile</b>, or <b>Recompile</b> a cartridge / all cartridges.
      </div>
      {relMsg && (
        <div className="alert alert-success" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{relMsg}</span>
          <button onClick={() => setRelMsg(null)} title="Dismiss"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: 'inherit', opacity: 0.55 }}>×</button>
        </div>
      )}
      {wizardCart && (
        <RelationWizard
          cartridges={cartridges}
          initialCartridge={wizardCart}
          onClose={(done) => {
            const c = wizardCart;
            setWizardCart(null);
            if (done) { setRelMsg('New relation type created and compiled.'); openCartridge(c); }
          }} />
      )}

      {cartridges.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔧</div>
          <div>No cartridges found.</div>
          <div className="text-sm mt-8">Set Elsevier NLP Installation Directory in Settings.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '290px 1fr', gap: 16 }}>
          {/* Cartridge list */}
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="card-header" style={{ padding: '10px 14px', marginBottom: 0 }}>Cartridges</div>
            {cartridges.map(c => (
              <div
                key={c.name}
                style={{
                  padding: '9px 14px',
                  cursor: 'pointer',
                  background: selectedCartridge?.name === c.name ? 'var(--surface2)' : 'transparent',
                  borderLeft: `3px solid ${selectedCartridge?.name === c.name ? 'var(--accent)' : 'transparent'}`,
                  color: selectedCartridge?.name === c.name ? 'var(--accent)' : 'var(--text-dim)',
                  fontSize: 13,
                  transition: 'all 0.15s',
                }}
                onClick={() => openCartridge(c)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <span>{c.name}</span>
                  <button className="btn btn-secondary btn-sm" style={{ fontSize: 11, padding: '1px 7px', whiteSpace: 'nowrap' }}
                    title={'Create a new relation type in ' + c.name}
                    onClick={(e) => { e.stopPropagation(); setWizardCart(c); }}>
                    ＋ New relation
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* File browser */}
          <div>
            {/* Breadcrumb trail */}
            {breadcrumbs.length > 0 && (
              <div className="flex items-center gap-4 mb-12 text-sm" style={{ flexWrap: 'wrap' }}>
                {breadcrumbs.map((crumb, idx) => (
                  <React.Fragment key={idx}>
                    {idx > 0 && <span style={{ color: 'var(--muted)' }}>›</span>}
                    <span
                      onClick={() => handleBreadcrumb(crumb, idx)}
                      onContextMenu={(e) => openFolderMenu(e, crumb.path)}
                      style={{
                        cursor: idx < breadcrumbs.length - 1 ? 'pointer' : 'default',
                        color: idx < breadcrumbs.length - 1 ? 'var(--accent)' : 'var(--text)',
                        fontWeight: idx === breadcrumbs.length - 1 ? 600 : 400,
                      }}
                    >
                      {crumb.label}
                    </span>
                  </React.Fragment>
                ))}
                {loading && <span className="spinner" style={{ marginLeft: 4 }} />}
                {selectedCartridge && <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} disabled={recomp && !recomp.finished} onClick={() => recompile(selectedCartridge)}
                  title={'Recompile all patterns of ' + selectedCartridge.name + ' only, several folders at once'}>⚙ Recompile {selectedCartridge.name}</button>}
              </div>
            )}

            {compiling && <div className="alert alert-info" style={{ marginBottom: 12 }}><span className="spinner" /> Compiling <b>{compiling}</b> — the .grbatch files are rebuilt, this can take a few minutes…</div>}
            {compRes && (
              <div className={'alert ' + (compRes.error || compRes.jobs.some(j => !j.ok) ? 'alert-danger' : 'alert-success')} style={{ marginBottom: 12, fontSize: 12 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <b style={{ flex: 1 }}>Compile {compRes.dir}: {compRes.error ? 'failed' : compRes.jobs.every(j => j.ok) ? compRes.jobs.length + ' pattern folder' + (compRes.jobs.length !== 1 ? 's' : '') + ' compiled' : compRes.jobs.filter(j => !j.ok).length + ' of ' + compRes.jobs.length + ' failed'}</b>
                  <button onClick={() => setCompRes(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, color: 'inherit', opacity: 0.55 }}>×</button>
                </div>
                {compRes.error && <div style={{ whiteSpace: 'pre-wrap' }}>{compRes.error}</div>}
                {compRes.jobs && compRes.jobs.map(j => (
                  <div key={j.prefix} style={{ marginTop: 3 }}>
                    {j.ok ? '✓' : '✗'} <code>comp_{j.prefix}</code> → <code>{j.batch}</code> <span className="text-muted">({j.folders.join(', ')})</span>{j.message ? ' — ' + j.message : ''}
                  </div>
                ))}
              </div>
            )}
            {!loading && entries.length === 0 && (
              <div className="alert alert-warning">No files found in this directory.</div>
            )}

            {!loading && entries.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map(f => (
                      <tr key={f.name} onContextMenu={f.isDir ? (e) => openFolderMenu(e, `${currentPath}/${f.name}`) : undefined}>
                        <td>
                          <span style={{ marginRight: 8 }}>{f.isDir ? '📁' : getFileIcon(f.name)}</span>
                          <span className="mono">{f.name}{f.isDir ? '/' : ''}</span>
                        </td>
                        <td>
                          {f.isDir
                            ? <span className="badge badge-warning">dir</span>
                            : getFileBadge(f.name)
                          }
                        </td>
                        <td>
                          {f.isDir
                            ? <button className="btn btn-secondary btn-sm" onClick={() => handleEnterDir(f.name)}>
                                📂 Open
                              </button>
                            : <button className="btn btn-secondary btn-sm" onClick={() => handleOpen(f.name)}>
                                ✏ Open in Editor
                              </button>
                          }
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      {ctx && createPortal(
        <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', left: Math.min(ctx.x, window.innerWidth - 230), top: Math.min(ctx.y, window.innerHeight - 70), zIndex: 20000, background: 'var(--surface-dim, #1e1e2e)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 4px 14px rgba(0,0,0,.4)', padding: 4, minWidth: 210 }}>
          <div className="text-xs text-muted" style={{ padding: '2px 10px' }}>{ctx.dir || '(cartridge)'}</div>
          <div onClick={() => compileDir(ctx.dir)} style={{ padding: '5px 10px', cursor: 'pointer', fontSize: 13, borderRadius: 4 }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2, rgba(255,255,255,.08))'; }} onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
            ⚙ Compile (this folder and its subfolders)
          </div>
        </div>, document.body)}
    </div>
  );
}
