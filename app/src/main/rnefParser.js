'use strict';
/**
 * Fast streaming RNEF reader for the Results Viewer.
 *
 * The old viewer sent the whole file to the renderer and parsed it with DOMParser, which means a
 * 200 MB document tree (GBs of memory, minutes of CPU) plus several querySelectorAll() calls per
 * <resnet>. This parser instead:
 *   • reads the file in chunks (never holds the whole file),
 *   • cuts out each complete <resnet>…</resnet> block,
 *   • walks its tags with a single regex pass (no DOM),
 *   • yields to the event loop between chunks so the app stays responsive,
 *   • returns compact relation rows; the coloured sentence segments are built lazily in the
 *     renderer for the rows that are actually displayed.
 */
const fs = require('fs');

// Decode XML entities in attribute values (the DOM did this for us before)
function decodeXml(s) {
  if (!s || s.indexOf('&') === -1) return s || '';
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(cp); } catch { return m; }
      }
    }
  });
}

// URL-encoding that Elsevier NLP uses in URN attributes
const decodeUrn = (s) => (s || '')
  .replace(/%20/g, ' ').replace(/%2c/gi, ',')
  .replace(/%28/gi, '(').replace(/%29/gi, ')')
  .replace(/%3a/gi, ':').replace(/%2f/gi, '/');

function doiFromTextRef(t) { const m = t && t.match(/^info:doi\/([^#\s]+)/i);  return m ? m[1] : ''; }
function pmidFromTextRef(t) { const m = t && t.match(/^info:pmid\/([^#\s]+)/i); return m ? m[1] : ''; }

// <tag attr="v" …>, </tag>, <tag … /> — attribute values may contain '>' so quoted strings are skipped whole
const TAG_RE  = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR_RE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(text) {
  const out = {};
  if (!text) return out;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(text)) !== null) out[m[1]] = decodeXml(m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/** Parse one complete <resnet>…</resnet> block and push its relation rows. */
function parseResnet(block, getId, relations) {
  const nodeMap = {};
  let resnetMsrc = '';
  let curNode = null;       // node being read
  let curControl = null;    // control being read

  const finishControl = (ctl) => {
    const inLinks    = ctl.links.filter(l => l.type === 'in');
    const outLinks   = ctl.links.filter(l => l.type === 'out');
    const inOutLinks = ctl.links.filter(l => l.type === 'in-out');
    const isDirect   = inLinks.length > 0 || outLinks.length > 0;

    let nodeA, nodeB;
    if (isDirect) {
      nodeA = nodeMap[inLinks[0] && inLinks[0].ref]  || null;
      nodeB = nodeMap[outLinks[0] && outLinks[0].ref] || null;
    } else {
      const nodes = inOutLinks.map(l => nodeMap[l.ref]).filter(Boolean);
      nodes.sort((a, b) => a.name.localeCompare(b.name));
      nodeA = nodes[0]; nodeB = nodes[1];
    }

    const msrcByIdx = ctl.msrcByIdx;
    if (resnetMsrc && Object.keys(msrcByIdx).length === 0) msrcByIdx['1'] = resnetMsrc;

    const base = {
      type: ctl.controlType, isDirect,
      node1: nodeA ? nodeA.name : '', node1Type: nodeA ? nodeA.nodeType : '',
      node1Urn: nodeA ? nodeA.urn : '', node1Ids: nodeA ? nodeA.ids : [],
      node2: nodeB ? nodeB.name : '', node2Type: nodeB ? nodeB.nodeType : '',
      node2Urn: nodeB ? nodeB.urn : '', node2Ids: nodeB ? nodeB.ids : [],
    };
    const indices = Object.keys(msrcByIdx).sort((a, b) => Number(a) - Number(b));
    if (indices.length === 0) {
      relations.push({ ...base, doi: '', pmid: '', msrc: '' });
    } else {
      for (const idx of indices) {
        const textRef = ctl.textRefByIdx[idx] || '';
        relations.push({
          ...base,
          doi:  ctl.doiByIdx[idx]  || doiFromTextRef(textRef),
          pmid: ctl.pmidByIdx[idx] || pmidFromTextRef(textRef),
          msrc: msrcByIdx[idx] || '',
        });
      }
    }
  };

  TAG_RE.lastIndex = 0;
  let t;
  while ((t = TAG_RE.exec(block)) !== null) {
    const closing = t[1] === '/', name = t[2], selfClose = t[4] === '/';
    if (closing) {
      if (name === 'node' && curNode) { nodeMap[curNode.localId] = curNode.rec; curNode = null; }
      else if (name === 'control' && curControl) { finishControl(curControl); curControl = null; }
      continue;
    }
    if (name === 'resnet') {
      resnetMsrc = parseAttrs(t[3]).msrc || '';
    } else if (name === 'node') {
      const a = parseAttrs(t[3]);
      const urn = decodeUrn(a.urn || '');
      const id  = urn ? getId(urn) : null;
      curNode = { localId: a.local_id || '', rec: { name: '', nodeType: '', urn, ids: id ? [id] : [] } };
      if (selfClose) { nodeMap[curNode.localId] = curNode.rec; curNode = null; }
    } else if (name === 'control') {
      curControl = { links: [], controlType: '', msrcByIdx: {}, doiByIdx: {}, pmidByIdx: {}, textRefByIdx: {} };
      if (selfClose) { finishControl(curControl); curControl = null; }
    } else if (name === 'link' && curControl) {
      const a = parseAttrs(t[3]);
      curControl.links.push({ type: a.type || '', ref: a.ref || '' });
    } else if (name === 'attr') {
      if (curNode) {
        const a = parseAttrs(t[3]);
        if (a.name === 'Name')     curNode.rec.name = a.value || '';
        if (a.name === 'NodeType') curNode.rec.nodeType = a.value || '';
      } else if (curControl) {
        const a = parseAttrs(t[3]);
        const n = a.name || '', v = a.value || '', idx = a.index || '';
        if (n === 'ControlType' && !idx) curControl.controlType = v;
        else if (n === 'msrc' && idx)    curControl.msrcByIdx[idx] = v;
        else if (n === 'DOI')            curControl.doiByIdx[idx || '1'] = v;
        else if (n === 'PMID')           curControl.pmidByIdx[idx || '1'] = v;
        else if (n === 'TextRef')        curControl.textRefByIdx[idx || '1'] = v;
      }
    }
  }
}

/**
 * @param {string}   filePath
 * @param {(urn:string)=>string|null} getId  URN → NLP ID lookup (e.g. urnMap.get)
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<object[]>} relation rows (no sentence segments)
 */
async function parseRnefFile(filePath, getId, onProgress) {
  const total = fs.statSync(filePath).size;
  const relations = [];
  let buf = '';
  let read = 0;
  let lastReport = 0;

  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 8 * 1024 * 1024 });
  for await (const chunk of stream) {
    read += Buffer.byteLength(chunk, 'utf8');
    buf += chunk;
    let from = 0, incompleteStart = -1;
    for (;;) {
      let s = buf.indexOf('<resnet', from);
      // must be '<resnet ' or '<resnet>' (not another element name starting with "resnet")
      while (s !== -1 && !/[\s>\/]/.test(buf.charAt(s + 7) || ' ')) s = buf.indexOf('<resnet', s + 7);
      if (s === -1) break;
      const e = buf.indexOf('</resnet>', s);
      if (e === -1) { incompleteStart = s; break; }   // block continues in the next chunk
      parseResnet(buf.slice(s, e + 9), getId, relations);
      from = e + 9;
    }
    // keep only the unprocessed tail (an incomplete block, or a possible partial "<resnet" token)
    buf = incompleteStart >= 0 ? buf.slice(incompleteStart) : buf.slice(Math.max(from, buf.length - 16));
    if (onProgress && read - lastReport > 16 * 1024 * 1024) { lastReport = read; onProgress(read, total); }
    await new Promise(r => setImmediate(r));    // let the main process breathe
  }
  if (onProgress) onProgress(total, total);
  return relations;
}

module.exports = { parseRnefFile };
