import React, { useEffect, useMemo, useRef, useState } from 'react';
import FloatingDialog from './FloatingDialog';
import CreateMacroDialog from './CreateMacroDialog';
import FindMacroDialog from './FindMacroDialog';
import PatternHelpDialog from './PatternHelpDialog';
import MacroTextarea, { LintIssues, lintMarks } from './PatternEditor';
import { lintPattern } from '../utils/patternLint';
import { parseSections } from '../utils/msgrepSections';
import { splitAlternatives, consolidateAlternatives } from '../utils/consolidate';

// The in-app editor of a .msgrep file (Pattern File Editor → "Open in Editor"). The editing box, its spell-check (patternLint.js) and the macro tooltips are
// the ones of the "New relation / Design pattern" dialog (PatternEditor.jsx), so a rule added there applies here too. "Check" compiles the edited file with msgrep.
// The drop-down lists the CONTROL rules and pattern sets of the file: choosing one shows (and edits) only that part.
// The symbolic relation of a frame with its arrow head coloured: --| (negative Effect) red, -+> (positive Effect) green — for a quick visual identification
const ARROW_GREEN = '#a6e3a1', ARROW_RED = '#f38ba8';
function Arrowed({ text }) {
  const m = /^([\s\S]*?\])(-\+>|--\|)([\s\S]*)$/.exec(text);
  if (!m) return <>{text}</>;
  return <>{m[1]}<span style={{ color: m[2] === '--|' ? ARROW_RED : ARROW_GREEN, fontWeight: 700 }}>{m[2]}</span>{m[3]}</>;
}
// a drop-down like a <select>, but its entries can be coloured (a native <select> cannot colour a part of an entry): options: [{ value, label, group? }]
function FramePicker({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  const cur = options.find(o => o.value === value) || options[0];
  let lastGroup = null;
  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minWidth: 320 }}>
      <button type="button" className="form-control" onClick={() => setOpen(o => !o)}
        style={{ width: '100%', textAlign: 'left', fontSize: 12, fontFamily: 'monospace', display: 'flex', justifyContent: 'space-between', gap: 8, cursor: 'pointer' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><Arrowed text={cur.label} /></span><span>▾</span>
      </button>
      {open && (
        <div style={{ position: 'absolute', zIndex: 50, left: 0, right: 0, top: '100%', marginTop: 2, maxHeight: '55vh', overflowY: 'auto', background: 'var(--surface, #1e1e2e)', border: '1px solid var(--border)', borderRadius: 6, boxShadow: '0 6px 20px rgba(0,0,0,0.45)' }}>
          {options.map(o => {
            const head = o.group && o.group !== lastGroup ? (lastGroup = o.group, <div key={'g:' + o.group} style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>{o.group}</div>) : null;
            const bg = o.value === value ? 'rgba(124,106,247,0.28)' : 'transparent';
            return (
              <React.Fragment key={o.value}>
                {head}
                <div onClick={() => { onChange(o.value); setOpen(false); }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'rgba(124,106,247,0.18)'; }} onMouseLeave={e => { e.currentTarget.style.background = bg; }}
                  style={{ padding: '3px 10px', fontSize: 12, fontFamily: 'monospace', cursor: 'pointer', whiteSpace: 'nowrap', background: bg }}><Arrowed text={o.label} /></div>
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function FileEditorDialog({ cartPath, cartName, file, onClose, initialSet = '' }) {
  const api = window.api.relation;
  const [loaded, setLoaded] = useState(null);                 // { eol, mtime }
  const [text, setText] = useState('');
  const [orig, setOrig] = useState('');
  const [error, setError] = useState('');
  const [focusIdx, setFocusIdx] = useState(-1);               // -1 = the whole file
  const [check, setCheck] = useState(null);                   // { busy } | { text, res } | { text, error }
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [macroVer, setMacroVer] = useState(0);
  const [editMacroName, setEditMacroName] = useState('');
  // The pattern sets that the rule picked in the drop-down calls but that are written in ANOTHER file (a Rules.msgrep that holds only frames): they are shown and edited
  // under the frame, in a second editing box. defs: &NAME → where it is defined; others: file → { text, orig, eol, mtime } of those other files.
  const [defs, setDefs] = useState({});
  const [others, setOthers] = useState({});
  const [setIdx, setSetIdx] = useState(0);

  useEffect(() => {
    let live = true;
    api.readFile({ cartPath, file }).then(r => {
      if (!live) return;
      if (r.ok === false) { setError(r.error); return; }
      setLoaded({ eol: r.file.eol, mtime: r.file.mtime }); setText(r.file.text); setOrig(r.file.text);
    }).catch(e => live && setError(e.message));
    return () => { live = false; };
  }, [cartPath, file]);

  const otherDirty = Object.values(others).some(o => o.text !== o.orig);
  const dirOf = (f) => f.replace(/[\\/][^\\/]*$/, '');
  const dirtyOthers = Object.entries(others).filter(([, o]) => o.text !== o.orig).map(([f, o]) => ({ file: f, text: o.text }));
  const extraSig = dirtyOthers.map(x => x.file + '\u0001' + x.text).join('\u0002');
  const dirty = text !== orig || otherDirty;
  const sections = useMemo(() => parseSections(text), [text]);
  // a file with frames opens on its first frame, so the frame and the pattern set it calls are there at once
  const autoFocused = useRef(false);
  useEffect(() => {
    if (autoFocused.current || !loaded || initialSet) return;
    autoFocused.current = true;
    { const k = sections.findIndex(s => s.kind === 'control'); if (k >= 0) setFocusIdx(k); }
  }, [loaded, sections]);
  // opened on a given pattern set ("Edit" of the read-only pattern view): the drop-down starts on that set, once, when the file is loaded
  const openedOnSet = useRef(false);
  useEffect(() => {
    if (!initialSet || openedOnSet.current || !loaded) return;
    openedOnSet.current = true;
    const k = sections.findIndex(sec => sec.kind === 'set' && sec.label.toLowerCase() === (initialSet.startsWith('&') ? initialSet : '&' + initialSet).toLowerCase());
    if (k >= 0) setFocusIdx(k);
  }, [loaded, sections]);
  const focus = focusIdx >= 0 ? sections[Math.min(focusIdx, sections.length - 1)] : null;
  const lo = focus ? focus.start : 0, hi = focus ? focus.end : text.length;
  const view = text.slice(lo, hi);
  const lint = useMemo(() => lintPattern(text), [text]);
  const lintHere = lint.filter(l => l.fix.index >= lo && l.fix.index < hi);

  // ── the pattern sets of the chosen rule that live in other files ──
  const callNames = focus && focus.kind === 'control' ? focus.calls || [] : [];
  const callKey = callNames.join(',');
  useEffect(() => {
    const need = callNames.filter(n => !(n in defs));
    if (!need.length) return;
    let live = true;
    api.findSetDefs({ cartPath, file, names: need }).then(r => { if (live && r.ok !== false) setDefs(d => ({ ...d, ...r.defs })); }).catch(() => {});
    return () => { live = false; };
  }, [callKey, cartPath, file]);
  // the pattern sets the frame calls: a set written in this file is edited in the same text; one written in ANOTHER file is loaded from it
  const linked = callNames.map(n => { const hs = defs[n] || []; const hit = hs.find(h => h.inFile) || hs[0]; return { name: n, hit, here: !!(hit && hit.inFile) }; }).filter(x => x.hit);
  // While a name is being typed (the call in the frame, or the "#define &NAME" of the set) the two names differ for a moment and the set cannot be found by its name: the set that was
  // shown stays on the screen (the same file, the same place among the sets of that file), so the box does not disappear under the cursor.
  const stuck = useRef(null);                                  // { focusIdx, name, hit, here, ord }
  const stuckHere = !!(focus && focus.kind === 'control' && stuck.current && stuck.current.focusIdx === focusIdx);
  const found = linked.length ? linked[Math.min(setIdx, linked.length - 1)] : null;
  const sel = found || (stuckHere ? { name: stuck.current.name, hit: stuck.current.hit, here: stuck.current.here } : null);
  const here = !!(sel && sel.here);
  const selFile = sel && !here ? sel.hit.file : '';                  // the other file ('' when the set is in this file)
  useEffect(() => { setSetIdx(0); }, [focusIdx]);
  useEffect(() => {
    if (!selFile || others[selFile]) return;
    let live = true;
    api.readFile({ cartPath, file: selFile }).then(r => {
      if (!live) return;
      setOthers(o => ({ ...o, [selFile]: r.ok === false ? { error: r.error, text: '', orig: '' } : { text: r.file.text, orig: r.file.text, eol: r.file.eol, mtime: r.file.mtime } }));
    }).catch(e => live && setOthers(o => ({ ...o, [selFile]: { error: e.message, text: '', orig: '' } })));
    return () => { live = false; };
  }, [selFile, cartPath]);
  const oRec = selFile ? others[selFile] : null;
  const srcText = here ? text : oRec && !oRec.error ? oRec.text : null;          // the text the pattern set is in
  const oSecs = useMemo(() => (here ? sections : srcText != null ? parseSections(srcText) : []), [here, sections, srcText]);
  const setSecs = oSecs.filter(s => s.kind === 'set');
  let oSet = sel ? setSecs.find(s => s.label.toLowerCase() === sel.name.toLowerCase()) : null;
  if (oSet && found) stuck.current = { focusIdx, name: sel.name, hit: sel.hit, here: sel.here, ord: setSecs.indexOf(oSet) };
  else if (!oSet && stuckHere) oSet = setSecs[stuck.current.ord] || null;                  // renamed: the set at the same place
  const oView = oSet ? srcText.slice(oSet.start, oSet.end) : '';
  // edit the text of the set's file (functional updater like setText); for a set in this file that is the text itself
  const setOtherText = (fn) => (here ? setText(fn) : setOthers(o => ({ ...o, [selFile]: { ...o[selFile], text: typeof fn === 'function' ? fn(o[selFile].text) : fn } })));
  const changeSet = (v) => oSet && setOtherText(srcText.slice(0, oSet.start) + v + srcText.slice(oSet.end));
  const oLintHere = useMemo(() => (oSet ? (here ? lint : lintPattern(srcText)).filter(l => l.fix.index >= oSet.start && l.fix.index < oSet.end) : []), [srcText, oSet && oSet.start, oSet && oSet.end]);
  const oMarks = oSet ? lintMarks(oLintHere).filter(m => m.index >= oSet.start && m.index < oSet.end).map(m => ({ index: m.index - oSet.start, length: Math.min(m.length, oSet.end - m.index) })) : [];
  const twoParts = !!sel;
  // A rule (… : pattern ;) and a pattern set (#define &NAME(…)( … ) ;) must end with ";" — msgrep reports the NEXT line then ("name or #name expected"). The box shows exactly what is in the file,
  // so a missing ";" is only marked (red wavy underline on the last character); the app never adds or removes a character of the text itself.
  const noSemi = (t) => !/;\s*$/.test(t);
  const focusEndMissing = !!focus && (focus.kind === 'set' || !!focus.body) && noSemi(view);
  const setEndMissing = !!oSet && noSemi(oView);
  const endMark = (t) => ({ index: Math.max(0, t.trimEnd().length - 1), length: 1 });
  const EndWarn = ({ what }) => (
    <div style={{ marginTop: 6, padding: '5px 8px', border: '1px solid var(--danger, #f38ba8)', borderRadius: 6, fontSize: 12, color: 'var(--danger, #f38ba8)' }}>
      ✗ This {what} does not end with “;” in the file — msgrep will stop at the next line (“name or #name expected”). The last character is underlined; add the “;” yourself.
    </div>
  );

  // compile errors → the whole line gets the wavy underline
  const lineRange = (n, t0 = text) => { let s = 0; for (let k = 1; k < n; k++) { const e = t0.indexOf('\n', s); if (e < 0) return null; s = e + 1; } const e = t0.indexOf('\n', s); const end = e < 0 ? t0.length : e; const lead = t0.slice(s, end).search(/\S/); return lead < 0 ? null : { index: s + lead, length: end - s - lead }; };
  const checkStale = !!check && (check.text !== text || check.sig !== extraSig);
  const checked = check && check.res && !checkStale ? check.res : null;
  const errMarks = checked ? checked.errors.map(e => lineRange(e.line)).filter(Boolean) : [];
  const marks = [...lintMarks(lintHere), ...errMarks.filter(m => !lintHere.some(l => m.index < l.fix.index + l.fix.length && l.fix.index < m.index + m.length))]
    .filter(m => m.index >= lo && m.index < hi).map(m => ({ index: m.index - lo, length: Math.min(m.length, hi - m.index) }));

  // compile errors that msgrep reports in the file of the pattern set shown under the frame
  const oErrMarks = checked && oSet && (here || oRec)
    ? (here ? errMarks : checked.others.filter(e => e.file.toLowerCase() === selFile.split('/').pop().toLowerCase()).map(e => lineRange(e.line, oRec.text)).filter(Boolean))
        .filter(m => m.index >= oSet.start && m.index < oSet.end).map(m => ({ index: m.index - oSet.start, length: Math.min(m.length, oSet.end - m.index) })) : [];

  const change = (v) => setText(focus ? text.slice(0, lo) + v + text.slice(hi) : v);

  // the edited pattern-set files (other than this one) that the check can take into account: the ones in the same folder
  const runCheck = async () => {
    setNote(''); setCheck({ busy: true });
    const sig = extraSig;
    try {
      const r = await api.checkFile({ cartPath, file, text, extra: dirtyOthers.filter(x => dirOf(x.file).toLowerCase() === dirOf(file).toLowerCase()) });
      setCheck(r.ok === false ? { text, sig, error: r.error } : { text, sig, res: r.check });
    } catch (e) { setCheck({ text, sig, error: e.message }); }
  };

  // → true when everything edited here (this file, and the pattern-set files shown under the frame) is on disk afterwards
  const save = async (force = false) => {
    setSaving(true); setNote('');
    let ok = true; const done = [];
    const put = async (f, content, rec, apply) => {
      const r = await api.saveFile({ cartPath, file: f, text: content, eol: rec.eol, mtime: rec.mtime, force });
      if (r.ok === false) {
        if (r.error === 'CHANGED_ON_DISK') {
          if (window.confirm(f + '\n\nThis file was changed on disk after it was opened here (another editor?).\n\nOverwrite it with the text in this editor? A copy of the file on disk is kept in _relation_backups.')) { const r2 = await api.saveFile({ cartPath, file: f, text: content, eol: rec.eol, mtime: rec.mtime, force: true }); if (r2.ok === false) { setNote('✗ ' + r2.error); ok = false; return; } apply(r2.saved); done.push(r2.saved.backup); return; }
          ok = false; return;
        }
        setNote('✗ ' + r.error); ok = false; return;
      }
      apply(r.saved); done.push(r.saved.backup);
    };
    try {
      if (text !== orig) await put(file, text, loaded, (s) => { setLoaded(l => ({ ...l, mtime: s.mtime })); setOrig(text); });
      for (const [f, o] of Object.entries(others)) {
        if (!ok) break;
        if (o.text !== o.orig) await put(f, o.text, o, (s) => setOthers(all => ({ ...all, [f]: { ...all[f], orig: o.text, mtime: s.mtime } })));
      }
      if (ok && done.length) setNote('✓ Saved' + (done.length > 1 ? ' ' + done.length + ' files' : '') + '. A copy of the previous file' + (done.length > 1 ? 's is' : ' is') + ' in ' + done[0].split(/[\\/]/).slice(0, 2).join('\\') + '.');
    } catch (e) { setNote('✗ ' + e.message); ok = false; }
    setSaving(false);
    return ok;
  };

  // Compile: the folder of this file is rebuilt (ttkconf comp_…, the old .grbatch is replaced); the edited text is saved first. A file that several pattern folders
  // include (AllPatterns.msgrep of a parent folder) rebuilds all of them — the user is told which before it starts.
  const dir = file.replace(/[\\/][^\\/]*$/, '');
  const topLevel = !/[\\/]/.test(dir) || /^grdata$/i.test(dir);
  const [comp, setComp] = useState(null);                  // { busy } | { jobs } | { error }
  const [target, setTarget] = useState(null);                  // what compiling this file's folder builds: { plan: [{ prefix, batch, folders }], fresh: [{ rel, prefix, batch }] } | { error }
  useEffect(() => {
    if (topLevel) { setTarget(null); return; }
    let live = true;
    api.compileFolder({ cartPath, relDir: dir, dryRun: true }).then(r => live && setTarget(r.ok === false ? { error: r.error } : r.result)).catch(e => live && setTarget({ error: e.message }));
    return () => { live = false; };
  }, [cartPath, dir]);
  const compile = async () => {
    setComp({ busy: true }); setNote('');
    try {
      if (dirty && !(await save())) { setComp(null); return; }
      // the folder of this file; and, when the pattern set under the frame was edited in a file of another folder (that is not a top-level macro file), that folder too
      // dirs: [{ d, only }] — `only`: a pattern set of a shared file was edited, so of the folder's batches only those whose rules call that set are rebuilt
      const dirs = [{ d: dir }];
      const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
      const sd = selFile ? dirOf(selFile) : '';
      const setEdited = !!(selFile && others[selFile] && others[selFile].text !== others[selFile].orig);
      if (setEdited && /[\\/]/.test(sd) && norm(sd) !== norm(dir)) {
        const sdJob = { d: sd, only: sel ? [sel.name] : undefined };
        if (norm(dir).startsWith(norm(sd) + '/') && !dirty) dirs.splice(0, 1, sdJob);       // only the set changed: the batches that call it (this folder's among them)
        else dirs.push(sdJob);                                                              // the frame file changed too (or another folder): this folder in full, plus the batches calling the set
      }
      const plans = [];
      for (const x of dirs) {
        const plan = await api.compileFolder({ cartPath, relDir: x.d, dryRun: true, onlyUsing: x.only });
        if (plan.ok === false) { setComp({ error: plan.error }); return; }
        plans.push(plan.result);
      }
      const seen = new Set();
      const batches = plans.flatMap(p => [...p.plan.map(x => ({ key: x.prefix, text: x.batch + '  (' + x.folders.join(', ') + ')' })), ...p.fresh.map(f => ({ key: 'new:' + f.rel, text: 'NEW folder ' + f.rel + ' → ' + f.batch }))]).filter(b => !seen.has(b.key) && seen.add(b.key));
      if (!batches.length) { setComp({ error: 'No pattern batch calls ' + (sel ? sel.name : 'the edited pattern set') + ' — nothing to compile.' }); return; }
      if (batches.length > 1 && !window.confirm('Compiling rebuilds ' + batches.length + ' pattern batches' + (dirs.some(x => x.only) ? ' (the ones whose rules call ' + dirs.find(x => x.only).only[0] + ')' : '') + ':\n\n' + batches.map(b => b.text).join('\n') + '\n\nThis can take several minutes. Continue?')) { setComp(null); return; }
      const jobs = [];
      for (const x of dirs) {
        const r = await api.compileFolder({ cartPath, relDir: x.d, onlyUsing: x.only });
        if (r.ok === false) { setComp({ error: r.error }); return; }
        for (const j of r.result.jobs) if (!jobs.some(x => x.prefix === j.prefix)) jobs.push(j);
      }
      setComp({ jobs });
    } catch (e) { setComp({ error: e.message }); }
  };

  // Consolidate patterns: the patterns of a set (or after the ":" of a rule) that do not contradict each other are merged (rules: utils/consolidate.js). The chosen
  // part of the file — the whole file, or the rule / set picked in the drop-down — is looked at; the result is shown first and put into the text only on "Apply".
  // Find macro: the macros of this cartridge that contain a word; Insert puts the macro name into the text at the cursor
  const [findMacro, setFindMacro] = useState(false);
  const [help, setHelp] = useState(false);                   // the Help window: pattern notation
  const box = useRef(null);                                // the editing box (its selection is kept while the Find macro window has the focus)
  const box2 = useRef(null);                               // the second box: the pattern set under the frame
  const activeBox = useRef('frame');                       // which of the two boxes was worked in last ('frame' | 'set')
  const insertAtCursor = (name) => {
    const inSet = twoParts && oSet && activeBox.current === 'set';
    const ref = inSet ? box2 : box, cur = inSet ? oView : view;
    const el = ref.current;
    const a = el ? el.selectionStart : cur.length, b = el ? el.selectionEnd : cur.length;
    (inSet ? changeSet : change)(cur.slice(0, a) + name + cur.slice(b));
    requestAnimationFrame(() => { const e = ref.current; if (e) { e.focus(); e.setSelectionRange(a + name.length, a + name.length); } });
  };
  const [cons, setCons] = useState(null);                  // { changes: [{ label, line, before, after, groups, start, end, body }], scanned } — what Apply would do
  const consolidate = () => {
    const onSet = twoParts && oSet && activeBox.current === 'set';                    // the pattern set under the frame was the last box worked in
    const src = onSet ? srcText : text;
    const parts = (onSet ? [oSet] : focus ? [focus] : sections).filter(sec => sec.body);
    const changes = [];
    for (const sec of parts) {
      const alts = splitAlternatives(src.slice(sec.body.start, sec.body.end));
      if (!alts || alts.length < 2) continue;
      const r = consolidateAlternatives(alts);
      if (r.out.length >= alts.length) continue;
      changes.push({ label: (sec.kind === 'set' ? 'Pattern set ' : 'Rule ') + sec.label, line: sec.line, before: alts.length, after: r.out.length, groups: r.groups.filter(g => g.merged).map(g => ({ ...g, from: g.members.map(i => alts[i]) })), start: sec.body.start, end: sec.body.end, body: '\n' + r.out.join('\n|\n') + '\n' });
    }
    setCons({ changes, scanned: parts.length, onSet });
  };
  const applyConsolidation = () => {
    let t = cons.onSet ? srcText : text;
    for (const c of [...cons.changes].sort((a, b) => b.start - a.start)) t = t.slice(0, c.start) + c.body + t.slice(c.end);
    if (cons.onSet) setOtherText(t); else setText(t);
    setCons(null); setCheck(null); setNote('Patterns consolidated — review the result, then Save & Compile (or Close to throw it away).');
  };

  // compiled successfully and nothing changed since: nothing left to save or compile
  const upToDate = !dirty && !topLevel && !!comp && !comp.busy && !comp.error && !!comp.jobs && comp.jobs.length > 0 && comp.jobs.every(j => j.ok);
  const close = () => { if (!dirty || window.confirm('The file has unsaved changes. Close without saving?')) onClose(); };
  // a rule is listed by its symbolic relation: (in types) -[ControlType; properties]-effect> (out types) → the pattern set it calls
  const secLabel = (s) => s.kind === 'set'
    ? 'Pattern set ' + s.label + ' — line ' + s.line + (s.detail ? ' — ' + s.detail : '')
    : (s.symbolic || 'Rule ' + s.label) + (s.calls && s.calls.length ? '   → ' + s.calls.join(', ') : '') + '   (line ' + s.line + ')';

  return (
    <>
      <FloatingDialog title={'Edit ' + file + (dirty ? ' •' : '') + (cartName ? ' — ' + cartName : '')} width={1150}>
        <div style={{ fontSize: 12 }}>
          {error && <div className="text-danger" style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{error}</div>}
          {!loaded && !error && <div className="text-muted">loading…</div>}
          {loaded && <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <label title="Choose the frame (CONTROL rule) to edit — it is listed by its symbolic relation; the pattern set it calls is shown below it">{sections.some(s => s.kind === 'control') ? 'Frame' : 'Show'}</label>
              <FramePicker value={focus ? focusIdx : -1} onChange={setFocusIdx} options={[
                { value: -1, label: 'Whole file — ' + sections.filter(s => s.kind === 'control').length + ' CONTROL rule(s), ' + sections.filter(s => s.kind === 'set').length + ' pattern set(s)' },
                ...sections.map((s, i) => (s.kind === 'control' ? { value: i, label: secLabel(s), group: 'CONTROL rules' } : null)).filter(Boolean),
                ...sections.map((s, i) => (s.kind === 'set' ? { value: i, label: secLabel(s), group: 'Pattern sets' } : null)).filter(Boolean),
              ]} />
              <button type="button" className="btn btn-sm btn-secondary" title="Open the file in the system's text editor instead" onClick={() => window.api.shell.openFile(cartPath + '\\' + file)}>Open in Notepad</button>
            </div>
            <div className="text-xs" style={{ marginBottom: 6 }}>
              <span className="text-muted">Compiled into: </span>
              {topLevel ? <span className="text-muted">no batch of its own — this macro file is included by the pattern folders</span>
                : !target ? <span className="text-muted">…</span>
                : target.error ? <span className="text-muted">{target.error}</span>
                : <>
                    {target.plan.slice(0, 4).map((p, i) => <span key={p.prefix}>{i > 0 && ', '}<code>{p.batch}</code> <span className="text-muted">(comp_{p.prefix})</span></span>)}
                    {target.plan.length > 4 && <span className="text-muted"> and {target.plan.length - 4} more</span>}
                    {target.fresh.map((f, i) => <span key={f.rel}>{(i > 0 || target.plan.length > 0) && ', '}<code>{f.batch}</code> <span className="text-muted">(new — comp_{f.prefix} is registered in ttkconf.ini / locscan.ini on the first compile)</span></span>)}
                    {target.plan.length + target.fresh.length > 1 && <span className="text-muted"> — this file is shared by {target.plan.length + target.fresh.length} pattern folders; Save &amp; Compile rebuilds all of them</span>}
                  </>}
            </div>
            {focus && <div className="text-xs text-muted" style={{ marginBottom: 4 }}>Only this {focus.kind === 'set' ? 'pattern set' : 'rule'} is shown (lines {focus.line}–{text.slice(0, focus.end).split('\n').length} of the file); the rest of the file is kept as it is.</div>}
            {twoParts && <div style={{ fontWeight: 600, margin: '2px 0 4px' }}>Frame <span className="text-muted" style={{ fontWeight: 400 }}>— {file}</span></div>}
            <div onFocusCapture={() => { activeBox.current = 'frame'; }}>
              <MacroTextarea key={macroVer + ':' + focusIdx} taRef={box} height={twoParts ? '20vh' : '58vh'} cartPath={cartPath} value={view} onChange={change} marks={focusEndMissing ? [...marks, endMark(view)] : marks} onEditMacro={setEditMacroName} />
            </div>
            <LintIssues text={text} lint={lintHere} setText={setText} />
            {focusEndMissing && <EndWarn what={focus.kind === 'set' ? 'pattern set' : 'rule'} />}
            {twoParts && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>Pattern set</span>
                  {linked.length > 1
                    ? <select className="form-control" style={{ width: 'auto', fontSize: 12 }} value={Math.min(setIdx, linked.length - 1)} onChange={e => setSetIdx(Number(e.target.value))}>
                        {linked.map((x, i) => <option key={x.name} value={i}>{x.name}</option>)}
                      </select>
                    : <code>{sel.name}</code>}
                  <span className="text-muted">— {here ? file + ' (this file)' : selFile}, line {sel.hit.line}{oSet ? ' — ' + oSet.detail : ''}</span>
                  {!here && oRec && oRec.text !== oRec.orig && <span style={{ color: 'var(--warning, #e8a000)' }}>• changed</span>}
                  <button type="button" className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto', padding: '1px 8px' }} title="Open this pattern file in the system's text editor" onClick={() => window.api.shell.openFile(cartPath + '\\' + (selFile || file).replace(/\//g, '\\'))}>Open in Notepad</button>
                </div>
                {!here && !oRec && <div className="text-muted">loading…</div>}
                {oRec && oRec.error && <div className="text-danger" style={{ whiteSpace: 'pre-wrap' }}>{oRec.error}</div>}
                {(here || (oRec && !oRec.error)) && !oSet && <div className="text-muted">The pattern set {sel.name} was not found in {here ? file : selFile}.</div>}
                {(here || (oRec && !oRec.error)) && oSet && <>
                  <div onFocusCapture={() => { activeBox.current = 'set'; }}>
                    <MacroTextarea key={macroVer + ':set:' + selFile + sel.name} taRef={box2} height="34vh" cartPath={cartPath} value={oView} onChange={changeSet}
                      marks={[...oMarks, ...oErrMarks.filter(m => !oMarks.some(l => m.index < l.index + l.length && l.index < m.index + m.length)), ...(setEndMissing ? [endMark(oView)] : [])]} onEditMacro={setEditMacroName} />
                  </div>
                  <LintIssues text={srcText} lint={oLintHere} setText={setOtherText} />
                  {setEndMissing && <EndWarn what="pattern set" />}
                </>}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={saving || comp?.busy || (topLevel && !dirty) || upToDate} onClick={topLevel ? () => save(false) : compile}
                title={upToDate ? 'Everything is saved and compiled — nothing to do until the patterns are changed' : topLevel ? 'A macro file directly in grdata is included by the pattern folders: save it, then compile those (right-click the folder → Compile)' : 'Save the file (if changed) and compile its folder with ttkconf — the .grbatch is rebuilt'}>
                {saving || comp?.busy ? <><span className="spinner" /> {comp?.busy && !saving ? 'Compiling…' : 'Saving…'}</> : upToDate ? '✓ Compiled' : topLevel ? '💾 Save' : '💾 Save & Compile'}
              </button>
              <button className="btn btn-secondary" disabled={check?.busy} onClick={runCheck} title="Compile the edited text with msgrep (nothing is saved) and show the errors">{check?.busy ? <><span className="spinner" /> Checking…</> : 'Check rules'}</button>
              <button className="btn btn-secondary" onClick={() => setFindMacro(true)} title="Find the macros of this cartridge that contain a word and insert one into the text at the cursor">Find macro</button>
              <button className="btn btn-secondary" onClick={() => setHelp(h => !h)} title="The pattern notation — symbol and brief explanation — to look up while editing">Help</button>
              <button className="btn btn-secondary" onClick={consolidate} title="Merge the patterns of a set that do not contradict each other into one: longer gaps, united word sets, optional words — nothing is changed until you press Apply">Consolidate patterns</button>
              <button className="btn btn-secondary" onClick={close}>Close</button>
              {!dirty && <span className="text-muted">no changes</span>}
              {note && <span style={{ color: note.startsWith('✓') ? 'var(--success, #a6e3a1)' : 'var(--danger, #f38ba8)' }}>{note}</span>}
            </div>
            {cons && (
              <div style={{ marginTop: 8, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, maxHeight: 280, overflow: 'auto' }}>
                {!cons.changes.length
                  ? <div className="text-muted">Nothing to consolidate: no two patterns of {focus ? 'this ' + (focus.kind === 'set' ? 'set' : 'rule') : 'the ' + cons.scanned + ' set(s) / rule(s) of the file'} can be merged without changing what they mean.
                      <button className="btn btn-sm btn-secondary" style={{ marginLeft: 8, padding: '1px 8px' }} onClick={() => setCons(null)}>OK</button></div>
                  : <>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                        <b style={{ flex: 1 }}>{cons.changes.reduce((n, c) => n + c.before, 0)} patterns → {cons.changes.reduce((n, c) => n + c.after, 0)} in {cons.changes.length} set{cons.changes.length !== 1 ? 's' : ''} — nothing is changed until you apply it</b>
                        <button className="btn btn-sm btn-primary" onClick={applyConsolidation}>Apply</button>
                        <button className="btn btn-sm btn-secondary" onClick={() => setCons(null)}>Cancel</button>
                      </div>
                      {cons.changes.map((c, i) => (
                        <details key={i} open={cons.changes.length === 1} style={{ marginBottom: 4 }}>
                          <summary><b>{c.label}</b> <span className="text-muted">— line {c.line}: {c.before} → {c.after} patterns</span></summary>
                          {c.groups.map((g, k) => (
                            <div key={k} style={{ margin: '4px 0 6px 14px', fontFamily: 'monospace', fontSize: 11.5 }}>
                              <div style={{ color: 'var(--success, #a6e3a1)' }}>→ {g.text}</div>
                              {g.from.map((p, q) => <div key={q} className="text-muted" style={{ marginLeft: 12 }}>#{g.members[q] + 1}  {p.replace(/\s+/g, ' ')}</div>)}
                            </div>
                          ))}
                        </details>
                      ))}
                    </>}
              </div>
            )}
            {comp && !comp.busy && (
              <div style={{ marginTop: 8, color: comp.error || comp.jobs.some(j => !j.ok) ? 'var(--danger, #f38ba8)' : 'var(--success, #a6e3a1)' }}>
                {comp.error ? <div style={{ whiteSpace: 'pre-wrap' }}>✗ {comp.error}</div> : comp.jobs.map(j => (
                  <div key={j.prefix}>{j.ok ? '✓' : '✗'} <code>comp_{j.prefix}</code> → <code>{j.batch}</code> <span className="text-muted">({j.folders.join(', ')})</span>{j.message ? ' — ' + j.message : ''}</div>
                ))}
              </div>
            )}
            {check && !check.busy && (check.error
              ? <div className="text-danger" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>✗ {check.error}</div>
              : <div style={{ marginTop: 8, opacity: !checkStale ? 1 : 0.55 }}>
                  {check.res.ok
                    ? <div style={{ color: 'var(--success, #a6e3a1)' }}>✓ msgrep compiles the file ({check.res.seconds} s){checkStale ? ' — the text changed since this check' : ''}.{check.res.warnings.length > 0 && <span className="text-muted"> {check.res.warnings.length} warning(s): {check.res.warnings.slice(0, 3).join(' | ')}</span>}</div>
                    : <div style={{ color: 'var(--danger, #f38ba8)' }}>
                        ✗ msgrep does not compile it{checkStale ? ' (the text changed since this check)' : ''}:
                        {check.res.errors.map((e, i) => <div key={i}>Line {e.line}: {e.message}</div>)}
                        {check.res.others.map((e, i) => <div key={'o' + i} className="text-muted">{e.file} line {e.line}: {e.message} (another file of this folder)</div>)}
                        {check.res.general.map((g, i) => <div key={'g' + i}>{g}</div>)}
                      </div>}
                </div>)}
          </>}
        </div>
      </FloatingDialog>
      {help && <PatternHelpDialog onClose={() => setHelp(false)} />}
      {findMacro && <FindMacroDialog api={api} cartPath={cartPath} cartName={cartName} onInsert={insertAtCursor} onClose={() => setFindMacro(false)} />}
      {editMacroName && <CreateMacroDialog api={api} cartPath={cartPath} cartName={cartName} patternText={text} relationName="" editName={editMacroName} onAdded={() => setMacroVer(v => v + 1)} onClose={() => setEditMacroName('')} />}
    </>
  );
}
