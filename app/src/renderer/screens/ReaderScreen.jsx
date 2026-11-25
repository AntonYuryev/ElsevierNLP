import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './reader.css';
import { createDocFinder } from '../utils/docFinder';
import {
  READER_CSS, collectBlocks, collectPdfBlocks, buildMsxml, alignBlocks, alignWithCoref, findPronouns, corefPrompt, resolveReplies, matchReferent, finishAnnotations, applyAnnotations,
  rgbOf, TYPE_ORDER, relationParts, stripIds, tripleItems, uniqueTriples, markAsserted, badgeText, tripleRowSegs, entityRows, relationRecords, ENTITY_COLUMNS, RELATION_COLUMNS, ENTITY_FILTERS, RELATION_FILTERS,
} from '../utils/readerDoc';

// ── the document as HTML for the sandboxed frame ───────────────────────────────────────────────────────────────
// A page is shown with its own layout (its styles and images load from its address); everything that runs is taken out of it.
function prepareHtml(html, baseUrl) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script, noscript, iframe, frame, frameset, object, embed, applet, base, meta[http-equiv="refresh" i], link[rel~="preload" i], link[rel~="modulepreload" i], link[rel~="prefetch" i]').forEach(n => n.remove());
  d.querySelectorAll('*').forEach(el => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      else if (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
    }
  });
  let head = d.head;
  if (!head) { head = d.createElement('head'); d.documentElement.insertBefore(head, d.body); }
  if (baseUrl) { const b = d.createElement('base'); b.href = baseUrl; head.insertBefore(b, head.firstChild); }
  const csp = d.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy'; csp.content = "script-src 'none'; object-src 'none'; frame-src 'none'"; head.insertBefore(csp, head.firstChild);
  return '<!doctype html>' + d.documentElement.outerHTML;
}
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function textToHtml(text) {
  const paras = String(text).replace(/\r\n/g, '\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return '<!doctype html><html><head><meta charset="utf-8"></head><body style="font:16px/1.65 Georgia, serif; max-width: 860px; margin: 24px auto; padding: 0 20px; color:#222">'
    + paras.map(p => '<p style="white-space:pre-wrap;margin:0 0 14px">' + esc(p) + '</p>').join('') + '</body></html>';
}

// the title of an article: the citation / Open Graph meta, else <title>
function pageTitle(html) {
  try {
    const d = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const m = (n) => { const e = d.querySelector(`meta[name="${n}"],meta[property="${n}"]`); return e ? (e.getAttribute('content') || '').trim() : ''; };
    return (m('citation_title') || m('dc.title') || m('og:title') || (d.title || '').trim()).replace(/\s+/g, ' ');
  } catch { return ''; }
}

// ── a PDF rendered page by page: the page as an image, its text as a transparent text layer on top (the highlights are put into that layer) ──
async function renderPdf(base64, root, onPage) {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const bin = atob(base64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  const pdf = await pdfjs.getDocument({ data }).promise;
  root.innerHTML = '';
  const scale = 1.4, dpr = window.devicePixelRatio || 1;
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });
    const pageEl = document.createElement('div');
    pageEl.className = 'reader-pdf-page';
    pageEl.style.width = viewport.width + 'px'; pageEl.style.height = viewport.height + 'px';
    pageEl.style.setProperty('--total-scale-factor', String(scale));
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr); canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
    pageEl.appendChild(canvas);
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    pageEl.appendChild(layer);
    root.appendChild(pageEl);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
    const tl = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
    await tl.render();
    layer.style.width = viewport.width + 'px'; layer.style.height = viewport.height + 'px';
    if (onPage) onPage(p, pdf.numPages);
  }
  return pdf.numPages;
}

// ── the triples by the types of their entities (NP1 → NP2): "Protein → Disease" … There can be a hundred pairs, so: the biggest ones as bars (a filter box for the rest),
//    or a matrix of the types (NP1 down, NP2 across) in which the colour is the number — one look at all of them. Every pair / cell opens its triples in the Results viewer.
const TOP = 12;
const pairTypes = (p) => p.split(' → ');
function TypeDot({ t }) { return <i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, marginRight: 4, background: `rgb(${rgbOf(t).join(',')})` }} />; }
function PairStats({ items, total, asserted, uniq, onUniq, onOpen }) {
  const [view, setView] = useState('top');
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const counts = useMemo(() => { const m = new Map(); for (const it of items) for (const p of it.pairs) m.set(p, (m.get(p) || 0) + 1); return m; }, [items]);
  const list = useMemo(() => [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), [counts]);
  const max = list.length ? list[0][1] : 1;
  const w = q.trim().toLowerCase();
  const found = w ? list.filter(([p]) => p.toLowerCase().includes(w)) : list;
  const shown = all || w ? found : found.slice(0, TOP);
  const typed = list.filter(([p]) => p.includes(' → '));
  const types = useMemo(() => { const s = new Set(); typed.forEach(([p]) => pairTypes(p).forEach(t => s.add(t))); return [...TYPE_ORDER.filter(t => s.has(t)), ...[...s].filter(t => !TYPE_ORDER.includes(t)).sort()]; }, [list]);   // eslint-disable-line react-hooks/exhaustive-deps
  const pct = total ? Math.round(100 * items.length / total) : 0;
  const uniqBox = <label className="checkbox-item" style={{ display: 'flex', gap: 5, alignItems: 'center' }} title="Checked: a triple that stands in several sentences counts once. Unchecked: it counts in every sentence it stands in."><input type="checkbox" checked={uniq} onChange={e => onUniq(e.target.checked)} /> <span className="text-sm">Only unique triples</span></label>;
  if (!items.length) return <div style={{ marginTop: 10 }}><div className="reader-bar">{uniqBox}<span className="text-muted" style={{ fontSize: 12 }}>{total ? (asserted ? 'No triple has a relation asserted from it.' : 'Every triple has a relation asserted from it.') : 'no triples'}</span></div></div>;
  const noPair = counts.get('no entity pair') || 0;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="reader-bar">
        {uniqBox}
        <button className="reader-chip reader-chip-btn" style={{ fontWeight: 700 }} onClick={() => onOpen('')} title="Click: all these triples, as a table in the Results viewer">{asserted ? 'Asserted' : 'Unasserted'}: {items.length} of {total} {uniq ? 'unique ' : ''}triples ({pct}%)</button>
        <span className="text-muted" style={{ fontSize: 12 }}>{asserted ? 'a relation of the same sentence joins an entity of NP1 and an entity of NP2' : 'no relation of the sentence joins them'} — by the types of the entities, NP1 → NP2 ({typed.length} pair{typed.length === 1 ? '' : 's'}):</span>
        <span style={{ flex: 1 }} />
        <span style={{ display: 'inline-flex' }}>
          <button className={`btn btn-sm ${view === 'top' ? 'btn-primary' : 'btn-secondary'}`} style={{ borderRadius: '6px 0 0 6px' }} onClick={() => setView('top')} title="The pairs with the most triples, as bars">Top pairs</button>
          <button className={`btn btn-sm ${view === 'matrix' ? 'btn-primary' : 'btn-secondary'}`} style={{ borderRadius: '0 6px 6px 0' }} onClick={() => setView('matrix')} title="All the pairs at once: NP1 type down, NP2 type across, the colour is the number of triples">Matrix</button>
        </span>
      </div>
      {view === 'top' && <>
        <div className="reader-bar" style={{ marginTop: 8 }}>
          <input className="form-control" style={{ width: 220, fontSize: 12 }} placeholder="Filter the pairs, e.g. Protein or Disease" value={q} onChange={e => setQ(e.target.value)} />
          {!w && found.length > TOP && <button className="btn btn-sm btn-secondary" onClick={() => setAll(v => !v)}>{all ? `Top ${TOP} only` : `Show all ${found.length} pairs`}</button>}
          {w && <span className="text-xs text-muted">{found.length} of {list.length} pairs</span>}
        </div>
        <div style={{ marginTop: 6, maxHeight: 230, overflow: 'auto' }}>
          {shown.map(([p, n]) => {
            const [a, b] = pairTypes(p);
            return (
              <div key={p} className="reader-pair" onClick={() => onOpen(p)} title={`${n} triple${n === 1 ? '' : 's'} — click: they as a table in the Results viewer`}>
                <span className="reader-pair-name">{b ? <><TypeDot t={a} />{a} <span className="text-muted">→</span> <TypeDot t={b} />{b}</> : p}</span>
                <span className="reader-pair-bar"><span style={{ width: Math.max(2, 100 * n / max) + '%' }} /></span>
                <b className="reader-pair-n">{n}</b>
              </div>
            );
          })}
          {!shown.length && <span className="text-muted" style={{ fontSize: 12 }}>no pair matches</span>}
        </div>
      </>}
      {view === 'matrix' && (
        <div style={{ marginTop: 8, maxHeight: 280, overflow: 'auto' }}>
          <table className="reader-matrix">
            <thead><tr><th title="NP1 ↓ / NP2 →">NP1 ↓  NP2 →</th>{types.map(t => <th key={t}><TypeDot t={t} />{t}</th>)}</tr></thead>
            <tbody>
              {types.map(a => (
                <tr key={a}>
                  <th><TypeDot t={a} />{a}</th>
                  {types.map(b => {
                    const n = counts.get(a + ' → ' + b) || 0;
                    return <td key={b} className={n ? 'on' : ''} style={n ? { background: `rgba(124,106,247,${0.15 + 0.75 * n / max})` } : undefined} onClick={n ? () => onOpen(a + ' → ' + b) : undefined} title={n ? `${a} → ${b}: ${n} triple${n === 1 ? '' : 's'} — click to open them` : ''}>{n || ''}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {noPair > 0 && <div className="text-xs text-muted" style={{ marginTop: 6 }}>{noPair} triple{noPair === 1 ? ' has' : 's have'} no entity on one of the sides (not in the pairs above; they are in “all these triples”).</div>}
    </div>
  );
}

export default function ReaderScreen({ onShowTable, onShowRelations }) {
  const [url, setUrl] = useState('');
  const [doc, setDoc] = useState(null);                         // { kind: 'html' | 'pdf', name, url, html | pdf }
  const [carts, setCarts] = useState([]);
  const [selected, setSelected] = useState([]);                 // names
  const [pickOpen, setPickOpen] = useState(false);
  const [busy, setBusy] = useState('');                         // '' | 'loading' | 'rendering' | 'analyzing'
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [stats, setStats] = useState(null);                     // { types: { type: n }, entities, relations }
  // the favourite view (highlight / colour font, background, markup and relations on or off) is kept between runs of the app
  const [pref] = useState(() => { try { return JSON.parse(localStorage.getItem('reader.view') || '{}') || {}; } catch { return {}; } });
  const [showHl, setShowHl] = useState(pref.showHl !== false);
  const [showRel, setShowRel] = useState(pref.showRel !== false);
  // the semantic triples of the sentences (NP1 / predicate / NP2), those a relation was asserted from and those not: shown unless the user hid them (remembered like the other two;
  // an earlier version had one button for both: its choice is taken over)
  const [showAsr, setShowAsr] = useState(pref.showAsr !== undefined ? pref.showAsr !== false : pref.showTrip !== false);
  const [showUna, setShowUna] = useState(pref.showUna !== undefined ? pref.showUna !== false : pref.showTrip !== false);
  const [mode, setMode] = useState(pref.mode === 'font' ? 'font' : 'highlight');               // how the marked-up entities are shown: 'highlight' (background colour) | 'font' ("Color font": bold coloured text)
  const [minCtl, setMinCtl] = useState(false);                 // the panel with the controls / the panel with the statistics minimized: more room for the document
  const [minStats, setMinStats] = useState(false);
  const wrapRef = useRef(null);
  const [docH, setDocH] = useState(null);                         // the height of the document view: all the room that is left under the panels
  const [bg, setBg] = useState(['white', 'light', 'gray', 'dark'].includes(pref.bg) ? pref.bg : 'white');                         // the background of the page: 'white' | 'light' | 'gray' | 'dark' (light colours are easier to read on a darker one)
  const [tip, setTip] = useState(null);
  const [ready, setReady] = useState(0);                        // counts up whenever a document is in the DOM and can be analysed

  const frameRef = useRef(null), pdfRef = useRef(null);
  const scrollPos = useRef({ x: 0, y: 0, main: 0 });            // the scroll position of the document and of the page: a screen that is not shown has no layout - the position is lost and is put back when the Reader is shown again
  const stRef = useRef(null);                                   // { st, draw }: the progress line of the relations step
  const model = useRef({ blocks: null, undo: null, ents: [], sents: [] });
  const flags = useRef({ hl: true, rel: true, asr: false, una: false, mode: 'highlight', bg: 'white', cor: 'res' });
  // the classes the style of the highlights switches on (see READER_CSS / reader.css)
  const applyClasses = (el) => {
    const f = flags.current;
    el.classList.toggle('nlp-hl', f.hl); el.classList.toggle('nlp-rel', f.rel); el.classList.toggle('nlp-asr', f.asr); el.classList.toggle('nlp-una', f.una); el.classList.toggle('nlp-font', f.mode === 'font');
    el.querySelectorAll('.nlp-badge').forEach(b => badgeText(b, f));                                          // the badges after the sentences tell what is shown
    for (const b of ['light', 'gray', 'dark']) el.classList.toggle('nlp-bg-' + b, f.bg === b);
    for (const c of ['orig', 'res', 'aud']) el.classList.toggle('nlp-cor-' + c, f.cor === c);                    // how the resolved pronouns are shown
  };
  const token = useRef(0);
  const curUrl = useRef(''), histRef = useRef([]), navRef = useRef(null), busyRef = useRef('');
  const [canBack, setCanBack] = useState(false);
  const selRef = useRef([]); selRef.current = selected;
  const cartsRef = useRef([]); cartsRef.current = carts;
  // the Reader's own "Max parallel cartridges" (the NLP Runner has another one): kept here (localStorage) and sent with every analysis; the app settings get a copy
  const [ctlTab, setCtlTabState] = useState(() => { try { const t = localStorage.getItem('reader.tab'); return ['file', 'nlp', 'vis'].includes(t) ? t : 'file'; } catch { return 'file'; } });       // the tab of the controls, remembered
  const setCtlTab = (t) => { setCtlTabState(t); setPickOpen(false); setBmOpen(false); try { localStorage.setItem('reader.tab', t); } catch {} };
  const [statTab, setStatTabState] = useState(() => { try { const t = localStorage.getItem('reader.statTab'); return ['ent', 'rel', 'asr', 'una'].includes(t) ? t : 'ent'; } catch { return 'ent'; } });         // the tab of the statistics, remembered
  const setStatTab = (t) => { setStatTabState(t); try { localStorage.setItem('reader.statTab', t); } catch {} };
  const [maxPar, setMaxPar] = useState(() => { const v = parseInt(localStorage.getItem('reader.maxParallel')); return v >= 1 ? v : 0; });       // 0: not chosen yet
  const maxParRef = useRef(0); maxParRef.current = maxPar;
  // Resolve pronouns (coreference): the pronouns of the document are resolved by the LLM (one question each, with the N sentences before) and the relations are found in the text with the names; both are saved in the settings
  const [resolveP, setResolveP] = useState(true);
  const [corefN, setCorefN] = useState(1);
  const [corView, setCorView] = useState(['orig', 'res', 'aud'].includes(pref.corView) ? pref.corView : 'res');       // 'orig' = the words of the author, 'res' = the names (pills), 'aud' = both
  const resolveRef = useRef(true), corefNRef = useRef(1); resolveRef.current = resolveP; corefNRef.current = corefN;
  const corefRef = useRef(null);                                  // { corefs, rblocks } of the analysed document
  const [corefLog, setCorefLog] = useState([]);                  // every pronoun that was asked about: { sentence, pronoun, candidates, answer, resolved } ("Pronoun log")

  useEffect(() => {
    let live = true;
    Promise.all([window.api.medscan.listCartridges(), window.api.settings.get()]).then(([list, s]) => {
      if (!live) return;
      const l = list || [];
      setCarts(l);
      setMaxPar(m => m || (s && (s.readerMaxParallel || s.maxParallelCartridges)) || 2);
      setResolveP(!s || s.readerResolvePronouns !== false); setCorefN(s && Number.isFinite(Number(s.readerCorefN)) ? Number(s.readerCorefN) : 1);        // not chosen in the Reader yet: starts from the saved setting / the NLP Runner's value
      let mine = null; try { mine = JSON.parse(localStorage.getItem('reader.carts')); } catch {}                       // the Reader's own last choice (kept apart from the NLP Runner's)
      if (Array.isArray(mine)) { setSelected(l.filter(c => mine.includes(c.name)).map(c => c.name)); return; }
      const want = (s && s.selectedCartridgeNames) || [];
      const ok = l.filter(c => want.includes(c.name)).map(c => c.name);
      setSelected(ok.length ? ok : l.filter(c => /^standard$/i.test(c.name)).map(c => c.name));
    }).catch(() => {});
    // finding the relations: the cartridges done, and - when the LLM extracts the triples - the sentences it has answered out of those it is asked (all cartridges together), with the time
    const st = { done: 0, total: 0, label: '', llm: false, ld: 0, lt: 0, lc: 0, t0: Date.now(), names: [] };
    const draw = () => {
      let t = `Entities are shown — finding the relations: ${st.done} of ${st.total} cartridges${st.names.length ? ' (done: ' + st.names.join(', ') + ')' : ''}`;
      const el = Math.round((Date.now() - st.t0) / 1000), mm = Math.floor(el / 60), ss = String(el % 60).padStart(2, '0');
      if (!st.llm) t += `, elapsed ${mm}:${ss}`;
      if (st.llm) {
        t += st.lt ? ` — LLM triples: ${st.ld.toLocaleString()} of ${st.lt.toLocaleString()} sentences answered (${Math.round(100 * st.ld / st.lt)}%)${st.lc ? ' in ' + st.lc + ' cartridge' + (st.lc === 1 ? '' : 's') + ' so far' : ''}, ${mm}:${ss}` : ' — the triples are extracted by the LLM: counting the sentences it will be asked…';
      }
      setProgress(t);
    };
    stRef.current = { st, draw };
    const off = window.api.reader.onProgress(p => { if (p.label && !st.names.includes(p.label)) st.names.push(p.label); Object.assign(st, { done: p.done, total: p.total, label: p.label || '', llm: !!p.llm }); draw(); });
    const offLlm = window.api.reader.onLlmProgress(p => { Object.assign(st, { llm: true, ld: p.done, lt: p.total, lc: p.cartridges }); draw(); });
    return () => { live = false; off(); offLlm(); };
  }, []);

  // ── the root of the document in the DOM ──
  const viewOf = useCallback(() => {
    if (!doc) return null;
    if (doc.kind === 'pdf') return pdfRef.current ? { document: document, root: pdfRef.current, classRoot: pdfRef.current, frame: null } : null;
    const f = frameRef.current;
    const d = f && f.contentDocument;
    return d && d.body ? { document: d, root: d.body, classRoot: d.documentElement, frame: f } : null;
  }, [doc]);

  // ── tooltips ──
  const onMove = useCallback((e, frame) => {
    const seg = e.target && e.target.closest ? e.target.closest('.nlp-seg') : null;
    if (!seg) { setTip(null); return; }
    const m = model.current;
    const ent = seg.dataset.e != null ? m.ents[Number(seg.dataset.e)] : null;          // also when "Show markup" is off: the entity under the mouse is outlined then, and its tooltip (markup, MedScan ID, URN) opens
    const s = seg.dataset.s != null ? m.sents[Number(seg.dataset.s)] : null;
    const rels = s && flags.current.rel && s.rels.length ? s.rels : null;                 // asserted by the rules
    // extracted from the text: on an underlined word (NP1, predicate, NP2) only the triples that word is a part of, elsewhere in the sentence all of them
    // (the asserted triples when "Show asserted triples" is on, the unasserted ones when "Show unasserted triples" is on)
    const f = flags.current;
    const shownIn = (list) => list.filter(t => (t.asserted ? f.asr : f.una));
    const mine = seg.dataset.tr ? seg.dataset.tr.split(',').map(Number).map(i => s && s.trips[i]).filter(Boolean) : [];
    const inSentence = s ? shownIn(s.trips) : [];
    const picked = mine.length ? shownIn(mine) : inSentence;
    const tripsA = picked.filter(t => t.asserted), tripsU = picked.filter(t => !t.asserted);
    const tripsAll = inSentence.length;
    if (!ent && !rels && !tripsA.length && !tripsU.length) { setTip(null); return; }
    const off = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    setTip({ x: e.clientX + off.left, y: e.clientY + off.top, ent: ent ? ent.ent : null, rels, tripsA, tripsU, tripsAll, tripsShown: picked.length });
  }, []);
  const bindEvents = useCallback((view) => {
    const t = view.document === document ? view.root : view.document;
    {                                                                        // the scroll position of the document (only while the Reader is shown: a hidden one reports 0)
      const win = view.document === document ? null : view.document.defaultView;
      (win || view.root).addEventListener('scroll', () => {
        if (!wrapRef.current || wrapRef.current.offsetParent === null) return;
        const q = scrollPos.current;
        if (win) { q.x = win.scrollX; q.y = win.scrollY; } else { q.x = view.root.scrollLeft; q.y = view.root.scrollTop; }
      }, { passive: true });
    }
    t.addEventListener('mousemove', (e) => onMove(e, view.frame));
    t.addEventListener('mouseout', (e) => { if (!e.relatedTarget) setTip(null); });
    let chainKey = '';                                                      // hovering over a mention of an entity (or a resolved pronoun): all the mentions of it in the document get a soft outline
    t.addEventListener('mouseover', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-ck]') : null;
      const key = el ? el.dataset.ck : '';
      if (key === chainKey) return;
      chainKey = key;
      const root = view.document === document ? view.root : view.document;
      root.querySelectorAll('.nlp-chain').forEach(x => x.classList.remove('nlp-chain'));
      if (key) root.querySelectorAll('[data-ck]').forEach(x => { if (x.dataset.ck === key) x.classList.add('nlp-chain'); });
    });
    t.addEventListener('click', (e) => {
      const cor = e.target && e.target.closest ? e.target.closest('.nlp-coref') : null;
      if (cor) { cor.classList.toggle('nlp-flip'); return; }                // a click on a resolved pronoun shows the word of the author (and back)
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      e.preventDefault();
      if (!/^https?:/i.test(a.href)) return;
      const strip = (u) => String(u || '').replace(/#.*$/, '');
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) { window.api.shell.openExternal(a.href); return; }        // Ctrl / Shift + click: the system browser
      if (a.hash && strip(a.href) === strip(curUrl.current)) {                                                              // a link inside the page: scroll to it
        const id = decodeURIComponent(a.hash.slice(1)), d = a.ownerDocument;
        const el = d.getElementById(id) || d.querySelector('[name="' + id.replace(/"/g, '') + '"]');
        if (el) el.scrollIntoView({ block: 'start' });
        return;
      }
      navRef.current && navRef.current(a.href);                                                                             // another page: opens in the Reader
    });
  }, [onMove]);

  // ── loading ──
  const clearModel = () => { try { model.current.undo && model.current.undo(); } catch (_) { /* the DOM is gone */ } model.current = { blocks: null, undo: null, ents: [], sents: [] }; setStats(null); setTip(null); };
  const show = (res) => {
    scrollPos.current = { x: 0, y: 0, main: scrollPos.current.main };
    if (!res || !res.ok) { if (!(res && res.canceled)) setError((res && res.error) || 'Could not load the document.'); setBusy(''); return; }
    token.current++;
    clearModel(); setError('');
    const title = res.kind === 'html' ? pageTitle(res.data) : '';
    if (res.kind === 'pdf') { setDoc({ kind: 'pdf', name: res.name || res.url, url: res.url, pdf: res.data }); }
    else setDoc({ kind: 'html', name: res.name || res.url, title, url: res.url, textChars: res.textChars, rendered: !!res.rendered, html: res.kind === 'html' ? prepareHtml(res.data, /^https?:|^file:/i.test(res.url || '') ? res.url : '') : textToHtml(res.data) });
    setBusy('rendering');
  };
  const loadUrl = async (u) => {
    const target = (typeof u === 'string' ? u : url).trim();
    if (!target) return;
    setBusy('loading'); setError(''); setProgress('');
    const res = await window.api.reader.fetchUrl(target);
    if (res && res.ok) curUrl.current = res.url || target;
    show(res);
  };
  // a link of the page opened in the Reader: the page left goes on the history (← Back)
  navRef.current = (href) => {
    if (busyRef.current) return;
    if (/^https?:/i.test(curUrl.current)) { histRef.current.push(curUrl.current); setCanBack(true); }          // (an uploaded file has no address to come back to)
    setUrl(href);
    loadUrl(href);
  };
  const goBack = () => {
    const prev = histRef.current.pop();
    setCanBack(histRef.current.length > 0);
    if (prev) { setUrl(prev); loadUrl(prev); }
  };
  // ── bookmarks: the favourite articles, kept between runs of the app ──
  const [bms, setBms] = useState(() => { try { const a = JSON.parse(localStorage.getItem('reader.bookmarks') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } });
  const [bmOpen, setBmOpen] = useState(false);
  const saveBms = (a) => { setBms(a); try { localStorage.setItem('reader.bookmarks', JSON.stringify(a)); } catch {} };
  const docUrl = doc && /^https?:/i.test(doc.url || '') ? doc.url : '';
  const bookmarked = docUrl ? bms.find(b => b.url === docUrl) : null;
  // the name is edited in the list (window.prompt does not exist in Electron): { b: the bookmark being renamed (null = the new one), v: the text }
  const [bmEdit, setBmEdit] = useState(null);
  const toggleBookmark = () => {
    if (!docUrl) return;
    if (bookmarked) { saveBms(bms.filter(b => b !== bookmarked)); return; }
    saveBms([...bms, { name: (doc.title || '').trim() || (doc.name && doc.name !== docUrl ? doc.name : docUrl), url: docUrl, added: Date.now() }]);
    setBmOpen(true); setBmEdit({ i: bms.length, v: (doc.title || '').trim() || docUrl });          // the new bookmark is open for a rename
  };
  const renameBookmark = (i, name) => { if (name && name.trim()) saveBms(bms.map((x, k) => k === i ? { ...x, name: name.trim() } : x)); setBmEdit(null); };
  const openBookmark = (b) => { setBmOpen(false); setUrl(b.url); histRef.current = []; setCanBack(false); loadUrl(b.url); };
  const loadFile = async () => {
    setBusy('loading'); setError(''); setProgress('');
    const res = await window.api.reader.openFile();
    if (res && res.ok) { setUrl(res.url || ''); curUrl.current = res.url || ''; }
    show(res);
  };

  // the frame has loaded its document
  const onFrameLoad = () => {
    const f = frameRef.current, d = f && f.contentDocument;
    if (!d || !d.body || !doc || doc.kind !== 'html') return;
    if (!d.getElementById('nlp-reader-style')) { const st = d.createElement('style'); st.id = 'nlp-reader-style'; st.textContent = READER_CSS; d.head.appendChild(st); }
    bindEvents({ document: d, root: d.body, frame: f });
    setBusy(''); setReady(r => r + 1);
  };
  // a PDF is rendered into its container
  useEffect(() => {
    if (!doc || doc.kind !== 'pdf') return;
    let live = true;
    const my = token.current;
    (async () => {
      try {
        await new Promise(r => setTimeout(r, 0));
        const n = await renderPdf(doc.pdf, pdfRef.current, (p, total) => live && setProgress(`Rendering page ${p} of ${total}`));
        if (!live || my !== token.current) return;
        bindEvents({ document, root: pdfRef.current, frame: null });
        setProgress(n + ' page' + (n === 1 ? '' : 's')); setBusy(''); setReady(r => r + 1);
      } catch (e) { if (live) { setError('Could not render the PDF: ' + e.message); setBusy(''); } }
    })();
    return () => { live = false; };
  }, [doc]);

  // ── highlights / relations on and off ──
  useEffect(() => {
    try { localStorage.setItem('reader.view', JSON.stringify({ showHl, showRel, showAsr, showUna, mode, bg, corView })); } catch {}
    flags.current = { hl: showHl, rel: showRel, asr: showAsr, una: showUna, mode, bg, cor: corView };
    const v = viewOf();
    if (!v) return;
    applyClasses(v.classRoot);
    if (!showHl && !showRel && !showAsr && !showUna) setTip(null);
  }, [showHl, showRel, showAsr, showUna, mode, bg, corView, ready, viewOf]);

  // ── NLP ──
  const analyze = useCallback(async () => {
    const v = viewOf();
    if (!v) return;
    const chosen = cartsRef.current.filter(c => selRef.current.includes(c.name));
    const markupCart = cartsRef.current.find(c => /^standard$/i.test(c.name)) || chosen[0];       // medscan -O1 runs once, with the Standard cartridge
    if (!chosen.length) { setError('Choose at least one cartridge.'); return; }
    const my = ++token.current;
    setError(''); setBusy('analyzing'); setProgress('Reading the text of the document…'); setTip(null);
    const T = { t0: Date.now(), mk: 0, co: 0, llm: { asked: 0, noPair: 0, failed: 0, kept: 0, firstError: '' } };                          // how long each phase took (shown when the analysis is finished)
    try { model.current.undo && model.current.undo(); } catch (_) { /* */ }
    model.current = { blocks: null, undo: null, ents: [], sents: [] };
    corefRef.current = null; setCorefLog([]);
    await new Promise(r => setTimeout(r, 30));
    // a web page: the article itself (<article> / <main>), not its menus, banners and footers
    let root = v.root;
    if (doc.kind === 'html') { const a = v.document.querySelector('article') || v.document.querySelector('main, [role="main"]'); if (a && (a.textContent || '').length > 3000) root = a; }
    let blocks = doc.kind === 'pdf' ? collectPdfBlocks(v.root) : collectBlocks(v.document, root);
    if (!blocks.length && doc.kind !== 'pdf') blocks = collectBlocks(v.document, v.root, { loose: true });
    if (!blocks.length) { setBusy(''); setProgress(''); setStats({ types: {}, entities: 0, relations: 0 }); setError('The document has no text to analyze' + (doc.kind === 'html' ? ' — the page gives no text without a browser session. Save the page as HTML in your browser and use Upload file, or load a PDF.' : '.')); return; }
    // 1) the entities: medscan -O1 on the document as MSXML, once (Standard cartridge) — the page is highlighted as soon as it comes, without waiting for the relations
    setProgress('Marking up the entities (medscan -O1)…');
    const msxml = buildMsxml(blocks, doc.name || 'Reader document');
    const mk = await window.api.reader.markup({ msxml, markupCartridge: markupCart && { name: markupCart.name, path: markupCart.path }, organism: 'Mammal' });
    if (my !== token.current) return;
    if (!mk.ok) { setBusy(''); setProgress(''); setError(mk.error || 'The analysis failed.'); return; }
    T.mk = Date.now() - T.t0;
    const errs = [];
    if (mk.error) errs.push((markupCart && markupCart.name || 'markup') + ': ' + mk.error);
    const urnMap = await getUrnMap();                                    // URN → NLP ID: which triple has a relation asserted from it (the Asserted / Unasserted triples tabs)
    if (my !== token.current) return;
    const results = [{ o1: mk.o1, rnefParts: [] }];                     // what is known so far: the markup, then the relations of each cartridge as they come
    const render = () => {
      try { model.current.undo && model.current.undo(); } catch (_) { /* */ }
      const al = alignWithCoref(blocks, corefRef.current, results);                // after "Resolve pronouns": the relations were found in the text with the names, their positions are put back onto the page
      const fin = finishAnnotations(al.ents, al.sents, al.trips);
      markAsserted(fin.sents, urnMap);                                  // which triple has a relation asserted from it, before the page is marked up (it looks different)
      const undo = applyAnnotations(v.document, blocks, fin.ents, fin.sents, { badges: doc.kind !== 'pdf', coref: corefRef.current && doc.kind !== 'pdf' ? corefRef.current.corefs : [] });       // (a PDF text layer has fixed positions: no longer name in the place of a pronoun there)
      model.current = { blocks, undo, ents: fin.ents, sents: fin.sents, entCounts: new Map([...al.seenEnts].map(([k, v]) => [k, v.n])) };
      const types = {};
      al.seenEnts.forEach(val => { types[val.type] = (types[val.type] || 0) + 1; });
      const relTypes = {};
      al.seenRels.forEach(r => { relTypes[r.type] = (relTypes[r.type] || 0) + 1; });
      setStats({ types, entities: al.seenEnts.size, relations: al.seenRels.size, triples: al.seenTrips.size, relTypes, trips: tripleItems(fin.sents) });
      applyClasses(v.classRoot);
    };
    render();
    // 1b) Resolve pronouns: one question to the LLM for each pronoun that has an entity before it (the N sentences before + its own); the answers replace the pronouns in the text the relations are found in
    let relMsxml = buildMsxml(blocks, doc.name || 'Reader document', { noTables: true });          // tables: entity markup only, no relations
    const tCo = Date.now();
    if (resolveRef.current) {
      const found = findPronouns(blocks, mk.o1, { n: corefNRef.current });
      const skippedRows = (found.skipped || []).map(x => ({ sentence: x.sentence, pronoun: x.word, candidates: '', answer: '(not asked) ' + x.reason, resolved: '', asked: false }));
      setCorefLog(skippedRows);
      if (found.length) {
        setProgress('Resolving pronouns: asking the LLM about ' + found.length + ' pronoun' + (found.length === 1 ? '' : 's') + '…');
        const offAsk = window.api.reader.onCorefProgress(q => setProgress('Resolving pronouns: ' + q.done + ' of ' + q.total + ' answered by the LLM…'));
        let ans;
        try { ans = await window.api.reader.corefAsk(found.map(x => corefPrompt(null, x))); } finally { offAsk(); }
        if (my !== token.current) return;
        if (ans && ans.cancelled) { setBusy(''); setProgress('Cancelled.'); return; }
        if (!ans.ok) errs.push('Resolve pronouns: ' + ans.error);
        else {
          const co = resolveReplies(blocks, found, ans.replies);
          setCorefLog([...found.map((x, i) => ({ sentence: x.sentence, pronoun: x.word, candidates: x.cands.map(c => c.name).join('; '), answer: String(ans.replies[i] || '').trim(), resolved: (matchReferent(ans.replies[i], x.cands) || {}).name || '', asked: true })), ...skippedRows]);
          if (co) { corefRef.current = co; relMsxml = buildMsxml(co.rblocks, doc.name || 'Reader document', { noTables: true }); render(); }
          setProgress(co ? co.corefs.length + ' of ' + found.length + ' pronouns resolved' : 'No pronoun could be resolved (' + found.length + ' asked)');
        }
      }
    }
    T.co = Date.now() - tCo;
    const tRel = Date.now();
    // 2) the relations: the full pipeline of every chosen cartridge; each result underlines its sentences as soon as it is ready
    setProgress(`Entities are shown — finding the relations: 0 of ${chosen.length} cartridges…`);
    const S = stRef.current;                                              // the clock of the relations step (conceptscan and LLM alike): redrawn every second
    let tick = null;
    if (S) { Object.assign(S.st, { done: 0, total: chosen.length, label: '', names: [], llm: false, ld: 0, lt: 0, lc: 0, t0: Date.now() }); tick = setInterval(S.draw, 1000); }
    const off = window.api.reader.onRelationsPart(part => {
      if (my !== token.current) return;
      if (part.error) errs.push(part.cartridge + ': ' + part.error);
      if (part.llm) { for (const k of ['asked', 'noPair', 'failed', 'kept']) T.llm[k] += part.llm[k] || 0; if (part.llm.firstError && !T.llm.firstError) T.llm.firstError = part.cartridge + ': ' + part.llm.firstError; }
      results.push({ o1: '', rnefParts: part.rnefParts, cs: part.triples });
      render();
    });
    let rel;
    try { rel = await window.api.reader.relations({ msxml: relMsxml, cartridges: chosen.map(c => ({ name: c.name, path: c.path })), organism: 'Mammal', maxParallel: maxParRef.current || undefined }); }
    finally { off(); if (tick) clearInterval(tick); }
    if (my !== token.current) return;
    const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
    setBusy(''); setProgress(rel && rel.cancelled ? 'Cancelled — the part analyzed so far is shown.' : 'Done in ' + sec(Date.now() - T.t0) + ': markup ' + sec(T.mk) + (resolveRef.current ? ', pronouns ' + sec(T.co) : '') + ', relations ' + sec(Date.now() - tRel) + (T.llm.asked + T.llm.noPair ? ' — LLM: ' + T.llm.asked + ' requests, ' + T.llm.noPair + ' sentences without an entity pair, ' + T.llm.kept + ' triple lines written, ' + T.llm.failed + ' requests failed' : ''));
    if (T.llm.failed) errs.push('LLM triplefication: ' + T.llm.failed + ' sentence(s) were skipped because the LLM request failed (first: ' + T.llm.firstError + ')');
    if (rel && !rel.ok) errs.push(rel.error || 'The relations could not be found.');
    if (errs.length) setError(errs.join('\n'));
  }, [doc, viewOf]);

  useEffect(() => {
    if (ready && selRef.current.length) analyze();                // a loaded document is analyzed at once (entities, triples, relations)
  }, [ready]);                                                // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const calc = () => {
      const w = wrapRef.current, main = w && w.closest('main');
      if (!w || !main || w.offsetParent === null) return;                    // not shown (another screen is open): keep the last height
      const top = w.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      const h = Math.max(300, Math.floor(main.clientHeight - top - 12));
      setDocH(prev => (prev === h ? prev : h));
    };
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  });                                                                          // after every render: the panels above change their height (progress line, error, counts …)

  // Ctrl+F "Find on page" searches the DOCUMENT of the Reader with the app's own finder (window.nlpFinder, used by FindBar): Chromium's find cannot step from the window's own text into the iframe
  useEffect(() => {
    const finder = createDocFinder(() => {
      if (!wrapRef.current || wrapRef.current.offsetParent === null) return null;          // the Reader is not the screen that is shown
      const v = viewOf();
      return v ? { document: v.document, root: v.root } : null;
    });
    window.nlpFinder = finder;
    return () => { finder.stop(); if (window.nlpFinder === finder) delete window.nlpFinder; };
  }, [viewOf]);
  // the pronouns that were asked about, with the entities offered, the answer of the LLM and what it was resolved to (empty: the answer was "none" or none of the entities): a table in the Results viewer
  const openCorefLog = () => {
    if (!onShowTable || !corefLog.length) return;
    const base = (doc && doc.name ? doc.name : 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
    const n = corefLog.filter(r => r.resolved).length, asked = corefLog.filter(r => r.asked !== false).length;
    onShowTable({ title: 'Pronoun resolution', subtitle: (doc && doc.name ? doc.name + ' — ' : '') + asked + ' pronoun' + (asked === 1 ? '' : 's') + ' asked, ' + n + ' resolved, ' + (corefLog.length - asked) + ' not asked (the reason is in the LLM answer column)', filters: [],
      columns: [{ key: 'sentence', label: 'Sentence', width: 90 }, { key: 'pronoun', label: 'Pronoun', width: 10 }, { key: 'candidates', label: 'Entities offered', width: 40 }, { key: 'answer', label: 'LLM answer', width: 30 }, { key: 'resolved', label: 'Resolved to', width: 24 }],
      rows: corefLog, fileName: base + ' - pronouns.xlsx' });
  };
  // Switching to another screen hides the Reader (display: none) and the scroll positions are lost: they are recorded while it is shown and put back when its box has a size again
  const viewOfRef = useRef(null); viewOfRef.current = viewOf;
  useEffect(() => {
    const w = wrapRef.current;
    if (!w) return;
    const main = w.closest('main');
    const onMain = () => { if (w.offsetParent !== null && main) scrollPos.current.main = main.scrollTop; };
    if (main) main.addEventListener('scroll', onMain, { passive: true });
    let wasHidden = false;
    const restore = () => {
      const q = scrollPos.current;
      const apply = () => {
        if (w.offsetParent === null) return;
        if (main) main.scrollTop = q.main;
        const v = viewOfRef.current && viewOfRef.current();
        if (!v) return;
        try { if (v.frame && v.frame.contentWindow) v.frame.contentWindow.scrollTo(q.x, q.y); else if (v.root && v.root.scrollTo) v.root.scrollTo(q.x, q.y); } catch (_) { /* the frame is gone */ }
      };
      requestAnimationFrame(() => { apply(); setTimeout(apply, 60); setTimeout(apply, 250); });        // (the layout of a frame that was hidden takes a moment)
    };
    const ro = window.ResizeObserver ? new ResizeObserver(() => {
      if (w.offsetParent === null) { wasHidden = true; return; }
      if (!wasHidden) return;
      wasHidden = false;
      restore();
    }) : null;
    if (ro) ro.observe(w);
    return () => { if (ro) ro.disconnect(); if (main) main.removeEventListener('scroll', onMain); };
  }, []);
  const cancel = () => { token.current++; window.api.reader.cancel(); setBusy(''); setProgress('Cancelled — what was found so far is shown.'); };          // the token stops the analysis at its next step; the main process kills the running programs
  // a click on a count of the bar: the sentences with that entity type (every type: type = ''), or with relations, as a table in the Results viewer
  const urnByIdRef = useRef(null);                            // NLP / MedScan ID -> its URNs (from urnMapRef), for the tooltip of an entity
  const urnsOfIds = (key) => {
    const m = urnMapRef.current;
    if (!m || !m.size) return [];
    if (!urnByIdRef.current) { const r = new Map(); for (const [urn, id] of m) { const k = String(id); if (!r.has(k)) r.set(k, []); r.get(k).push(urn); } urnByIdRef.current = r; }
    const out = [];
    for (const id of String(key || '').split(',').filter(Boolean)) for (const u of urnByIdRef.current.get(id) || []) { let d = u; try { d = decodeURIComponent(u); } catch (_) { /* as it is */ } if (!out.includes(d)) out.push(d); }
    return out;
  };
  const urnMapRef = useRef(null);                              // URN → NLP ID (ObjectNames.tab): which entity of a sentence is which node of a relation
  const getUrnMap = async () => {
    if (urnMapRef.current) return urnMapRef.current;
    const cart = cartsRef.current.find(c => /^standard$/i.test(c.name)) || cartsRef.current[0];
    try { urnMapRef.current = new Map(cart ? await window.api.pipeline.getUrnEntries({ cartridgePath: cart.path }) : []); } catch (_) { urnMapRef.current = new Map(); }
    urnByIdRef.current = null;                                            // the other way round (NLP ID -> URNs) is made when a tooltip needs it
    return urnMapRef.current;
  };
  const openTable = async (kind, type = '') => {
    const m = model.current;
    if (!onShowTable || !onShowRelations || !m.blocks) return;
    const base = (doc && doc.name ? doc.name : 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
    if (kind === 'relations') {
      // the relations as the Results viewer shows an RNEF file: Node 1 / Node 2 with type and clickable NLP IDs, occurrences, the coloured sentence
      const relations = relationRecords(m.blocks, m.sents, m.ents, await getUrnMap(), type);
      const nSent = new Set(relations.map(r => r.msrc)).size;
      onShowRelations({ title: type ? 'Sentences with ' + type + ' relations' : 'Sentences with relations', subtitle: (doc && doc.name ? doc.name + ' — ' : '') + relations.length + ' relation' + (relations.length === 1 ? '' : 's') + ' in ' + nSent + ' sentence' + (nSent === 1 ? '' : 's'), relations, fileName: base + ' - ' + (type || 'relations') + '.xlsx' });
    } else {
      const rows = entityRows(m.blocks, m.ents, type, m.entCounts);
      const n = m.ents.filter(e => !type || e.ent.type === type).length;
      onShowTable({ title: type ? 'Sentences with ' + type : 'Sentences with marked-up entities', subtitle: (doc && doc.name ? doc.name + ' — ' : '') + rows.length + ' sentence' + (rows.length === 1 ? '' : 's') + ', ' + n + ' mention' + (n === 1 ? '' : 's'), columns: ENTITY_COLUMNS, filters: ENTITY_FILTERS, rows, fileName: base + ' - ' + (type || 'entities') + '.xlsx' });
    }
  };
  // the triples of a tab (asserted / unasserted), all of them or those of one entity-type pair ("Protein → Disease"), as a table in the Results viewer
  // "Only unique triples": a triple that stands in several sentences counts once (checked) or in each of them (unchecked) — the statistics are made again when it is switched
  const [uniq, setUniqState] = useState(() => { try { return localStorage.getItem('reader.uniqTriples') !== '0'; } catch { return true; } });
  const setUniq = (v) => { setUniqState(v); try { localStorage.setItem('reader.uniqTriples', v ? '1' : '0'); } catch {} };
  const tripItems = useMemo(() => { const all = (stats && stats.trips) || []; return uniq ? uniqueTriples(all) : all; }, [stats, uniq]);
  const asrItems = useMemo(() => tripItems.filter(i => i.asserted), [tripItems]);
  const unaItems = useMemo(() => tripItems.filter(i => !i.asserted), [tripItems]);
  const openTriples = (asserted, pair = '') => {
    const m = model.current;
    if (!onShowTable || !m.blocks) return;
    const base = (doc && doc.name ? doc.name : 'document').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);
    const rows = (asserted ? asrItems : unaItems).filter(it => !pair || it.pairs.includes(pair)).map(it => ({
      sentence: ((m.blocks[it.bi] && m.blocks[it.bi].norm.slice(it.a, it.b)) || '').trim(), np1: it.np1, predicate: it.pred, np2: it.np2, pair: it.pairs.join('; '), pairs: it.pairs, tag: it.tag, paragraph: it.bi + 1,
      ...tripleRowSegs(m.blocks, m.ents, it),                                  // the entities in orange, the predicate of an asserted triple in green
    }));
    const what = asserted ? 'Asserted triples' : 'Unasserted triples';
    onShowTable({
      title: what + (pair ? ' — ' + pair : ''),
      subtitle: (doc && doc.name ? doc.name + ' — ' : '') + rows.length + ' triple' + (rows.length === 1 ? '' : 's') + (asserted ? ' with a relation asserted from them' : ' without a relation'),
      columns: [{ key: 'sentence', label: 'Sentence', width: 90 }, { key: 'np1', label: 'NP1', width: 34 }, { key: 'predicate', label: 'Predicate', width: 14 }, { key: 'np2', label: 'NP2', width: 34 }, { key: 'pair', label: 'Entity pair', width: 30 }, { key: 'tag', label: 'Triple type', width: 10 }, { key: 'paragraph', label: 'Paragraph', width: 11 }],
      filters: [{ kind: 'multi', label: 'Entity pair', field: 'pairs' }, { kind: 'multi', label: 'Triple type', field: 'tag' }],
      rows, fileName: base + ' - ' + what.toLowerCase().replace(/ /g, '_') + (pair ? ' ' + pair.replace(/ → /g, '-') : '') + '.xlsx',
    });
  };
  const typeNames = stats ? [...TYPE_ORDER.filter(t => stats.types[t]), ...Object.keys(stats.types).filter(t => !TYPE_ORDER.includes(t)).sort()] : [];
  const pickCarts = (list) => { setSelected(list); try { localStorage.setItem('reader.carts', JSON.stringify(list)); } catch {} };
  const toggleCart = (name) => pickCarts(selected.includes(name) ? selected.filter(x => x !== name) : [...selected, name]);
  const working = busy === 'loading' || busy === 'rendering' || busy === 'analyzing';
  busyRef.current = working ? busy : '';

  return (
    <div>
      <div className="screen-header" style={{ marginBottom: 12 }}>
        <h1 className="screen-title">Reader</h1>
      </div>

      <div className="card" style={{ marginBottom: 12, position: 'relative' }}>
        <button className="btn btn-sm btn-secondary" style={{ position: 'absolute', top: 6, right: 8, padding: '0 8px', zIndex: 2 }} onClick={() => setMinCtl(v => !v)} title={minCtl ? 'Show the controls' : 'Minimize this panel — more room for the document'}>{minCtl ? '▾ Controls' : '▴ Minimize'}</button>
        {minCtl ? (
          <div className="reader-bar" style={{ paddingRight: 110 }}>
            <b style={{ fontSize: 13 }}>{doc ? doc.name : 'No document'}</b>
            {working ? <span className="text-sm text-muted"><span className="spinner" /> {progress || 'Working…'}</span> : progress ? <span className="text-sm text-muted">{progress}</span> : null}
            {error && <span className="text-danger text-sm">{String(error).split('\n')[0]}</span>}
          </div>
        ) : (<>
        <div className="reader-tabs" style={{ paddingRight: 110 }}>
          {[['file', 'File'], ['nlp', 'NLP'], ['vis', 'Visualization']].map(([k, l]) => (
            <button key={k} className={`reader-tab ${ctlTab === k ? 'active' : ''}`} onClick={() => setCtlTab(k)}>{l}</button>
          ))}
        </div>
        {ctlTab === 'file' && <div className="reader-bar" style={{ marginTop: 10, paddingRight: 110 }}>
          <input className="form-control" style={{ flex: 1, minWidth: 320 }} value={url} placeholder="Address of an article or web page, e.g. https://www.ncbi.nlm.nih.gov/pmc/articles/…"
            onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') loadUrl(); }} />
          {canBack && <button className="btn btn-secondary" disabled={working} onClick={goBack} title="Back to the previous page">←</button>}
          <button className="btn btn-primary" disabled={working || !url.trim()} onClick={() => loadUrl()}>Load</button>
          <button className="btn btn-secondary" disabled={working} onClick={loadFile} title="An article as a PDF, an HTML or a text file">📂 Upload file…</button>
          <button className="btn btn-secondary" disabled={working || !docUrl} onClick={toggleBookmark} title={docUrl ? (bookmarked ? 'Remove this page from the bookmarks' : 'Keep this article in the bookmarks') : 'Only web pages can be bookmarked'}>{bookmarked ? '★ Bookmarked' : '☆ Add to bookmarks'}</button>
          <div style={{ position: 'relative' }}>
            <button className="btn btn-secondary" onClick={() => setBmOpen(v => !v)} title="The bookmarked articles">🔖 Bookmarks ({bms.length}) ▾</button>
            {bmOpen && <div className="card" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 30, width: 460, maxHeight: 360, overflow: 'auto', padding: 6, marginTop: 4 }}>
              {!bms.length && <div className="text-sm text-muted" style={{ padding: 8 }}>No bookmarks yet. Open an article and press “Add to bookmarks”.</div>}
              {bms.map((b, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px' }}>
                  {bmEdit && bmEdit.i === i
                    ? <input className="form-control" autoFocus style={{ flex: 1, minWidth: 0 }} value={bmEdit.v} onChange={e => setBmEdit({ i, v: e.target.value })} onFocus={e => e.target.select()}
                        onKeyDown={e => { if (e.key === 'Enter') renameBookmark(i, bmEdit.v); if (e.key === 'Escape') setBmEdit(null); }} onBlur={() => renameBookmark(i, bmEdit.v)} />
                    : <a href="#" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.name + '\n' + b.url} onClick={e => { e.preventDefault(); openBookmark(b); }}>{b.name}</a>}
                  <button className="btn btn-sm btn-secondary" style={{ padding: '0 6px' }} title="Rename" onClick={() => setBmEdit({ i, v: b.name })}>✎</button>
                  <button className="btn btn-sm btn-secondary" style={{ padding: '0 6px' }} title="Remove" onClick={() => saveBms(bms.filter(x => x !== b))}>✕</button>
                </div>
              ))}
            </div>}
          </div>
        </div>}
        {ctlTab === 'nlp' && <div className="reader-bar" style={{ marginTop: 10 }}>
          <div style={{ position: 'relative' }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setPickOpen(o => !o)} title="The cartridges whose pipelines analyze the text">
              Cartridges: {selected.length ? selected.join(', ') : 'none'} ▾
            </button>
            {pickOpen && (
              <div style={{ position: 'absolute', zIndex: 60, top: '100%', left: 0, marginTop: 2, padding: 6, minWidth: 220, background: 'var(--surface, #1e1e2e)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 6px 20px rgba(0,0,0,0.45)' }}>
                <div style={{ display: 'flex', gap: 6, padding: '2px 4px 6px' }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => pickCarts(carts.map(c => c.name))}>All</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => pickCarts([])}>None</button>
                </div>
                {carts.map(c => (
                  <label key={c.name} className="checkbox-item" style={{ display: 'flex', gap: 6, padding: '2px 4px' }}>
                    <input type="checkbox" checked={selected.includes(c.name)} onChange={() => toggleCart(c.name)} /> <span>{c.name}</span>
                  </label>
                ))}
                <div style={{ textAlign: 'right', marginTop: 4 }}><button className="btn btn-sm btn-secondary" onClick={() => setPickOpen(false)}>Close</button></div>
              </div>
            )}
          </div>
          <label className="checkbox-item" style={{ display: 'flex', gap: 6, alignItems: 'center' }} title="Pronouns (it, its, they, them, their) are replaced by the entity they refer to before the relations are found: the LLM chosen under Triplefication is asked, for each pronoun, which of the entities marked up in the sentences before it is meant. The page keeps the author's words; the names are shown in pills (Visualization tab). It takes effect from the next analysis.">
            <input type="checkbox" checked={resolveP} disabled={busy === 'analyzing'} onChange={e => { setResolveP(e.target.checked); window.api.settings.set({ readerResolvePronouns: e.target.checked }); }} />
            <span className="text-sm">Resolve pronouns</span>
          </label>
          <label className="checkbox-item" style={{ display: 'flex', gap: 6, alignItems: 'center' }} title="How many sentences before the sentence with the pronoun are looked at for its entity (1: the previous sentence and the sentence itself). Saved in the settings.">
            <span className="text-sm">preceding sentences</span>
            <input type="number" min="0" max="10" step="1" value={corefN} disabled={!resolveP || busy === 'analyzing'}
              onChange={e => { const v = Math.max(0, Math.min(10, parseInt(e.target.value) || 0)); setCorefN(v); window.api.settings.set({ readerCorefN: v }); }}
              style={{ width: 52, textAlign: 'right' }} />
          </label>
          <button className="btn btn-sm btn-secondary" disabled={!corefLog.length} onClick={openCorefLog} title="Every pronoun that was asked about: the sentence, the entities offered, the answer of the LLM and what it was resolved to. A pronoun with no 'Resolved to' stays as the author wrote it.">Pronoun log{corefLog.length ? ' (' + corefLog.filter(r => r.resolved).length + ' of ' + corefLog.filter(r => r.asked !== false).length + ' resolved' + (corefLog.some(r => r.asked === false) ? ', ' + corefLog.filter(r => r.asked === false).length + ' not asked' : '') + ')' : ''}</button>
          <label className="checkbox-item" style={{ display: 'flex', gap: 6, alignItems: 'center' }} title="How many cartridges analyze the page at the same time. The Reader's own setting — the NLP Runner has another one, for its many articles. Higher is faster but uses more memory: each cartridge process loads its dictionaries. It takes effect from the next analysis.">
            <span className="text-sm">Max parallel cartridges</span>
            <input type="number" min="1" max="16" step="1" value={maxPar || 2} disabled={busy === 'analyzing'}
              onChange={e => { const v = Math.max(1, parseInt(e.target.value) || 1); setMaxPar(v); try { localStorage.setItem('reader.maxParallel', String(v)); } catch {} window.api.settings.set({ readerMaxParallel: v }); }}
              style={{ width: 56, textAlign: 'right' }} />
          </label>
        </div>}
        {/* what is going on (loading, analysis, its progress) is shown whichever tab is open */}
        {(busy === 'analyzing' || working || progress) && <div className="reader-bar" style={{ marginTop: 8 }}>
          {busy === 'analyzing' && <button className="btn btn-secondary btn-sm" onClick={cancel}>Stop</button>}
          {working && <span className="text-sm text-muted"><span className="spinner" /> {progress || (busy === 'loading' ? 'Loading…' : busy === 'rendering' ? 'Rendering…' : '')}</span>}
          {!working && progress && <span className="text-sm text-muted">{progress}</span>}
        </div>}
        {ctlTab === 'vis' && <div className="reader-bar" style={{ marginTop: 10 }}>
          <span className="text-xs text-muted">Markup:</span>
          <span style={{ display: 'inline-flex' }}>
            <button className={`btn btn-sm ${mode === 'highlight' ? 'btn-primary' : 'btn-secondary'}`} style={{ borderRadius: '6px 0 0 6px' }} onClick={() => setMode('highlight')} title="Marked-up entities have a coloured background">Highlight</button>
            <button className={`btn btn-sm ${mode === 'font' ? 'btn-primary' : 'btn-secondary'}`} style={{ borderRadius: '0 6px 6px 0' }} onClick={() => setMode('font')} title="Marked-up entities are bold, in the colour of their type">Color font</button>
          </span>
          <select className="form-control" style={{ width: 'auto', fontSize: 12 }} value={bg} onChange={e => setBg(e.target.value)} title="Background of the page — light colours are easier to read on a darker one">
            <option value="white">Background: white</option><option value="light">Background: light gray</option><option value="gray">Background: gray</option><option value="dark">Background: dark</option>
          </select>
          <span className="text-xs text-muted">Pronouns:</span>
          <span style={{ display: 'inline-flex' }} title="How the pronouns that were resolved are shown: the words of the author, the names (a dotted pill; hover: the original word, click: flips it), or both. Hover over a mention of an entity to outline all its mentions.">
            {[['orig', 'Original'], ['res', 'Resolved'], ['aud', 'Audit']].map(([k, l], i, a) => (
              <button key={k} className={`btn btn-sm ${corView === k ? 'btn-primary' : 'btn-secondary'}`} style={{ borderRadius: i === 0 ? '6px 0 0 6px' : i === a.length - 1 ? '0 6px 6px 0' : 0 }} onClick={() => setCorView(k)}>{l}</button>
            ))}
          </span>
          <button className={`btn btn-sm ${showHl ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowHl(v => !v)} title="The marked-up entities (highlighted or in colour)">{showHl ? 'Hide markup' : 'Show markup'}</button>
          <button className={`btn btn-sm ${showRel ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowRel(v => !v)} title="Asserted relations — what the rules derived from the triples: wavy underline of the sentences, a dashed purple mark at the start of the sentence">{showRel ? 'Hide relations' : 'Show relations'}</button>
          <button className={`btn btn-sm ${showAsr ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowAsr(v => !v)} title="Asserted triples — the semantic triples ConceptScan extracted from the sentences and from which the rules asserted a relation, as they stand in the text: a solid blue mark at the start of the sentence, solid lines under NP1 (blue), the predicate (gray) and NP2 (teal), and a badge after the sentence. Hover a sentence (or a marked word) for them.">{showAsr ? 'Hide asserted triples' : 'Show asserted triples'}</button>
          <button className={`btn btn-sm ${showUna ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShowUna(v => !v)} title="Unasserted triples — the semantic triples ConceptScan extracted from the sentences but from which no relation was asserted: a dotted blue mark at the start of the sentence, dotted lines under NP1 (blue), the predicate (gray) and NP2 (teal), and a badge after the sentence. Hover a sentence (or a marked word) for them.">{showUna ? 'Hide unasserted triples' : 'Show unasserted triples'}</button>
        </div>}
        {error && <div className="text-danger" style={{ marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</div>}
        {doc && <div className="text-xs text-muted" style={{ marginTop: 6 }}>{doc.name}{doc.textChars ? ' — ' + doc.textChars.toLocaleString() + ' characters of text' : ''}{doc.rendered ? ' (the page was loaded by the built-in browser)' : ''}</div>}
        </>)}
      </div>

      {stats && (
        <div className="card" style={{ marginBottom: 12, position: 'relative' }}>
          <button className="btn btn-sm btn-secondary" style={{ position: 'absolute', top: 6, right: 8, padding: '0 8px', zIndex: 2 }} onClick={() => setMinStats(v => !v)} title={minStats ? 'Show the statistics' : 'Minimize this panel — more room for the document'}>{minStats ? '▾ Statistics' : '▴ Minimize'}</button>
          {minStats ? (
            <div className="reader-bar" style={{ paddingRight: 120 }}>
              <button className="reader-chip reader-chip-btn" style={{ fontWeight: 700 }} disabled={!stats.entities} onClick={() => openTable('entities', '')} title="Click: the sentences with marked-up entities, as a table in the Results viewer">Entities: {stats.entities}</button>
              <button className="reader-chip reader-chip-btn" style={{ fontWeight: 700 }} disabled={!stats.relations} onClick={() => openTable('relations')} title="Click: the sentences with extracted relations, as a table in the Results viewer">Relations: {stats.relations}</button>
              <button className="reader-chip reader-chip-btn" style={{ fontWeight: 700 }} disabled={!asrItems.length} onClick={() => openTriples(true)} title={`Click: the triples a relation was asserted from${uniq ? ' (unique ones)' : ''}, as a table in the Results viewer`}>Asserted triples: {asrItems.length}</button>
              <button className="reader-chip reader-chip-btn" style={{ fontWeight: 700 }} disabled={!unaItems.length} onClick={() => openTriples(false)} title={`Click: the triples with no relation asserted from them${uniq ? ' (unique ones)' : ''}, as a table in the Results viewer`}>Unasserted triples: {unaItems.length}</button>
            </div>
          ) : (<>
          {/* two tabs: Entities (the count, one box per entity type) and Relations (the count, the triples, one box per relation type) — every box opens its sentences in the Results viewer */}
          <div className="reader-tabs" style={{ paddingRight: 120 }}>
            {[['ent', `Entities (${stats.entities || 0})`], ['rel', `Relations (${stats.relations || 0})`], ['asr', `Asserted triples (${asrItems.length})`], ['una', `Unasserted triples (${unaItems.length})`]].map(([k, l]) => <button key={k} className={`reader-tab ${statTab === k ? 'active' : ''}`} onClick={() => setStatTab(k)}>{l}</button>)}
          </div>
          {statTab === 'asr' && <PairStats items={asrItems} total={tripItems.length} asserted uniq={uniq} onUniq={setUniq} onOpen={(p) => openTriples(true, p)} />}
          {statTab === 'una' && <PairStats items={unaItems} total={tripItems.length} uniq={uniq} onUniq={setUniq} onOpen={(p) => openTriples(false, p)} />}
          {statTab === 'ent' && <>
          <div className="reader-bar" style={{ marginTop: 10 }}>
            <button className="reader-chip reader-chip-btn" style={{ fontWeight: 700 }} disabled={!stats.entities} onClick={() => openTable('entities', '')} title="Click: the sentences with marked-up entities, as a table in the Results viewer">Entities: {stats.entities}</button>
            <span className="text-muted" style={{ fontSize: 12 }}>(unique, marked up):</span>
          </div>
          <div className="reader-bar" style={{ marginTop: 8 }}>
            {typeNames.map(t => <button key={t} className="reader-chip reader-chip-btn" onClick={() => openTable('entities', t)} title={`Click: the sentences with ${t} entities, as a table in the Results viewer`}><i style={{ background: `rgb(${rgbOf(t).join(',')})` }} />{t} <b>{stats.types[t]}</b></button>)}
            {!typeNames.length && <span className="text-muted" style={{ fontSize: 12 }}>no entities</span>}
          </div>
          </>}
          {statTab === 'rel' && <>
          <div className="reader-bar" style={{ marginTop: 10 }}>
            <button className="reader-chip reader-chip-btn" style={{ fontWeight: 700 }} disabled={!stats.relations} onClick={() => openTable('relations')} title="Click: the sentences with extracted relations, as a table in the Results viewer">Relations: {stats.relations}</button>
            <span className="text-muted" style={{ fontSize: 12 }}>(unique, by relation type):</span>
            <span style={{ flex: 1 }} />
            <span className="reader-chip" style={{ fontWeight: 700 }} title="Semantic triples extracted from the sentences by ConceptScan (unique) — the relations are asserted from them by the rules">Triples: {stats.triples || 0}</span>
          </div>
          <div className="reader-bar" style={{ marginTop: 8 }}>
            {Object.keys(stats.relTypes || {}).sort((a, b) => stats.relTypes[b] - stats.relTypes[a] || a.localeCompare(b)).map(t => <button key={t} className="reader-chip reader-chip-btn" onClick={() => openTable('relations', t)} title={`Click: the sentences with ${t} relations, as a table in the Results viewer`}>{t} <b>{stats.relTypes[t]}</b></button>)}
            {!stats.relations && <span className="text-muted" style={{ fontSize: 12 }}>{busy === 'analyzing' ? 'finding the relations…' : 'no relations'}</span>}
          </div>
          </>}
          </>)}
        </div>
      )}

      {!doc && <div className="empty-state"><div className="empty-state-icon">📖</div><div>Load an article: type or paste its address above, or upload a PDF, HTML or text file.</div><div className="text-sm mt-8">The text is shown as it is, with the entities found by the NLP highlighted and the sentences with relations underlined.</div></div>}
      <div ref={wrapRef}>
      {doc && doc.kind === 'html' && (
        <iframe key={doc.url + doc.html.length} ref={frameRef} className="reader-frame" style={{ height: docH ? docH + 'px' : 'calc(100vh - 290px)', minHeight: 300 }} title="document"
          sandbox="allow-same-origin" srcDoc={doc.html} onLoad={onFrameLoad} />
      )}
      {doc && doc.kind === 'pdf' && <div ref={pdfRef} className={`reader-pdf ${showHl ? 'nlp-hl' : ''} ${showRel ? 'nlp-rel' : ''} ${showAsr ? 'nlp-asr' : ''} ${showUna ? 'nlp-una' : ''} ${mode === 'font' ? 'nlp-font' : ''} ${bg !== 'white' ? 'nlp-bg-' + bg : ''}`} style={{ height: docH ? docH + 'px' : 'calc(100vh - 290px)', minHeight: 300 }} />}
      </div>

      {tip && (
        <div className="reader-tip" style={{ left: Math.max(8, Math.min(tip.x + 14, window.innerWidth - 580)), top: Math.max(8, Math.min(tip.y + 18, window.innerHeight - 140)) }}>
          {tip.ent && <div><code>{tip.ent.markup}</code> <span style={{ color: `rgb(${rgbOf(tip.ent.type).join(',')})`, fontWeight: 700 }}>{tip.ent.type}</span></div>}
          {tip.ent && (() => { const urns = urnsOfIds(tip.ent.key); return (
            <div className="text-xs" style={{ marginTop: 2 }}>MedScan ID: <code>{String(tip.ent.key).split(',').join(', ')}</code>{urns.length ? <> &nbsp;URN: <code>{urns.join(' ; ')}</code></> : <> &nbsp;<span className="text-muted">no URN in this cartridge's ObjectNames</span></>}</div>
          ); })()}
          {tip.ent && tip.ent.expansion && <div style={{ marginTop: 2 }}><b>{tip.ent.abbrev}</b> = {tip.ent.expansion} <span className="text-muted">(local de-abbreviation)</span></div>}
          {/* solid blue = triples a relation was asserted from; dotted blue = triples with no relation; dashed purple = the relations asserted by the rules */}
          {[['A', tip.tripsA, 'reader-tip-ex', 'Asserted triples'], ['U', tip.tripsU, 'reader-tip-un', 'Unasserted triples']].map(([k, list, cls, label]) => list && list.length > 0 && (
            <div key={k} className={'reader-tip-sec ' + cls} style={{ marginTop: tip.ent || (k === 'U' && tip.tripsA.length) ? 6 : 0 }}>
              <div className="reader-tip-h">{label} — {list.length} triple{list.length === 1 ? '' : 's'}{tip.tripsShown < tip.tripsAll && k === (tip.tripsA.length ? 'A' : 'U') ? ` with this word (of ${tip.tripsAll} shown in the sentence)` : ''}</div>
              {list.map((t, i) => (
                <div key={i} className="reader-tip-row">
                  {t.tag && <span className="reader-tip-tag">{t.tag}</span>}
                  <span className="rt-np1">{stripIds(t.np1) || '…'}</span> <span className="rt-pred">—({t.pred})→</span> <span className="rt-np2">{stripIds(t.np2) || '…'}</span>
                </div>
              ))}
            </div>
          ))}
          {tip.rels && (
            <div className="reader-tip-sec reader-tip-as" style={{ marginTop: tip.ent || tip.tripsA.length || tip.tripsU.length ? 6 : 0 }}>
              <div className="reader-tip-h">Relations asserted by the rules — {tip.rels.length} relation{tip.rels.length === 1 ? '' : 's'}</div>
              {tip.rels.map((r, i) => (
                <div key={i} className="reader-tip-row" style={{ fontFamily: 'Consolas, monospace' }}>
                  {relationParts(r.rel).map((p, k) => <span key={k} style={{ color: p.color, fontWeight: p.bold ? 700 : undefined }}>{p.t}</span>)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
