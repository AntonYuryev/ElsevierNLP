'use strict';
/**
 * SciBite CENtree connector (main process).
 *
 * Settings (electron-store): centreeUrl (base URL of the CENtree server), centreeToken (Bearer token),
 * centreeApiPrefix (default '/api'), centreeTimeoutSec (default 30), centreeInsecureTls (bool).
 *
 * Auth: a pasted Bearer token (centreeToken) or centreeUser/centreePassword (POST /api/authenticate; the JWT is cached
 * in memory and renewed once on a 401). Without a token the data endpoints answer 200 with an empty body.
 */
const ENDPOINTS = {            // verified against https://psgcentree.lifesciencepsg.com/v3/api-docs
  login:       () => '/authenticate',                                                    // POST {username,password} -> {id_token}
  ping:        () => '/ontologies',
  ontologies:  () => '/ontologies',
  ontology:    (id) => `/ontologies/${encodeURIComponent(id)}`,
  classById:   (ontology, classId) => `/ontologies/${encodeURIComponent(ontology)}/classes/${encodeURIComponent(classId)}`,
  classByPrimaryId: (ontology) => `/ontologies/${encodeURIComponent(ontology)}/classes/query`,   // ?primaryId=
  search:      () => '/search',                                                          // ?q&ontology&from&size
  exactLabel:  (ontology) => `/search/${encodeURIComponent(ontology)}/exactLabel`,      // ?label=
};

function cfg(store) {
  const g = (k, d) => { const v = store.get(k); return v === undefined || v === '' ? d : v; };
  return {
    base:     String(g('centreeUrl', '')).replace(/\/+$/, ''),
    token:    String(g('centreeToken', '')),
    prefix:   '/' + String(g('centreeApiPrefix', '/api')).replace(/^\/+|\/+$/g, ''),
    timeout:  Math.max(1, Number(g('centreeTimeoutSec', 30)) || 30) * 1000,
    insecure: !!g('centreeInsecureTls', false),
    user:     String(g('centreeUser', '')),
    password: String(g('centreePassword', '')),
  };
}

let jwt = { key: '', token: '' };
async function login(c) {
  const res = await fetch(c.base + c.prefix + ENDPOINTS.login(), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ username: c.user, password: c.password }), signal: AbortSignal.timeout(c.timeout) });
  const text = await res.text();
  if (!res.ok) throw new Error(`CENtree login failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  const tok = JSON.parse(text).id_token;
  if (!tok) throw new Error('CENtree login returned no token');
  jwt = { key: c.base + '|' + c.user, token: tok };
  return tok;
}

async function request(store, method, path, opts = {}, retried = false) {
  const { query, body, headers: extraHeaders, raw } = opts;
  const c = cfg(store);
  if (!c.base) throw new Error('CENtree URL is not set (Settings > SciBite CENtree).');
  const url = new URL(c.base + (c.prefix === '/' ? '' : c.prefix) + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
  let bearer = c.token;
  if (!bearer && c.user && c.password) bearer = (jwt.key === c.base + '|' + c.user && jwt.token) || await login(c);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (c.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(c.timeout) });
    if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    if (res.status === 401 && !c.token && c.user && !retried) { jwt = { key: '', token: '' }; return await request(store, method, path, opts, true); }
    if (!res.ok) throw new Error(`CENtree HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (check the token)' : ''}: ${text.slice(0, 300)}`);
    if (!text) { if (!bearer) throw new Error('Empty response: CENtree needs a token or a user name and password (Settings > SciBite CENtree).'); return null; }
    try { return JSON.parse(text); } catch { return text; }        // some endpoints answer with plain text (a file name, a version tag, a report)
  } finally {
    if (c.insecure) { if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls; }
  }
}


// ── Batch import support ─────────────────────────────────────────────────────────────────────────────
const PAGE = 200;
const isoStart = (ymd) => `${ymd}T00:00:00Z`;
const arr = (x) => Array.isArray(x) ? x : (x && (x.elements || x.content)) || [];

/** all ontologies (paged with from/size): [{ id, name }] */
async function allOntologies(store, isCancelled) {
  const out = []; const seen = new Set();
  for (let from = 0; ; from += PAGE) {
    if (isCancelled()) throw new Error('Cancelled');
    const page = await request(store, 'GET', ENDPOINTS.ontologies(), { query: { from, size: PAGE } });
    const els = arr(page);
    let fresh = 0;
    for (const e of els) {
      const id = e.ontologyId || (e.ontologyMetadataJSONBean && e.ontologyMetadataJSONBean.ontologyUniqueID);
      if (!id || seen.has(id)) continue;
      seen.add(id); fresh++;
      const m = e.ontologyMetadataJSONBean || {};
      out.push({ id, name: m.ontologyShortDisplayName || m.ontologyLongDisplayName || id, loaded: e.loaded !== false });
    }
    const total = page && typeof page.total === 'number' ? page.total : null;
    if (!els.length || !fresh || (total !== null && from + PAGE >= total) || els.length < PAGE && total === null) break;
  }
  return out;
}

/** every ontology with its dates: [{ id, name, loaded, version, lastLoaded, lastModified, type, keywords }] (one paged request, no job per ontology) */
async function listOntologies(store, isCancelled = () => false) {
  const out = []; const seen = new Set();
  for (let page = 0; page < 50; page++) {
    if (isCancelled()) throw new Error('Cancelled');
    const res = await request(store, 'GET', '/search/ontologies', { query: { page, size: PAGE, populateLoadedInfo: true } });
    const els = arr(res); let fresh = 0;
    for (const e of els) {
      const id = e.ontologyId || (e.ontologyMetadataJSONBean && e.ontologyMetadataJSONBean.ontologyUniqueID);
      if (!id || seen.has(id)) continue;
      seen.add(id); fresh++;
      const m = e.ontologyMetadataJSONBean || {};
      out.push({ id, name: m.ontologyShortDisplayName || m.ontologyLongDisplayName || id, loaded: e.loaded !== false, version: e.version || m.version || '',
        lastLoaded: e.lastLoaded || '', lastModified: e.lastModified || '', type: m.ontologyType || '', keywords: m.keywords || [],
        longName: m.ontologyLongDisplayName || '', description: String(m.description || '').replace(/\s+/g, ' ').trim() });
    }
    const last = res && typeof res.last === 'boolean' ? res.last : els.length < PAGE;
    if (last || !els.length || !fresh) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Whole-ontology download (the Batch Import compares it with the dictionaries) ───────────────────────────────────────────────
const idKeyOf = (s) => String(s).replace(/^.*[\/#]/, '').replace(/_/g, ':').toLowerCase();   // ids of a class / a parent reference may be written differently (IRI / GO:0008150 / GO_0008150): compare their tails

/** every class of an ontology (scroll, 1000 per request): [{ primaryId, label, synonyms, parents }] */
async function downloadClasses(store, ontologyId, { isCancelled = () => false, onTick = () => {} } = {}) {
  const out = []; const seen = new Set(); let scrollId = ''; let total = null;
  let size = 5000;                                       // a scroll is one chain of requests: bigger pages mean fewer round trips (falls back to 1000 when the server refuses the size)
  for (let i = 0; i < 100000; i++) {
    if (isCancelled()) throw new Error('Cancelled');
    const q = { size }; if (scrollId) q.scrollId = scrollId;
    let page;
    try { page = await request(store, 'GET', `/ontologies/${encodeURIComponent(ontologyId)}/classes`, { query: q }); }
    catch (e) { if (i === 0 && size > 1000 && /HTTP 4\d\d/.test(e.message)) { size = 1000; i--; continue; } throw e; }
    const els = arr(page); if (page && typeof page.total === 'number') total = page.total;
    let fresh = 0;
    for (const e of els) {
      const id = e.primaryID || e.primaryId; if (!id || seen.has(id)) continue;
      seen.add(id); fresh++;
      out.push({ primaryId: id, label: e.primaryLabel || '', synonyms: e.synonyms || [], parents: e.superClasses || [] });
    }
    onTick(out.length, total);
    if (page && page.scrollId) scrollId = page.scrollId;
    if (!els.length || !fresh || (total !== null && out.length >= total)) break;
  }
  return out;
}

/** the classes at or below the given branch classes (by the subclass links of the downloaded classes) */
function branchMembers(classes, branchIds) {
  const children = new Map();
  for (const c of classes) for (const p of c.parents) { const k = idKeyOf(p); if (!children.has(k)) children.set(k, []); children.get(k).push(idKeyOf(c.primaryId)); }
  const keep = new Set(); const stack = branchIds.map(idKeyOf);
  while (stack.length) { const k = stack.pop(); if (keep.has(k)) continue; keep.add(k); for (const ch of children.get(k) || []) stack.push(ch); }
  return classes.filter(c => keep.has(idKeyOf(c.primaryId)));
}

/** for each given class: how many direct children it has and how many terms are at or below it (itself included): { primaryId: { direct, total } } */
function countBelow(classes, ids) {
  const children = new Map();
  for (const c of classes) for (const p of c.parents) { const k = idKeyOf(p); if (!children.has(k)) children.set(k, []); children.get(k).push(idKeyOf(c.primaryId)); }
  const out = {};
  for (const id of ids) {
    const root = idKeyOf(id); const seen = new Set(); const stack = [root];
    while (stack.length) { const k = stack.pop(); if (seen.has(k)) continue; seen.add(k); for (const ch of children.get(k) || []) stack.push(ch); }
    out[id] = { direct: new Set(children.get(root) || []).size, total: seen.size };
  }
  return out;
}

/** top of the hierarchy of ontologies: { id: { roots, branches } } - roots = number of root classes, branches = what a user can pick below them (the root classes, or the children of the only root) */
async function ontologyShape(store, ids) {
  const out = {}; let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const page = await request(store, 'GET', `/ontologies/${encodeURIComponent(id)}/rootClassesPage`, { query: { from: 0, size: 50 } });
        const els = arr(page); const roots = page && typeof page.total === 'number' ? page.total : els.length;
        const first = els[0] && (els[0].value || els[0]);
        out[id] = { roots, branches: roots === 1 && first ? Number(first.numberOfChildren || 0) : roots };
      } catch (e) { out[id] = { error: String(e.message).slice(0, 100) }; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

/** size of ontologies: { id: { classes, obsoleteClasses, properties, instances } | { error } } (a few requests at a time) */
async function ontologyStats(store, ids) {
  const out = {}; let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const r = await request(store, 'GET', `/ontologies/${encodeURIComponent(id)}/stats`);
        const t = (r && r.totals) || {};
        out[id] = { classes: t.classes ?? null, obsoleteClasses: t.obsoleteClasses ?? 0, properties: t.properties ?? 0, instances: t.instances ?? 0 };
      } catch (e) { out[id] = { error: String(e.message).slice(0, 100) }; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

/** committed edits of one ontology after fromDate, paged; one record per class: { primaryId, label, created, ts } */
async function ontologyChanges(store, ontologyId, fromDate, isCancelled, debug = {}) {
  const byClass = new Map(); const seenEdits = new Set();
  for (let page = 0; ; page++) {
    if (isCancelled()) throw new Error('Cancelled');
    const res = await request(store, 'GET', `/ontologies/${encodeURIComponent(ontologyId)}/edits/committed`, { query: { fromDate: isoStart(fromDate), page, size: PAGE } });
    const edits = arr(res);
    for (const e of edits) {
      const key = e.id != null ? 'e' + e.id : null;
      if (key) { if (seenEdits.has(key)) continue; seenEdits.add(key); }
      const pid = e.primaryId; if (!pid) continue;
      if (!debug.sample) debug.sample = JSON.stringify(e).slice(0, 1800);
      const actions = (e.ontologyEditActionSet || []).map(a => a.editAction);
      // classes only: edits of properties (label, definition, ...) and of instances are left out
      const b = e.ontologyJSONBean || {}, et = String(b.entityType || '').toLowerCase();
      const isProp = /propert/.test(et) || b.propertyType !== undefined || b.superProperties !== undefined || b.characteristics !== undefined || actions.includes('EDIT_CHARACTERISTICS') || actions.includes('ADD_NEW_ONTOLOGY_PROPERTY');
      const isInst = /instance/.test(et) || b.instanceOf !== undefined || actions.includes('ADD_NEW_ONTOLOGY_INSTANCE');
      if (isProp || isInst) continue;
      const created = actions.includes('ADD_NEW_ONTOLOGY_CLASS');
      const r = byClass.get(pid) || { primaryId: pid, label: e.primaryLabel || '', created: false, ts: '', obsolete: false };
      r.created = r.created || created;
      if (actions.includes('OBSOLETE') || actions.includes('DELETE')) r.obsolete = true;
      if (!r.ts || (e.creationDate && e.creationDate > r.ts)) { r.ts = e.creationDate || r.ts; if (e.primaryLabel) r.label = e.primaryLabel; }
      byClass.set(pid, r);
    }
    const last = res && typeof res.last === 'boolean' ? res.last : edits.length < PAGE;
    if (last || !edits.length) break;
  }
  return [...byClass.values()];
}

// ── Version comparison: what changed between a released version (S3) of an ontology and the version CENtree has loaded ──────────────
// CENtree computes a "diff report" as a server job (GET /ontology/{id}/differences -> job id + the name of a zip with diff_<ontology>.txt).
// The report lists  CHANGED_CLASS <iri> <label>  (and the NEW / DELETED / OBSOLETE counterparts) followed by the field changes of the class.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const verTime = (v) => { const t = Date.parse(String((v.s3ObjectTags || {}).last_updated || '').replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : NaN; };

/** versions of an ontology, newest first: [{ tag, versionId, time (ms) }] (empty when it has none) */
async function ontologyVersions(store, ontologyId) {
  const v = await request(store, 'GET', `/ontologies/${encodeURIComponent(ontologyId)}/versions`);
  return (Array.isArray(v) ? v : []).map(x => ({ tag: x.tag, versionId: x.versionId, time: verTime(x) })).filter(x => x.tag && Number.isFinite(x.time)).sort((a, b) => b.time - a.time);
}

/** the release in force on a date: the newest version uploaded by the end of that day (or the oldest one when the date is older than all). null = nothing newer than the date, nothing to compare */
function baseVersionFor(versions, ymd) {
  if (!versions.length) return null;
  const end = Date.parse(ymd + 'T23:59:59Z');
  if (versions[0].time <= end) return null;
  return versions.find(v => v.time <= end) || versions[versions.length - 1];
}

/** parses diff_<ontology>.txt -> { records: [{ primaryId, label, kind, created, obsolete, fields:[...] }], unknown: [first words of lines of an unknown kind] } */
function parseDiffReport(text) {
  const records = []; const unknown = new Set(); let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Z]+_CLASS)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) {
      const kind = m[1];
      cur = { kind, primaryId: m[2], label: m[3].trim(), created: /^(NEW|ADDED|CREATED)_/.test(kind), obsolete: /^(DELETED|OBSOLETE|REMOVED)_/.test(kind), fields: new Set() };
      if (!/^(NEW|ADDED|CREATED|CHANGED|MODIFIED|DELETED|OBSOLETE|REMOVED)_CLASS$/.test(kind)) unknown.add(kind);
      records.push(cur); continue;
    }
    const f = /fieldName=([A-Za-z]+)/.exec(line);
    if (f && cur) cur.fields.add(f[1]);
  }
  return { records: records.map(r => ({ ...r, fields: [...r.fields] })), unknown: [...unknown] };
}

/** runs the comparison of the loaded version with the version tagged baseTag and returns the parsed report */
async function versionDiff(store, ontologyId, baseTag, { isCancelled = () => false, timeoutMs = 20 * 60 * 1000 } = {}) {
  const start = await request(store, 'GET', `/ontology/${encodeURIComponent(ontologyId)}/differences`, { query: { version: baseTag, loadType: 'VERSION', latestVersion: 'CURRENT_LOADED_VERSION', withJobDetails: true } });
  const jobId = start && start.job && start.job.id, file = start && start.message;
  if (!jobId || !file) throw new Error('The comparison job did not start: ' + JSON.stringify(start).slice(0, 200));
  const t0 = Date.now();
  for (;;) {
    if (isCancelled()) throw new Error('Cancelled');
    if (Date.now() - t0 > timeoutMs) throw new Error('The comparison job took too long');
    await sleep(1500);
    const j = await request(store, 'GET', `/jobs/${jobId}`);
    if (j && j.finished) {
      if (j.status !== 'Succeeded') throw new Error('Comparison job ' + j.status + ': ' + String(j.completionMessage || '').slice(0, 200));
      break;
    }
  }
  const zipBuf = await request(store, 'GET', file.replace(/^\/api/, ''), { raw: true });
  const JSZip = require('jszip'); const zip = await JSZip.loadAsync(zipBuf);
  const entry = Object.values(zip.files).find(e => !e.dir && /\.txt$/i.test(e.name));
  if (!entry) throw new Error('The comparison report has no text file');
  return parseDiffReport(await entry.async('string'));
}

/** all records created/updated after fromDate in every ontology: { ontologies: [{id,name,records}], errors } */
async function fetchChanges(store, { fromDate, ontologyIds = null, useVersions = true, isCancelled = () => false, onProgress = () => {} }) {
  const debug = {};
  let onts = await allOntologies(store, isCancelled);
  if (Array.isArray(ontologyIds)) { const want = new Set(ontologyIds); onts = onts.filter(o => want.has(o.id)); }   // only the ontologies the user selected
  const result = []; const errors = []; const warnings = []; const unknownKinds = new Set();
  for (let i = 0; i < onts.length; i++) {
    if (isCancelled()) throw new Error('Cancelled');
    onProgress({ done: i, total: onts.length, ontology: onts[i].name });
    let records;
    try {
      records = await ontologyChanges(store, onts[i].id, fromDate, isCancelled, debug);
    } catch (e) {
      if (e.message === 'Cancelled') throw e;
      throw new Error(`Ontology ${onts[i].name}: ${e.message}`);   // FR-09: no partial results
    }
    // Terms that arrived with a new release of the ontology are not edits: compare the loaded version with the release in force at the cut-off date.
    if (onts[i].loaded && useVersions) {
      try {
        const versions = await ontologyVersions(store, onts[i].id);
        const base = baseVersionFor(versions, fromDate);
        if (base) {
          onProgress({ done: i, total: onts.length, ontology: `${onts[i].name}: comparing with version ${base.tag}` });
          const diff = await versionDiff(store, onts[i].id, base.tag, { isCancelled });
          diff.unknown.forEach(k => unknownKinds.add(k));
          const byId = new Map(records.map(r => [r.primaryId, r]));
          const ts = new Date(versions[0].time).toISOString();
          for (const d of diff.records) {
            const r = byId.get(d.primaryId);
            if (r) { r.created = r.created || d.created; r.obsolete = r.obsolete || d.obsolete; r.fields = d.fields; r.via = 'edit+version'; continue; }
            const n = { primaryId: d.primaryId, label: d.label, created: d.created, ts, obsolete: d.obsolete, fields: d.fields, via: 'version' };
            records.push(n); byId.set(d.primaryId, n);
          }
        }
      } catch (e) {
        if (e.message === 'Cancelled') throw e;
        warnings.push(`${onts[i].name}: version comparison not possible (${e.message}); only edits made in CENtree are listed`);
      }
    }
    if (records.length) result.push({ ...onts[i], records });
  }
  onProgress({ done: onts.length, total: onts.length, ontology: '' });
  return { ontologies: result, errors, warnings, unknownKinds: [...unknownKinds], sample: debug.sample || '' };
}

/** label + synonyms of classes (a few requests at a time): [{ ...record, label, synonyms }] */
async function classDetails(store, ontologyId, records, { isCancelled = () => false, onTick = () => {} } = {}) {
  const out = new Array(records.length); let next = 0, done = 0;
  const worker = async () => {
    while (next < records.length) {
      if (isCancelled()) throw new Error('Cancelled');
      const i = next++; const r = records[i];
      let synonyms = [], label = r.label, missing = false;
      try {
        const c = await request(store, 'GET', ENDPOINTS.classByPrimaryId(ontologyId), { query: { primaryId: r.primaryId } });
        if (c) { label = c.primaryLabel || label; synonyms = c.synonyms || []; }
      } catch (e) { if (!/HTTP 404/.test(e.message)) throw e; missing = true; }   // not a class of this ontology (a property, an instance, removed)
      out[i] = { ...r, label, synonyms, missing }; onTick(++done, records.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

// ── Branches (roots and their children) and the branches a class sits under ──────────────────────────────────
// What a user can read about a class: its definition, else a comment / description / definition annotation, else its synonyms
function describeClass(v) {
  const flat = (a) => (Array.isArray(a) ? a : []).map(x => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
  let text = flat(v.textualDefinitions);
  if (!text) for (const [k, vals] of Object.entries(v.annotationProperties || {})) { if (/comment|definition|description|IAO_0000115/i.test(k)) { text = flat(vals); if (text) break; } }
  if (!text && Array.isArray(v.synonyms) && v.synonyms.length) text = 'Synonyms: ' + v.synonyms.slice(0, 6).join('; ');
  return text;
}
const nodeOf = (v) => v && ({ classId: v.id, primaryId: v.primaryID || v.primaryId, label: v.primaryLabel || v.primaryID || '', numberOfChildren: Number(v.numberOfChildren || 0), description: describeClass(v) });

/** parentClassId null: the root classes of the ontology; otherwise the children of that class. -> [{ classId, primaryId, label, numberOfChildren }] sorted by label */
async function branchChildren(store, ontologyId, parentClassId) {
  const out = []; const seen = new Set();
  for (let from = 0; from < 5000; from += PAGE) {
    const path = parentClassId ? `/ontologies/${encodeURIComponent(ontologyId)}/classes/${encodeURIComponent(parentClassId)}/children` : `/ontologies/${encodeURIComponent(ontologyId)}/rootClassesPage`;
    const page = await request(store, 'GET', path, { query: { from, size: PAGE } });
    const els = arr(page); let fresh = 0;
    for (const e of els) { const n = nodeOf(e.value && e.value.primaryID !== undefined || e.value && e.value.id !== undefined ? e.value : e); if (n && n.primaryId && !seen.has(n.primaryId)) { seen.add(n.primaryId); out.push(n); fresh++; } }
    const total = page && typeof page.total === 'number' ? page.total : null;
    if (!els.length || !fresh || (total !== null && from + PAGE >= total) || (total === null && els.length < PAGE)) break;
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

const collectStrings = (node, out) => {
  if (!node) return;
  const v = node.value;
  if (typeof v === 'string') out.add(v);
  else if (v && typeof v === 'object') for (const k of ['primaryID', 'primaryId', 'id', 'shortFormId', 'entityUniqueID']) if (typeof v[k] === 'string') out.add(v[k]);
  for (const l of node.leaves || []) collectStrings(l, out);
};

/** for each primaryId: the primaryIds (IRIs) of the class and of everything above it, from the paths from the root: { primaryId: [iri, ...] } */
async function classAncestors(store, ontologyId, primaryIds, { isCancelled = () => false, onTick = () => {}, debug = {} } = {}) {
  const out = {}; let next = 0, done = 0;
  const worker = async () => {
    while (next < primaryIds.length) {
      if (isCancelled()) throw new Error('Cancelled');
      const pid = primaryIds[next++]; const set = new Set([pid]);
      try {
        const tree = await request(store, 'GET', `/ontologies/${encodeURIComponent(ontologyId)}/classes/paths-from-root/simple`, { query: { classPrimaryId: pid, maximumNumberOfPaths: 100 } });
        if (!debug.sample) debug.sample = JSON.stringify(tree).slice(0, 1500);
        collectStrings(tree, set);
      } catch (e) { if (!/HTTP 404/.test(e.message)) throw e; }
      out[pid] = [...set]; onTick(++done, primaryIds.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

const wrap = (fn) => async (...a) => { try { return { ok: true, data: await fn(...a) }; } catch (e) { return { ok: false, error: e.message || String(e) }; } };

module.exports = {
  ENDPOINTS,
  request,
  fetchChanges,
  listOntologies: wrap((s) => listOntologies(s)),
  ontologyStats: wrap((s, ids) => ontologyStats(s, ids)),
  ontologyShape: wrap((s, ids) => ontologyShape(s, ids)),
  downloadClasses,
  branchMembers,
  countBelow,
  classDetails,
  branchChildren,
  classAncestors,
  test:        wrap((s) => request(s, 'GET', ENDPOINTS.ping())),
  ontologies:  wrap((s, q) => request(s, 'GET', ENDPOINTS.ontologies(), { query: q })),
  ontology:    wrap((s, id) => request(s, 'GET', ENDPOINTS.ontology(id))),
  term:        wrap((s, ontology, primaryId) => request(s, 'GET', ENDPOINTS.classByPrimaryId(ontology), { query: { primaryId } })),
  classById:   wrap((s, ontology, classId) => request(s, 'GET', ENDPOINTS.classById(ontology, classId))),
  exactLabel:  wrap((s, ontology, label) => request(s, 'GET', ENDPOINTS.exactLabel(ontology), { query: { label } })),
  search:      wrap((s, { query, ontology, from, size }) => request(s, 'GET', ENDPOINTS.search(), { query: { q: query, ontology, from, size } })),
  download:    wrap((s, path) => request(s, 'GET', path, { raw: true })),
  call:        wrap((s, { method = 'GET', path, query, body, headers }) => request(s, method, path, { query, body, headers })),
};
