import React, { useState, useEffect, useMemo, useRef } from 'react';
import { callLlm, getLlmRemainingToday } from '../../shared/llm';
import { NODE_TYPE_RANGES } from '../../shared/entityTypes';
import FileEditorDialog from './FileEditorDialog';

/**
 * "Patterns for relations": pick a relation type, the app scans every pattern library (*.msgrep) of the cartridges for
 * CONTROL declarations of that type and lists, per declaration, the file it is in and the patterns it applies
 * (one row per file that holds patterns). "Examples" asks the configured LLM for one sentence per pattern.
 */
const CACHE_KEY = 'relPatternExamples.v1';
const BATCH = 20;                                   // patterns per LLM request
const CONCURRENCY = 5;                              // LLM requests in flight at once
const SKIP_MACROS = new Set(['@regulator', '@target', '@in', '@out', '@^', '@$', '$WORD', '$PUNCT', '$NUM', '$ACT']);

// the default link colour is a dark blue that cannot be read on the dark background
const LINK = { color: '#8fd8ff' };
const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const loadCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; } };
const saveCache = (c) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { } };

const SYSTEM = `You write example sentences for patterns of a biomedical relation-extraction system (MedScan).
Pattern syntax: tokens are words; "a b" is a sequence; "(x|y)" and "[x y]" mean one of the listed words; "[^x y]" means any token that is NOT in the list; a trailing "?" makes an element optional; "{m,n}" repeats it; "@.{0,2}?" allows up to 2 arbitrary tokens; "$NAME" is a word set (its definition is given, choose any member); "word~" matches the word with any ending; "'&'" or "$ACT" only marks the action position in concept-scan output and is not written in the sentence; "@^" / "@$" are sentence start/end; quoted strings are literal words.
Entities: @regulator, @in and the "in" variable stand for the regulating entity; @target, @out and the "out" variable stand for the regulated entity. Use a realistic concrete name of one of the stated entity types for each.
Rules: write ONE natural English sentence per pattern that the pattern would match, in the exact word order the pattern requires. Wrap the regulator name in <R></R> and the target name in <T></T>. Reply with a JSON array of strings only, one per pattern, same order, no commentary.`;

/** Sentences from a reply: JSON array (possibly in a code fence / with prose around), {"sentences":[…]}, or numbered lines. */
function parseSentences(reply, n) {
  const text = String(reply || '').replace(/```(?:json)?/gi, '');
  const tryJson = (t) => { try { const v = JSON.parse(t); return Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v).find(Array.isArray) : null); } catch { return null; } };
  let arr = tryJson(text.trim());
  if (!arr) { const a0 = text.indexOf('['), a1 = text.lastIndexOf(']'); if (a0 >= 0 && a1 > a0) arr = tryJson(text.slice(a0, a1 + 1)); }
  if (!arr) {
    const lines = text.split(/\r?\n/).map(l => l.match(/^\s*\d+[.)]\s+(.*\S)\s*$/)).filter(Boolean).map(m => m[1].replace(/^["']|["',]+$/g, ''));
    if (lines.length >= Math.min(n, 1)) arr = lines;
  }
  return arr && arr.length ? arr.map(x => (typeof x === 'string' ? x : x && (x.sentence || x.example || x.text) || '')) : null;
}

function renderExample(text) {
  const out = [];
  const re = /<([RT])>([\s\S]*?)<\/\1>/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<span key={k++} style={{ fontWeight: 600, color: m[1] === 'R' ? 'var(--danger, #e06c75)' : 'var(--success, #7bc47f)' }}>{m[2]}</span>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function RelationPatternsModal({ cartridges, onClose }) {
  const carts = useMemo(() => cartridges.map(c => ({ name: c.name, path: c.path })), [cartridges]);
  const [types, setTypes] = useState([]);
  const [rel, setRel] = useState('');
  const [cartFilter, setCartFilter] = useState('');
  const [showAll, setShowAll] = useState(false);              // results page: also list the declarations the Regulator / Target selection hides
  const [page, setPage] = useState('select');               // 'select': relation type + entity types · 'results': the patterns (after "Show patterns")
  const [regOff, setRegOff] = useState(() => new Set());     // regulator entity types the user unchecked (all are checked by default)
  const [tgtOff, setTgtOff] = useState(() => new Set());     // target entity types the user unchecked
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [examples, setExamples] = useState(loadCache);        // key → sentence
  const examplesRef = useRef(examples);
  examplesRef.current = examples;
  const [busyRows, setBusyRows] = useState({});               // row index → true while generating
  const [rowErrors, setRowErrors] = useState({});
  const [bulk, setBulk] = useState(null);                     // { done, total } while generating for all rows
  const stopRef = useRef(false);

  useEffect(() => {
    window.api.relation.types({ carts }).then(r => {
      if (r.ok) setTypes(r.types); else setError(r.error);
    });
  }, [carts]);

  const scan = async (name) => {
    setRel(name); setRows(null); setError(''); setRowErrors({}); setRegOff(new Set()); setTgtOff(new Set()); setPage('select'); setShowAll(false);
    if (!name) return;
    setBusy(true);
    const r = await window.api.relation.patternsFor({ carts, name });
    setBusy(false);
    if (r.ok) setRows(r.rows); else setError(r.error);
  };

  const absPath = (cartName, relPath) => {
    const c = carts.find(x => x.name === cartName);
    return c ? `${c.path.replace(/[\\/][^\\/]+$/, '')}\\${relPath}` : relPath;   // relPath starts with the cartridge folder
  };
  // a .msgrep file opens in the app's own pattern editor (spell-check, rules check, Save & Compile); relPath starts with the cartridge folder, the editor wants the path inside it
  const [editFile, setEditFile] = useState(null);                 // { cartPath, cartName, file }
  const open = (cartName, relPath) => {
    const c = carts.find(x => x.name === cartName);
    if (c && /\.msgrep$/i.test(relPath)) setEditFile({ cartPath: c.path, cartName: c.name, file: relPath.replace(/^[^\\/]+[\\/]/, '') });
    else window.api.shell.openFile(absPath(cartName, relPath));
  };

  // ── examples ────────────────────────────────────────────────────────────
  const groupsOf = (r) => [
    ...r.patternSets.map((s, k) => ({ id: `s${k}:${s.name}`, label: s.name, alts: s.alts })),
    ...(r.inlinePattern ? [{ id: 'inline', label: 'inline pattern', alts: r.inlinePattern.alts }] : []),
  ];
  const exKey = (r, g, a) => `${r.cartridge}|${r.relationFile || r.patternsFile}|${rel}|${g.id}|${hash(g.alts[a])}|${hash(JSON.stringify(r.roles))}`;
  const missingAlts = (r) => groupsOf(r).flatMap(g => g.alts.map((_, a) => ({ g, a })).filter(x => !examplesRef.current[exKey(r, g, x.a)]));
  const requestsFor = (r) => groupsOf(r).reduce((n, g) => n + Math.ceil(g.alts.map((_, a) => a).filter(a => !examplesRef.current[exKey(r, g, a)]).length / BATCH), 0);

  // One LLM request: up to BATCH patterns of one group of one row.
  const runBatch = async (r, g, idx) => {
    const cart = carts.find(c => c.name === r.cartridge);
    const fileAbs = absPath(r.cartridge, r.patternsFile);
    const texts = idx.map(a => g.alts[a]);
    const names = [...new Set(texts.flatMap(t => t.match(/[$@][A-Za-z_]\w*/g) || []))].filter(n => !SKIP_MACROS.has(n));
    const dres = names.length ? await window.api.relation.macroDefs({ cartPath: cart.path, file: fileAbs, names }) : { ok: true, defs: {} };
    const defs = dres.ok ? dres.defs : {};
    const roleTxt = (k, word) => r.roles?.[k] ? `${word}: variable ${r.roles[k].var}, entity types ${r.roles[k].types.join(' / ')}` : `${word}: (not declared)`;
    const user = [
      `Relation type: ${rel}`,
      roleTxt('in', 'Regulator (in)'), roleTxt('out', 'Target (out)'),
      Object.keys(defs).length ? 'Word-set definitions (shortened):\n' + Object.entries(defs).map(([n, d]) => `${n} = ${d}`).join('\n') : '',
      `Patterns (${texts.length}):`,
      ...texts.map((t, n) => `${n + 1}. ${t}`),
    ].filter(Boolean).join('\n');
    const reply = await callLlm([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      { fn: 'relpat.examples', grounding: false, json: true, maxTokens: 8192 });      // Gemini: no search tool, JSON mode, room for 20 sentences (and any thinking)
    const arr = parseSentences(reply, texts.length);
    if (!arr) throw new Error('The LLM reply could not be read as a list of sentences. Reply began: ' + JSON.stringify(String(reply).slice(0, 160)));
    const next = { ...examplesRef.current };            // no await between read and write → safe with parallel requests
    idx.forEach((a, n) => { if (typeof arr[n] === 'string' && arr[n].trim()) next[exKey(r, g, a)] = arr[n].trim(); });
    saveCache(next);
    examplesRef.current = next;
    setExamples(next);
  };

  // Runs the missing batches of the given rows with CONCURRENCY requests in flight.
  const runRows = async (rowIdxs, onRowDone) => {
    const tasks = [];
    for (const ri of rowIdxs) {
      const r = rows[ri];
      for (const g of groupsOf(r)) {
        const todo = g.alts.map((_, a) => a).filter(a => !examplesRef.current[exKey(r, g, a)]);
        for (let i = 0; i < todo.length; i += BATCH) tasks.push({ ri, r, g, idx: todo.slice(i, i + BATCH) });
      }
    }
    const left = {};
    tasks.forEach(t => { left[t.ri] = (left[t.ri] || 0) + 1; });
    setRowErrors(e => { const n = { ...e }; rowIdxs.forEach(ri => { n[ri] = ''; }); return n; });
    setBusyRows(b => { const n = { ...b }; Object.keys(left).forEach(ri => { n[ri] = true; }); return n; });
    let next = 0, aborted = false;
    const finishOne = (ri) => {
      if (--left[ri] > 0) return;
      setBusyRows(b => { const n = { ...b }; delete n[ri]; return n; });
      if (onRowDone) onRowDone();
    };
    const worker = async () => {
      while (!aborted && !stopRef.current) {
        const t = tasks[next++];
        if (!t) break;
        try { await runBatch(t.r, t.g, t.idx); }
        catch (e) {
          setRowErrors(x => ({ ...x, [t.ri]: e.message }));
          if (/limit reached|not configured|No LLM model/.test(e.message)) aborted = true;     // no point in sending more
        }
        finishOne(t.ri);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
    setBusyRows(b => { const n = { ...b }; Object.keys(left).forEach(ri => { delete n[ri]; }); return n; });   // rows left unfinished after Stop / abort
  };

  const generateRow = (r, ri) => { stopRef.current = false; return runRows([ri]); };

  // Regulator / Target boxes: the entity types the declarations of this relation type use as "in" / "out" (of the cartridge chosen). A declaration is shown when one of its
  // "in" types is checked as regulator AND one of its "out" types is checked as target; a declaration whose types are not declared is always shown.
  const inCart = (r) => !cartFilter || r.cartridge === cartFilter;
  const typesOf = (r, k) => (r.roles && r.roles[k] && r.roles[k].types) || [];
  const TABLE_TYPES = NODE_TYPE_RANGES.map(([n]) => n);
  const usedIn = new Set((rows || []).filter(inCart).flatMap(r => typesOf(r, 'in'))), usedOut = new Set((rows || []).filter(inCart).flatMap(r => typesOf(r, 'out')));
  const ordered = (used) => [...TABLE_TYPES.filter(t => used.has(t)), ...[...used].filter(t => !TABLE_TYPES.includes(t)).sort()];   // only the types the relation uses, in the order of the shared table
  const regTypes = ordered(usedIn), tgtTypes = ordered(usedOut);
  const picked = (types, off) => types.filter(t => !off.has(t));
  const passes = (r) => {
    const a = typesOf(r, 'in'), b = typesOf(r, 'out');
    return (!a.length || a.some(t => !regOff.has(t))) && (!b.length || b.some(t => !tgtOff.has(t)));
  };
  const inCartIdx = (rows || []).map((r, i) => i).filter(i => inCart(rows[i]));
  const matchIdx = inCartIdx.filter(i => passes(rows[i]));                        // the declarations that match the checked entity types
  const visibleIdx = page === 'results' && showAll ? inCartIdx : matchIdx;       // what the results page lists
  const hiddenCount = inCartIdx.length - matchIdx.length;
  const toggle = (setOff, t) => setOff(o => { const n = new Set(o); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const typeBox = (title, types, off, setOff) => (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', width: 300, flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 3 }}>
        <b style={{ fontSize: 12 }}>{title}</b>
        <a href="#" className="text-xs" style={LINK} onClick={e => { e.preventDefault(); setOff(new Set()); }}>all</a>
        <a href="#" className="text-xs" style={LINK} onClick={e => { e.preventDefault(); setOff(new Set(types)); }}>none</a>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '1px 10px' }}>
        {types.map(t => (
          <label key={t} style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={!off.has(t)} onChange={() => toggle(setOff, t)} />{t}
          </label>
        ))}
      </div>
    </div>
  );
  const visible = visibleIdx.map(i => rows[i]);

  const generateAll = async () => {
    const todo = visibleIdx.filter(i => missingAlts(rows[i]).length > 0);
    const reqs = todo.reduce((n, i) => n + requestsFor(rows[i]), 0);
    if (!reqs) return;
    const q = await getLlmRemainingToday();
    if (!window.confirm(`Generate examples for ${todo.length} row(s)?\n\nThis needs about ${reqs} LLM request(s) (${BATCH} patterns per request, ${CONCURRENCY} in parallel).\nToday: ${q.used} of ${q.limit} requests used, ${q.remaining} left.`)) return;
    stopRef.current = false;
    let done = 0;
    setBulk({ done: 0, total: todo.length });
    await runRows(todo, () => setBulk({ done: ++done, total: todo.length }));
    setBulk(null);
  };

  const FileLink = ({ cart, file, line }) => (
    <a href="#" className="mono" style={{ ...LINK, fontSize: 11.5, wordBreak: 'break-all' }} title="Open in editor"
      onClick={(e) => { e.preventDefault(); open(cart, file); }}>
      {file}{line ? `:${line}` : ''}
    </a>
  );

  const AltList = ({ r, g }) => g.alts.map((a, n) => {
    const ex = examples[exKey(r, g, n)];
    return (
      <div key={n} style={{ marginBottom: 6 }}>
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 11 }}>{a}</pre>
        {ex && <div style={{ fontSize: 12, fontStyle: 'italic', margin: '1px 0 0 10px', color: 'var(--text-dim)' }}>↳ {renderExample(ex)}</div>}
      </div>
    );
  });

  return (
    <>
    <div className="modal-backdrop" style={{ zIndex: 10000 }}>
      <div className="modal" style={{ width: 1280, maxWidth: '97vw', maxHeight: '94vh', overflowY: 'auto' }}>
        <div className="modal-title">Patterns for relations</div>

        {page === 'select' && (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 12 }}>
            {rows && rows.length > 0 && typeBox('Regulator', regTypes, regOff, setRegOff)}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', alignSelf: 'center', justifyContent: 'center' }}>
              <label style={{ fontSize: 13 }}>Relation type&nbsp;
                <select className="form-control" style={{ width: 240, display: 'inline-block' }} value={rel} onChange={e => scan(e.target.value)}>
                  <option value="">— choose —</option>
                  {types.map(t => <option key={t.name} value={t.name}>{t.name}{t.alias ? ` (GraphExplorer: ${t.alias})` : ''}</option>)}
                </select>
              </label>
              {rows && (
                <label style={{ fontSize: 13 }}>Cartridge&nbsp;
                  <select className="form-control" style={{ width: 180, display: 'inline-block' }} value={cartFilter} onChange={e => setCartFilter(e.target.value)}>
                    <option value="">All</option>
                    {[...new Set(rows.map(r => r.cartridge))].sort().map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              )}
              {busy && <span><span className="spinner" /> Scanning pattern libraries…</span>}
              {rows && !busy && <span className="text-sm text-muted">{matchIdx.length}{matchIdx.length !== inCartIdx.length ? ' of ' + inCartIdx.length : ''} declaration(s) match</span>}
              {rows && rows.length > 0 && (
                <button className="btn btn-primary" disabled={!matchIdx.length} onClick={() => setPage('results')} title="List the patterns of the declarations that match the checked entity types">Show patterns</button>
              )}
            </div>
            {rows && rows.length > 0 && typeBox('Target', tgtTypes, tgtOff, setTgtOff)}
          </div>
        )}
        {page === 'results' && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setPage('select')} title="Back to the relation type and entity types">← Change selection</button>
            <span className="text-sm"><b>{rel}</b>{cartFilter ? ' · ' + cartFilter : ''} · Regulator: {picked(regTypes, regOff).join(', ') || '—'} · Target: {picked(tgtTypes, tgtOff).join(', ') || '—'}</span>
            <span className="text-sm text-muted">{visible.length} of {inCartIdx.length} row(s)</span>
            {hiddenCount > 0 && !showAll && <span className="text-sm">{hiddenCount} hidden by the entity type selection — <a href="#" style={LINK} onClick={e => { e.preventDefault(); setShowAll(true); }}>show all {inCartIdx.length}</a></span>}
            {showAll && hiddenCount > 0 && <span className="text-sm">showing all, including {hiddenCount} that do not match the selection — <a href="#" style={LINK} onClick={e => { e.preventDefault(); setShowAll(false); }}>show only matching</a></span>}
            {visible.length > 0 && !bulk && (
              <button className="btn btn-secondary btn-sm" onClick={generateAll} title="Ask the LLM for an example sentence for every pattern shown">✎ Examples for all rows</button>
            )}
            {bulk && (
              <span className="text-sm"><span className="spinner" /> Examples {bulk.done}/{bulk.total} rows…{' '}
                <button className="btn btn-secondary btn-sm" onClick={() => { stopRef.current = true; }}>Stop</button></span>
            )}
          </div>
        )}

        {error && <div className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}
        {rows && rows.length === 0 && <div className="alert alert-warning">No CONTROL declaration with ControlType = "{rel}" found in any pattern library.</div>}

        {page === 'results' && visible.length > 0 && (
          <div className="table-wrap">
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr><th style={{ width: '24%' }}>Control declaration</th><th style={{ width: '15%' }}>File containing it</th>
                  <th>Patterns used by the control</th><th style={{ width: '15%' }}>File containing the patterns</th></tr>
              </thead>
              <tbody>
                {visibleIdx.map((ri) => {
                  const r = rows[ri];
                  const missing = missingAlts(r).length;
                  return (
                    <tr key={ri} style={{ verticalAlign: 'top' }}>
                      <td><div className="text-xs text-muted">{r.cartridge}</div><code style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{r.control}</code></td>
                      <td><FileLink cart={r.cartridge} file={r.controlFile} line={r.controlLine} /></td>
                      <td>
                        <div style={{ marginBottom: 4 }}>
                          <button className="btn btn-secondary btn-sm" style={{ fontSize: 11, padding: '1px 8px' }}
                            disabled={!!busyRows[ri] || !!bulk || missing === 0}
                            onClick={() => generateRow(r, ri).catch(() => { })}
                            title={missing ? `${requestsFor(r)} LLM request(s)` : 'All patterns of this row already have an example'}>
                            {busyRows[ri] ? <><span className="spinner" /> Generating…</> : missing ? '✎ Examples' : '✓ Examples'}
                          </button>
                          {rowErrors[ri] && <span className="text-xs" style={{ color: 'var(--danger, #e06c75)', marginLeft: 8 }}>{rowErrors[ri]}</span>}
                        </div>
                        {groupsOf(r).map((g, k) => (
                          <details key={k} open={g.id === 'inline' || !!g.alts.some((_, n) => examples[exKey(r, g, n)])} style={{ marginBottom: 4 }}>
                            <summary>
                              {g.id === 'inline'
                                ? <span className="text-muted">pattern written in the rule file after “:” — {r.inlinePattern.alternatives} pattern{r.inlinePattern.alternatives === 1 ? '' : 's'}{r.sharedPattern ? ' (shared: written after the last CONTROL of this group, which has the same pattern)' : ''}</span>
                                : <><code>{g.label}</code> <span className="text-muted">— {r.patternSets[k].alternatives} pattern{r.patternSets[k].alternatives === 1 ? '' : 's'}</span></>}
                            </summary>
                            <div style={{ maxHeight: 340, overflow: 'auto', margin: '4px 0' }}><AltList r={r} g={g} /></div>
                          </details>
                        ))}
                      </td>
                      <td><FileLink cart={r.cartridge} file={r.patternsFile} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
    {editFile && <FileEditorDialog key={editFile.cartPath + editFile.file} cartPath={editFile.cartPath} cartName={editFile.cartName} file={editFile.file} onClose={() => setEditFile(null)} />}
    </>
  );
}
