import React, { useState, useEffect, useRef, useMemo } from 'react';

// Batch Import source "CENtree": the user ticks the ontologies to take (the whole ontology, or only some of its branches), the app downloads them
// from CENtree and writes ONE aggregated file (name ⇥ synonyms) that the normal Batch Import then analyzes against the dictionaries
// (Aggregated format; the entity type, organism, target table ... are chosen below, as for any file).
//
// Branches: an ontology with a hierarchy shows how many branches it has; "Branches" opens its root classes, their children and grandchildren (depth 2).
// Ticking a branch takes that class and everything below it. Ticking the whole ontology takes everything (its branches are then not needed).
// props: onReady({ file, count }) — Batch Import then selects the file; the user chooses the entity type and runs "Analyze" as for any file.

const MAX_DEPTH = 2;                                    // roots (0), their children (1), their children (2)
// A readable page for a class. http://purl.obolibrary.org/obo/... redirects to raw RDF/XML that browsers cannot show, so OBO ids go to the EBI Ontology Lookup Service;
// every other address (identifiers.org, w3id.org ...) is opened as it is.
const viewUrl = (iri) => {
  const o = /^https?:\/\/purl\.obolibrary\.org\/obo\/([A-Za-z]+)_[\w.-]+$/.exec(iri);
  return o ? `https://www.ebi.ac.uk/ols4/ontologies/${o[1].toLowerCase()}/classes/${encodeURIComponent(encodeURIComponent(iri))}` : iri;
};
// short id of a class from its IRI, so that a borrowed class is recognisable: http://purl.obolibrary.org/obo/HP_0000001 -> HP:0000001, http://identifiers.org/ncbigene/26468 -> ncbigene:26468
const curie = (iri) => {
  const o = /\/obo\/([A-Za-z]+)_([\w.-]+)$/.exec(iri); if (o) return o[1] + ':' + o[2];
  const i = /identifiers\.org\/([\w.]+)\/([^/]+)$/i.exec(iri); if (i) return i[1] + ':' + i[2];
  return '';
};
let kept = null;                                        // the panel is unmounted while Batch Import shows its results: its state is kept here while the app runs

// runs fn over items, `limit` at a time; a failure of one item does not stop the others
async function runPool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = items[i++]; try { await fn(n); } catch { /* the user can still open the branch by hand */ } }
  }));
}

// Branch picker of one ontology: lazily loaded tree, each class can be ticked.
function BranchTree({ ontId, picked, setPicked, setPickedMany, wholeOn, disabled, cache, setCache, counts, counting, countErr, auto, onCount, nTerms }) {
  const [open, setOpen] = useState(() => new Set());
  const [leafOpen, setLeafOpen] = useState(false);            // the group of top-level classes without children
  const [err, setErr] = useState('');
  const key = (cid) => ontId + '|' + (cid || 'ROOT');
  const load = async (node) => {                         // node null = the root classes
    const k = key(node && node.classId);
    if (cache[k]) return cache[k];
    const r = await window.api.centree.branchChildren({ ontologyId: ontId, parentClassId: node ? node.classId : null });
    if (!r.ok) { setErr(r.error); return null; }
    setCache(c => ({ ...c, [k]: r.data }));
    return r.data;
  };
  useEffect(() => {                                       // a single root class is only the top of the hierarchy: open it at once
    (async () => {
      const roots = await load(null);
      if (roots && roots.length === 1 && roots[0].numberOfChildren > 0) { setOpen(new Set([roots[0].primaryId])); load(roots[0]); }
    })();
  }, [ontId]);                                            // eslint-disable-line react-hooks/exhaustive-deps
  // The children of branches known to have children are fetched in the background, 6 at a time, so that opening a branch is instant (two levels deep, at most 24 requests per round)
  const prefetching = useRef(new Set());
  useEffect(() => {
    const roots = cache[key(null)]; if (!roots) return;
    const todo = [];
    const visit = (list, depth) => {
      for (const n of list) {
        if (depth >= MAX_DEPTH) continue;
        const sub = cache[key(n.classId)];
        if (sub) visit(sub, depth + 1);
        else if (counts[n.primaryId] && counts[n.primaryId].direct > 0 && !prefetching.current.has(n.classId)) todo.push(n);
      }
    };
    visit(roots, 0);
    const batch = todo.slice(0, 24);
    batch.forEach(n => prefetching.current.add(n.classId));
    if (batch.length) runPool(batch, 6, n => load(n));
  }, [cache, counts]);                                    // eslint-disable-line react-hooks/exhaustive-deps
  const toggleOpen = (n) => { setOpen(s => { const x = new Set(s); x.has(n.primaryId) ? x.delete(n.primaryId) : x.add(n.primaryId); return x; }); load(n); };
  const render = (parent, depth) => {
    const list = cache[key(parent && parent.classId)];
    if (!list) return <div className="text-xs text-muted" style={{ paddingLeft: depth * 22 }}><span className="spinner" /> loading…</div>;
    if (!list.length) return <div className="text-xs text-muted" style={{ paddingLeft: depth * 22 }}>no classes</div>;
    const renderNode = (n, d = depth) => (
      <div key={n.primaryId}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '2px 0', paddingLeft: d * 22 }}>
          {d < MAX_DEPTH && !(counts[n.primaryId] && counts[n.primaryId].direct === 0 && !n.numberOfChildren)
            ? <button className="btn btn-secondary" style={{ padding: '0 6px', minWidth: 22 }} onClick={() => toggleOpen(n)}>{open.has(n.primaryId) ? '▾' : '▸'}</button>
            : <span style={{ display: 'inline-block', width: 22, flex: '0 0 22px' }} />}
          <input type="checkbox" style={{ marginTop: 3, flex: '0 0 auto' }} checked={!wholeOn && !!picked[n.primaryId]} disabled={disabled} onChange={() => setPicked(ontId, n)} />
          {/^https?:\/\//i.test(n.primaryId)
            ? <a href={viewUrl(n.primaryId)} title={n.primaryId + (viewUrl(n.primaryId) !== n.primaryId ? '\nOpens in the EBI Ontology Lookup Service' : '\nOpens in the browser')} style={{ flex: '0 0 auto', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--accent, #7c6af7)', cursor: 'pointer', textDecoration: 'underline' }}
                onClick={e => { e.preventDefault(); window.api.shell.openExternal(viewUrl(n.primaryId)); }}>{n.label}</a>
            : <span title={n.primaryId} style={{ flex: '0 0 auto', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</span>}
          {curie(n.primaryId) && curie(n.primaryId).toLowerCase() !== String(n.label).toLowerCase() && <span className="text-xs text-muted mono" style={{ flex: '0 0 auto', marginTop: 1 }} title="Where the class comes from">{curie(n.primaryId)}</span>}
          {(() => {                                              // children: what CENtree reports, else what the downloaded ontology shows; total = the branch and everything below it
            const c = counts[n.primaryId]; const direct = c ? c.direct : n.numberOfChildren;
            if (!direct && !(c && c.total)) return null;
            return <span className="text-xs text-muted" style={{ flex: '0 0 auto', marginTop: 1, whiteSpace: 'nowrap' }} title="Direct children · all terms in the branch (the branch itself included)">
              ({(direct || 0).toLocaleString()} children{c ? `, ${c.total.toLocaleString()} terms` : ''})</span>;
          })()}
          {n.description && <div className="text-xs text-muted" title={n.description} style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{n.description}</div>}
        </div>
        {open.has(n.primaryId) && d < MAX_DEPTH && render(n, d + 1)}
      </div>
    );
    // Top-level classes without any child are usually artifacts of the ontology import: they are collected in one collapsed group "Leafs" (known once the branch counts are there)
    const isLeaf = (n) => depth === 0 && counts[n.primaryId] && counts[n.primaryId].direct === 0;
    const leaves = list.filter(isLeaf);
    const allLeafPicked = leaves.length > 0 && leaves.every(n => picked[n.primaryId]);
    return (<>
      {list.filter(n => !isLeaf(n)).map(n => renderNode(n))}
      {leaves.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '2px 0' }}>
            <button className="btn btn-secondary" style={{ padding: '0 6px', minWidth: 22 }} onClick={() => setLeafOpen(v => !v)}>{leafOpen ? '▾' : '▸'}</button>
            <input type="checkbox" style={{ marginTop: 3, flex: '0 0 auto' }} checked={!wholeOn && allLeafPicked} disabled={disabled} onChange={() => setPickedMany(ontId, leaves, !allLeafPicked)} title="Take all of them" />
            <span style={{ fontStyle: 'italic', flex: '0 0 auto' }}>Leafs</span>
            <span className="text-xs text-muted" style={{ marginTop: 1 }}>({leaves.length.toLocaleString()} top-level classes without children: usually artifacts of the ontology import, rarely worth importing)</span>
          </div>
          {leafOpen && leaves.map(n => renderNode(n, depth + 1))}
        </div>
      )}
    </>);
  };
  return (
    <div style={{ padding: '6px 4px 8px' }}>
      <div className="text-xs text-muted" style={{ marginBottom: 4 }}>
        {wholeOn ? 'The whole ontology is ticked, so everything is taken. Tick a branch here to take only that branch instead.' : 'Tick the branches to take (a branch includes everything below it). Import one entity type at a time: tick the branches of one entity type, download, then the next.'}
      </div>
      {err && <div className="alert alert-danger">{err}</div>}
      {countErr && <div className="text-xs" style={{ color: 'var(--danger, #c33)' }}>Branch counts failed: {countErr}</div>}
      {counting && <div className="text-xs text-muted"><span className="spinner" /> counting the terms of each branch (downloads the ontology once)…</div>}
      {!auto && !counting && <div className="text-xs text-muted" style={{ marginBottom: 4 }}>
        <button className="btn btn-secondary" style={{ padding: '0 8px', fontSize: 11 }} onClick={onCount}>Count the terms of each branch</button> downloads the whole ontology ({nTerms ? nTerms.toLocaleString() + ' terms' : 'large'}) once; the later import reuses it.
      </div>}
      {render(null, 0)}
    </div>
  );
}

export default function CentreeImport({ onReady }) {
  const k = kept || {};
  const [busy, setBusy]           = useState(false);
  const [progress, setProgress]   = useState(null);
  const [error, setError]         = useState('');
  const [ready, setReady]         = useState(k.ready ?? null);
  const [onts, setOnts]           = useState(k.onts ?? null);           // [{ id, name, loaded, version, lastLoaded, lastModified, type, keywords, longName, description }]
  const [stats, setStats]         = useState(k.stats ?? {});            // ontology id -> { classes, obsoleteClasses, properties, instances } | { error }
  const [shape, setShape]         = useState(k.shape ?? {});            // ontology id -> { roots, branches } | { error }
  const [selOnts, setSelOnts]     = useState(() => new Set(k.selOnts || []));      // whole ontologies
  const [picked, setPicked]       = useState(k.picked ?? {});           // ontology id -> { branch primaryId: { label } }
  const [openBr, setOpenBr]       = useState(() => new Set(k.openBr || []));       // ontologies whose branches are shown
  const [tree, setTree]           = useState(k.tree ?? {});             // branch tree cache
  const [counts, setCounts]       = useState(k.counts ?? {});           // ontology id -> { branch primaryId: { direct, total } }
  const [countOn, setCountOn]     = useState(() => new Set(k.countOn || []));      // large ontologies the user asked to count
  const [countBusy, setCountBusy] = useState(null);                     // ontology id being counted
  const [countErr, setCountErr]   = useState({});                       // ontology id -> message
  const [filter, setFilter]       = useState(k.filter ?? '');
  const [showUnloaded, setShowUnloaded] = useState(k.showUnloaded ?? false);
  const [sort, setSort]           = useState(k.sort ?? { key: 'lastModified', dir: -1 });     // newest modification on top
  const [ontErr, setOntErr]       = useState('');
  const [ontBusy, setOntBusy]     = useState(false);
  const [showOnts, setShowOnts]   = useState(k.showOnts ?? true);
  const runId = useRef(null);
  useEffect(() => { kept = { counts, countOn: [...countOn], ready, onts, stats, shape, selOnts: [...selOnts], picked, openBr: [...openBr], tree, filter, showUnloaded, sort, showOnts }; }, [ready, onts, stats, shape, selOnts, picked, openBr, tree, filter, showUnloaded, sort, showOnts]);

  const loadOnts = async () => {
    setOntBusy(true); setOntErr('');
    const r = await window.api.centree.listOntologies();
    setOntBusy(false);
    if (!r.ok) { setOntErr(r.error); return; }
    setOnts(r.data);
    const ids = r.data.filter(o => o.loaded).map(o => o.id);          // sizes and branch counts of the loaded ontologies, in the background
    window.api.centree.ontologyStats(ids).then(s => { if (s.ok) setStats(s.data); }).catch(() => {});
    window.api.centree.ontologyShape(ids).then(s => { if (s.ok) setShape(s.data); }).catch(() => {});
  };
  useEffect(() => {
    window.api.settings.get().then(s => {
      if (!(kept && kept.selOnts)) setSelOnts(new Set(s.centreeSelectedOntologies || []));
      if (!(kept && kept.picked)) setPicked(s.centreeSelectedBranches || {});
    }).catch(() => {});
    if (!(kept && kept.onts)) loadOnts();
    return window.api.centree.onProgress(p => { if (p.runId === runId.current) setProgress(p); });
  }, []);                                                              // eslint-disable-line react-hooks/exhaustive-deps

  const saveSel = (ids, br) => {
    window.api.settings.set({ centreeSelectedOntologies: [...ids], centreeSelectedBranches: br });
  };
  const chooseOnts = (ids) => { const n = new Set(ids); setSelOnts(n); saveSel(n, picked); };
  const toggleOnt = (id) => { const n = new Set(selOnts); n.has(id) ? n.delete(id) : n.add(id); chooseOnts(n); };
  const toggleBranch = (ontId, node) => {
    let ids = selOnts;
    let cur = { ...(picked[ontId] || {}) };
    if (selOnts.has(ontId)) {                              // the whole ontology was ticked: switch to this branch only
      ids = new Set(selOnts); ids.delete(ontId); setSelOnts(ids);
      cur = { [node.primaryId]: { label: node.label } };
    } else if (cur[node.primaryId]) delete cur[node.primaryId];
    else cur[node.primaryId] = { label: node.label };
    const next = { ...picked, [ontId]: cur }; if (!Object.keys(cur).length) delete next[ontId];
    setPicked(next); saveSel(ids, next);
  };
  const toggleBranches = (ontId, nodes, on) => {          // tick / untick several branches at once (the group "Leafs")
    let ids = selOnts; let cur = { ...(picked[ontId] || {}) };
    if (selOnts.has(ontId)) { ids = new Set(selOnts); ids.delete(ontId); setSelOnts(ids); cur = {}; }
    for (const n of nodes) { if (on) cur[n.primaryId] = { label: n.label }; else delete cur[n.primaryId]; }
    const next = { ...picked, [ontId]: cur }; if (!Object.keys(cur).length) delete next[ontId];
    setPicked(next); saveSel(ids, next);
  };
  const toggleOpenBr = (id) => setOpenBr(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Branch counts (children, terms below) come from the downloaded ontology: automatic for ontologies up to 100,000 terms, on request for larger ones.
  const autoCount = (id) => countOn.has(id) || (stats[id] && typeof stats[id].classes === 'number' && stats[id].classes <= 100000);
  const missingCounts = (id) => {
    const ids = [];
    for (const [key, list] of Object.entries(tree)) if (key.startsWith(id + '|')) for (const n of list) if (!(counts[id] && counts[id][n.primaryId])) ids.push(n.primaryId);
    return ids;
  };
  useEffect(() => {
    if (countBusy) return;
    for (const id of openBr) {
      if (!autoCount(id) || countErr[id]) continue;
      const ids = missingCounts(id);
      if (!ids.length) continue;
      (async () => {
        setCountBusy(id); runId.current = 'n' + Date.now();
        const r = await window.api.centree.branchCounts({ runId: runId.current, ontologyId: id, primaryIds: ids });
        setCountBusy(null);
        if (r.ok) setCounts(c => ({ ...c, [id]: { ...(c[id] || {}), ...r.data } }));
        else if (!r.cancelled) setCountErr(e => ({ ...e, [id]: r.error }));
      })();
      break;
    }
  }, [tree, openBr, countOn, stats, countBusy, counts]);                  // eslint-disable-line react-hooks/exhaustive-deps

  const day = (x) => { if (!x) return ''; const t = typeof x === 'number' ? x : Date.parse(x); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : String(x).slice(0, 10); };
  const sortBy = (key) => setSort(s => s.key === key ? { key, dir: -s.dir } : { key, dir: 1 });
  const sortMark = (key) => sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '';
  const nBranches = (o) => (shape[o.id] && typeof shape[o.id].branches === 'number' ? shape[o.id].branches : null);
  const shownOnts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const val = (o) => sort.key === 'selected' ? ((selOnts.has(o.id) ? 2 : 0) + (picked[o.id] ? 1 : 0))
      : sort.key === 'classes' ? (stats[o.id] && typeof stats[o.id].classes === 'number' ? stats[o.id].classes : '')
      : sort.key === 'branches' ? (nBranches(o) ?? '')
      : sort.key === 'lastLoaded' ? day(o.lastLoaded) : sort.key === 'lastModified' ? day(o.lastModified)
      : String(o[sort.key] ?? '').toLowerCase();
    return (onts || [])
      .filter(o => (showUnloaded || o.loaded) && (!q || [o.id, o.name, o.longName, o.description, o.type, ...(o.keywords || [])].join(' ').toLowerCase().includes(q)))
      .sort((a, b) => {
        const x = val(a), y = val(b);
        if (x === '' && y !== '') return 1;
        if (y === '' && x !== '') return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || a.name.localeCompare(b.name);
      });
  }, [onts, filter, showUnloaded, sort, selOnts, picked, stats, shape]);          // eslint-disable-line react-hooks/exhaustive-deps

  // what will be downloaded: whole ontologies, and the ticked branches of the others
  const sources = useMemo(() => {
    const byId = new Map((onts || []).map(o => [o.id, o]));
    const out = [];
    for (const id of selOnts) { const o = byId.get(id); if (o) out.push({ id, name: o.name, whole: true }); }
    for (const [id, br] of Object.entries(picked)) {
      if (selOnts.has(id) || !byId.has(id)) continue;
      out.push({ id, name: byId.get(id).name, whole: false, branches: Object.entries(br).map(([primaryId, v]) => ({ primaryId, label: v.label })) });
    }
    return out;
  }, [onts, selOnts, picked]);
  const nBranchPicked = sources.filter(s => !s.whole).reduce((n, s) => n + s.branches.length, 0);
  const wholeTerms = sources.filter(s => s.whole).reduce((n, s) => n + ((stats[s.id] && stats[s.id].classes) || 0), 0);

  const go = async () => {
    if (!sources.length) { setError('Tick at least one ontology, or one branch of an ontology.'); return; }
    setError(''); setReady(null); setProgress(null);
    runId.current = 'd' + Date.now(); setBusy(true);
    const r = await window.api.centree.downloadSelected({ runId: runId.current, sources });
    setBusy(false); setProgress(null);
    if (!r.ok) { if (!r.cancelled) setError(r.error); return; }
    if (!r.count) { setError('Nothing to import: the selection has no terms with a name.'); return; }
    setReady({ file: r.file, count: r.count, per: r.per });
    onReady?.({ file: r.file, count: r.count });
  };
  const cancel = () => window.api.centree.cancel(runId.current);

  const heads = [['selected', '✓'], ['name', 'Ontology'], ['branches', 'Branches'], ['description', 'Description'], ['id', 'Id'], ['version', 'Version'], ['classes', 'Terms'],['lastLoaded', 'Last loaded'], ['lastModified', 'Last modified']];
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <button className="btn btn-secondary" style={{ padding: '0 8px' }} onClick={() => setShowOnts(v => !v)}>{showOnts ? '▾' : '▸'}</button>
        <strong>Ontologies to import</strong>
        <span className="text-xs text-muted">{selOnts.size} whole{nBranchPicked ? `, ${nBranchPicked} branch${nBranchPicked === 1 ? '' : 'es'}` : ''} selected{onts ? ` · ${onts.filter(o => o.loaded).length} loaded in CENtree` : ''}</span>
        {ontBusy && <span className="text-xs text-muted"><span className="spinner" /> loading the list…</span>}
        <button className="btn btn-secondary" style={{ padding: '0 8px', fontSize: 11 }} disabled={ontBusy || busy} onClick={loadOnts}>↻ Refresh list</button>
      </div>
      {ontErr && <div className="alert alert-danger">{ontErr} <button className="btn btn-secondary" style={{ marginLeft: 8 }} onClick={loadOnts}>Retry</button></div>}
      {showOnts && onts && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
            <input className="form-control" style={{ width: 240 }} placeholder="Filter by name, id, type, keyword…" value={filter} onChange={e => setFilter(e.target.value)} />
            <button className="btn btn-secondary" disabled={busy} onClick={() => chooseOnts([...selOnts, ...shownOnts.filter(o => o.loaded).map(o => o.id)])}>Select shown</button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => chooseOnts([...selOnts].filter(id => !shownOnts.some(o => o.id === id)))}>Deselect shown</button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => { chooseOnts([]); setPicked({}); saveSel([], {}); }}>None</button>
            <label className="text-xs text-muted" style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={showUnloaded} onChange={e => setShowUnloaded(e.target.checked)} /> show not loaded ({(onts || []).filter(o => !o.loaded).length})
            </label>
          </div>
          <div className="table-wrap" style={{ maxHeight: 340 }}>
            <table className="data-table compact">
              <thead><tr>
                {heads.map(([key, label]) => (
                  <th key={key} onClick={() => sortBy(key)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title="Click to sort">{label}{sortMark(key)}</th>
                ))}
              </tr></thead>
              <tbody>
                {shownOnts.map(o => {
                  const nb = nBranches(o), np = Object.keys(picked[o.id] || {}).length, st = stats[o.id];
                  return (
                    <React.Fragment key={o.id}>
                      <tr style={!o.loaded ? { opacity: 0.5 } : undefined}>
                        <td><input type="checkbox" checked={selOnts.has(o.id)} disabled={!o.loaded || busy} title={o.loaded ? 'Take the whole ontology' : 'Not loaded in CENtree'} onChange={() => toggleOnt(o.id)} /></td>
                        <td title={(o.keywords || []).length ? 'Keywords: ' + o.keywords.join(', ') : ''} style={{ whiteSpace: 'nowrap' }}>
                          <a href={'https://www.ebi.ac.uk/ols4/ontologies/' + encodeURIComponent(String(o.id).toLowerCase())}
                            title={'Browse this ontology in the EBI Ontology Lookup Service (public ontologies only; in-house ones such as embio are not there)' + ((o.keywords || []).length ? '\nKeywords: ' + o.keywords.join(', ') : '')}
                            style={{ color: 'var(--accent, #7c6af7)', textDecoration: 'underline', cursor: 'pointer' }}
                            onClick={e => { e.preventDefault(); e.stopPropagation(); window.api.shell.openExternal('https://www.ebi.ac.uk/ols4/ontologies/' + encodeURIComponent(String(o.id).toLowerCase())); }}>{o.name}</a>{!o.loaded ? ' (not loaded)' : ''}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {o.loaded && (nb === null ? (shape[o.id] && shape[o.id].error ? '?' : '…') : nb > 0
                            ? <button className="btn btn-secondary" style={{ padding: '0 6px', fontSize: 11 }} disabled={busy} onClick={() => toggleOpenBr(o.id)} title="Choose branches of this ontology">
                                {openBr.has(o.id) ? '▾' : '▸'} {nb.toLocaleString()}{np ? ` (${np} ticked)` : ''}
                              </button>
                            : '—')}
                        </td>
                        <td title={[o.longName, o.description].filter(Boolean).join(' — ')} style={{ maxWidth: 420, minWidth: 220 }}>
                          {o.longName && <div style={{ fontWeight: 600 }}>{o.longName}</div>}
                          {o.description && <div className="text-xs text-muted" style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{o.description}</div>}
                        </td>
                        <td className="mono">{o.id}</td>
                        <td>{o.version}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}
                          title={st && !st.error ? `${(st.classes ?? 0).toLocaleString()} classes, ${(st.obsoleteClasses || 0).toLocaleString()} obsolete, ${(st.properties || 0).toLocaleString()} properties, ${(st.instances || 0).toLocaleString()} instances` : (st && st.error) || ''}>
                          {!o.loaded ? '' : !st ? '…' : st.error ? '?' : st.classes == null ? '—' : st.classes.toLocaleString()}
                        </td>
                        <td>{day(o.lastLoaded) || (o.loaded ? '—' : '')}</td>
                        <td>{day(o.lastModified) || (o.loaded ? '—' : '')}</td>
                      </tr>
                      {openBr.has(o.id) && (
                        <tr><td></td><td colSpan={heads.length - 1}>
                          <BranchTree ontId={o.id} picked={picked[o.id] || {}} setPicked={toggleBranch} setPickedMany={toggleBranches} wholeOn={selOnts.has(o.id)} disabled={busy} cache={tree} setCache={setTree}
                            counts={counts[o.id] || {}} counting={countBusy === o.id} countErr={countErr[o.id]} auto={autoCount(o.id)} nTerms={stats[o.id] && stats[o.id].classes}
                            onCount={() => { setCountErr(e => { const n = { ...e }; delete n[o.id]; return n; }); setCountOn(s => new Set([...s, o.id])); }} />
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {!shownOnts.length && <tr><td colSpan={heads.length} className="text-muted">No ontology matches the filter.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {busy
          ? <button className="btn btn-secondary" onClick={cancel}>Cancel</button>
          : <button className="btn btn-primary" onClick={go} disabled={!sources.length}>Download selected and prepare for import</button>}
        {busy && <span className="text-xs text-muted"><span className="spinner" /> Downloading{progress ? ` ${progress.done.toLocaleString()}${progress.total ? '/' + progress.total.toLocaleString() : ''}${progress.ontology ? ' — ' + progress.ontology : ''}` : '…'}</span>}
        {!busy && sources.length > 0 && <span className="text-xs text-muted">
          {sources.length} source{sources.length === 1 ? '' : 's'}{wholeTerms ? ` · about ${wholeTerms.toLocaleString()} terms from whole ontologies` : ''}{nBranchPicked ? ` · ${nBranchPicked} branch${nBranchPicked === 1 ? '' : 'es'}` : ''}
        </span>}
      </div>
      {error && <div className="alert alert-danger" style={{ marginTop: 10 }}>{error} <button className="btn btn-secondary" style={{ marginLeft: 8 }} onClick={go}>Retry</button></div>}

      {ready && <div className="alert alert-success" style={{ marginTop: 10 }}>
        {ready.count.toLocaleString()} terms downloaded ({ready.per.map(p => `${p.name}${p.branches ? ' [' + p.branches.join(', ') + ']' : ''}: ${p.selected.toLocaleString()}`).join('; ')}).
        The file is selected below as an Aggregated file. Choose the <strong>entity type</strong> and the target table, then click <strong>Analyze</strong>: the terms are compared with the current dictionaries.
      </div>}
    </div>
  );
}
