import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import FloatingDialog from './FloatingDialog';
import UsedPatternsDialog from './UsedPatternsDialog';
import FindMacroDialog from './FindMacroDialog';
import PatternHelpDialog from './PatternHelpDialog';
import FileEditorDialog from './FileEditorDialog';
import { effectArrow, effectColor } from '../utils/effectArrow';
import CreateMacroDialog from './CreateMacroDialog';
import MacroTextarea, { LintIssues, lintMarks } from './PatternEditor';
import { lintPattern, applyFixes } from '../utils/patternLint';
import { chooseFrame, frameFit, macroGaps, folderName } from '../utils/frames';

// "New relation" wizard (Patterns screen). Backend: src/main/relationBuilder.js
//   1 Cartridge → 2 Relation declaration → 3 Entity types → 4 Pattern + validation → 5 Files written + Compile & register (one step)
const STEPS = ['Cartridge', 'Relation', 'Entity types', 'Pattern', 'Files & compile'];
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

const listStyle = { width: '100%', height: 230, fontSize: 13, background: 'var(--surface)', color: 'var(--text)',
                    border: '1px solid var(--border)', borderRadius: 6, padding: 4 };

// `suggest` ({ relation, regulator, target, pattern, sentence }) = opened from Pipeline → "Suggest pattern":
// steps 1–3 are filled in automatically and the wizard starts at step 4 with the LLM's pattern.
export default function RelationWizard({ cartridges, initialCartridge, suggest, onClose }) {
  const [step, setStep] = useState(suggest ? 4 : 1);
  const [cart, setCart] = useState(initialCartridge || cartridges[0] || null);
  const [info, setInfo] = useState(null);                 // { nodeTypes, relations, usedPrefixes }
  const [name, setName] = useState('');
  const [directional, setDirectional] = useState(true);   // FR 2.2: checked by default
  const [prefix, setPrefix] = useState('');
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [declared, setDeclared] = useState(null);         // { written, line, existed }
  const [available, setAvailable] = useState([]);
  const [regs, setRegs] = useState([]);
  const [tgts, setTgts] = useState([]);
  const [selA, setSelA] = useState([]);
  const [selR, setSelR] = useState([]);
  const [selT, setSelT] = useState([]);
  const [text, setText] = useState(suggest?.pattern || '');
  const [setName_, setSetName] = useState('');
  const [setTouched, setSetTouched] = useState(false);
  const [effectSel, setEffectSel] = useState(null);       // the Effect chosen in step 4 for a NEW rule: null = as given by the Suggest pattern choice / the modelling set, '' = none, else positive | negative | unknown
  const [validation, setValidation] = useState(null);     // { result, text, set }
  const [gen, setGen] = useState(null);
  const [comp, setComp] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lintBlocked, setLintBlocked] = useState(false);   // Validate was pressed while the spell-check still had hits
  const [userTest, setUserTest] = useState(null);    // "Test pattern": { busy } | { text, result } — the pattern as typed, run on the Suggest-pattern markup like the repair steps do
  const [testSent, setTestSent] = useState('');             // opened without a sentence (Patterns → Add relation): the user's own test sentence …
  const [testMk, setTestMk] = useState(null);                 // … and its markup { sentence, markup } from this cartridge's pipeline
  const [createMacro, setCreateMacro] = useState(null);       // dialog: a new macro in a macro file { text, start, end, body }
  const openCreateMacro = () => {
    const el = patternBox.current;
    const start = el ? el.selectionStart : text.length, end = el ? el.selectionEnd : text.length;
    const sel = text.slice(start, end).trim();
    setCreateMacro({ text, start, end, body: !sel ? '' : /^\[[\s\S]*\]$/.test(sel) ? sel : '[' + sel + ']', hasSel: end > start });
  };
  const [editMacroName, setEditMacroName] = useState('');       // dialog: edit this existing macro (context menu "Edit macro")
  const [macroVer, setMacroVer] = useState(0);                 // bumped when a macro was created / changed: the pattern box forgets the macro definitions it showed in tooltips
  const macroCreated = (name, putIn, edited, renamedTo) => {
    const c = createMacro;
    setMacroVer(v => v + 1);
    if (renamedTo) { setText(t => t.replace(new RegExp(name.replace(/[$]/g, '[$]') + '(?![A-Za-z0-9_])', 'g'), () => renamedTo)); return; }   // the pattern being edited follows the rename
    if (edited || !putIn || !c) return;
    if (c.hasSel && text === c.text) setText(c.text.slice(0, c.start) + name + c.text.slice(c.end)); else insertAtCursor(name);
  };
  // "Edit" in the read-only view of a pattern set: that file opens in the pattern editor, on that set. When it is closed the sets of the relation are read again
  // (the file may have changed: the list of existing sets and the macro tooltips are brought up to date)
  const [editSet, setEditSet] = useState(null);                  // { file (inside the cartridge), set }
  const closeSetEditor = () => {
    setEditSet(null); setMacroVer(v => v + 1);
    if (name) api.existingSets({ cartPath, name }).then(ex => { if (ex.ok) setCandList(ex.sets || []); }).catch(() => { /* optional */ });
  };
  const [findMacro, setFindMacro] = useState(false);          // dialog: find a macro by a word it contains
  const [help, setHelp] = useState(false);                     // dialog: the pattern notation (Help)
  const patternBox = useRef(null);                            // the pattern textarea (Find macro inserts at its cursor)
  const insertAtCursor = (s) => {
    const el = patternBox.current;
    const at = el ? el.selectionStart : text.length, to = el ? el.selectionEnd : text.length;
    const pre = text.slice(0, at), post = text.slice(to);
    const piece = (pre && !/\s$|[\[(]$/.test(pre) ? ' ' : '') + s + (post && !/^\s|^[\])]/.test(post) ? ' ' : '');
    setText(pre + piece + post);
    requestAnimationFrame(() => { if (el) { el.focus(); const p = (pre + piece).length; el.setSelectionRange(p, p); } });
  };
  const [viewExisting, setViewExisting] = useState(false);  // dialog: the existing pattern that already extracts the relation
  const [setView, setSetView] = useState(null);     // read-only view of the chosen existing set: { set, ruleFile, setFile, frame, patterns } | { error }
  const [error, setError] = useState(null);
  const [finished, setFinished] = useState(false);
  const [frameWarn, setFrameWarn] = useState(null);     // { missing, others } — node types not IsFrame in this cartridge
  const [prefill, setPrefill] = useState(null);         // { name, regulators, targets, both, sources } of an existing relation

  const cartPath = cart?.path;
  // "Suggest pattern": pattern sets of this relation that already exist in the cartridge; the pattern may be added to one of them
  const [candList, setCandList] = useState(suggest?.candidates || []);
  const cands = candList;
  const [placeId, setPlaceId] = useState(suggest?.placementId || null);
  const [placeTouched, setPlaceTouched] = useState(false);          // the user picked a set in the list himself: do not choose for him again
  const [placeReason, setPlaceReason] = useState(suggest?.placementReason || '');
  const [placeWhy, setPlaceWhy] = useState(suggest?.placementWhy || '');
  const [analysis, setAnalysis] = useState(null);                    // what the LLM-time messages say about the CURRENT pattern text: { macroHints, elsewhere }
  const hasActNow = /[$]ACT(?![A-Za-z0-9_])|(?<![\w&])&(?![A-Za-z_])/.test(text.replace(/^\s*#define.*$/gm, ''));   // $ACT or a literal "&" (ConceptScan pattern)
  const lint = useMemo(() => lintPattern(text), [text]);
  // the token a validation error points at (line / column from the app's syntax check), underlined like the spell-check marks; only while the check is about THIS text
  const errMarks = useMemo(() => {
    if (!validation) return [];
    const vt = validation.text;                                  // the text the check was about; when it was edited since, the token is looked up again in the new text
    const lineStart = [0];
    for (let i = 0; i < vt.length; i++) if (vt[i] === '\n') lineStart.push(i + 1);
    const out = [];
    for (const e of [...(validation.result.errors || []), ...(validation.result.warnings || []).filter(w => w.kind === 'syntax' && /Unexpected/.test(w.message))]) {
      if (!e.line || !e.col || lineStart[e.line - 1] === undefined) continue;
      let at = lineStart[e.line - 1] + e.col - 1, len;
      const open = vt.lastIndexOf('{', at), close = vt.indexOf('}', at);
      if (open >= 0 && close > open && !/[}\s]/.test(vt.slice(open + 1, at))) { at = open; len = close - open + 1; }       // inside a {n,m} quantifier: the whole quantifier
      else { const m = /^[^\s\[\]()|{}]+/.exec(vt.slice(at)); len = m ? m[0].length : 1; }
      if (vt !== text) { const tok = vt.slice(at, at + len); at = text.indexOf(tok); if (at < 0) continue; }
      if (!out.some(o => at < o.index + o.length && o.index < at + len)) out.push({ index: at, length: len });
    }
    return out;
  }, [validation, text]);
  // messages that describe a pattern text show only while they are about THIS text: the LLM's own (its design report) or the one analysed on the last Test / validate
  const isLlmText = text.trim() === String(suggest?.pattern || '').trim();
  const fresh = analysis && analysis.text === text ? analysis : null;
  const hintsNow = fresh ? fresh.macroHints : (isLlmText ? (suggest?.macroHints || []) : []);
  // From the Pipeline screen (a sentence + markup exist) the pattern must pass the test on THIS text before “Validate” is possible;
  // a test that cannot be run at all (e.g. a node type that is no frame yet) does not block
  const needsTest = !!suggest?.markup;
  const testPassed = (() => {
    const r = userTest?.result;
    if (r && !userTest.busy && userTest.text === text) return !!(r.ok && (r.skipped || r.terms > 0));
    return !!(isLlmText && suggest?.tested && (suggest.tested.skipped || suggest.tested.ok));   // the LLM's own pattern was already tested exactly like this while it was designed
  })();
  const testedNow = (() => {
    const r = userTest?.result;
    if (r && !userTest.busy && userTest.text === text) return !r.ok ? { ok: false, message: r.message, own: true } : r.skipped ? { skipped: true, message: r.message } : { ok: r.terms > 0, terms: r.terms, own: true };
    return isLlmText ? suggest?.tested : null;
  })();
  const picked = cands.find(c => c.id === placeId) || null;
  const patMode = hasActNow ? 'csout' : 'msout';
  const placed = picked && picked.mode === patMode ? picked : null;                   // same input mode → appended to that set
  const model = picked && hasActNow && picked.mode !== patMode ? picked : null;       // $ACT next to a sentence-level set → own &<SET>_CS, properties copied from it
  const modeClash = picked && !hasActNow && picked.mode !== patMode;                  // no $ACT but the set holds ConceptScan patterns
  // CONTROL properties of a NEW rule: the ones of the modelling set, overridden by what was chosen in Suggest pattern (Effect = negative …)
  const ruleProps = { ...(model ? model.props : {}), ...(suggest?.props || {}) };     // $ACT: own &<SET>_CS in Patterns4cs, rule properties copied from it
  if (effectSel !== null) { if (effectSel) ruleProps.Effect = effectSel; else delete ruleProps.Effect; }       // the Effect dropdown of step 4 wins
  // the properties the frame of the NEW pattern must have (what Suggest pattern chose, then the Effect dropdown): the pattern goes only into a set whose rule has exactly these
  const wantProps = (() => { const p = { ...(suggest?.props || {}) }; if (effectSel !== null) { if (effectSel) p.Effect = effectSel; else delete p.Effect; } return p; })();
  const setNameFinal = placed ? placed.set : (setName_ || name.toUpperCase()).trim();

  // The ttkconf command prefix is decided by the app after the pattern is validated (step 4):
  // an existing relation keeps its prefix; a new one gets a unique suggestion (editable).
  useEffect(() => { if (!setTouched) setSetName(model ? model.set + '_CS' : name.toUpperCase()); }, [name, setTouched, model?.set]);

  const api = window.api.relation;
  const run = async (fn) => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!suggest) return;
    run(async () => {
      const r = await api.info({ cartPath });
      if (!r.ok) throw new Error(r.error);
      const key = Object.keys(r.relations).find(k => k.toLowerCase() === suggest.relation.toLowerCase()) || suggest.relation;
      const dir = r.relations[key] ? r.relations[key] === 'in,out' : true;
      const d = await api.declare({ cartPath, name: key, directional: dir });
      if (!d.ok) throw new Error(d.error);
      setInfo(r); setName(key); setDirectional(dir); setDeclared(d);
      setRegs([suggest.regulator]); setTgts([suggest.target]);
      setAvailable(r.nodeTypes);
      setText(suggest.pattern);
    });
  }, []);

  // ── navigation ────────────────────────────────────────────────────────────
  const goStep1Next = () => run(async () => {
    const r = await api.info({ cartPath });
    if (!r.ok) throw new Error(r.error);
    setInfo(r);
    setAvailable(r.nodeTypes); setRegs([]); setTgts([]);
    setStep(2);
  });

  const nameProblem = useMemo(() => {
    if (!name) return null;
    if (!NAME_RE.test(name)) return 'Use letters, digits and underscores; start with a letter.';
    const ex = info && Object.keys(info.relations).find(k => k.toLowerCase() === name.toLowerCase());
    if (ex) return `"${ex}" already exists in this cartridge (roles ${info.relations[ex]}) — new patterns will be added to it.`;
    return null;
  }, [name, info]);
  const nameBlocking = !name || !NAME_RE.test(name);
  // An existing relation keeps its directionality: the checkbox follows it (and is locked) instead of failing on Next
  const existingKey = info && name && Object.keys(info.relations).find(k => k.toLowerCase() === name.toLowerCase());
  const existingRoles = existingKey ? info.relations[existingKey] : null;
  useEffect(() => {
    if (existingRoles) setDirectional(existingRoles === 'in,out');
  }, [existingRoles]);

  const goStep2Next = () => run(async () => {
    const r = await api.declare({ cartPath, name, directional });
    if (!r.ok) throw new Error(r.error);
    setDeclared(r);
    // Existing relation: show the regulators / targets its current rules already use
    if (r.existed && (!prefill || prefill.name !== name)) {
      const e = await api.entities({ cartPath, name });
      if (e.ok) {
        const all = new Set([...(info?.nodeTypes || []), ...e.entities.regulators, ...e.entities.targets]);
        const sorted = (l) => [...new Set(l)].sort((a, c) => a.localeCompare(c));
        setRegs(sorted([...e.entities.regulators, ...e.entities.both])); setTgts(sorted([...e.entities.targets, ...e.entities.both]));     // a type used on both sides is on both sides
        setAvailable(sorted(all));
        setSelA([]); setSelR([]); setSelT([]);
        setPrefill({ name, ...e.entities });
      }
    } else if (!r.existed && prefill) {                                  // a new name after an earlier prefill → start clean
      setAvailable(info?.nodeTypes || []); setRegs([]); setTgts([]); setPrefill(null);
    }
    setStep(3);
  });

  // The node types of nodetype.ini stay in the left list; a type can be put on the regulator side, the target side, or both (patterns may accept the same type at both ends).
  const addTo = (to, setTo) => {
    if (!selA.length) return;
    setTo([...new Set([...to, ...selA])].sort((a, b) => a.localeCompare(b)));
  };
  const removeFrom = (list, setList, sel, setSel) => { setList(list.filter(x => !sel.includes(x))); setSel([]); };
  // Node types that are not IsFrame here: if other cartridges have all of them as frames, offer them before adding anything.
  const goStep3Next = () => run(async () => {
    setFrameWarn(null);
    const r = await api.frameCheck({ cartPath, types: [...regs, ...tgts], carts: cartridges.map(c => ({ name: c.name, path: c.path })) });
    if (r.ok && r.missing.length && r.others.length) { setFrameWarn({ missing: r.missing, others: r.others }); return; }
    setStep(4);
  });

  // "Change the cartridge": take the declaration back out of this one, declare the relation in the chosen one, go on with the pattern
  const switchCartridge = (c) => run(async () => {
    if (declared?.written) await api.revert({ cartPath, name });
    const inf = await api.info({ cartPath: c.path });
    if (!inf.ok) throw new Error(inf.error);
    const d = await api.declare({ cartPath: c.path, name, directional });
    if (!d.ok) throw new Error(d.error);
    setInfo(inf); setDeclared(d); setCart(c);
    setPrefill(null); setValidation(null); setPrefix(''); setPrefixTouched(false); setGen(null); setComp(null);
    setFrameWarn(null); setStep(4);
  });

  // The messages the LLM design came with (words missing in macros, where the pattern goes, better cartridge) describe the pattern the LLM wrote.
  // Once the user's own text is tested / validated they are worked out again for THAT text. → the set it should go to (id or null)
  const reanalyze = async () => {
    let hints = [], list = candList, pid = placeId;
    try {
      const names = [...new Set(text.match(/[$][A-Za-z_]\w*/g) || [])].filter(n => n !== '$ACT');
      if (names.length) {
        const d1 = (await api.macroDefs({ cartPath, file: cartPath + '\\ctrltype.ini', names, max: 1500 })).defs || {};
        const nested = [...new Set(Object.values(d1).flatMap(b => b.match(/[$@][A-Za-z_]\w*/g) || []))].filter(n => !(n in d1) && n !== '$ACT').slice(0, 40);
        const d2 = nested.length ? ((await api.macroDefs({ cartPath, file: cartPath + '\\ctrltype.ini', names: nested, max: 1500 })).defs || {}) : {};
        hints = macroGaps(text, { ...d1, ...d2 });
      }
    } catch { /* optional */ }
    const row = { props: wantProps, regulator: regs[0], target: tgts[0], directional };
    try {
      const ex = await api.existingSets({ cartPath, name });
      if (ex.ok) { list = ex.sets || []; setCandList(list); }
    } catch { /* keep the list we have */ }
    if (!placeTouched && list.length) { const r = chooseFrame(list, row, text); pid = r.id; setPlaceId(pid); setPlaceReason(r.reason); setPlaceWhy(r.why || ''); }
    setAnalysis({ text, macroHints: hints });
    return pid;
  };

  // Opened from Patterns → Add relation (no Suggest-pattern data): the existing sets of the relation are looked up when step 4 opens, and again when the
  // pattern turns into a ConceptScan one ($ACT / &) or the node types change, so the pattern is offered the set that fits (e.g. &FA_DISEASE).
  useEffect(() => {
    if (suggest || step !== 4 || !name || !declared || !regs.length || !tgts.length) return;
    let live = true;
    api.existingSets({ cartPath, name }).then(ex => {
      if (!live || !ex.ok) return;
      const list = ex.sets || [];
      setCandList(list);
      if (!placeTouched && list.length) { const r = chooseFrame(list, { props: wantProps, regulator: regs[0], target: tgts[0], directional }, text); setPlaceId(r.id); setPlaceReason(r.reason); setPlaceWhy(r.why || ''); }
    }).catch(() => { /* optional */ });
    return () => { live = false; };
  }, [step, name, declared, hasActNow, regs.join('|'), tgts.join('|'), directional, effectSel]);
  // opened from Suggest pattern: another Effect chosen in step 4 means another frame - the set is chosen again (unless the user picked one himself)
  useEffect(() => {
    if (!suggest || effectSel === null || placeTouched || !candList.length) return;
    const r = chooseFrame(candList, { props: wantProps, regulator: regs[0], target: tgts[0], directional }, text);
    setPlaceId(r.id); setPlaceReason(r.reason); setPlaceWhy(r.why || '');
  }, [effectSel]);

  // run the pattern as it stands on the markup (compile only when there is none) → the raw testPattern result
  const runTest = async (markup = suggest?.markup) => {
    try {
      const c = await api.testPattern({ cartPath, pattern: text, markup, relationName: name, regulators: regs, targets: tgts, compileOnly: !markup });
      return c.ok ? c.result : { ok: false, message: c.error };
    } catch (e) { return { ok: false, message: e.message }; }
  };

  const validate = () => run(async () => {
    // 1. spell-check: known notation mistakes must be fixed (the Fix buttons) before the pattern can be validated
    if (lint.length) { setLintBlocked(true); return; }
    setLintBlocked(false);
    // the messages about the LLM's pattern are replaced by ones about this text; its set may differ from the LLM's pattern's
    const pid = await reanalyze();
    const pk = pid && (cands.find(c => c.id === pid) || (await api.existingSets({ cartPath, name })).sets?.find(c => c.id === pid));
    const setNow = pk && pk.mode === (hasActNow ? 'csout' : 'msout') ? pk.set : (setName_ || name.toUpperCase()).trim();
    const r = await api.validate({ cartPath, text, relationName: name, setName: setNow });
    if (!r.ok) throw new Error(r.error);
    // 2. the app's static checks, then 3. a real msgrep compile in a temporary folder (nothing is kept) — what msgrep rejects stops here, not in step 5
    if (r.result.ok && !testPassed) {                      // a pattern that already passed the test on exactly this text is not compiled a second time
      const cr = await runTest();
      setUserTest({ text, result: cr });
      if (!cr.ok) {
        setValidation({ result: { ...r.result, ok: false, errors: [{ kind: 'compile', message: cr.message }] }, text, set: setNow });
        return;
      }
    }
    setValidation({ result: r.result, text, set: setNow });
    if (!placed && r.result.ttk && (r.result.ttk.existing || !prefixTouched)) { setPrefix(r.result.ttk.prefix); if (r.result.ttk.existing) setPrefixTouched(false); }
  });
  const validated = validation && validation.result.ok && validation.text === text && validation.set === setNameFinal;
  // A pattern that passed the test needs no click on "Validate": the checks that step 5 relies on (macro files, pattern set, ttkconf command) run by themselves.
  // Once per text — when the checks fail the errors are shown and the user edits the text (no retry loop).
  const autoTried = useRef(null);
  useEffect(() => {
    if (step !== 4 || !needsTest || !testPassed || validated || busy || lint.length || !text.trim() || autoTried.current === text) return;
    if (!name || !declared || !regs.length || !tgts.length) return;          // the wizard is still loading (the relation name is set after the cartridge info arrives)
    autoTried.current = text;
    validate();
  });

  const generate = () => run(async () => {
    // the declaration is re-sent: harmless when it exists, and it restores it after a rolled-back compile
    const d = await api.declare({ cartPath, name, directional });
    if (!d.ok) throw new Error(d.error);
    const r = await api.generate({ cartPath, relationName: name, setName: setNameFinal, regulators: regs, targets: tgts, patternText: text, placement: placed ? { id: placed.id, swap: frameFit(placed, regs, tgts, directional).swap } : undefined, cloneProps: !placed && Object.keys(ruleProps).length ? ruleProps : undefined });
    if (!r.ok) throw new Error(r.error);
    setGen(r.result);
  });
  const goStep4Next = async () => { setGen(null); setComp(null); setStep(5); await generate(); };

  const compile = () => run(async () => {
    const r = await api.compile({ cartPath, relationName: name, prefix, mode: gen.mode, placement: placed ? { id: placed.id } : undefined });
    if (!r.ok) throw new Error(r.error);
    setComp(r.result);
    if (r.result.ok) setFinished(true);
  });

  const close = async () => {
    if (!finished && declared?.written) {
      const keep = window.confirm(`The relation "${name}" was already declared in ctrltype.ini.\n\nOK = keep it   |   Cancel = remove it again`);
      if (!keep) await api.revert({ cartPath, name });
    }
    onClose(finished);
  };

  // ── render helpers ───────────────────────────────────────────────────────
  const Header = () => (
    <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
      {STEPS.map((s, i) => (
        <span key={s} style={{
          fontSize: 12, padding: '3px 10px', borderRadius: 12,
          background: step === i + 1 ? 'var(--accent)' : 'transparent',
          color: step === i + 1 ? '#fff' : step > i + 1 ? 'var(--success, #a6e3a1)' : 'var(--text-muted)',
          border: '1px solid ' + (step === i + 1 ? 'var(--accent)' : 'var(--border)'),
        }}>{step > i + 1 ? '✓ ' : ''}{i + 1}. {s}</span>
      ))}
    </div>
  );

  const errList = (kind) => (validation?.result.errors || []).filter(e => e.kind === kind);

  return (
    <>
    <FloatingDialog title={`New relation — ${cart?.name || 'cartridge'}`} width={920} dock={suggest ? 'right' : null}>
      <div>
        <Header />

        {error && <div className="alert alert-danger" style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>{error}</div>}

        {/* ── Step 1: cartridge ── */}
        {step === 1 && (
          <div>
            <p style={{ fontSize: 13, marginBottom: 8 }}>Select the cartridge that will get the new relation type:</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 300, overflowY: 'auto' }}>
              {cartridges.map(c => (
                <label key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer',
                  padding: '4px 8px', borderRadius: 6, background: cart?.name === c.name ? 'rgba(124,106,247,0.18)' : 'transparent' }}>
                  <input type="radio" name="relcart" checked={cart?.name === c.name} onChange={() => setCart(c)} />
                  {c.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* ── Step 2: declaration ── */}
        {step === 2 && (
          <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: '10px 12px', alignItems: 'center', fontSize: 13 }}>
            <label>Relation type name</label>
            <div>
              <input className="form-control" value={name} onChange={e => setName(e.target.value.trim())} placeholder="e.g. Metabolization" autoFocus />
              {nameProblem && <div className="text-xs" style={{ color: name && !NAME_RE.test(name) ? 'var(--danger, #f38ba8)' : 'var(--warning, #e8a000)', marginTop: 3 }}>{nameProblem}</div>}
            </div>
            <label>Directional</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={directional} disabled={!!existingRoles} onChange={e => setDirectional(e.target.checked)} />
              the relation has a strict direction (regulator → target)
              {existingRoles && <span className="text-xs text-muted">— fixed by the existing relation ({existingRoles})</span>}
            </label>
            <label>ctrltype.ini line</label>
            <code style={{ fontSize: 12 }}>{(name || '<Name>')}={directional ? 'in,out' : 'in-out,in-out'}</code>
          </div>
        )}

        {/* ── Step 3: entity types ── */}
        {step === 3 && (
          <div>
            <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 10 }}>
              Note: For non-directional relations, the assignment of entities to Regulators or Targets is not strictly important, but it is critical for directional relations.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 1fr', gap: 10, alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Node types in nodetype.ini ({available.length})</div>
                <select multiple style={listStyle} value={selA} onChange={e => setSelA([...e.target.selectedOptions].map(o => o.value))}>
                  {available.map(t => <option key={t} value={t}>{t}{regs.includes(t) || tgts.includes(t) ? '   — ' + [regs.includes(t) && 'regulator', tgts.includes(t) && 'target'].filter(Boolean).join(' + ') : ''}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => addTo(regs, setRegs)}>→ Regulators</button>
                <button className="btn btn-secondary btn-sm" onClick={() => addTo(tgts, setTgts)}>→ Targets</button>
                <button className="btn btn-secondary btn-sm" disabled={!selR.length}
                  onClick={() => removeFrom(regs, setRegs, selR, setSelR)}>← Regulators</button>
                <button className="btn btn-secondary btn-sm" disabled={!selT.length}
                  onClick={() => removeFrom(tgts, setTgts, selT, setSelT)}>← Targets</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Regulators ({regs.length})</div>
                  <select multiple style={{ ...listStyle, height: 100 }} value={selR} onChange={e => setSelR([...e.target.selectedOptions].map(o => o.value))}>
                    {regs.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Targets ({tgts.length})</div>
                  <select multiple style={{ ...listStyle, height: 100 }} value={selT} onChange={e => setSelT([...e.target.selectedOptions].map(o => o.value))}>
                    {tgts.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
            </div>
            {prefill && (
              <div className="text-xs" style={{ marginTop: 8, color: 'var(--text-muted)' }}>
                Pre-filled from the existing rules of “{prefill.name}” ({prefill.sources.join(', ') || 'no CONTROL block found'}) — you can change the lists.
                {prefill.both.length > 0 && <span style={{ color: 'var(--warning, #e8a000)' }}> Used on both sides there: {prefill.both.join(', ')}.</span>}
              </div>
            )}
            {frameWarn && (
              <div className="alert alert-warning" style={{ marginTop: 10 }}>
                <div style={{ marginBottom: 8 }}>
                  Node type(s) <b>{frameWarn.missing.join(', ')}</b> are not used by this cartridge. I found that cartridge{frameWarn.others.length > 1 ? 's' : ''}{' '}
                  <b>{frameWarn.others.map(o => o.name).join(' and ')}</b> can use {frameWarn.missing.length > 1 ? 'these node types' : 'this node type'}.
                  Do you want me to change the cartridge for your patterns or proceed to adding all node types to this cartridge?
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {frameWarn.others.map(o => (
                    <button key={o.name} className="btn btn-primary btn-sm" disabled={busy} onClick={() => switchCartridge(o)}>Change cartridge to {o.name}</button>
                  ))}
                  <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setFrameWarn(null); setStep(4); }}>Add node types to {cart?.name}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Step 4: pattern + validation ── */}
        {step === 4 && (
          <div>
            {suggest && (
              <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 10 }}>
                {suggest.queueInfo && <div style={{ fontWeight: 600, marginBottom: 4 }}>{suggest.queueInfo} — the next one opens when you close this dialog (Finish or Cancel).</div>}
                {suggest.existing?.matches?.length > 0 && (
                  <div style={{ marginBottom: 4, color: '#a6e3a1' }}>
                    ⚠ This relation is already extracted from the sentence by the existing pattern <b>#{suggest.existing.matches[0].index}</b> of <code>{suggest.existing.matches[0].set}</code> — the new pattern is probably redundant.
                    <button type="button" className="btn btn-sm" style={{ marginLeft: 6, padding: '1px 8px' }} onClick={() => setViewExisting(true)}>View existing pattern</button>
                  </div>
                )}
                {suggest.timing?.total > 0 && <div className="text-xs" style={{ marginBottom: 4, fontWeight: 600 }} title="Time per stage of the design, in seconds">⏱ Designed in {(suggest.timing.total / 1000).toFixed(1)} s — {Object.entries(suggest.timing).filter(([k, v]) => k !== 'total' && v >= 100).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`).join(', ')}{suggest.tested?.candidate ? ` · candidate ${suggest.tested.candidate} of ${suggest.tested.of} passed the test` : ''}</div>}
                {suggest.fails?.length > 0 && <div style={{ color: 'var(--warning, #e8a000)', marginBottom: 4 }}>⚠ {suggest.fails.length} pattern(s) could not be designed: {suggest.fails.join(' | ').slice(0, 300)}</div>}
                {suggest.fromExisting
                  ? <>Existing pattern <b>#{suggest.fromExisting.index}</b> of <code>{suggest.fromExisting.set}</code> ({suggest.fromExisting.folder}) that already extracts this relation from <i style={SENT_STYLE}>{suggest.sentence}</i> — inspect it and edit it as you like (parameter names are shown as @regulator / @target)<br /></>
                  : <>Pattern suggested by the LLM for <i style={SENT_STYLE}>{suggest.sentence}</i><br /></>}
                {testedNow && !testedNow.skipped && (testedNow.ok
                  ? <div style={{ color: 'var(--success, #a6e3a1)', marginBottom: 4 }}>✓ {testedNow.own ? 'Your pattern, tested' : 'Tested'} on this sentence: {testedNow.terms} output relation(s){testedNow.attempts ? ` (after ${testedNow.attempts} automatic repair${testedNow.attempts > 1 ? 's' : ''})` : ''}.</div>
                  : <div style={{ color: 'var(--warning, #e8a000)', marginBottom: 4 }}>⚠ {testedNow.own ? 'Your pattern, tested' : 'Tested'} on this sentence: {testedNow.message ? testedNow.message : 'no output relation'} — the pattern probably does not work yet; check it against the pseudo-sentences.</div>)}
                {testedNow?.skipped && <div className="text-xs" style={{ marginBottom: 4 }}>Not tested: {testedNow.message}.</div>}
                {suggest.props && Object.keys(suggest.props).length > 0 && <div style={{ marginBottom: 4 }}>CONTROL properties: <b>{Object.entries(suggest.props).map(([k, v]) => k + ' = ' + v).join(', ')}</b></div>}
                {suggest.movedFrom && (
                  <div style={{ margin: '4px 0', padding: '5px 8px', border: '1px solid var(--accent, #7c6ff0)', borderRadius: 6 }}>
                    ↪ Moved here from <b>{suggest.movedFrom}</b>: this cartridge has the frame for the pattern. The macros and the markup are those of {suggest.movedFrom} — press <b>Test pattern</b> and “Validate” to check them against {cart?.name}.
                  </div>
                )}
                {isLlmText && suggest?.macroFixes?.applied?.length > 0 && (
                  <div style={{ margin: '4px 0', color: '#a6e3a1' }}>
                    ✓ Pattern corrected: {suggest.macroFixes.applied.map((a, i) => <span key={i}>{i > 0 && '; '}{a.kind === 'glue' ? <><b>{a.to}</b> added{a.macro ? <> next to <b>{a.macro}</b></> : ''} (a prefix stuck to an entity is the text anti-, which the macro does not contain)</> : a.kind === 'drop' ? <><code>{a.replaced.join(' ')}</code> removed (<b>{a.macro}</b> already contains it)</> : a.kind === 'quote' ? <><code>{a.replaced.join(' ')}</code> → <b>{a.to}</b> (a word with a hyphen is quoted and matched as written)</> : <><code>{a.replaced.join(' ')}</code> → <b>{a.macro}</b>{a.extra.length ? ` (also accepts ${a.extra.join(', ')})` : ''}</>}</span>)}.
                  </div>
                )}
                {isLlmText && suggest?.macroFixes?.suggested?.length > 0 && (
                  <div style={{ margin: '4px 0', color: 'var(--text-muted)' }}>
                    💡 Macros that contain a word of the pattern but many more (not applied): {suggest.macroFixes.suggested.map((s, i) => <span key={i}>{i > 0 && '; '}<b>{s.macro}</b> has <code>{s.words.join(' ')}</code> and {s.extra} other word{s.extra === 1 ? '' : 's'}</span>)}.
                  </div>
                )}
                {hintsNow.length > 0 && (
                  <div style={{ margin: '4px 0', padding: '5px 8px', border: '1px solid var(--warning, #e8a000)', borderRadius: 6, color: 'var(--warning, #e8a000)' }}>
                    ⚠ Words the pattern needs next to a macro, but the macro does not contain them:{' '}
                    {hintsNow.map((h, i) => <span key={i}>{i > 0 && '; '}<b>{h.word}</b> (beside {h.macros.join(', ')})</span>)}.
                    {' '}Consider adding {hintsNow.length > 1 ? 'them' : 'it'} to the macro definition{hintsNow.length > 1 ? 's' : ''} so other patterns profit too; the pattern works as it is.
                  </div>
                )}
                {suggest.pseudo && <><span style={{ fontFamily: 'Consolas, monospace', whiteSpace: 'pre-wrap' }}>{suggest.pseudo}</span><br /></>}
                <b>{suggest.regulator}</b> — {name} <span style={{ color: effectColor(ruleProps.Effect), fontWeight: 700 }}>{effectArrow(ruleProps.Effect)}</span> <b>{suggest.target}</b> in {cart?.name} cartridge. Review it, edit if needed, then press "Test pattern" if it was edited, then press “Validate” to proceed to deployment steps.
                Steps 1–3 were filled in automatically.
              </div>
            )}
            {(cands.length > 0 || suggest) && (
              <div style={{ marginBottom: 10, fontSize: 13 }}>
                <div style={{ marginBottom: 4 }}>{'Where should the pattern go?'} {placeReason && <span className="text-xs text-muted">— {placeReason}{placeWhy && <> <span title={placeWhy} style={{ textDecoration: 'underline dotted', cursor: 'help' }}>Why?</span></>}</span>}</div>
                <select className="form-control" value={placeId || ''} onChange={e => { setPlaceTouched(true); setPlaceId(e.target.value || null); }} style={{ width: '100%', fontSize: 12 }}>
                  {cands.map(c => {
                    const { addR, addT, swap: sw } = frameFit(c, regs, tgts, directional);
                    const props = Object.entries(c.props).map(([k, v]) => k + '=' + v).join(', ');
                    return <option key={c.id} value={c.id} disabled={addR.length + addT.length > 0}>
                      {hasActNow && c.mode !== patMode
                        ? '&' + c.set + '_CS (new, ConceptScan) — copies ' + props + ' from &' + c.set + ' (sentence-level)'
                        : '&' + c.set + (c.mode === 'csout' ? ' [ConceptScan]' : ' [sentence]') + ' — ' + props + ' — ' + c.regs.join(',') + ' → ' + c.tgts.join(',') + (sw ? ' (non-directional: types fit the other way round)' : '') + (addR.length + addT.length ? '  (rule lacks ' + [...addR, ...addT].join(', ') + ' — not usable)' : '')}
                    </option>;
                  })}
                  <option value="">{hasActNow ? 'New set without copied properties' : 'Create a new pattern set'}</option>
                </select>
                {modeClash && (
                  <div className="text-xs" style={{ marginTop: 5, color: 'var(--danger, #f38ba8)' }}>⚠ &amp;{picked.set} holds ConceptScan patterns (<code>$ACT</code>); this pattern has no <code>$ACT</code> — choose a sentence-level set or “Create a new pattern set”.</div>
                )}
                {model && (
                  <div className="text-xs" style={{ marginTop: 5, color: 'var(--text-muted)' }}>
                    A <code>$ACT</code> pattern cannot join a set with sentence-level patterns. The new set <code>&amp;{setNameFinal}</code> is created in <code>grdata\{folderName(name)}\Patterns4cs</code>,
                    its rule gets the properties <code>{Object.entries(ruleProps).map(([k, v]) => k + '=' + v).join(', ') || 'none'}</code> (taken from the rule of <code>&amp;{model.set}</code>, chosen properties win) and the node types {regs.join(', ')} → {tgts.join(', ')}.
                    It is compiled into its own batch and run with <code>-Icsout</code>.
                  </div>
                )}
                {placed && Object.entries(wantProps).some(([k, v]) => placed.props[k] !== v) && (
                  <div className="text-xs" style={{ marginTop: 5, color: 'var(--danger, #f38ba8)' }}>⚠ The rule of &amp;{placed.set} has {Object.entries(placed.props).map(([k, v]) => k + '=' + v).join(', ') || 'no properties'}, but this pattern needs {Object.entries(wantProps).map(([k, v]) => k + '=' + v).join(', ')} — choose a set with those properties or “Create a new pattern set”.</div>
                )}
                {placed && (
                  <div className="text-xs" style={{ marginTop: 5, color: 'var(--text-muted)' }}>
                    The pattern is appended (“|”) to <code>&amp;{placed.set}</code> in <code>{placed.setFile}</code>; its rule is in <code>{placed.ruleFile}</code> and the folder is compiled by <code>comp_{placed.prefix}</code>. <button type="button" className="btn btn-sm" style={{ marginLeft: 4, padding: '1px 8px' }} onClick={async () => { const r = await api.viewSet({ cartPath, name, id: placed.id }); setSetView(r.ok ? r.view : { error: r.error }); }}>View patterns</button>
                    {(() => {
                      const { addR, addT, swap: sw } = frameFit(placed, regs, tgts, directional);
                      return (addR.length + addT.length) > 0
                        ? <span style={{ color: 'var(--warning, #e8a000)' }}> The rule does not allow {[...addR, ...addT].join(', ')} yet — it will be added to its {addR.length ? 'in' : ''}{addR.length && addT.length ? ' / ' : ''}{addT.length ? 'out' : ''} list (the set's other patterns then apply to it too).</span>
                        : <span> The rule already allows these node types{sw ? <> — the other way round (<code>@regulator</code> binds to the rule's <code>out</code> variable; fine for a non-directional relation)</> : null}.</span>;
                    })()}
                  </div>
                )}
              </div>
            )}
            {!placed && <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, fontSize: 13 }}>
              <label>Pattern set name&nbsp;<code>&amp;</code></label>
              <input className="form-control" style={{ width: 240, fontFamily: 'monospace' }} value={setName_}
                onChange={e => { setSetTouched(true); setSetName(e.target.value.trim()); }} />
              <span className="text-xs text-muted">defined as <code>&amp;{setNameFinal}(@regulator, @target)</code>; an existing set with the same regulator/target types gets the new pattern appended with “|”; if its rule uses other types, a new set (<code>_2</code>, <code>_3</code>…) is created</span>
            </div>}
            {!placed && <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, fontSize: 13 }}>
              <label>Effect</label>
              <select className="form-control" style={{ width: 240 }} value={ruleProps.Effect || ''} onChange={e => setEffectSel(e.target.value)}
                title="The Effect property of the new rule (CONTROL { ... Effect = ... }): what the relation does to the target">
                <option value="">(no Effect property)</option>
                <option value="positive">positive</option>
                <option value="negative">negative</option>
                <option value="unknown">unknown</option>
              </select>
              <span className="text-xs text-muted">written into the CONTROL block of the new rule: <code>Effect = {ruleProps.Effect || '…'}</code>{effectSel === null && (suggest?.props?.Effect || model?.props?.Effect) ? ' (taken from ' + (suggest?.props?.Effect ? 'the Suggest pattern choice' : '&' + model.set) + ')' : ''}. An existing set keeps the Effect of its rule.</span>
            </div>}
            <MacroTextarea key={macroVer} onEditMacro={setEditMacroName} taRef={patternBox} cartPath={cartPath} value={text} onChange={setText} regNames={suggest?.regNames} tgtNames={suggest?.tgtNames} regType={suggest?.regulator} tgtType={suggest?.target} marks={[...lintMarks(lint), ...errMarks.filter(m => !lint.some(l => m.index < l.fix.index + l.fix.length && l.fix.index < m.index + m.length))]}
              placeholder={'Extraction pattern. Use @regulator and @target for the entities; macros ($NAME, &NAME) and #define blocks are allowed, e.g.\n\n#define $MY_VERB [metabolized~ "metabolic conversion"]\n\n(@regulator [^$AND $COMMA]{0,5} $MY_VERB [^$AND]{0,3} @target)'} />
            <LintIssues text={text} lint={lint} setText={setText} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <button className="btn btn-primary" onClick={validate} disabled={busy || validated || !text.trim() || (needsTest && !testPassed)}
                title={needsTest && !testPassed ? 'Press “Test pattern” first: the pattern must produce output on the sentence' : undefined}>
                {busy ? <><span className="spinner" /> Checking…</> : '✔ Validate'}
              </button>
              <button className="btn btn-secondary" onClick={() => setFindMacro(true)} title="Find the macros of this cartridge that contain a word, and insert one into the pattern">Find macro</button>
              <button className="btn btn-secondary" onClick={() => setHelp(h => !h)} title="The pattern notation — symbol and brief explanation — to look up while editing">Help</button>
              <button className="btn btn-secondary" onClick={openCreateMacro} title="Create a new macro (from the selected text) in one of the macro files — optionally in all cartridges at once">Create macro</button>
              <button className="btn btn-secondary" disabled={busy || userTest?.busy || !text.trim()} title="Run this pattern on the ConceptScan markup of the sentence (the same test the app runs while it designs a pattern); nothing is saved"
                onClick={async () => {
                  setUserTest({ busy: true });
                  await reanalyze();
                  let mk = suggest?.markup, sentence = '';
                  if (!mk && testSent.trim()) {                      // no pipeline sentence: run the pasted one through this cartridge first
                    sentence = testSent.trim();
                    try {
                      if (testMk?.sentence === sentence) mk = testMk.markup;
                      else {
                        const r = await api.sentenceMarkup({ cartPath, sentence });
                        if (r.ok === false) throw new Error(r.error);
                        mk = r.markup; setTestMk({ sentence, markup: mk });
                      }
                    } catch (e) { setUserTest({ text, sentence, result: { ok: false, message: 'the test sentence could not be processed: ' + e.message } }); return; }
                  }
                  setUserTest({ text, sentence, result: await runTest(mk) });
                }}>
                {userTest?.busy ? <><span className="spinner" /> Testing…</> : 'Test pattern'}
              </button>
              {userTest?.result && !userTest.busy && (() => {
                const r = userTest.result, stale = userTest.text !== text || (!suggest?.markup && (userTest.sentence || '') !== testSent.trim());
                const [color, msg] = !r.ok ? ['var(--danger, #f38ba8)', '✗ ' + (r.stage === 'validate' ? 'Pattern is not valid: ' : r.stage === 'compile' ? 'Pattern does not compile: ' : '') + r.message]
                  : r.compiled ? ['var(--success, #a6e3a1)', '✓ Compiles. Paste a test sentence below to see whether it extracts a relation.']
                  : r.skipped ? ['var(--text-muted)', r.message]
                  : r.terms > 0 ? ['var(--success, #a6e3a1)', `✓ ${r.terms} output relation${r.terms !== 1 ? 's' : ''} on this sentence`]
                  : ['var(--warning, #e8a000)', '✗ Compiles, but produces NO output relation on this sentence'];
                return <span style={{ color, fontSize: 13, opacity: stale ? 0.55 : 1 }}>{msg}{stale ? ' (the text changed since this test)' : ''}</span>;
              })()}
              {validated && <span style={{ color: 'var(--success, #a6e3a1)', fontSize: 13 }}>✓ Pattern is valid{validation.result.hasAct ? ', processes conceptscan pseudo-sentences' : ', processes tagged sentences'}</span>}
              {validation && !validated && validation.result.ok && <span className="text-muted" style={{ fontSize: 13 }}>Text changed since the last check — validate again.</span>}
              {needsTest && !testPassed && !userTest?.busy && <span className="text-muted" style={{ fontSize: 13 }}>Test the pattern first — “Validate” unlocks when it produces output on this sentence{userTest?.result && userTest.text === text ? ' (the last test did not)' : ''}.</span>}
              {lintBlocked && lint.length > 0 && <span style={{ color: 'var(--danger, #f38ba8)', fontSize: 13 }}>✗ Fix the {lint.length} spell-check problem{lint.length !== 1 ? 's' : ''} above first (Fix buttons), then validate.</span>}
            </div>
            {!suggest?.markup && (
              <div style={{ marginTop: 8 }}>
                <label className="text-xs text-muted" style={{ display: 'block', marginBottom: 3 }}>Test sentence (optional) — paste a sentence this pattern should extract a relation from; “Test pattern” runs it through the {cart?.name || 'cartridge'} pipeline and then the pattern</label>
                <textarea className="form-control" rows={2} spellCheck={false} style={{ width: '100%', resize: 'vertical' }} value={testSent} onChange={e => setTestSent(e.target.value)} placeholder="e.g. Equol was associated with lower risk of dyslipidemia." />
              </div>
            )}

            {validation && !validation.result.ok && (
              <div className="alert alert-danger" style={{ marginTop: 10, fontSize: 12 }}>
                {errList('macro').length > 0 && (
                  <div style={{ marginBottom: 6 }}><strong>Macros</strong>
                    <ul style={{ margin: '2px 0 0 18px' }}>{errList('macro').map((e, i) => <li key={i}>{e.message}</li>)}</ul>
                  </div>)}
                {errList('entity').length > 0 && (
                  <div style={{ marginBottom: 6 }}><strong>Entity names</strong> — use <code>@regulator</code> and <code>@target</code>
                    <ul style={{ margin: '2px 0 0 18px' }}>{errList('entity').map((e, i) => <li key={i}>{e.message}</li>)}</ul>
                  </div>)}
                {errList('syntax').length > 0 && (
                  <div style={{ marginBottom: 6 }}><strong>Syntax</strong>
                    <ul style={{ margin: '2px 0 0 18px' }}>{errList('syntax').map((e, i) => <li key={i}>{e.message}{e.line ? ` (line ${e.line}, col ${e.col})` : ''}</li>)}</ul>
                  </div>)}
                {errList('compile').length > 0 && (
                  <div style={{ marginBottom: 6 }}><strong>msgrep does not compile this pattern</strong>
                    <ul style={{ margin: '2px 0 0 18px' }}>{errList('compile').map((e, i) => <li key={i} style={{ wordBreak: 'break-word' }}>{e.message}</li>)}</ul>
                  </div>)}
                {errList('general').map((e, i) => <div key={i}>{e.message}</div>)}
              </div>
            )}
            {validation?.result.warnings?.length > 0 && (
              <div className="alert alert-warning" style={{ marginTop: 8, fontSize: 12 }}>
                {validation.result.warnings.map((w, i) => <div key={i}>⚠ {w.message} (line {w.line}, col {w.col})</div>)}
              </div>
            )}
            {validated && !placed && validation.result.ttk && (
              <div style={{ marginTop: 8, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>ttkconf commands:</span>
                {validation.result.ttk.existing
                  ? <span>this relation is already compiled by <code>comp_{validation.result.ttk.prefix}</code> — the new pattern is compiled by it (nothing new is registered)</span>
                  : <>
                      <span>new relation → will register</span>
                      <input className="form-control" style={{ width: 90, padding: '1px 6px' }} value={prefix}
                        onChange={e => { setPrefixTouched(true); setPrefix(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '')); }} />
                      <code>del_{prefix || '…'} / comp_{prefix || '…'}</code>
                    </>}
              </div>
            )}
            {validated && (
              <div className="text-xs" style={{ marginTop: 8, color: 'var(--text-muted)' }}>
                {validation.result.macroFiles.length > 0 && <div>Macro source files to include: {validation.result.macroFiles.join(', ')}</div>}
                {validation.result.inlineMacros.length > 0 && <div>Macros copied in (their file would clash with another include): {validation.result.inlineMacros.map(m => m.name).join(', ')}</div>}
                {validation.result.customDefines.length > 0 && <div>Your macros → {name}_wordsets.msgrep: {validation.result.customDefines.map(m => m.name).join(', ')}</div>}
              </div>
            )}
          </div>
        )}

        {/* ── Step 5: files ── */}
        {step === 5 && (
          <div style={{ fontSize: 13 }}>
            {busy && <div><span className="spinner" /> Writing files…</div>}
            {gen && (
              <>
                <p style={{ marginBottom: 6 }}>
                  <b>{gen.files.filter(f => f.action !== 'unchanged').length} file(s) written, {gen.files.filter(f => f.action === 'unchanged').length} unchanged</b> in <code>{gen.relDir}</code> (pattern set <code>&amp;{gen.set}</code> {gen.setAction}; input mode <code>-I{gen.mode}</code>). Nothing here can be changed; compile to finish, or go back to change the pattern.
                </p>
                {gen.frameAdded?.length > 0 && <div className="alert alert-warning" style={{ marginBottom: 8 }}>
                  ⚠ Added <b>{gen.frameAdded.join(', ')}</b> to <code>[NodeType-IsFrame]</code> in nodetype.ini (and nodetype.ini.delta): msgrep cannot output
                  relations for node types that are not listed there.
                </div>}
                {gen.ruleExtended && (gen.ruleExtended.regulators.length + gen.ruleExtended.targets.length) > 0 && <p style={{ marginBottom: 6, color: 'var(--warning, #b45309)' }}>
                  The CONTROL rule of <code>&amp;{gen.set}</code> now also allows {[...gen.ruleExtended.regulators, ...gen.ruleExtended.targets].join(', ')}.
                </p>}
                {gen.setRenamed &&<p style={{ marginBottom: 6, color: 'var(--warning, #b45309)' }}>
                  &amp;{gen.requestedSet} already exists for different regulator/target types, so a new pattern set <code>&amp;{gen.set}</code> was created for this pattern.
                </p>}
                <table className="data-table" style={{ fontSize: 12 }}>
                  <tbody>{gen.files.map(f => (
                    <tr key={f.file}><td className="mono">{f.file}{f.detail && <div className="text-xs text-muted" style={{ fontFamily: 'inherit' }}>{f.detail}</div>}</td>
                      <td style={{ width: 90, color: f.action === 'unchanged' ? 'var(--text-muted)' : 'var(--success, #a6e3a1)' }}>{f.action}</td></tr>
                  ))}</tbody>
                </table>
                {gen.inlined?.length > 0 && <div className="text-xs text-muted" style={{ marginTop: 6 }}>Macros copied into the wordsets file: {gen.inlined.join(', ')}</div>}
              </>
            )}
          </div>
        )}

        {/* ── Step 5, second part: compile & register (after the files above are written) ── */}
        {step === 5 && gen && (
          <div style={{ fontSize: 13, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            {placed ? <p style={{ marginBottom: 8 }}>
              Recompiles the folder of <code>&amp;{placed.set}</code> with <code>ttkconf.exe</code> (<code>del_{placed.prefix}</code> / <code>comp_{placed.prefix}</code>). Its output command already exists in locscan.ini, so nothing is registered; if the compile fails, all changes are rolled back.
            </p> : <p style={{ marginBottom: 8 }}>
              Compiles the patterns with <code>ttkconf.exe</code> (<code>del_{prefix}</code> / <code>comp_{prefix}</code>; registered in ttkconf.ini only if the relation has no compile command yet) and, when the compile succeeds,
              adds the <code>{folderName(name).toLowerCase()}{gen?.mode === 'csout' ? '_cs' : ''}</code> output command (<code>-I{gen?.mode || 'msout'}</code>, batch <code>{folderName(name).toLowerCase()}{gen?.mode === 'csout' ? '_cs' : ''}.grbatch</code> from <code>{gen?.mode === 'csout' ? 'Patterns4cs' : 'Patterns4sent'}</code>) to <code>allpats</code> in locscan.ini.
            </p>}
            {!comp && <button className="btn btn-primary" onClick={compile} disabled={busy || !gen}>
              {busy ? <><span className="spinner" /> Compiling…</> : '⚙ Compile & register'}
            </button>}
            {comp?.ok && <div className="alert alert-success">✓ Relation “{name}” compiled and registered in {cart.name}.</div>}
            {comp && (
              <>
                <pre style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: 8, fontSize: 11, maxHeight: 200, overflow: 'auto', marginTop: 8 }}>
                  {[...(comp.log || []), '', comp.compLog || ''].join('\n')}
                </pre>
                {comp.backupDir && <div className="text-xs text-muted">Backup of every changed file: {comp.backupDir}</div>}
              </>
            )}
          </div>
        )}

        {/* ── buttons ── */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={close} disabled={busy}>{finished ? 'Close' : 'Cancel'}</button>
          <div style={{ display: 'flex', gap: 10 }}>
            {step > 1 && !finished && !comp && (
              <button className="btn btn-secondary" disabled={busy}
                onClick={async () => {
                  setError(null);
                  if (step === 3 && declared?.written) {          // going back to rename: withdraw the declaration
                    await api.revert({ cartPath, name });
                    setDeclared(null);
                  }
                  setStep(step - 1);
                }}>← Back</button>
            )}
            {step === 5 && !finished && comp && !comp.ok && (
              <button className="btn btn-secondary" onClick={() => { setComp(null); setGen(null); setStep(4); }}>← Back to pattern</button>
            )}
            {step === 1 && <button className="btn btn-primary" disabled={busy || !cart} onClick={goStep1Next}>Next →</button>}
            {step === 2 && <button className="btn btn-primary" disabled={busy || nameBlocking} onClick={goStep2Next}>Next →</button>}
            {step === 3 && <button className="btn btn-primary" disabled={!regs.length || !tgts.length} onClick={goStep3Next}>Next →</button>}
            {step === 4 && <button className="btn btn-primary" disabled={busy || !validated || (!placed && !/^[a-z0-9]+$/.test(prefix))} onClick={goStep4Next}>Next →</button>}
          </div>
        </div>
      </div>
    </FloatingDialog>
    {createMacro && <CreateMacroDialog api={api} cartPath={cartPath} cartName={cart?.name} patternText={text} relationName={name} initialBody={createMacro.body} hasSelection={createMacro.hasSel} onAdded={macroCreated} onClose={() => setCreateMacro(null)} />}
    {editMacroName && <CreateMacroDialog api={api} cartPath={cartPath} cartName={cart?.name} patternText={text} relationName={name} editName={editMacroName} onAdded={macroCreated} onClose={() => setEditMacroName('')} />}
    {editSet && <FileEditorDialog cartPath={cartPath} cartName={cart?.name} file={editSet.file} initialSet={editSet.set} onClose={closeSetEditor} />}
    {help && <PatternHelpDialog onClose={() => setHelp(false)} />}
    {findMacro && <FindMacroDialog api={api} cartPath={cartPath} onInsert={insertAtCursor} onClose={() => setFindMacro(false)} />}
    {viewExisting && suggest?.existing && <UsedPatternsDialog res={suggest.existing} cartPath={cartPath} names={{ regNames: suggest.regNames, tgtNames: suggest.tgtNames }} title="Existing pattern that already extracts this relation (read-only)" onClose={() => setViewExisting(false)} />}
    {setView && (
      <FloatingDialog title={setView.error ? 'View patterns' : '&' + setView.set + ' — frame and patterns (read-only)'} width={820} dock="left">
        <div style={{ padding: 12, fontSize: 12 }}>
          {setView.error ? <div className="text-danger">{setView.error}</div> : <>
            <div className="text-xs text-muted" style={{ marginBottom: 3 }}>CONTROL frame — <code>{setView.ruleFile}</code></div>
            <pre style={{ margin: '0 0 12px', padding: 8, background: 'var(--bg-input, #1e1e2e)', borderRadius: 6, whiteSpace: 'pre-wrap', userSelect: 'text' }}>{setView.frame}</pre>
            <div className="text-xs text-muted" style={{ marginBottom: 3, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ flex: 1 }}>Pattern set — <code>{setView.setFile}</code> ({setView.mode === 'csout' ? 'run on ConceptScan output (-Icsout)' : 'sentence-level'})</span>
              <button type="button" className="btn btn-sm btn-primary" style={{ padding: '1px 12px' }} title="Close this read-only view and edit the pattern set in the pattern editor"
                onClick={() => { setEditSet({ file: setView.setFile, set: setView.set }); setSetView(null); }}>Edit</button>
            </div>
            <pre style={{ margin: 0, padding: 8, background: 'var(--bg-input, #1e1e2e)', borderRadius: 6, whiteSpace: 'pre-wrap', userSelect: 'text', maxHeight: '55vh', overflow: 'auto' }}>{setView.patterns}</pre>
          </>}
          <div style={{ marginTop: 10, textAlign: 'right' }}><button type="button" className="btn btn-sm" onClick={() => setSetView(null)}>Close</button></div>
        </div>
      </FloatingDialog>
    )}
    </>
  );
}

// the input sentence inside the teal info banner: a lighter, brighter aqua than the banner text so it stands out
const SENT_STYLE = { color: '#9ff3ff', fontWeight: 600 };
