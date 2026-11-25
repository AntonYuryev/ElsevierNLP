import React, { useMemo, useState } from 'react';
import MultiSelect from './MultiSelect';
import { rgbOf } from '../utils/readerDoc';

// A table of the Results viewer that does not come from an RNEF file — the sentences of the Reader with an entity type, or with relations.
// table: { title, subtitle?, columns: [{ key, label, width }], rows: [{ <key>: text }], fileName }; exported to Excel / CSV; filtered and sorted on screen.
const PAGE = 200;
// the entities of a sentence as the Results viewer shows a node: name, type, NLP IDs — an ID opens its dictionary record
const ITEM_H = 40;                                           // every entity of a row has the same height, so the Doc Occ column lines up with the Entities column
function Entities({ items, onIdClick }) {
  return <div>{items.map((it, i) => (
    <div key={i} style={{ height: ITEM_H, overflow: 'hidden' }}>
      <div style={{ fontWeight: 600 }}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, marginRight: 5, background: 'rgb(' + rgbOf(it.type).join(',') + ')' }} />{it.name}{it.expansion ? <span className="text-muted" style={{ fontWeight: 400 }}> (= {it.expansion})</span> : null}</div>
      <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 1 }}>
        <span style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 3, padding: '1px 5px', marginRight: 4 }}>{it.type}</span>
        {it.ids.map(id => <span key={id} onClick={e => { e.stopPropagation(); onIdClick && onIdClick(id); }} style={{ cursor: 'pointer', textDecoration: 'underline dotted', marginRight: 4, color: 'var(--accent)' }} title="Click to look up the dictionary record">ID:{id}</span>)}
      </div>
    </div>
  ))}</div>;
}
// how often each entity of the row occurs in the whole document (medscan -O1 results), one number per entity, in the line of the entity
function Occurrences({ items }) {
  return <div>{items.map((it, i) => <div key={i} style={{ height: ITEM_H, fontVariantNumeric: 'tabular-nums', textAlign: 'right', fontWeight: 600 }} title={'"' + it.name + '" occurs ' + it.count + ' time(s) in the document'}>{it.count}</div>)}</div>;
}
// the sentence with its entities coloured: an entity type (a highlight in the colour of the type), or a role in a relation (regulator red, target green …, as in the RNEF viewer)
function Sentence({ segs }) {
  return <span style={{ lineHeight: 1.6 }}>{segs.map((g, i) => {
    if (g.rgb) return <span key={i} style={{ background: 'rgba(' + g.rgb.join(',') + ',0.4)', borderRadius: 2, padding: '0 1px', fontWeight: 600 }}>{g.text}</span>;
    if (g.color) return <strong key={i} style={{ color: g.color, opacity: g.dim ? 0.8 : 1, fontWeight: g.bold ? 700 : 400 }}>{g.text}</strong>;
    if (g.dim) return <span key={i} style={{ color: 'var(--text-dim)' }}>{g.text}</span>;
    return <span key={i}>{g.text}</span>;
  })}</span>;
}
export default function ResultsTable({ table, onBack, onClose, onNodeIdClick }) {
  const cols = table.columns.filter(c => !c.hidden);          // the columns on screen (a hidden one is only exported)
  const [q, setQ] = useState('');
  const filters = table.filters || [];
  const [fv, setFv] = useState({});                       // the value of every filter: an array (multi) or a text
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const rows = useMemo(() => {
    const w = q.trim().toLowerCase();
    let r = w ? table.rows.filter(x => table.columns.some(c => String(x[c.key] ?? '').toLowerCase().includes(w))) : table.rows;
    filters.forEach((f, i) => {
      const v = fv[i];
      if (f.kind === 'multi' && v && v.length) r = r.filter(x => [].concat(x[f.field] ?? []).some(t => v.includes(t)));
      else if (f.kind === 'text' && v && v.trim()) { const t = v.trim().toLowerCase(); r = r.filter(x => f.fields.some(k => String(x[k] ?? '').toLowerCase().includes(t))); }
    });
    if (sort.key) r = [...r].sort((a, b) => { const x = a[sort.key], y = b[sort.key]; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''))) * sort.dir; });
    return r;
  }, [table, q, sort, fv]);
  const optionsOf = (f) => [...new Set(table.rows.flatMap(x => [].concat(x[f.field] ?? [])).filter(Boolean))].sort();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);

  const doExport = async () => {
    setBusy(true); setMsg('');
    const res = await window.api.rnef.exportTable({ title: table.title, columns: table.columns, rows, defaultName: table.fileName || 'table.xlsx' });
    setBusy(false);
    if (res.ok) { setMsg('Saved: ' + res.filePath); window.api.shell.openFile(res.filePath); }
    else if (!res.canceled) setMsg('✗ ' + (res.error || 'Export failed'));
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Results Viewer</h1>
        <div className="flex gap-8">
          {onBack && <button className="btn btn-secondary" onClick={onBack} title="Back to the document">← Reader</button>}
          <button className="btn btn-secondary" onClick={doExport} disabled={busy || !rows.length} title="Export the rows shown (Excel, or CSV by the file name) ">{busy ? <><span className="spinner" /> Exporting…</> : '⬇ Export to Excel / CSV'}</button>
          <button className="btn btn-secondary" onClick={onClose} title="Close this table and go back to the RNEF files of the Results viewer">Open RNEF files…</button>
        </div>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="flex gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ fontSize: 14 }}>{table.title}</b>
          {table.subtitle && <span className="text-muted text-sm">{table.subtitle}</span>}
          <span style={{ flex: 1 }} />
          <input className="form-control" style={{ width: 280 }} placeholder="Search all columns" value={q} onChange={e => { setQ(e.target.value); setPage(0); }} />
          <span className="text-sm text-muted">{rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}</span>
        </div>
        {msg && <div className="text-xs" style={{ marginTop: 6, color: msg.startsWith('✗') ? 'var(--danger, #f38ba8)' : 'var(--success, #a6e3a1)' }}>{msg}</div>}
      </div>
      {filters.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(' + filters.length + ', 1fr)', gap: 12, marginBottom: 12 }}>
          {filters.map((f, i) => (
            <div key={i} className="form-group" style={{ marginBottom: 0 }}>
              <label>Filter by {f.label}</label>
              {f.kind === 'multi'
                ? <MultiSelect label={f.label} options={optionsOf(f)} selected={fv[i] || []} onChange={v => { setFv(o => ({ ...o, [i]: v })); setPage(0); }} />
                : <input className="form-control" value={fv[i] || ''} placeholder={f.placeholder || ''} onChange={e => { setFv(o => ({ ...o, [i]: e.target.value })); setPage(0); }} />}
            </div>
          ))}
        </div>
      )}
      <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - ' + (filters.length ? 330 : 260) + 'px)' }}>
        <table className="data-table" style={{ width: '100%', tableLayout: 'auto' }}>
          <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
            <tr>
              {cols.map(c => (
                <th key={c.key} style={{ cursor: 'pointer', whiteSpace: 'nowrap', minWidth: Math.min(360, (c.width || 20) * 6) }} onClick={() => { setSort(s => (s.key === c.key ? { key: c.key, dir: -s.dir } : { key: c.key, dir: 1 })); setPage(0); }}>
                  {c.label}{sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i}>{cols.map(c => <td key={c.key} style={{ verticalAlign: 'top', whiteSpace: c.key === 'sentence' || c.key === 'symbolic' || c.key === 'markup' ? 'normal' : 'pre-wrap', fontSize: 12 }}>{c.key === 'entities' && r.entityItems ? <Entities items={r.entityItems} onIdClick={onNodeIdClick} /> : c.key === 'occ' && r.entityItems ? <Occurrences items={r.entityItems} /> : r[c.key + 'Segs'] ? <Sentence segs={r[c.key + 'Segs']} /> : String(r[c.key] ?? '')}</td>)}</tr>
            ))}
            {!shown.length && <tr><td colSpan={cols.length} className="text-muted" style={{ padding: 16 }}>No rows.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex gap-8" style={{ marginTop: 8, alignItems: 'center' }}>
          <button className="btn btn-sm btn-secondary" disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
          <span className="text-sm text-muted">Page {page + 1} of {pages}</span>
          <button className="btn btn-sm btn-secondary" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>Next ›</button>
        </div>
      )}
    </div>
  );
}
