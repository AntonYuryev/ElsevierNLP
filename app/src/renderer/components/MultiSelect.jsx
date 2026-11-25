import React, { useState, useEffect, useRef } from 'react';

// ── Multi-select checkbox dropdown ───────────────────────────────────────────
export default function MultiSelect({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (val) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };
  const selectAll  = () => onChange([...options]);
  const clearAll   = () => onChange([]);

  const buttonLabel = selected.length === 0
    ? `— All ${label.toLowerCase()}s —`
    : selected.length === 1
      ? selected[0]
      : `${selected.length} selected`;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="form-control"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          cursor: 'pointer', textAlign: 'left', width: '100%',
          background: selected.length > 0 ? 'var(--accent-subtle, rgba(var(--accent-rgb,0,120,212),0.12))' : '',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {buttonLabel}
        </span>
        <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.6 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute', zIndex: 9999, top: 'calc(100% + 3px)', left: 0, right: 0,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          maxHeight: 260, display: 'flex', flexDirection: 'column',
        }}>
          {/* Actions row */}
          <div style={{ display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <button type="button" className="btn btn-xs btn-secondary"
              style={{ fontSize: 11, padding: '1px 8px' }} onClick={selectAll}>All</button>
            <button type="button" className="btn btn-xs btn-secondary"
              style={{ fontSize: 11, padding: '1px 8px' }} onClick={clearAll}>Clear</button>
          </div>
          {/* Options list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {options.map(opt => (
              <label key={opt} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
                cursor: 'pointer', fontSize: 12,
                background: selected.includes(opt) ? 'var(--accent-subtle, rgba(var(--accent-rgb,0,120,212),0.1))' : '',
              }}>
                <input type="checkbox" checked={selected.includes(opt)} onChange={() => toggle(opt)}
                  style={{ cursor: 'pointer', flexShrink: 0 }} />
                {opt}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

