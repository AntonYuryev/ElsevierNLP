import React, { useEffect, useRef, useState } from 'react';

// Find in page, like Ctrl+F of a browser: opens with Ctrl+F (the key is caught by the main process, so it works wherever the focus is, also inside the document of the
// Reader), Enter = next match, Shift+Enter = previous, Esc = close. Chromium does the searching and the highlighting (the frame of a document included).
// Enter / Shift+Enter / Esc are taken by the main process while the bar is open (find:keys): when Chromium finds something it moves the focus into the page, and giving
// the focus back to the text box moves the start of the next search to the box itself (every "next" then stayed on the first match) — so the focus is left where it is.
export default function FindBar() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [res, setRes] = useState({ active: 0, matches: 0 });
  const input = useRef(null);
  const openRef = useRef(false);
  const timer = useRef(null);
  const pending = useRef(false);                                  // typed, the search has not started yet (Enter then starts it)

  // the main process may take Enter / Esc while the bar is open — unless the focus is in another text box (the address of the Reader, a dialog …)
  // a screen with its own finder (the Reader: window.nlpFinder) searches its document itself; then Enter / Esc are handled by the text box (nothing takes the focus away from it)
  const finder = () => (window.nlpFinder && window.nlpFinder.available() ? window.nlpFinder : null);
  const syncKeys = () => {
    const a = document.activeElement;
    const other = a && a !== input.current && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
    window.api.find.keys(openRef.current && !other && !finder());
  };
  const close = () => { clearTimeout(timer.current); openRef.current = false; setOpen(false); setRes({ active: 0, matches: 0 }); window.api.find.stop(); if (window.nlpFinder) window.nlpFinder.stop(); };

  useEffect(() => {
    const offOpen = window.api.find.onOpen(() => { openRef.current = true; setOpen(true); setTimeout(() => { if (input.current) { input.current.focus(); input.current.select(); } syncKeys(); }, 0); });
    const offRes = window.api.find.onResult(r => setRes({ active: r.active, matches: r.matches }));
    const offClose = window.api.find.onClose(() => close());
    const onFocus = () => setTimeout(syncKeys, 0);
    document.addEventListener('focusin', onFocus); document.addEventListener('focusout', onFocus);
    return () => { offOpen(); offRes(); offClose(); document.removeEventListener('focusin', onFocus); document.removeEventListener('focusout', onFocus); clearTimeout(timer.current); };
  }, []);                                                                                  // eslint-disable-line react-hooks/exhaustive-deps

  // a new search (typing): Chromium moves the focus into the page when it finds something — the text box gets it back (the next search starts from the top anyway)
  const keepFocus = () => setTimeout(() => { if (input.current && document.activeElement !== input.current) input.current.focus(); }, 0);
  const search = (t) => { clearTimeout(timer.current); pending.current = false; const f = finder(); if (f) { setRes(f.run(t, true, false)); return; } window.api.find.run({ text: t, next: false, forward: true }); keepFocus(); };
  // typing: the search starts when the typing pauses (a search of a big annotated page takes a while and blocks the page — a search per letter made the typing stutter)
  const searchSoon = (t) => { clearTimeout(timer.current); if (!t) { window.api.find.run({ text: '' }); if (window.nlpFinder) window.nlpFinder.stop(); setRes({ active: 0, matches: 0 }); return; } pending.current = true; timer.current = setTimeout(() => search(t), 350); };
  // ▲ ▼: the next / previous match of the search going on, the focus stays where Chromium put it
  const step = (forward) => { if (!text) return; clearTimeout(timer.current); const f = finder(); if (f) { setRes(f.run(text, forward, true)); return; } window.api.find.run({ text, next: true, forward }); };

  if (!open) return null;
  return (
    <div style={{ position: 'fixed', top: 52, right: 24, zIndex: 4000, display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', background: 'var(--surface, #1e1e2e)', border: '1px solid var(--border, #45475a)', borderRadius: 8, boxShadow: '0 6px 22px rgba(0,0,0,0.5)' }}>
      <input ref={input} className="form-control" style={{ width: 240, fontSize: 13 }} placeholder="Find in page" value={text}
        onChange={e => { setText(e.target.value); searchSoon(e.target.value); }}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.currentTarget.select(); }
          else if (finder() && e.key === 'Enter') { e.preventDefault(); if (pending.current) search(text); else step(!e.shiftKey); }       // (the main process takes Enter only when Chromium searches)
          else if (finder() && e.key === 'Escape') { e.preventDefault(); close(); }
        }} />
      <span className="text-xs text-muted" style={{ minWidth: 56, textAlign: 'center' }}>{text ? (res.matches ? `${res.active} of ${res.matches}` : 'No matches') : ''}</span>
      <button className="btn btn-sm btn-secondary" title="Previous match (Shift+Enter)" disabled={!res.matches} onMouseDown={e => e.preventDefault()} onClick={() => step(false)}>▲</button>
      <button className="btn btn-sm btn-secondary" title="Next match (Enter)" disabled={!res.matches} onMouseDown={e => e.preventDefault()} onClick={() => step(true)}>▼</button>
      <button className="btn btn-sm btn-secondary" title="Close (Esc)" onClick={close}>✕</button>
    </div>
  );
}
