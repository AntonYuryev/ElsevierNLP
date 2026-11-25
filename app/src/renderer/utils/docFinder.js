// Find in page for the DOCUMENT of the Reader (an iframe, or the text layers of a PDF), done by the app itself with the CSS Custom Highlight API: no element of the page is changed, so the
// annotations (entities, triples, resolved pronouns) stay as they are.
// Why not Chromium's findInPage: the Reader window has text outside the document too (the controls, the progress line, the find bar's own box) and the document is an iframe: with matches in both
// Electron's "next" stays on the first match (it never gets from the window into the iframe), and the matches of the controls count as matches of the page.
const FIND_CSS = '::highlight(nlp-find) { background-color: #ffe066; color: #000; } ::highlight(nlp-find-active) { background-color: #ff9632; color: #000; }';

/** getView() -> { document, root } of the document that is shown, or null. -> { available, run(text, forward, next) -> { active, matches }, stop() } */
export function createDocFinder(getView) {
  let ranges = [], active = -1, lastText = '', doc = null;

  const textNodes = (view) => {
    const d = view.document, out = [];
    const win = d.defaultView;
    const hidden = new Map();
    const isHidden = (el) => {                                              // an element that is not shown (display: none) holds no text of the page
      for (let e = el; e && e !== view.root.parentElement; e = e.parentElement) {
        let h = hidden.get(e);
        if (h === undefined) { try { h = win.getComputedStyle(e).display === 'none'; } catch (_) { h = false; } hidden.set(e, h); }
        if (h) return true;
      }
      return false;
    };
    const walker = d.createTreeWalker(view.root, 4);                         // text nodes
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('script,style,noscript,template,textarea,select,option')) continue;
      if (!n.nodeValue || isHidden(el)) continue;
      out.push(n);
    }
    return out;
  };

  const clear = () => {
    try { if (doc && doc.defaultView && doc.defaultView.CSS && doc.defaultView.CSS.highlights) { doc.defaultView.CSS.highlights.delete('nlp-find'); doc.defaultView.CSS.highlights.delete('nlp-find-active'); } } catch (_) { /* the document is gone */ }
  };

  const collect = (text) => {
    const view = getView();
    clear();
    ranges = []; active = -1; doc = view ? view.document : null;
    if (!view || !text) return;
    const nodes = textNodes(view);
    // the text of the document as one string (a match may run over several elements: the annotations cut the text into pieces): offsets -> node
    let all = '';
    const starts = [];
    for (const n of nodes) { starts.push(all.length); all += n.nodeValue; }
    const hay = all.toLowerCase(), needle = text.toLowerCase();
    const locate = (pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
      const i = locate(at), j = locate(at + needle.length - 1);
      const r = view.document.createRange();
      r.setStart(nodes[i], at - starts[i]);
      r.setEnd(nodes[j], at + needle.length - starts[j]);
      ranges.push(r);
    }
    lastText = text;
    if (!view.document.getElementById('nlp-find-style')) { const st = view.document.createElement('style'); st.id = 'nlp-find-style'; st.textContent = FIND_CSS; (view.document.head || view.document.documentElement).appendChild(st); }
  };

  const show = () => {
    const win = doc && doc.defaultView;
    if (!win || !win.CSS || !win.CSS.highlights || !win.Highlight) return;
    win.CSS.highlights.set('nlp-find', new win.Highlight(...ranges));
    if (active >= 0 && ranges[active]) {
      win.CSS.highlights.set('nlp-find-active', new win.Highlight(ranges[active]));
      const el = ranges[active].startContainer.parentElement;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  };

  return {
    available: () => !!getView(),
    /** next = false: a new search (the first match); next = true: the next / previous match of the search that is going on (the text of the box is searched again when the page was changed) */
    run(text, forward = true, next = false) {
      if (!text) { collect(''); return { active: 0, matches: 0 }; }
      if (!next || text !== lastText || !ranges.length || !ranges[0].startContainer.isConnected) {
        const keep = next && text === lastText ? active : -1;                // the page was re-drawn (annotations): searched again, the position is kept
        collect(text);
        active = ranges.length ? (keep >= 0 ? Math.min(keep, ranges.length - 1) : (forward ? 0 : ranges.length - 1)) : -1;
        if (next && keep >= 0 && ranges.length) active = (keep + (forward ? 1 : -1) + ranges.length) % ranges.length;
      } else active = (active + (forward ? 1 : -1) + ranges.length) % ranges.length;
      show();
      return { active: active >= 0 ? active + 1 : 0, matches: ranges.length };
    },
    stop() { clear(); ranges = []; active = -1; lastText = ''; },
  };
}
