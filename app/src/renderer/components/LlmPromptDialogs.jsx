import React, { useState, useEffect, useRef } from 'react';

// The two buttons of a ConceptScan (LLM ...) step of the Pipeline screen.
// step.llm = { cartridge: <name>, cartridgePath } is sent by the main process with the finished step.
const SYNC = 'nlp-triple-sync';
const NL = String.fromCharCode(10);

// the requests of a run, read from the log of conceptscan_llm (it prints every prompt it sends):
//   --- SENTENCE: <plain sentence>  ...  --- PROMPT:  <prompt>  --- MODEL ANSWER: ...
export function promptsOfLog(log) {
  const out = [];
  for (const block of String(log || '').replace(/\r/g, '').split(NL + '--- SENTENCE: ').slice(1)) {      // (the log of a Windows process has CRLF line ends)
    const sentence = block.split(NL)[0];
    const pairs = [];
    const re = /--- PROMPT:\n([\s\S]*?)\n--- MODEL ANSWER:/g;
    let m;
    while ((m = re.exec(block)) !== null) pairs.push({ prompt: m[1] });
    out.push({ sentence, pairs });
  }
  return out;
}

const BOX = { width: '100%', fontFamily: 'monospace', fontSize: 11, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: 8, boxSizing: 'border-box', resize: 'vertical' };

// A floating window, not a modal: no dark backdrop and nothing blocks the screen behind it, so the tagged sentence stays visible and usable.
// Drag it by its title bar; resize it by the corner at its bottom right.
function Modal({ title, onClose, children, actions, height = 520 }) {
  const W = Math.min(820, window.innerWidth - 80);
  const [pos, setPos] = useState({ x: Math.max(20, window.innerWidth - W - 40), y: 70 });
  const drag = useRef(null);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const down = (e) => { if (e.target.closest('button')) return; drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }; e.currentTarget.setPointerCapture(e.pointerId); };
  const move = (e) => { if (drag.current) setPos({ x: clamp(e.clientX - drag.current.dx, 120 - W, window.innerWidth - 120), y: clamp(e.clientY - drag.current.dy, 0, window.innerHeight - 40) }); };
  const up = () => { drag.current = null; };
  return (
    <div style={{ position: 'fixed', left: pos.x, top: pos.y, width: W, height: Math.min(height, window.innerHeight - 100), minWidth: 380, minHeight: 240, maxWidth: '96vw', maxHeight: '92vh', zIndex: 200, resize: 'both', overflow: 'auto',
                  display: 'flex', flexDirection: 'column', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 12px 36px rgba(0,0,0,0.55)' }}>
      <div onPointerDown={down} onPointerMove={move} onPointerUp={up}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', cursor: 'move', userSelect: 'none', touchAction: 'none', borderBottom: '1px solid var(--border)', flex: '0 0 auto' }}>
        <span className="modal-title" style={{ margin: 0, flex: 1 }}>{title}</span>
        <span className="text-xs text-muted">drag to move</span>
        <button className="btn btn-secondary btn-sm" onClick={onClose} title="Close">✕</button>
      </div>
      <div style={{ padding: 14, flex: '1 1 auto', overflow: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>{children}</div>
      <div className="modal-actions" style={{ margin: 0, padding: '10px 14px', borderTop: '1px solid var(--border)', flex: '0 0 auto' }}>{actions}<button className="btn btn-secondary" onClick={onClose}>Close</button></div>
    </div>
  );
}

// ONE window with two tabs: "View prompt" (the requests this run sent, with the JSON line and the plain sentence) and "Edit prompt" (the template of the cartridge).
// The buttons of the ConceptScan (LLM) step open it on the tab of the button; the tabs switch between the two views without closing anything, so the template can be edited
// while a complete request of the last run is a click away. Both panes stay mounted (the text of the editor and the scroll positions are kept).
//   tab = 'view' | 'edit' (state of the Pipeline screen, onTab changes it), step.llm = { cartridge, cartridgePath }, step.stderr = the log of the run
export function PromptDialog({ step, tab, onTab, onClose }) {
  const llm = step.llm || {};
  const sentences = promptsOfLog(step.stderr);
  const viewText = !sentences.length
    ? 'The log of this run has no prompt: no pair of entities of the sentence can be extracted by a frame of the cartridge, so no request was sent.'
    : sentences.map(s => {
        const head = 'Sentence:' + NL + s.sentence + NL;
        if (!s.pairs.length) return head + NL + 'No pair of entities of this sentence can be extracted by a frame of the cartridge: no request was sent.';
        return head + s.pairs.map(p => NL + 'Prompt:' + NL + p.prompt).join(NL);
      }).join(NL + NL);

  // the template: the one edited by the user, else the default of the cartridge (it differs: only DiseaseFX has a change-type line); saved in the user's settings, used by the next run
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [def, setDef] = useState(null);
  const [answerLine, setAnswerLine] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [ref, setRef] = useState('');                              // the pronoun question (second request): one text for every cartridge
  const [refSaved, setRefSaved] = useState('');
  const [refDef, setRefDef] = useState(null);
  const [refNote, setRefNote] = useState(false);
  useEffect(() => {
    (async () => {
      const [s, r] = await Promise.all([window.api.settings.get(), window.api.llm.defaultReferentPrompt()]);
      const edited = (s.llmReferentPrompt || '').trim();
      const def = r && r.ok ? r.text : '';
      setRefDef(def); const start = edited || def; setRef(start); setRefSaved(start);
    })();
  }, []);
  const saveRef = async () => {
    await window.api.settings.set({ llmReferentPrompt: !ref.trim() || ref === refDef ? '' : ref });       // only an edit is stored; none = the built-in question
    setRefSaved(ref); setRefNote(true);
  };
  const refEdited = refDef !== null && ref !== refDef;
  const refDirty = ref !== refSaved;
  useEffect(() => {
    (async () => {
      const [s, r] = await Promise.all([window.api.settings.get(), window.api.llm.defaultPrompt({ cartridge: llm.cartridge })]);
      if (!r.ok) setError(r.error); else { setDef(r.text); setAnswerLine(r.answerLine || ''); }
      const edited = (s.llmPairPrompts || {})[llm.cartridge];
      const start = edited && edited.trim() ? edited : (r.ok ? r.text : '');
      setText(start); setSavedText(start);
    })();
  }, []);
  const save = async () => {
    const s = await window.api.settings.get();
    const map = { ...(s.llmPairPrompts || {}) };
    if (!text.trim() || text === def) delete map[llm.cartridge]; else map[llm.cartridge] = text;      // only edits are stored; none = the default template
    await window.api.settings.set({ llmPairPrompts: map });
    window.dispatchEvent(new CustomEvent(SYNC, { detail: { reload: true } }));                          // the NLP Runner shows the same text
    setSavedText(text); setSaved(true);
  };
  const edited = def !== null && text !== def;
  const dirty = text !== savedText;                                                                      // typed, not saved yet

  const tabButton = (id, label) => (
    <button className={`btn btn-sm ${tab === id ? 'btn-primary' : 'btn-secondary'}`} onClick={() => onTab(id)}>{label}</button>
  );
  const pane = (id) => ({ display: tab === id ? 'flex' : 'none', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 });
  return (
    <Modal title={`Prompt for ${llm.cartridge || 'this cartridge'}`} onClose={onClose} height={520}
      actions={tab === 'pronoun' ? <>
        <button className="btn btn-secondary" disabled={refDef === null || !refEdited} onClick={() => { setRef(refDef); setRefNote(false); }}>Use default question</button>
        <button className="btn btn-primary" onClick={saveRef}>Save</button>
      </> : tab === 'edit' ? <>
        <button className="btn btn-secondary" disabled={def === null || !edited} onClick={() => { setText(def); setSaved(false); }}>Use default template</button>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </> : null}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flex: '0 0 auto' }}>
        {tabButton('view', 'View prompt')}
        {tabButton('edit', 'Edit prompt' + (dirty ? ' •' : ''))}
        {tabButton('pronoun', 'Pronoun prompt' + (refDirty ? ' •' : ''))}
      </div>

      <div style={pane('view')}>
        <div className="text-xs text-muted" style={{ marginBottom: 6 }}>The requests of the last run: one per sentence; the prompt was followed by the sentence as plain text. No worked examples.</div>
        <textarea readOnly spellCheck={false} value={viewText} style={{ ...BOX, flex: '1 1 auto', minHeight: 160, resize: 'none' }} />
      </div>

      <div style={pane('edit')}>
        <div className="text-xs text-muted" style={{ marginBottom: 6 }}>
          One request is sent per sentence: this template, then the sentence as plain text. To list the entities in the prompt write <code>{'${1:list of tagged entities}'}</code> (or <code>{'${entities}'}</code>) where the list should stand, e.g. <code>Target entities in sentence: {'${1:list of tagged entities}'}</code>: it becomes <code>["a", "b"]</code> - every entity a frame of the cartridge can use, in the order of the sentence. Without the placeholder no list is sent. Saved per cartridge, the same template as in the NLP Runner. <b>Run the pipeline again to use it.</b>
        </div>
        {error && <div className="alert alert-danger" style={{ marginBottom: 6 }}>{error}</div>}
        <textarea spellCheck={false} value={text} onChange={e => { setText(e.target.value); setSaved(false); }} style={{ ...BOX, flex: '1 1 auto', minHeight: 120, resize: 'none' }} />
        <div className="text-xs text-muted" style={{ marginTop: 6 }}>
          The answer is a JSON array of triples with ONE structure: noun phrase 1 - predicate - noun phrase 2. The last line of the template tells the model its JSON shape; the program finds the three values by the meaning of the keys (a key with "predicate" / "verb" / "relation", the keys with 1 and 2). Each noun phrase must hold an entity that a frame of the cartridge can use (two entities of the SAME type in one noun phrase are not allowed; entities of different types are, and the frames of the cartridge decide which pair is a relation): that is how the program knows which two entities a triple links. It writes the pseudo-sentence "noun phrase 1 & predicate noun phrase 2"; the first triple is #Main, the others #NPRel. A template without a JSON line gets the default line added.
          {!/\{\s*"[^"]+"\s*:/.test(text) && answerLine && <div style={{ marginTop: 4 }}>
            <b>This template has no JSON line</b>, so this one is added to every request: <span className="mono" style={{ userSelect: 'text' }}>{answerLine}</span>{' '}
            <button className="btn btn-secondary btn-sm" onClick={() => { setText(t => t.replace(/\s+$/, '') + NL + answerLine); setSaved(false); }}>Add it to the template</button>
          </div>}
        </div>
        <div className="text-xs" style={{ marginTop: 4, color: saved ? 'var(--success, #2a9)' : 'var(--text-muted)' }}>
          {saved ? '✓ Saved - run the pipeline again.' : dirty ? 'changed, not saved yet' : edited ? 'edited template (saved)' : 'the default template'}
        </div>
      </div>
      <div style={pane('pronoun')}>
        <div className="text-xs text-muted" style={{ marginBottom: 6 }}>
          A second, short request is sent only when a triple of the answer starts with a pronoun that has no entity of its own ("its deletion in β-cells"): which entity does the pronoun refer to?
          The question is sent as ONE user message (no system prompt); the answer should be one of the listed entities, or "none". The words {'${sentence}'} {'${np1}'} {'${predicate}'} {'${np2}'} {'${pronoun}'}
          {' '}{'${candidates}'} (the entities before the pronoun, as ["a", "b"]) are replaced. The question and the answer are in the Stderr tab (PRONOUN QUESTION / ANSWER / RESULT). Used by the next run.
        </div>
        <textarea spellCheck={false} value={ref} onChange={e => { setRef(e.target.value); setRefNote(false); }} style={{ ...BOX, flex: '1 1 auto', minHeight: 120, resize: 'none' }} />
        <div className="text-xs" style={{ marginTop: 4, color: refNote ? 'var(--success, #2a9)' : 'var(--text-muted)' }}>
          {refNote ? '✓ Saved - run the pipeline again.' : refDirty ? 'changed, not saved yet' : refEdited ? 'edited question (saved)' : 'the built-in question'}
        </div>
      </div>
    </Modal>
  );
}
