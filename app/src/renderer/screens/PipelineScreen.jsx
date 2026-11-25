import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PromptDialog } from '../components/LlmPromptDialogs';
import { warmMacros } from '../utils/warmMacros';
import SuggestPatternModal from '../components/SuggestPatternModal';
import RelationWizard from '../components/RelationWizard';
import FloatingDialog from '../components/FloatingDialog';
import UsedPatternsDialog from '../components/UsedPatternsDialog';
import { effectArrow, effectColor } from '../utils/effectArrow';

// The markup that the -Imsout pattern folders read: what goes INTO the conceptscan stage of the sentence pipeline of locscan.ini (the output of the stage before it —
// the glue stages have merged entities there, e.g. SMAC / DIABLO), not the raw MedScan output.
function msoutOf(steps) {
  const markup = (steps || []).filter(x => x.stepType === 'markup');
  const i = markup.findIndex(x => x.name === 'conceptscan');
  const before = i > 0 ? markup[i - 1] : markup.find(x => x.name === 'medscan');
  return (before && before.output) || '';
}

// ── Pretty-print XML ───────────────────────────────────────────────────────────
// how long a step took: 840 ms, 1.49 s, 2 min 05 s
function fmtElapsed(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60000), sec = Math.round((ms % 60000) / 1000);
  return `${m} min ${String(sec).padStart(2, '0')} s`;
}

function prettyXml(xml) {
  if (!xml || !xml.trim()) return '';
  try {
    let depth = 0;
    const INDENT = '  ';
    // Collapse whitespace between tags first
    const normalized = xml.replace(/>\s*</g, '><').trim();
    return normalized
      .replace(/(<[^/!?][^>]*[^/]>)|(<[^/!?][^>]*\/>)|(<\/[^>]+>)|(<[!?][^>]*>)/g, (m) => {
        if (m.startsWith('</')) {
          depth = Math.max(0, depth - 1);
          return '\n' + INDENT.repeat(depth) + m;
        } else if (m.endsWith('/>') || m.startsWith('<!') || m.startsWith('<?')) {
          return '\n' + INDENT.repeat(depth) + m;
        } else {
          const result = '\n' + INDENT.repeat(depth) + m;
          depth++;
          return result;
        }
      })
      .trim();
  } catch {
    return xml;
  }
}

// ── Parse ID{ids=alias} tokens from msrc sentence ─────────────────────────────
function parseMsrcSegments(msrc) {
  if (!msrc) return [{ text: msrc || '', role: 'text' }];
  const entries = [];
  const re = /ID\{([^=}]+)=([^}]+)\}/g;
  let m;
  while ((m = re.exec(msrc)) !== null) {
    entries.push({ ids: m[1].split(',').map(s => s.trim()), alias: m[2].trim(), start: m.index, end: m.index + m[0].length });
  }
  if (entries.length === 0) return [{ text: msrc, role: 'text' }];
  const segs = [];
  let pos = 0;
  for (const e of entries) {
    if (e.start > pos) {
      const plain = msrc.slice(pos, e.start).replace(/GLOSSARY\{[^}]+\}/g, '').replace(/CONTEXT\{[^}]+\}/g, '');
      if (plain) segs.push({ text: plain, role: 'text' });
    }
    segs.push({ text: e.alias, role: 'entity', ids: e.ids });
    pos = e.end;
  }
  if (pos < msrc.length) {
    const plain = msrc.slice(pos).replace(/GLOSSARY\{[^}]+\}/g, '').replace(/CONTEXT\{[^}]+\}/g, '');
    if (plain) segs.push({ text: plain, role: 'text' });
  }
  return segs;
}

// ── Line-level diff using LCS ─────────────────────────────────────────────────
// Returns array of { text, added } for currLines relative to prevLines.
function diffLines(prevLines, currLines) {
  const n = prevLines.length;
  const m = currLines.length;
  if (n === 0) return currLines.map(text => ({ text, added: true }));

  // Build LCS DP table (only needs two rows)
  let prev = new Array(m + 1).fill(0);
  let curr = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    [prev, curr] = [curr, prev];
    for (let j = 1; j <= m; j++) {
      curr[j] = prevLines[i - 1] === currLines[j - 1]
        ? prev[j - 1] + 1
        : Math.max(curr[j - 1], prev[j]);
    }
  }

  // Rebuild full table for backtracking
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = prevLines[i - 1] === currLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  // Backtrack: mark unchanged indices in currLines
  const unchanged = new Set();
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (prevLines[i - 1] === currLines[j - 1]) {
      unchanged.add(j - 1); i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return currLines.map((text, idx) => ({ text, added: !unchanged.has(idx) }));
}

// ── Word-level diff within a single line ──────────────────────────────────────
// Returns array of { text, added } segments.
// Tokenizer keeps ID{...} / GLOSSARY{...} / CONTEXT{...} as single atomic tokens
// so multi-word entity markup is never split across highlight boundaries.
const MARKUP_RE    = /(?:ID|GLOSSARY|CONTEXT|[A-Z]+)\{[^}]*\}|\S+|\s+/g;
const ID_TOKEN_RE  = /^(?:ID|GLOSSARY|CONTEXT)\{([^}]*)\}$/;

// ── Extract first numeric MedScan ID from an ID{...} token ────────────────────
function extractMsIds(idToken) {
  const m = ID_TOKEN_RE.exec(idToken);
  if (!m) return null;
  const eqIdx = m[1].indexOf('=');
  const idsStr = eqIdx >= 0 ? m[1].slice(0, eqIdx) : m[1];
  const ids = idsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n % 1000000 !== 0);
  return ids.length ? ids : null;
}

// ── Render one token — makes ID{...} tokens clickable ─────────────────────────
function IdSegment({ text, style, onIdClick }) {
  if (ID_TOKEN_RE.test(text) && onIdClick) {
    const msIds = extractMsIds(text);
    if (msIds !== null) {
      return (
        <span title="Click to open record" onClick={() => onIdClick(msIds)}
          style={{ ...style, cursor: 'pointer', textDecoration: 'underline dotted' }}>
          {text}
        </span>
      );
    }
  }
  return <span style={style}>{text}</span>;
}

// ── Render a markup line: ID{...} tokens in muted color + clickable ─────────────
function MarkupLine({ text, baseStyle, onIdClick }) {
  const re = new RegExp('((?:ID|GLOSSARY|CONTEXT)\\{[^}]*\\})', 'g');
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ t: text.slice(last, m.index), kind: 'text' });
    const tok = m[0];
    if (tok.startsWith('ID{')) {
      const inner = tok.slice(3, -1);
      const eqIdx = inner.indexOf('=');
      const idsStr = eqIdx >= 0 ? inner.slice(0, eqIdx) : inner;
      const ids = idsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n % 1000000 !== 0);
      parts.push({ t: tok, kind: 'entity', ids });
    } else {
      // GLOSSARY / CONTEXT — show grayed, not clickable
      parts.push({ t: tok, kind: 'markup' });
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push({ t: text.slice(last), kind: 'text' });
  if (parts.length === 0) return <span style={baseStyle}>{text || ' '}</span>;

  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'entity') {
          const clickable = onIdClick && p.ids.length > 0;
          return (
            <span key={i}
              title={clickable ? 'Click to open record' : undefined}
              onClick={clickable ? () => onIdClick(p.ids) : undefined}
              style={{ ...baseStyle, cursor: clickable ? 'pointer' : 'default' }}>
              {p.t}
            </span>
          );
        }
        // words a step changed or added (word diff: green with a background) keep their green; the rest of the line is dimmed
        if (baseStyle && baseStyle.background) return <span key={i} style={baseStyle}>{p.t}</span>;
        if (p.kind === 'markup') {
          return <span key={i} style={{ ...baseStyle, color: 'var(--text)', opacity: 0.55 }}>{p.t}</span>;
        }
        return <span key={i} style={{ ...baseStyle, color: 'var(--text)', opacity: 0.55 }}>{p.t}</span>;
      })}
    </>
  );
}
function diffWords(prevLine, currLine) {
  const prevToks = prevLine.match(MARKUP_RE) || [];
  const currToks = currLine.match(MARKUP_RE) || [];
  const n = prevToks.length, m = currToks.length;
  if (n === 0) return [{ text: currLine, added: true }];

  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      dp[i][j] = prevToks[i - 1] === currToks[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  const segs = [];
  let i = n, j = m;
  while (j > 0) {
    if (i > 0 && prevToks[i - 1] === currToks[j - 1] && dp[i][j] === dp[i - 1][j - 1] + 1) {
      segs.unshift({ text: currToks[j - 1], added: false }); i--; j--;
    } else if (i > 0 && dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      segs.unshift({ text: currToks[j - 1], added: true }); j--;
    }
  }

  // Merge consecutive same-type segments
  const merged = [];
  for (const seg of segs) {
    if (merged.length && merged[merged.length - 1].added === seg.added) {
      merged[merged.length - 1].text += seg.text;
    } else merged.push({ ...seg });
  }
  return merged.length ? merged : [{ text: currLine, added: true }];
}

// ConceptScan pseudo-sentence ("<  #Main ID{..} & raise ID{..}"): only ConceptScan creates these lines, so their tagged entities are always shown green
const isPseudoLine = (t) => /^\s*<\s/.test(t || '');
const PSEUDO_ENTITY = { color: '#a6e3a1', fontWeight: 700 };

// ── Find the most similar line in prevLines (Dice coefficient on words) ────────
function findSimilarLine(currLine, prevLines) {
  const cTrimmed = currLine.trim();
  if (!cTrimmed) return null;
  const cSet = new Set(cTrimmed.split(/\s+/));
  let best = null, bestScore = 0;
  for (const pl of prevLines) {
    if (pl === currLine) continue;
    const pTrimmed = pl.trim();
    if (!pTrimmed) continue;
    const pSet = new Set(pTrimmed.split(/\s+/));
    let shared = 0;
    for (const w of cSet) if (pSet.has(w)) shared++;
    const score = (2 * shared) / (cSet.size + pSet.size);
    if (score > bestScore && score > 0.35) { bestScore = score; best = pl; }
  }
  return best;
}

// ── Check whether a pattern step produced any RNEF relations ──────────────────
function hasRnefContent(output) {
  return !!(output && output.includes('<resnet'));
}

// ── Decode URL-encoded URN (matches ObjectNames.tab decoding in main.js) ──────
function decodeUrn(s) {
  return (s || '')
    .replace(/%20/g, ' ').replace(/%2c/gi, ',')
    .replace(/%28/gi, '(').replace(/%29/gi, ')')
    .replace(/%3a/gi, ':').replace(/%2f/gi, '/');
}

// ── Extract sentences from RNEF XML with link-direction roles ─────────────────
// urnMap: Map<urn, mscanIdString> from ObjectNames.tab (loaded via IPC)
// Returns [{ msrc, entityRoles: Map<numericId, 'target'|'regulator'|'both'> }]
function extractRnefSentencesWithRoles(rnefXml, urnMap) {
  if (!rnefXml || !rnefXml.includes('<')) return [];
  try {
    const doc = new DOMParser().parseFromString(rnefXml, 'text/xml');
    if (doc.documentElement.tagName === 'parseerror' ||
        doc.documentElement.tagName === 'html') return [];

    // Merge a sentence+roles entry into the dedup map
    function mergeSentence(map, msrc, entityRoles, rel) {
      if (!map.has(msrc)) {
        map.set(msrc, { msrc, entityRoles, rels: rel ? [rel] : [] });
      } else {
        const ex = map.get(msrc);
        for (const [eid, role] of entityRoles) {
          const prev = ex.entityRoles.get(eid);
          ex.entityRoles.set(eid, prev && prev !== role ? 'both' : role);
        }
        if (rel && !ex.rels.some(x => x.key === rel.key)) ex.rels.push(rel);
      }
    }

    const sentences = new Map();

    const resnets = doc.getElementsByTagName('resnet');
    for (let ri = 0; ri < resnets.length; ri++) {
      const resnet = resnets[ri];

      // ── Build local_id → [mscanId, ...] map for this resnet's nodes ──────
      const nMap = new Map();
      const nInfo = new Map();          // local_id → { type, name, ids } for the symbolic form of a relation
      const nodeEls = resnet.getElementsByTagName('node');
      for (let ni = 0; ni < nodeEls.length; ni++) {
        const node = nodeEls[ni];
        const localId = node.getAttribute('local_id') || node.getAttribute('id') || '';
        if (!localId) continue;
        const urn = decodeUrn(node.getAttribute('urn') || '');
        const ids = [];

        // 1. ObjectNames.tab URN→mscanId lookup
        if (urn && urnMap && urnMap.size) {
          const mscanId = urnMap.get(urn);
          if (mscanId) { const n = parseInt(mscanId); if (!isNaN(n)) ids.push(n); }
        }
        // 2. Direct extraction for agi-llid URNs: urn:agi-llid:969 → 969
        if (ids.length === 0 && urn) {
          const m = urn.match(/^urn:agi-llid:(\d+)$/i);
          if (m) { const n = parseInt(m[1]); if (!isNaN(n)) ids.push(n); }
        }

        let nType = '', nName = '';
        for (const a of Array.from(node.getElementsByTagName('attr'))) {
          const an = a.getAttribute('name');
          if (an === 'NodeType') nType = a.getAttribute('value') || '';
          else if (an === 'Name') nName = a.getAttribute('value') || '';
        }
        nInfo.set(localId, { type: nType, name: nName, ids });

        if (ids.length) nMap.set(localId, ids);
      }

      // ── msrc can be an XML attribute on <resnet> (old/pipeline format) ──
      const resnetMsrc = resnet.getAttribute('msrc') || '';

      // ── Process each control / relation ──────────────────────────────────
      const controlEls = resnet.getElementsByTagName('control');
      const relationEls = resnet.getElementsByTagName('relation');
      const ctrlList = [...Array.from(controlEls), ...Array.from(relationEls)];

      if (ctrlList.length === 0 && resnetMsrc) {
        // No controls at all — add sentence with no role coloring
        mergeSentence(sentences, resnetMsrc, new Map());
        continue;
      }

      for (const ctrl of ctrlList) {
        // Collect msrc attr values (new indexed format inside control)
        const msrcByIdx = {};
        const attrEls = ctrl.getElementsByTagName('attr');
        for (let ai = 0; ai < attrEls.length; ai++) {
          const a = attrEls[ai];
          if (a.getAttribute('name') !== 'msrc') continue;
          const idx = a.getAttribute('index') || '1';
          msrcByIdx[idx] = a.getAttribute('value') || '';
        }
        // Fallback: resnet-level msrc (old single-sentence format)
        if (Object.keys(msrcByIdx).length === 0 && resnetMsrc) {
          msrcByIdx['1'] = resnetMsrc;
        }

        // Compute entity roles from link elements
        const entityRoles = new Map();
        const linkEls = ctrl.getElementsByTagName('link');
        for (let li = 0; li < linkEls.length; li++) {
          const link = linkEls[li];
          const ltype = link.getAttribute('type') || '';
          const ref   = link.getAttribute('ref')  || '';
          const eids  = nMap.get(ref);
          if (!eids) continue;
          const role = ltype === 'out' ? 'target'
                     : ltype === 'in'  ? 'regulator'
                     : ltype === 'in-out' ? 'both' : null;
          if (!role) continue;
          for (const eid of eids) {
            const prev = entityRoles.get(eid);
            entityRoles.set(eid, prev && prev !== role ? 'both' : role);
          }
        }

        let ctype = '', effect = '';
        for (const a of Array.from(attrEls)) {
          if (a.getAttribute('index')) continue;
          const an = a.getAttribute('name');
          if (an === 'ControlType') ctype = a.getAttribute('value') || '';
          else if (an === 'Effect') effect = a.getAttribute('value') || '';
        }
        const refsOf = (t) => Array.from(linkEls).filter(l => l.getAttribute('type') === t).map(l => l.getAttribute('ref') || '');
        const regRefs = refsOf('in'), tgtRefs = refsOf('out'), bothRefs = refsOf('in-out');
        const arrow = effectArrow(effect);

        for (const msrc of Object.values(msrcByIdx)) {
          if (!msrc) continue;
          // the entity as it is written in the sentence (the ID{ids=text} that carries the node's id); the node's own name if the sentence has none
          const segs = parseMsrcSegments(msrc);
          const label = (ref) => {
            const n = nInfo.get(ref);
            if (!n) return '';
            const seg = segs.find(g => g.role === 'entity' && (g.ids || []).some(id => n.ids.includes(parseInt(id))));
            return `${n.type || '?'}:(${seg ? seg.text : n.name})`;           // MedicalProcedure:(transarterial chemoembolization)
          };
          const names = (refs) => [...new Set(refs.map(label).filter(Boolean))];
          // { regs, tgts, both: ["SmallMol:(buprenorphine)", …], type, arrow } — shown by RelationNames, key = the same as plain text
          const regs = names(regRefs), tgts = names(tgtRefs), both = names(bothRefs);
          let rel = null;
          if (regs.length || tgts.length || both.length) {
            const type = ctype || 'relation';
            const key = (regs.length || tgts.length) ? `${regs.join(' + ')} — ${type} ${arrow} ${tgts.join(' + ')}` : both.join(` — ${type} — `);
            rel = { key, regs, tgts, both, type, arrow, effect };
          }
          mergeSentence(sentences, msrc, entityRoles, rel);
        }
      }
    }
    return [...sentences.values()];
  } catch (e) {
    console.error('[extractRnefSentencesWithRoles]', e);
    return [];
  }
}

// Symbolic form of the relations of a sentence: SmallMol:(buprenorphine) — Regulation -+> Disease:(opioid use disorder)
// The regulator is red, the target green, non-directional entities yellow — the colours of the same entities in the sentence below.
function RelationNames({ rels }) {
  if (!rels || !rels.length) return null;
  const ent = (list, color) => list.map((n, j) => <React.Fragment key={j}>{j > 0 ? ' + ' : ''}<strong style={{ color }}>{n}</strong></React.Fragment>);
  return <>{rels.map((r, i) => (
    <div key={i} className="mono" style={{ fontSize: 12, lineHeight: 1.7 }} title="regulator type:(entity in the sentence) — relation type, Effect arrow → target type:(entity)">
      {(r.regs.length || r.tgts.length)
        ? <>{ent(r.regs, ROLE_COLORS.regulator)} — {r.type} <strong style={{ color: effectColor(r.effect) }}>{r.arrow}</strong> {ent(r.tgts, ROLE_COLORS.target)}</>
        : r.both.map((n, j) => <React.Fragment key={j}>{j > 0 ? <> — {r.type} — </> : null}<strong style={{ color: ROLE_COLORS.both }}>{n}</strong></React.Fragment>)}
    </div>
  ))}</>;
}

// ── Colored sentence component ─────────────────────────────────────────────────
const ENTITY_COLOR = '#89dceb'; // default cyan (no role info)
const ROLE_COLORS = {
  target:    '#a6e3a1', // green
  regulator: '#f38ba8', // red/pink
  both:      '#f9e2af', // yellow/orange (non-directional)
};

// entityRoles: Map<numericId, 'target'|'regulator'|'both'> — optional
function ColoredSentence({ msrc, entityRoles, onIdClick }) {
  const segs = parseMsrcSegments(msrc);
  return (
    <span style={{ fontSize: 12, lineHeight: 1.6 }}>
      {segs.map((seg, i) => {
        if (seg.role !== 'entity') return <span key={i}>{seg.text}</span>;
        // Determine color by role
        let color = ENTITY_COLOR;
        if (entityRoles) {
          for (const id of (seg.ids || [])) {
            const numId = parseInt(id);
            if (!isNaN(numId) && entityRoles.has(numId)) {
              color = ROLE_COLORS[entityRoles.get(numId)] || ENTITY_COLOR;
              break;
            }
          }
        }
        const clickable = onIdClick && seg.ids?.length;
        return (
          <strong key={i}
            style={{ color, cursor: clickable ? 'pointer' : 'default',
                     textDecoration: clickable ? 'underline dotted' : 'none' }}
            title={clickable ? 'Click to open record' : seg.ids?.join(', ')}
            onClick={() => {
              if (!clickable) return;
              const ids = seg.ids.map(s => parseInt(s)).filter(n => !isNaN(n) && n % 1000000 !== 0);
              if (ids.length) onIdClick(ids);
            }}
          >{seg.text}</strong>
        );
      })}
    </span>
  );
}

// ── Step status badge ──────────────────────────────────────────────────────────
function StatusBadge({ status, code }) {
  if (status === 'running') return <span className="spinner" style={{ marginLeft: 6 }} />;
  if (status === 'done')    return <span style={{ color: code === 0 ? 'var(--success)' : 'var(--warning)', marginLeft: 6, fontSize: 11 }}>{code === 0 ? '✓' : `exit ${code}`}</span>;
  if (status === 'error')   return <span style={{ color: 'var(--danger)', marginLeft: 6, fontSize: 11 }}>✗ error</span>;
  return null;
}

// ── Tab selector for step output view ─────────────────────────────────────────
function StepOutput({ step, prevOutput, onIdClick, urnMap, extra }) {
  const isLlm = /LLM/.test(step.label || '') && !!step.stderr;      // the conceptscan step run by an LLM: its log (raw answer, fate of every triple) is what to read first
  const [tab, setTab] = useState(isLlm ? 'stderr' : 'xml');
  const [dlg, setDlg] = useState(null);           // 'view' | 'edit': the prompt dialogs of an LLM step
  const sentences = step.stepType === 'pattern' ? extractRnefSentencesWithRoles(step.output, urnMap) : [];

  // Auto-switch to Sentences tab once results arrive (only once per step)
  const autoSwitchedRef = useRef(false);
  useEffect(() => {
    if (!autoSwitchedRef.current && sentences.length > 0) {
      autoSwitchedRef.current = true;
      setTab('sentences');
    }
  }, [sentences.length]);

  const tabs = [{ id: 'xml', label: step.stepType === 'markup' ? 'Markup' : 'XML' }];
  if (step.stepType === 'pattern' && sentences.length > 0) tabs.push({ id: 'sentences', label: `Sentences (${sentences.length})` });
  if (step.stderr) tabs.push({ id: 'stderr', label: isLlm ? 'LLM response & filters' : 'Stderr' });
  if (step.cmd) tabs.push({ id: 'cmd', label: 'Command' });

  const pretty = prettyXml(step.output || '');

  // For markup steps with a previous step, compute a line-level diff
  const showDiff = step.stepType === 'markup' && prevOutput != null;
  const prevLines = showDiff ? prettyXml(prevOutput || '').split('\n') : [];
  const diffResult = showDiff
    ? diffLines(prevLines, pretty ? pretty.split('\n') : [])
    : null;
  const addedCount = diffResult ? diffResult.filter(l => l.added).length : 0;

  const PRE_STYLE = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '10px 12px',
    fontSize: 11,
    lineHeight: 1.5,
    maxHeight: 400,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    color: 'var(--text)',
    margin: 0,
  };

  return (
    <div style={{ marginTop: 8 }}>
      {(tabs.length > 1 || extra) && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
          {tabs.map(t => (
            <button
              key={t.id}
              className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setTab(t.id)}
            >{t.label}</button>
          ))}
          {step.llm && (
            <>
              <span style={{ width: 12 }} />
              <button className="btn btn-sm btn-secondary" title="The prompt(s) this run sent to the LLM" onClick={() => setDlg('view')}>View prompt</button>
              <button className="btn btn-sm btn-secondary" title="Edit the prompt template of this cartridge (used by the next run)" onClick={() => setDlg('edit')}>Edit prompt</button>
            </>
          )}
          {extra}
        </div>
      )}
      {dlg && <PromptDialog step={step} tab={dlg} onTab={setDlg} onClose={() => setDlg(null)} />}

      {tab === 'xml' && showDiff && diffResult ? (
        <>
          {addedCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text)', opacity: 0.55, marginBottom: 4 }}>
              <span style={{ color: '#a6e3a1', fontWeight: 600 }}>+{addedCount}</span> new line{addedCount !== 1 ? 's' : ''} added by this step
            </div>
          )}
          <pre style={PRE_STYLE}>
            {diffResult.length === 0
              ? <span style={{ color: 'var(--text)', opacity: 0.55 }}>(no output)</span>
              : diffResult.map((line, i) => {
                  if (!line.added) {
                    return (
                      <div key={i} style={{ paddingLeft: 6 }}>
                        <MarkupLine text={line.text || ' '} baseStyle={isPseudoLine(line.text) ? PSEUDO_ENTITY : undefined} onIdClick={onIdClick} />
                      </div>
                    );
                  }
                  const similarPrev = isPseudoLine(line.text) ? null : findSimilarLine(line.text, prevLines);   // a pseudo-sentence is new as a whole, not a variant of the msrc line
                  if (similarPrev) {
                    const wordSegs = diffWords(similarPrev, line.text);
                    return (
                      <div key={i} style={{ borderLeft: '2px solid #a6e3a1', paddingLeft: 4, marginLeft: -4 }}>
                        {wordSegs.map((seg, j) => (
                          <MarkupLine key={j} text={seg.text}
                            baseStyle={seg.added ? { color: '#a6e3a1', fontWeight: 700, background: 'rgba(166,227,161,0.18)' } : undefined}
                            onIdClick={onIdClick} />
                        ))}
                      </div>
                    );
                  }
                  return (
                    <div key={i} style={{ background: 'rgba(166,227,161,0.12)', borderLeft: '2px solid #a6e3a1', paddingLeft: 4, marginLeft: -4 }}>
                      <MarkupLine text={line.text || ' '} baseStyle={{ color: '#a6e3a1', fontWeight: 600 }} onIdClick={onIdClick} />
                    </div>
                  );
                })
            }
          </pre>
        </>
      ) : tab === 'xml' && step.stepType === 'markup' ? (
        <pre style={PRE_STYLE}>
          {!pretty
            ? <span style={{ color: 'var(--text)', opacity: 0.55 }}>(no output)</span>
            : pretty.split('\n').map((line, i) => (
                <div key={i}><MarkupLine text={line} baseStyle={isPseudoLine(line) ? PSEUDO_ENTITY : (prevOutput == null ? PSEUDO_ENTITY : undefined)} onIdClick={onIdClick} /></div>
              ))
          }
        </pre>
      ) : tab === 'xml' ? (
        <pre style={PRE_STYLE}>
          {pretty || <span style={{ color: 'var(--text)', opacity: 0.55 }}>(no output)</span>}
        </pre>
      ) : null}

      {tab === 'sentences' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--text)', opacity: 0.8, paddingLeft: 2 }}>
            {[
              { color: ROLE_COLORS.regulator, label: 'Regulator' },
              { color: ROLE_COLORS.target,    label: 'Target' },
              { color: ROLE_COLORS.both,      label: 'Non-directional' },
              { color: ENTITY_COLOR,          label: 'Entity (no role)' },
            ].map(({ color, label }) => (
              <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color }} />
                {label}
              </span>
            ))}
          </div>
          {/* one sentence: its relation(s) on the lines after the legend, one per line; several sentences: each one's relation(s) above its text */}
          {sentences.length === 1 && sentences[0].rels?.length > 0 && <div style={{ paddingLeft: 2 }}><RelationNames rels={sentences[0].rels} /></div>}
          {sentences.map((s, i) => (
            <div key={i} style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '8px 12px',
            }}>
              {sentences.length > 1 && s.rels?.length > 0 && <div style={{ marginBottom: 4 }}><RelationNames rels={s.rels} /></div>}
              <ColoredSentence msrc={s.msrc} entityRoles={s.entityRoles} onIdClick={onIdClick} />
            </div>
          ))}
        </div>
      )}

      {tab === 'stderr' && (
        <pre style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '10px 12px',
          fontSize: 11,
          lineHeight: 1.5,
          maxHeight: 300,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          color: 'var(--text)', opacity: 0.55,
          margin: 0,
        }}>
          {step.stderr}
        </pre>
      )}
      {tab === 'cmd' && step.cmd && (
        <pre style={{
          background: 'var(--bg2)',
          borderRadius: 'var(--radius)',
          padding: '10px 12px',
          fontSize: 11,
          lineHeight: 1.5,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: 'var(--text)',
          margin: 0,
        }}>
          {step.cmd}
        </pre>
      )}
    </div>
  );
}

// ── CartridgeAccordion — Level-1 result per cartridge (All Cartridges mode) ───
function CartridgeAccordion({ cart, result, drill, onBreak, onIdClick, onSuggest, urnMap }) {
  const [open, setOpen]   = useState(false);
  const [tab, setTab]     = useState('sentences');

  // Every pattern library returns its own XML document: parse them one by one (joined, they are not well-formed XML)
  // and merge sentences that several libraries found.
  const sentences = (() => {
    const merged = new Map();
    for (const p of (result?.rnefParts || [])) {
      for (const s of extractRnefSentencesWithRoles(p.xml, urnMap)) {
        const ex = merged.get(s.msrc);
        if (!ex) { merged.set(s.msrc, { ...s, entityRoles: new Map(s.entityRoles), rels: [...(s.rels || [])] }); continue; }
        for (const r of s.rels || []) if (!ex.rels.some(x => x.key === r.key)) ex.rels.push(r);
        for (const [eid, role] of s.entityRoles) {
          const prev = ex.entityRoles.get(eid);
          ex.entityRoles.set(eid, prev && prev !== role ? 'both' : role);
        }
      }
    }
    return [...merged.values()];
  })();
  const hasRelations = sentences.length > 0;

  const isDone    = result?.status === 'done';
  const isRunning = result?.status === 'running';
  const isError   = result?.status === 'error';

  // Level-2: markup/pattern step split
  const drillSteps   = drill?.steps || [];
  const markupSteps  = drillSteps.filter(s => s.stepType === 'markup');
  const patternSteps = drillSteps.filter(s => s.stepType === 'pattern');
  const matchedPats  = patternSteps.filter(s => s.status === 'done' &&  hasRnefContent(s.output));
  const pendingPats  = patternSteps.filter(s => s.status !== 'done');
  const emptyPats    = patternSteps.filter(s => s.status === 'done' && !hasRnefContent(s.output));
  const inputs       = { csout: drillSteps.find(x => x.name === 'conceptscan')?.output || '', msout: msoutOf(drillSteps) };   // what "Open pattern" runs the patterns on

  const PRE = {
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
    padding: '10px 12px', fontSize: 11, lineHeight: 1.5, maxHeight: 360,
    overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text)', margin: 0,
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      {/* ── Level-1 header ── */}
      <div onClick={() => isDone && setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', padding: '8px 14px', cursor: isDone ? 'pointer' : 'default',
                 background: 'var(--surface-dim)', userSelect: 'none', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          {cart.name}
          {isRunning && <span className="spinner" style={{ marginLeft: 6 }} />}
          {isDone && (
            <span style={{ color: hasRelations ? 'var(--success)' : 'var(--muted)', marginLeft: 6, fontSize: 11 }}>
              {hasRelations ? `✓ ${sentences.length} match${sentences.length !== 1 ? 'es' : ''}` : '✓ no matches'}
            </span>
          )}
          {isError && <span style={{ color: 'var(--danger)', marginLeft: 6, fontSize: 11 }}>✗ error</span>}
        </span>
        {isDone && <span style={{ color: 'var(--text)', opacity: 0.55, fontSize: 12 }}>{open ? '▲' : '▼'}</span>}
      </div>

      {/* ── Level-1 body: tabs for this cartridge's full-run result ── */}
      {open && isDone && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)' }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {sentences.length > 0 && (
              <button className={`btn btn-sm ${tab === 'sentences' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('sentences')}>
                Sentences ({sentences.length})
              </button>
            )}
            <button className={`btn btn-sm ${tab === 'markup' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('markup')}>
              Markup XML
            </button>
            {(result?.rnefParts || []).some(p => p.xml) && (
              <button className={`btn btn-sm ${tab === 'rnef' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('rnef')}>
                Relations XML
              </button>
            )}
            <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} title="Ask the LLM for a pattern that extracts a relation from this sentence"
              onClick={() => onSuggest(cart, result.finalMarkupXml)}>✨ Suggest pattern</button>
            <button className="btn btn-secondary btn-sm" title="Open the folder with the logs (command, exit code, stderr, stdout of every step) of the last pipeline run of this cartridge"
              onClick={async () => { const r = await window.api.pipeline.openLogs(cart.path); if (r && r.empty) alert('No logs yet — run the pipeline first.'); }}>📄 Open logs</button>
            {result?.allStderr && (
              <button className={`btn btn-sm ${tab === 'stderr' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('stderr')}>
                Stderr
              </button>
            )}
          </div>

          {tab === 'sentences' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sentences.length === 0
                ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>No relations found.</span>
                : sentences.map((s, i) => (
                    <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 12px' }}>
                      {s.rels?.length > 0 && <div style={{ marginBottom: 4 }}><RelationNames rels={s.rels} /></div>}
                      <ColoredSentence msrc={s.msrc} entityRoles={s.entityRoles} onIdClick={onIdClick} />
                    </div>
                  ))
              }
            </div>
          )}
          {tab === 'markup' && (
            <pre style={PRE}>
              {prettyXml(result.finalMarkupXml) || <span style={{ opacity: 0.55 }}>(no output)</span>}
            </pre>
          )}
          {tab === 'rnef' && (
            <pre style={PRE}>
              {(result.rnefParts || []).filter(p => p.xml).map(p =>
                `<!-- ${p.folder || p.name} -->\n${prettyXml(p.xml)}`
              ).join('\n\n') || <span style={{ opacity: 0.55 }}>(no output)</span>}
            </pre>
          )}
          {tab === 'stderr' && (
            <pre style={{ ...PRE, color: 'var(--text)', opacity: 0.55 }}>{result.allStderr}</pre>
          )}

          {/* ── Break into steps button ── */}
          {!drill && (
            <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }}
              onClick={() => onBreak(cart)}>
              Break into steps ▶
            </button>
          )}

          {/* ── Level-2: per-component pipeline steps ── */}
          {drill && (
            <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', opacity: 0.55, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Pipeline Components
              </div>
              {drill.running && <div className="flex items-center gap-8"><span className="spinner" /><span className="text-muted text-sm">Running…</span></div>}

              {markupSteps.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', opacity: 0.45, marginBottom: 6, textTransform: 'uppercase' }}>Sentence Markup</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {markupSteps.map((step, idx) => (
                      <StepAccordion key={step.name} step={step}
                        prevOutput={idx > 0 ? markupSteps[idx - 1].output : null}
                        expanded={!!(drill.expanded || {})[step.name]}
                        onToggle={() => onBreak({ ...cart, __toggleStep: step.name })}
                        onIdClick={onIdClick} urnMap={urnMap} />
                    ))}
                  </div>
                </div>
              )}

              {patternSteps.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', opacity: 0.45, marginBottom: 6, textTransform: 'uppercase' }}>Pattern Libraries</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {matchedPats.map(step => (
                      <StepAccordion key={step.name} step={step}
                        expanded={!!(drill.expanded || {})[step.name]}
                        onToggle={() => onBreak({ ...cart, __toggleStep: step.name })}
                        onIdClick={onIdClick} urnMap={urnMap} cartPath={cart.path} inputs={inputs} />
                    ))}
                    {pendingPats.map(step => (
                      <StepAccordion key={step.name} step={step}
                        expanded={!!(drill.expanded || {})[step.name]}
                        onToggle={() => onBreak({ ...cart, __toggleStep: step.name })}
                        onIdClick={onIdClick} urnMap={urnMap} cartPath={cart.path} inputs={inputs} />
                    ))}
                    {emptyPats.length > 0 && (
                      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 14px', fontSize: 12, color: 'var(--text)', opacity: 0.55 }}>
                        <strong style={{ color: 'var(--text-dim)' }}>{emptyPats.map(s => s.folder || s.name).join(', ')}</strong>
                        {' '}— no relations found
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main PipelineScreen ────────────────────────────────────────────────────────
export default function PipelineScreen({ onEditRecord }) {
  const [mode, setMode]                       = useState('single'); // 'single' | 'all'
  const [cartridges, setCartridges]           = useState([]);
  const [selectedCartridge, setSelectedCartridge] = useState(null);
  const [organism, setOrganism]               = useState('Mammal');
  const [userDict, setUserDict]               = useState('');
  const [sentence, setSentence]               = useState('');
  // ── Single-cartridge state ──
  const [running, setRunning]                 = useState(false);
  const [steps, setSteps]                     = useState([]);
  const [expanded, setExpanded]               = useState({});
  const [globalError, setGlobalError]         = useState('');
  const [urnMap, setUrnMap]                   = useState(new Map());
  // ── All-cartridges state ──
  const [allRunning, setAllRunning]           = useState(false);
  const [cartResults, setCartResults]         = useState({}); // { [name]: { status, finalMarkupXml, rnefParts, allStderr } }
  const [drillMap, setDrillMap]               = useState({}); // { [name]: { running, steps, expanded } }
  const [allUrnMap, setAllUrnMap]             = useState(new Map());
  // ── Suggest pattern (LLM) ──
  const [ranCart, setRanCart]               = useState(null); // the cartridge of the pipeline run on screen
  const [suggestFor, setSuggestFor]           = useState(null); // { cart, markup } → relation/node-type dialog
  const [suggestWizard, setSuggestWizard]     = useState(null); // { cart, relation, regulator, target, pattern } → wizard at step 4

  const unsubRef     = useRef(null);
  const unsubAllRef  = useRef(null);
  const drillCartRef = useRef(null); // cart currently drilling

  // Load cartridges + settings on mount
  useEffect(() => {
    window.api.medscan.listCartridges().then(carts => {
      setCartridges(carts);
      if (carts.length > 0) setSelectedCartridge(carts[0]);
      warmMacros(carts, carts[0]);
    });
    window.api.settings.get().then(s => {
      if (s.userDict) setUserDict(s.userDict);
    });
  }, []);

  // Load URN map for single-cartridge mode
  useEffect(() => {
    if (!selectedCartridge) return;
    window.api.pipeline.getUrnEntries({ cartridgePath: selectedCartridge.path })
      .then(entries => setUrnMap(new Map(entries)))
      .catch(() => setUrnMap(new Map()));
  }, [selectedCartridge]);

  // Load combined URN map when switching to All mode (use first cartridge's URN map as proxy)
  useEffect(() => {
    if (mode !== 'all' || cartridges.length === 0) return;
    window.api.pipeline.getUrnEntries({ cartridgePath: cartridges[0].path })
      .then(entries => setAllUrnMap(new Map(entries)))
      .catch(() => setAllUrnMap(new Map()));
  }, [mode, cartridges]);

  useEffect(() => () => {
    if (unsubRef.current)    unsubRef.current();
    if (unsubAllRef.current) unsubAllRef.current();
  }, []);

  // ── Single-cartridge run ───────────────────────────────────────────────────
  const subscribeEvents = useCallback(() => {
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    const unsub = window.api.pipeline.onEvent(e => {
      if (e.type === 'step_start') {
        setSteps(prev => {
          if (prev.some(s => s.name === e.name)) return prev;
          return [...prev, { name: e.name, label: e.label, folder: e.folder, status: 'running', output: '', stderr: '', stepType: 'markup', code: null }];
        });
      } else if (e.type === 'step_done') {
        setSteps(prev => prev.map(s => s.name === e.name
          ? { ...s, status: 'done', output: e.output || '', stderr: e.stderr || '', code: e.code ?? 0, stepType: e.stepType || 'markup', cmd: e.cmd || '', llm: e.llm, ms: e.ms }
          : s
        ));
        if (e.stepType === 'pattern' || (e.code != null && e.code !== 0)) {
          setExpanded(prev => ({ ...prev, [e.name]: true }));
        }
      } else if (e.type === 'done') {
        setRunning(false);
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      } else if (e.type === 'error') {
        setGlobalError(e.message || 'Pipeline error');
        setRunning(false);
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      }
    });
    unsubRef.current = unsub;
  }, []);

  const handleRun = async (cartOverride) => {
    const runCart = cartOverride && cartOverride.path ? cartOverride : selectedCartridge;      // (a click passes an event)
    if (!sentence.trim() || !runCart) return;
    const s = await window.api.settings.get();
    if (!s.medscanLicense) { setGlobalError('No NLP license key configured in Settings.'); return; }
    setGlobalError(''); setSteps([]); setExpanded({}); setRunning(true); setRanCart(runCart);
    subscribeEvents();
    window.api.pipeline.run({
      cartridgePath: runCart.path,
      sentence:      sentence.trim(),
      organism:      organism || 'Mammal',
      license:       s.medscanLicense,
      userDict:      s.userDict || userDict || '',
    });
  };

  const toggleStep = (name) => setExpanded(prev => ({ ...prev, [name]: !prev[name] }));

  // ── All-cartridges run ─────────────────────────────────────────────────────
  const handleRunAll = async () => {
    if (!sentence.trim() || cartridges.length === 0) return;
    const s = await window.api.settings.get();
    if (!s.medscanLicense) { setGlobalError('No NLP license key configured in Settings.'); return; }
    setGlobalError('');
    setDrillMap({});
    // Mark all carts as pending
    const initial = {};
    for (const c of cartridges) initial[c.name] = { status: 'running' };
    setCartResults(initial);
    setAllRunning(true);

    if (unsubAllRef.current) { unsubAllRef.current(); unsubAllRef.current = null; }
    const unsub = window.api.pipeline.onAllEvent(e => {
      if (e.type === 'cart_done') {
        setCartResults(prev => ({
          ...prev,
          [e.cartName]: {
            status: e.error ? 'error' : 'done',
            finalMarkupXml: e.finalMarkupXml || '',
            rnefParts:      e.rnefParts      || [],
            allStderr:      e.allStderr      || '',
          },
        }));
      } else if (e.type === 'all_done') {
        setAllRunning(false);
        if (unsubAllRef.current) { unsubAllRef.current(); unsubAllRef.current = null; }
      }
    });
    unsubAllRef.current = unsub;

    window.api.pipeline.runAll({
      cartridges,
      sentence:  sentence.trim(),
      organism:  organism || 'Mammal',
      license:   s.medscanLicense,
      userDict:  s.userDict || userDict || '',
    });
  };

  // ── Drill-down handler for a single cartridge (Level 2) ────────────────────
  // When __toggleStep is set, just toggle the step's expand state.
  const handleBreak = async (cart) => {
    if (cart.__toggleStep) {
      const stepName = cart.__toggleStep;
      const cartName = cart.name;
      setDrillMap(prev => ({
        ...prev,
        [cartName]: {
          ...prev[cartName],
          expanded: {
            ...(prev[cartName]?.expanded || {}),
            [stepName]: !(prev[cartName]?.expanded || {})[stepName],
          },
        },
      }));
      return;
    }

    const cartName = cart.name;
    // Don't restart if already drilling or done
    if (drillMap[cartName]?.steps?.length > 0) return;

    const s = await window.api.settings.get();
    drillCartRef.current = cartName;
    setDrillMap(prev => ({ ...prev, [cartName]: { running: true, steps: [], expanded: {} } }));

    // Subscribe to pipeline:event for this drill-down
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    const unsub = window.api.pipeline.onEvent(e => {
      const cn = drillCartRef.current;
      if (!cn) return;
      if (e.type === 'step_start') {
        setDrillMap(prev => {
          const d = prev[cn] || { running: true, steps: [], expanded: {} };
          if (d.steps.some(st => st.name === e.name)) return prev;
          return { ...prev, [cn]: { ...d, steps: [...d.steps, { name: e.name, label: e.label, folder: e.folder, status: 'running', output: '', stderr: '', stepType: 'markup', code: null }] } };
        });
      } else if (e.type === 'step_done') {
        setDrillMap(prev => {
          const d = prev[cn] || { running: true, steps: [], expanded: {} };
          const steps = d.steps.map(st => st.name === e.name
            ? { ...st, status: 'done', output: e.output || '', stderr: e.stderr || '', code: e.code ?? 0, stepType: e.stepType || 'markup', cmd: e.cmd || '', llm: e.llm, ms: e.ms }
            : st
          );
          const newExp = (e.stepType === 'pattern' || (e.code != null && e.code !== 0))
            ? { ...(d.expanded || {}), [e.name]: true }
            : d.expanded;
          return { ...prev, [cn]: { ...d, steps, expanded: newExp } };
        });
      } else if (e.type === 'done' || e.type === 'error') {
        setDrillMap(prev => ({ ...prev, [cn]: { ...(prev[cn] || {}), running: false } }));
        drillCartRef.current = null;
        if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
      }
    });
    unsubRef.current = unsub;

    window.api.pipeline.run({
      cartridgePath: cart.path,
      sentence:      sentence.trim(),
      organism:      organism || 'Mammal',
      license:       s.medscanLicense,
      userDict:      s.userDict || userDict || '',
    });
  };

  const markupSteps     = steps.filter(s => s.stepType === 'markup');
  const patternSteps    = steps.filter(s => s.stepType === 'pattern');
  const matchedPatterns = patternSteps.filter(s => s.status === 'done' &&  hasRnefContent(s.output));
  const pendingPatterns = patternSteps.filter(s => s.status !== 'done');
  const emptyPatterns   = patternSteps.filter(s => s.status === 'done' && !hasRnefContent(s.output));

  const SECTION_LABEL = { fontSize: 12, fontWeight: 600, color: 'var(--text)', opacity: 0.55, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' };

  return (
    <div className="screen-root" style={{ padding: '20px 24px', maxWidth: 900 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>NLP Pipeline</h2>

      {/* ── Mode switcher ── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20 }}>
        <button className={`btn btn-sm ${mode === 'single' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('single')}>
          Single Cartridge
        </button>
        <button className={`btn btn-sm ${mode === 'all' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('all')}>
          All Cartridges
        </button>
      </div>

      {/* ── Controls ── */}
      <div style={{ display: 'grid', gridTemplateColumns: mode === 'single' ? '1fr 1fr' : '1fr', gap: 16, marginBottom: 16 }}>
        {mode === 'single' && (
          <div>
            <label className="form-label">Cartridge</label>
            <select
              className="form-control"
              value={selectedCartridge?.path || ''}
              onChange={e => setSelectedCartridge(cartridges.find(c => c.path === e.target.value) || null)}
            >
              {cartridges.length === 0 && <option value="">No cartridges found</option>}
              {cartridges.map(c => <option key={c.path} value={c.path}>{c.name}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="form-label">Organism</label>
          <input
            className="form-control"
            value={organism}
            onChange={e => setOrganism(e.target.value)}
            placeholder="e.g. Mammal, Human"
          />
        </div>
      </div>


      <div style={{ marginBottom: 12 }}>
        <label className="form-label">Test sentence</label>
        <textarea
          className="form-control"
          rows={3}
          value={sentence}
          onChange={e => setSentence(e.target.value)}
          placeholder="Paste a sentence to run through the pipeline…"
          style={{ fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }}
          onKeyDown={e => { if (e.ctrlKey && e.key === 'Enter') mode === 'single' ? handleRun() : handleRunAll(); }}
        />
        <div className="text-xs text-muted mt-4">Ctrl+Enter to run</div>
      </div>

      {mode === 'single' ? (
        <button className="btn btn-primary" onClick={handleRun}
          disabled={running || !sentence.trim() || !selectedCartridge} style={{ marginBottom: 20 }}>
          {running ? <><span className="spinner" style={{ marginRight: 6 }} />Running…</> : '▶ Run Pipeline'}
        </button>
      ) : (
        <button className="btn btn-primary" onClick={handleRunAll}
          disabled={allRunning || !sentence.trim() || cartridges.length === 0} style={{ marginBottom: 20 }}>
          {allRunning
            ? <><span className="spinner" style={{ marginRight: 6 }} />Running {cartridges.length} cartridge{cartridges.length !== 1 ? 's' : ''}…</>
            : `▶ Run All Cartridges (${cartridges.length})`}
        </button>
      )}

      {globalError && (
        <div style={{ color: 'var(--danger)', marginBottom: 16, fontSize: 13 }}>{globalError}</div>
      )}

      {/* ── Single-cartridge results ── */}
      {mode === 'single' && steps.length > 0 && (
        <>
          {markupSteps.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={SECTION_LABEL}>Sentence Markup</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {markupSteps.map((step, idx) => (
                  <StepAccordion key={step.name} step={step}
                    prevOutput={idx > 0 ? markupSteps[idx - 1].output : null}
                    expanded={!!expanded[step.name]} onToggle={() => toggleStep(step.name)}
                    onIdClick={onEditRecord} urnMap={urnMap} />
                ))}
              </div>
            </div>
          )}
          {patternSteps.length > 0 && (
            <div>
              <div style={SECTION_LABEL}>Pattern Libraries</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {matchedPatterns.map(step => (
                  <StepAccordion key={step.name} step={step} expanded={!!expanded[step.name]} onToggle={() => toggleStep(step.name)} onIdClick={onEditRecord} urnMap={urnMap} cartPath={selectedCartridge?.path} inputs={{ csout: steps.find(x => x.name === 'conceptscan')?.output || '', msout: msoutOf(steps) }} />
                ))}
                {pendingPatterns.map(step => (
                  <StepAccordion key={step.name} step={step} expanded={!!expanded[step.name]} onToggle={() => toggleStep(step.name)} onIdClick={onEditRecord} urnMap={urnMap} cartPath={selectedCartridge?.path} inputs={{ csout: steps.find(x => x.name === 'conceptscan')?.output || '', msout: msoutOf(steps) }} />
                ))}
                {emptyPatterns.length > 0 && (
                  <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '8px 14px', fontSize: 12, color: 'var(--text)', opacity: 0.55 }}>
                    <strong style={{ color: 'var(--text-dim)' }}>{emptyPatterns.map(s => s.folder || s.name).join(', ')}</strong>
                    {' '}— no relations found
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {mode === 'single' && !running && selectedCartridge && steps.some(s => s.name === 'conceptscan') && (
        <button className="btn btn-secondary btn-sm" style={{ marginTop: 14 }}
          onClick={() => setSuggestFor({ cart: selectedCartridge, markup: steps.find(s => s.name === 'conceptscan')?.output || '', prev: markupSteps.length > 1 ? markupSteps[markupSteps.length - 2].output : undefined })}>
          ✨ Suggest pattern
        </button>
      )}

      {mode === 'single' && !running && selectedCartridge && (
        <button className="btn btn-secondary btn-sm" style={{ marginTop: 14, marginLeft: 8 }} title="Open the folder with the logs (command, exit code, stderr, stdout of every step) of the last pipeline run of this cartridge"
          onClick={async () => { const r = await window.api.pipeline.openLogs(selectedCartridge.path); if (r && r.empty) alert('No logs yet — run the pipeline first.'); }}>
          📄 Open logs
        </button>
      )}

      {suggestFor && (
        <SuggestPatternModal key={suggestFor.cart.path} cart={suggestFor.cart} sentence={sentence.trim()} markup={suggestFor.markup}
          markupView={<GreenMarkup text={suggestFor.markup} />}
          runOpts={{ organism: organism || 'Mammal', userDict }}
          preset={suggestFor.preset}
          pipelineCart={ranCart}
          extractedRels={steps.filter(st => st.stepType === 'pattern' && st.output).flatMap(st => extractRnefSentencesWithRoles(st.output, urnMap).flatMap(x => (x.rels || []).map(rl => ({ ...rl, folder: st.name }))))}
          onRunWith={(c0) => { const c = cartridges.find(x => String(x.path).toLowerCase() === String(c0.path).toLowerCase()) || c0; setSuggestFor(null); setSelectedCartridge(c); handleRun(c); }}
          onSwitchCartridge={(c, m, preset) => setSuggestFor({ cart: cartridges.find(x => String(x.path).toLowerCase() === String(c.path).toLowerCase()) || c, markup: m, preset })}
          onClose={() => setSuggestFor(null)}
          wizardOpen={!!suggestWizard}
          onResult={(list, fails) => setSuggestWizard({ cart: suggestFor.cart, queue: list, total: list.length, fails: fails || [] })} />
      )}
      {suggestWizard && suggestWizard.queue.length > 0 && (
        <RelationWizard key={suggestWizard.total - suggestWizard.queue.length} cartridges={cartridges} initialCartridge={(() => { const m = suggestWizard.queue[0].moveTo; return m ? (cartridges.find(c => String(c.path).toLowerCase() === String(m.path).toLowerCase()) || m) : suggestWizard.cart; })()}
          suggest={{ ...suggestWizard.queue[0], sentence: sentence.trim(), queueInfo: suggestWizard.total > 1 ? `Pattern ${suggestWizard.total - suggestWizard.queue.length + 1} of ${suggestWizard.total}` : '', fails: suggestWizard.fails }}
          onClose={() => setSuggestWizard(w => (w.queue.length > 1 ? { ...w, queue: w.queue.slice(1) } : null))} />
      )}

      {/* ── All-cartridges results (Level 1 + Level 2) ── */}
      {mode === 'all' && Object.keys(cartResults).length > 0 && (
        <div>
          <div style={SECTION_LABEL}>Cartridge Results</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {cartridges.map(cart => (
              <CartridgeAccordion
                key={cart.name}
                cart={cart}
                result={cartResults[cart.name]}
                drill={drillMap[cart.name] || null}
                onBreak={handleBreak}
                onIdClick={onEditRecord}
                onSuggest={(c, m) => setSuggestFor({ cart: c, markup: m, prev: ((drillMap[c.name]?.steps || []).filter(x => x.stepType === 'markup').slice(-2)[0] || {}).output })}
                urnMap={allUrnMap}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ConceptScan markup, every line in the "added by this step" green (Suggest pattern dialog) ──
function GreenMarkup({ text }) {
  const lines = String(text || '').split(String.fromCharCode(10)).filter(l => l.trim());
  return (
    <pre style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 12px', fontSize: 11,
                  lineHeight: 1.5, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>
      {lines.length === 0 ? <span style={{ opacity: 0.55 }}>(no ConceptScan output)</span>
        : lines.map((l, i) => (
          <div key={i}>{l.split(/(ID[{][^}]*[}])/).map((t, j) => /^ID[{]/.test(t)
            ? <span key={j} style={{ color: '#a6e3a1', fontWeight: 700 }}>{t}</span> : <span key={j}>{t}</span>)}</div>
        ))}
    </pre>
  );
}

// ── Accordion row ──────────────────────────────────────────────────────────────
function StepAccordion({ step, prevOutput, expanded, onToggle, onIdClick, urnMap, cartPath, inputs }) {
  const sentenceCount = step.stepType === 'pattern' ? extractRnefSentencesWithRoles(step.output, urnMap).length : 0;
  const [used, setUsed] = useState(null);       // result of relation.findUsed → read-only dialog
  const [finding, setFinding] = useState(false);
  const openPattern = async () => {
    setFinding(true);
    try { const r = await window.api.relation.findUsed({ cartPath, outputName: step.name, csout: inputs?.csout || '', msout: inputs?.msout || '', xml: step.output }); setUsed(r); }
    catch (e) { setUsed({ ok: false, error: e.message }); }
    setFinding(false);
  };

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      overflow: 'hidden',
    }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 14px',
          cursor: 'pointer',
          background: 'var(--surface-dim)',
          userSelect: 'none',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          {step.label}
          <StatusBadge status={step.status} code={step.code} />
        </span>
        {step.status === 'done' && step.stepType === 'pattern' && (
          <span style={{ fontSize: 11, color: sentenceCount > 0 ? 'var(--success)' : 'var(--muted)' }}>
            {sentenceCount > 0 ? `${sentenceCount} match${sentenceCount !== 1 ? 'es' : ''}` : 'no matches'}
          </span>
        )}
        {step.status === 'done' && (
          <span style={{ fontSize: 11, color: 'var(--text)', opacity: 0.55 }}>
            {step.output ? `${(step.output.length / 1024).toFixed(1)} KB` : '0 B'}{step.ms !== undefined && `  ·  ${fmtElapsed(step.ms)}`}
          </span>
        )}
        <span style={{ color: 'var(--text)', opacity: 0.55, fontSize: 12 }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && step.status !== 'running' && (
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)' }}>
          <StepOutput step={step} prevOutput={prevOutput} onIdClick={onIdClick} urnMap={urnMap} extra={cartPath && step.stepType === 'pattern' && sentenceCount > 0 ? (
            <button className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} disabled={finding} onClick={openPattern}
              title="Find the pattern of this folder that extracted the relation (searches its rule files with the pipeline input)">{finding ? 'Searching…' : '🔍 Open pattern'}</button>
          ) : null} />
        </div>
      )}
      {used && <UsedPatternsDialog res={used} cartPath={cartPath} folder={step.name} onClose={() => setUsed(null)} />}
    </div>
  );
}

