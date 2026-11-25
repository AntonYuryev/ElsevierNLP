import React, { useState, useEffect, useRef } from 'react';
import { DbExport } from './DictionaryScreen';
import { exactLiteralTokenized, makeTokenizer } from '../../shared/tokenizer';
import { addToCasDictionary, ensureChemNamesTokens } from '../../shared/casDictionary';

export default function DatabaseScreen({ onEditRecord }) {
  // ── Restore mode ──────────────────────────────────────────────────────────
  const [restoreMode, setRestoreMode] = useState('backup'); // 'backup' | 'deployed' | 'backupFile'
  const [backupFiles,      setBackupFiles]      = useState([]); // list of { name, path, date }
  const [backupFilesError, setBackupFilesError] = useState(null);
  const [selectedBackup,   setSelectedBackup]   = useState(''); // path of selected ZIP

  // ── Dict refresh state (inlined from DictRefresh component) ───────────────
  const [latestDate,     setLatestDate]     = useState(null);
  const [dateError,      setDateError]      = useState(null);
  const [dictConfirming, setDictConfirming] = useState(false);
  const [dictRunning,    setDictRunning]    = useState(false);
  const [dictLog,        setDictLog]        = useState([]);
  const [dictDone,       setDictDone]       = useState(false);
  const logRef = useRef(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [dictLog]);

  useEffect(() => {
    window.api.dict.getLatestDate().then(r => {
      if (r.ok) setLatestDate(r.date);
      else setDateError(r.error);
    });
    window.api.dict.onProgress(msg => setDictLog(l => [...l, msg]));
    return () => window.api.dict.offProgress();
  }, []);

  const handleDictRefresh = async () => {
    setDictConfirming(false);
    setDictRunning(true);
    setDictLog([]);
    setDictDone(false);
    const result = await window.api.dict.refresh();
    setDictRunning(false);
    setDictDone(true);
    if (!result.ok) setDictLog(l => [...l, `ERROR: ${result.error}`]);
  };

  // ── DB state ───────────────────────────────────────────────────────────────
  const [dbOp,          setDbOp]          = useState(null); // 'backup' | 'restore' | 'vacuum' | null
  const [dbResult,      setDbResult]      = useState(null); // { ok, message } — backup/restore only
  const [backupProgress,  setBackupProgress]  = useState(null); // { startedAt, activeTables, doneTables, elapsedSec, merging }
  const [restoreProgress, setRestoreProgress] = useState(null); // { startedAt, phase, activeTables, doneTables, elapsedSec }
  const [vacuumResult,  setVacuumResult]  = useState(null); // { ok, message } — compress only
  const [vacuumDetails, setVacuumDetails] = useState(null); // freed[] | null
  const [retokenizing,       setRetokenizing]       = useState(false);
  const [retokenizeResult,   setRetokenizeResult]   = useState(null);
  const [cleaningObjNames,    setCleaningObjNames]    = useState(false);
  const [cleanObjNamesResult, setCleanObjNamesResult] = useState(null);
  const [objNamesConflicts,   setObjNamesConflicts]   = useState(null);
  const [deduplicating,       setDeduplicating]       = useState(false);
  const [dedupResult,         setDedupResult]         = useState(null);
  const [fillingCarts,        setFillingCarts]        = useState(false);
  const [fillCartsResult,     setFillCartsResult]     = useState(null);

  // Export Records state
  const [exportDateFrom,    setExportDateFrom]    = useState('');
  const [exportDateTo,      setExportDateTo]      = useState('');
  const [exportCuratedOnly, setExportCuratedOnly] = useState(false);
  const [exportFormat,      setExportFormat]      = useState('json');
  const [exporting,         setExporting]         = useState(false);
  const [exportResult,      setExportResult]      = useState(null);

  // Import Records state
  const [importRows,     setImportRows]     = useState(null);
  const [importFileName, setImportFileName] = useState('');
  const [importing,      setImporting]      = useState(false);
  const [importProgress, setImportProgress] = useState(null);
  const [importResult,   setImportResult]   = useState(null);

  const handleExportRecords = async () => {
    setExporting(true);
    setExportResult(null);

    const DICT_TABLES = ['curnames', 'exactliteral', 'celldictionary', 'casdictionary', 'keywords', 'userdict'];
    const aliasCol = t => t === 'keywords' ? 'keywords' : 'alias';

    const conditions = ['(t.bdeleted IS NULL OR t.bdeleted = FALSE OR t.curated = TRUE)'];
    const params = [];
    if (exportCuratedOnly) conditions.push('t.curated = TRUE');
    if (exportDateFrom) { params.push(exportDateFrom); conditions.push(`t.updated_at >= $${params.length}::date`); }
    if (exportDateTo)   { params.push(exportDateTo);   conditions.push(`t.updated_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const where = conditions.join(' AND ');

    const unionSql = DICT_TABLES.map(t =>
      `SELECT t.medscan_id, o.name, o.urn,
              t.${aliasCol(t)} AS alias, '${t}' AS dictionary,
              t.match AS flag, t.organisms, t.cartridges, t.curated,
              COALESCE(t.bdeleted, FALSE) AS bdeleted,
              t.created_at, t.updated_at
       FROM ${t} t
       LEFT JOIN objectnames o ON o.medscan_id = t.medscan_id
       WHERE ${where}`
    ).join(' UNION ALL ');

    const res = await window.api.db.query(
      `SELECT * FROM (${unionSql}) q ORDER BY q.medscan_id, q.dictionary, q.alias LIMIT 500001`,
      params
    );
    if (!res.ok) { setExporting(false); setExportResult({ ok: false, message: res.error }); return; }

    const truncated = res.rows.length > 500000;
    const rows = truncated ? res.rows.slice(0, 500000) : res.rows;
    const dateStr = new Date().toISOString().slice(0, 10);

    let blob, filename;

    if (exportFormat === 'json') {
      const grouped = {};
      for (const r of rows) {
        const key = String(r.medscan_id);
        if (!grouped[key]) grouped[key] = { name: r.name || '', urn: r.urn || '', aliases: [] };
        grouped[key].aliases.push([
          r.alias || '',
          r.dictionary,
          r.flag || '',
          Array.isArray(r.organisms)  ? r.organisms  : [],
          Array.isArray(r.cartridges) ? r.cartridges : [],
          r.curated  || false,
          r.bdeleted || false,
          r.created_at ? new Date(r.created_at).toISOString() : '',
          r.updated_at ? new Date(r.updated_at).toISOString() : '',
        ]);
      }

      const lines = ['{'];
      const keys = Object.keys(grouped);
      keys.forEach((key, ki) => {
        const { name, urn, aliases } = grouped[key];
        const comma = ki < keys.length - 1 ? ',' : '';
        lines.push(`  ${JSON.stringify(key)}: {`);
        lines.push(`    "name": ${JSON.stringify(name)},`);
        lines.push(`    "urn": ${JSON.stringify(urn)},`);
        lines.push(`    "aliases": [`);
        aliases.forEach((tuple, ai) => {
          const tc = ai < aliases.length - 1 ? ',' : '';
          lines.push(`      ${JSON.stringify(tuple)}${tc}`);
        });
        lines.push(`    ]`);
        lines.push(`  }${comma}`);
      });
      lines.push('}');

      blob     = new Blob([lines.join('\n')], { type: 'application/json;charset=utf-8' });
      filename = `nlp_records_${dateStr}.json`;
    } else {
      const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['NLP ID', 'Name', 'URN', 'Alias', 'Dictionary', 'Flag', 'Organisms', 'Cartridges', 'Curated', 'Deleted', 'Date Created', 'Date Last Modified'];
      const csvRows = rows.map(r => [
        r.medscan_id, r.name || '', r.urn || '', r.alias || '', r.dictionary, r.flag || '',
        Array.isArray(r.organisms)  ? r.organisms.join('; ')  : (r.organisms  || ''),
        Array.isArray(r.cartridges) ? r.cartridges.join('; ') : (r.cartridges || ''),
        r.curated  ? 'true' : 'false',
        r.bdeleted ? 'true' : 'false',
        r.created_at ? new Date(r.created_at).toISOString() : '',
        r.updated_at ? new Date(r.updated_at).toISOString() : '',
      ]);
      const csv = [header, ...csvRows].map(row => row.map(escape).join(',')).join('\r\n');
      blob     = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      filename = `nlp_records_${dateStr}.csv`;
    }

    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);

    setExporting(false);
    setExportResult({
      ok: true,
      message: `✓ Exported ${rows.length.toLocaleString()} alias rows.${truncated ? ' Limit of 500 000 rows reached — narrow the date range to export the rest.' : ''}`,
    });
  };

  // ── CSV parser ─────────────────────────────────────────────────────────────
  const parseCsv = (text) => {
    const raw = text.startsWith('﻿') ? text.slice(1) : text;
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inQ) {
        if (ch === '"' && raw[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') { inQ = false; }
        else { field += ch; }
      } else {
        if (ch === '"') { inQ = true; }
        else if (ch === ',') { row.push(field); field = ''; }
        else if (ch === '\r' && raw[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else { field += ch; }
      }
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  };

  const handlePickImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportResult(null); setImportProgress(null);
    const text = await file.text();
    const VALID_TABLES = new Set(['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict']);

    const isJson = file.name.toLowerCase().endsWith('.json');
    let dataRows = [];

    if (isJson) {
      try {
        const obj = JSON.parse(text);
        for (const [msId, entity] of Object.entries(obj)) {
          for (const tuple of (entity.aliases || [])) {
            const dict = tuple[1];
            if (!VALID_TABLES.has(dict)) continue;
            dataRows.push([
              msId, entity.name, entity.urn, tuple[0], dict, tuple[2],
              Array.isArray(tuple[3]) ? tuple[3].join('; ') : (tuple[3] || ''),
              Array.isArray(tuple[4]) ? tuple[4].join('; ') : (tuple[4] || ''),
              tuple[5] ? 'true' : 'false',
              tuple[6] ? 'true' : 'false',
              tuple[7] || '',
              tuple[8] || '',
            ]);
          }
        }
      } catch (err) {
        setImportRows([]); setImportFileName(file.name); e.target.value = ''; return;
      }
    } else {
      const allRows = parseCsv(text);
      if (allRows.length < 2) { setImportRows([]); setImportFileName(file.name); e.target.value = ''; return; }
      dataRows = allRows.slice(1).filter(r => r.length >= 5 && VALID_TABLES.has(r[4]?.trim()));
    }

    setImportRows(dataRows);
    setImportFileName(file.name);
    e.target.value = '';
  };

  const handleConfirmImport = async () => {
    if (!importRows?.length) return;
    setImporting(true); setImportResult(null);
    setImportProgress({ current: 0, total: importRows.length });

    const VALID_TABLES = new Set(['curnames','exactliteral','celldictionary','casdictionary','keywords','userdict']);
    let inserted = 0, skipped = 0, bdeletedSkipped = 0;
    const errors = [];
    const onHandled = new Set();

    // CASDictionary rows: ask for chemNames approval ONCE for all of them before importing anything
    {
      const casAliases = importRows
        .filter(c => c[4]?.trim() === 'casdictionary' && c[3]?.trim())
        .map(c => c[3].trim());
      if (casAliases.length) {
        const pre = await ensureChemNamesTokens(casAliases);
        if (!pre.ok) {
          setImporting(false); setImportProgress(null);
          setImportResult({ ok: false, inserted: 0, skipped: importRows.length, bdeletedSkipped: 0,
            errors: [pre.cancelled ? 'Import cancelled — chemNames tokens for CASdictionary aliases were not approved.' : pre.error] });
          return;
        }
      }
    }

    const BATCH = 50;
    for (let i = 0; i < importRows.length; i += BATCH) {
      const batch = importRows.slice(i, i + BATCH);
      for (const cols of batch) {
        try {
          const msId      = Number(cols[0]?.trim());
          const name      = cols[1]?.trim() || null;
          const urn       = cols[2]?.trim() || null;
          const alias     = cols[3]?.trim() || '';
          const dict      = cols[4]?.trim();
          const flag      = cols[5]?.trim() || null;
          const orgsRaw   = cols[6]?.trim() || '';
          const cartsRaw  = cols[7]?.trim() || '';
          const curated   = cols[8]?.trim().toLowerCase() === 'true';
          const bdeleted  = cols[9]?.trim().toLowerCase() === 'true';
          const createdAt = cols[10]?.trim() || null;
          const updatedAt = cols[11]?.trim() || null;

          if (!msId || !alias || !VALID_TABLES.has(dict)) { skipped++; continue; }

          const organisms  = orgsRaw  ? orgsRaw.split(';').map(s => s.trim()).filter(Boolean)  : [];
          const cartridges = cartsRaw ? cartsRaw.split(';').map(s => s.trim()).filter(Boolean) : [];
          const aliasCol   = dict === 'keywords' ? 'keywords' : 'alias';
          // ExactLiteral tokenization is defined in shared/tokenizer.js.
          // Phase-1 → 'tokenized' column (xwords not loaded here; Retokenize fills in proper form).
          const tokenized = (dict === 'exactliteral' && (flag || '').includes('l'))
            ? alias
            : makeTokenizer(new Set())(alias);
          // Phase-2 → 'normalized' column.
          // exactliteral: use exactLiteralTokenized; others: leave as raw alias (Retokenize fixes).
          const normalized = dict === 'exactliteral'
            ? exactLiteralTokenized(alias, flag)
            : alias;

          if (name && !onHandled.has(msId)) {
            onHandled.add(msId);
            await window.api.db.query(
              `INSERT INTO objectnames (medscan_id, name, urn, created_at, updated_at)
               SELECT $1,$2,$3,NOW(),NOW()
               WHERE NOT EXISTS (SELECT 1 FROM objectnames WHERE medscan_id=$1)`,
              [msId, name, urn]
            );
          }

          // Check for bdeleted-only conflict before attempting insert
          let bdeletedBlocked = false;
          const chkRes = await window.api.db.query(
            `SELECT (bdeleted IS TRUE) AS is_bdeleted FROM ${dict} WHERE medscan_id=$1 AND LOWER(${aliasCol})=LOWER($2) LIMIT 1`,
            [msId, alias]
          );
          if (chkRes.ok && chkRes.rows.length > 0 && chkRes.rows[0].is_bdeleted) {
            bdeletedBlocked = true;
          }

          let res;
          if (dict === 'casdictionary') {
            // CASDictionary: single route (tokenize/normalize + chemNames check; approval was asked once up-front)
            const cr = await addToCasDictionary([{ msId, alias, match: flag, cartridges, organisms, curated, bdeleted, createdAt, updatedAt, onlyIfAbsent: true }]);
            res = cr.ok ? { ok: true, rowCount: cr.written } : { ok: false, error: cr.cancelled ? 'cancelled (chemNames tokens not approved)' : cr.error };
          } else
          res = await window.api.db.query(
            `INSERT INTO ${dict} (medscan_id, ${aliasCol}, match, tokenized, normalized, organisms, cartridges, curated, bdeleted, created_at, updated_at)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,
               COALESCE($10::timestamptz, NOW()),
               COALESCE($11::timestamptz, NOW())
             WHERE NOT EXISTS (
               SELECT 1 FROM ${dict} WHERE medscan_id=$1 AND LOWER(${aliasCol})=LOWER($2)
               AND (bdeleted IS NULL OR bdeleted = FALSE)
             )`,
            [msId, alias, flag, tokenized, normalized, organisms, cartridges, curated, bdeleted, createdAt, updatedAt]
          );
          if (res.ok) { if (res.rowCount > 0) inserted++; else if (bdeletedBlocked) bdeletedSkipped++; else skipped++; }
          else { errors.push(`ID ${msId} "${alias}": ${res.error}`); skipped++; }
        } catch (err) {
          errors.push(err.message); skipped++;
        }
      }
      setImportProgress({ current: Math.min(i + BATCH, importRows.length), total: importRows.length });
    }

    setImporting(false);
    setImportProgress(null);
    setImportResult({ ok: errors.length === 0, inserted, skipped, bdeletedSkipped, errors });
  };

  const handleBackup = async () => {
    setDbOp('backup'); setDbResult(null);
    // Clock starts when the save location has been chosen (main sends phase 'start' after the dialog).
    setBackupProgress({ startedAt: null, activeTables: new Set(), doneTables: [], elapsedSec: 0, merging: false });

    // Live elapsed-time ticker (updates every second).
    const tickerRef = { id: null };
    tickerRef.id = setInterval(() => {
      setBackupProgress(p => p && p.startedAt ? { ...p, elapsedSec: Math.round((Date.now() - p.startedAt) / 1000) } : p);
    }, 1000);

    // Subscribe to per-table progress from main process.
    const offProgress = window.api.db.onBackupProgress((ev) => {
      setBackupProgress(p => {
        if (!p) return p;
        if (ev.phase === 'start') return { ...p, startedAt: new Date(), elapsedSec: 0 };
        if (ev.phase === 'dumping') {
          const active = new Set(p.activeTables);
          active.add(ev.table);
          return { ...p, activeTables: active };
        }
        if (ev.phase === 'dumped' || ev.phase === 'skip') {
          const active = new Set(p.activeTables);
          active.delete(ev.table);
          return { ...p, activeTables: active, doneTables: [...p.doneTables, ev.table] };
        }
        if (ev.phase === 'merging') return { ...p, activeTables: new Set(), merging: true };
        return p;
      });
    });

    const res = await window.api.db.backup();

    clearInterval(tickerRef.id);
    offProgress();
    setBackupProgress(null);
    setDbOp(null);
    if (res.canceled) return;

    const fmtTime = (s) => s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;
    if (res.ok) {
      const skipped = res.skippedTables || [];
      const tg = res.timing, sec = (ms) => (ms / 1000).toFixed(1) + ' s', mb = (n) => (n / 1048576).toFixed(0) + ' MB';
      const top = tg ? Object.entries(tg.tables).sort((a, b) => b[1].ms - a[1].ms)[0] : null;
      const msg = `Backup saved — ${res.totalRows.toLocaleString()} rows in ${fmtTime(res.elapsedSec)} → ${res.filePath}`
        + (tg && top ? `\n⏱ dump ${sec(tg.dumpMs)} (slowest: ${top[0]} ${sec(top[1].ms)} — PostgreSQL ${sec(top[1].fetchMs)}, JSON ${sec(top[1].jsonMs)}), merge + gzip ${sec(tg.mergeMs)}, ${mb(tg.rawBytes)} → ${mb(tg.outBytes)}` : '')
        + (skipped.length ? `\n⚠ ${skipped.length} table(s) could not be backed up: ${skipped.map(s => `${s.table} (${s.error})`).join('; ')}` : '');
      setDbResult({ ok: skipped.length === 0, message: msg });
    } else {
      setDbResult({ ok: false, message: res.error });
    }
  };

  const handleVacuum = async () => {
    if (!window.confirm('This will run VACUUM FULL + ANALYZE on all dictionary tables.\n\nThe database will be locked for writes during the operation (typically 1–5 minutes). Continue?')) return;
    setDbOp('vacuum'); setVacuumResult(null); setVacuumDetails(null);
    const res = await window.api.db.vacuum();
    setDbOp(null);
    if (res.ok) {
      const saved = res.totalBefore - res.totalAfter;
      const fmt = (b) => b >= 1073741824 ? `${(b/1073741824).toFixed(2)} GB`
                       : b >= 1048576    ? `${(b/1048576).toFixed(1)} MB`
                       : `${(b/1024).toFixed(0)} KB`;
      setVacuumResult({ ok: true, message: `✓ Compression complete. Freed ${fmt(saved)} (${fmt(res.totalBefore)} → ${fmt(res.totalAfter)}).` });
      setVacuumDetails(res.freed);
    } else {
      setVacuumResult({ ok: false, message: res.error });
    }
  };

  const handleRestore = async () => {
    if (!window.confirm('This will overwrite ALL dictionary data with the backup. Continue?')) return;
    setDbOp('restore'); setDbResult(null);
    // The clock does NOT start now: first the user picks the backup file. It starts when main reports 'reading'.
    setRestoreProgress({ startedAt: null, phase: 'choosing', activeTables: new Set(), doneTables: [], elapsedSec: 0 });

    const tickerRef = { id: null };
    tickerRef.id = setInterval(() => {
      setRestoreProgress(p => p && p.startedAt ? { ...p, elapsedSec: Math.round((Date.now() - p.startedAt) / 1000) } : p);
    }, 1000);

    const offProgress = window.api.db.onRestoreProgress((ev) => {
      setRestoreProgress(p => {
        if (!p) return p;
        if (ev.phase === 'restoring') {
          const active = new Set(p.activeTables);
          active.add(ev.table);
          return { ...p, activeTables: active };
        }
        if (ev.phase === 'restored' || ev.phase === 'skip') {
          const active = new Set(p.activeTables);
          active.delete(ev.table);
          return { ...p, activeTables: active, doneTables: [...p.doneTables, ev.table] };
        }
        if (ev.phase === 'reading') return { ...p, phase: 'reading', startedAt: new Date(), elapsedSec: 0 };   // file chosen → start timing
        if (ev.phase === 'lookups') return { ...p, activeTables: new Set(), phase: 'lookups' };
        if (ev.phase === 'vacuum')  return { ...p, phase: 'vacuum', vacuumTable: ev.table };
        return { ...p, phase: ev.phase };
      });
    });

    const res = await window.api.db.restore();

    clearInterval(tickerRef.id);
    offProgress();
    setRestoreProgress(null);
    setDbOp(null);
    if (res.canceled) return;

    const fmtTime = (s) => s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`;
    if (res.ok) {
      const skipped = res.skippedTables || [];
      const tg = res.timing, sec = (ms) => (ms / 1000).toFixed(1) + ' s';
      const msg = `Restore complete — ${res.totalRows.toLocaleString()} rows loaded in ${fmtTime(res.elapsedSec)}.`
        + (tg ? `\n⏱ read + split ${sec(tg.splitMs)}, insert ${sec(tg.insertMs)}, lookups ${sec(tg.lookupsMs)}, VACUUM FULL + ANALYZE ${sec(tg.vacuumMs)}` : '')
        + (skipped.length ? `\n⚠ ${skipped.length} table(s) failed to restore: ${skipped.map(s => `${s.table} (${s.error})`).join('; ')}` : '');
      setDbResult({ ok: skipped.length === 0, message: msg });
    } else {
      setDbResult({ ok: false, message: res.error });
    }
  };

  const loadBackupFiles = async () => {
    setBackupFilesError(null);
    const res = await window.api.dict.listBackups();
    if (res.ok) {
      setBackupFiles(res.backups);
      if (res.backups.length > 0 && !selectedBackup) setSelectedBackup(res.backups[0].path);
    } else {
      setBackupFilesError(res.error);
    }
  };

  const handleRestoreFromBackupFile = async () => {
    if (!selectedBackup) return;
    const name = backupFiles.find(b => b.path === selectedBackup)?.name || selectedBackup;
    if (!window.confirm(`This will overwrite ALL dictionary data by restoring from:\n\n${name}\n\nThe created_at and updated_at fields will be reset for all records in all tables (set to the modification date of the imported files, not the original dates of the records).\n\nContinue?`)) return;
    setDictRunning(true); setDictLog([]); setDictDone(false);
    setDbResult(null);
    const result = await window.api.dict.restoreFromBackupFile(selectedBackup);
    setDictRunning(false);
    setDictDone(true);
    if (!result.ok) setDictLog(l => [...l, `ERROR: ${result.error}`]);
  };

  const handleRetokenize = async () => {
    setRetokenizing(true);
    setRetokenizeResult(null);
    const res = await window.api.db.retokenize();
    setRetokenizing(false);
    if (res.ok) {
      const parts = Object.entries(res.tableResults)
        .map(([t, n]) => `${t}: ${n.toLocaleString()}`);
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      const chemNote = res.chemNamesAdded === -1
        ? ' ⚠ chemNames sync failed (check console).'
        : res.chemNamesAdded > 0
          ? ` Added ${res.chemNamesAdded.toLocaleString()} token(s) to chemNames.`
          : '';
      setRetokenizeResult({ ok: true, message: `Updated ${res.totalUpdated.toLocaleString()} alias tokens${detail}.${chemNote}` });
    } else {
      setRetokenizeResult({ ok: false, message: res.error });
    }
  };

  const handleFillAllCartridges = async () => {
    setFillingCarts(true);
    setFillCartsResult(null);
    const res = await window.api.db.fillAllCartridges();
    setFillingCarts(false);
    if (res.ok) {
      setFillCartsResult({ ok: true, message: `All term control tables set to [${res.cartridges.join(', ')}].` });
    } else {
      setFillCartsResult({ ok: false, message: res.error });
    }
  };

  const handleDeduplicateAliases = async () => {
    if (!window.confirm(
      'This will delete duplicate aliases from all dictionary tables.\n\n' +
      'Two aliases are considered duplicates if they belong to the same NLP entity (same ID) ' +
      'and have the same normalized (Medscan) form, regardless of match flag. ' +
      'When duplicates differ by match flag, the alias WITH a match flag is kept. ' +
      'Differences in cartridges or organisms are ignored.\n\n' +
      'Continue?'
    )) return;
    setDeduplicating(true);
    setDedupResult(null);
    const res = await window.api.db.deduplicateAliases();
    setDeduplicating(false);
    if (res.ok) {
      const perTable = res.results
        .filter(r => r.deleted > 0)
        .map(r => `${r.table}: ${r.deleted.toLocaleString()}`)
        .join(', ');
      setDedupResult({
        ok: true,
        message: res.total === 0
          ? 'No duplicate aliases found.'
          : `Removed ${res.total.toLocaleString()} duplicate alias${res.total !== 1 ? 'es' : ''}${perTable ? ` (${perTable})` : ''}.`,
      });
    } else {
      setDedupResult({ ok: false, message: res.error });
    }
  };

  const handleCleanObjectNames = async () => {
    setCleaningObjNames(true);
    setCleanObjNamesResult(null);
    setObjNamesConflicts(null);
    const res = await window.api.db.cleanObjectNames();
    setCleaningObjNames(false);
    if (res.ok) {
      setCleanObjNamesResult({
        ok: true,
        message: [
          `Removed ${res.orphansDeleted.toLocaleString()} orphan row${res.orphansDeleted !== 1 ? 's' : ''},`,
          `${res.dupsDeleted.toLocaleString()} duplicate row${res.dupsDeleted !== 1 ? 's' : ''},`,
          `and ${(res.sentinelDeleted ?? 0).toLocaleString()} invalid URN row${(res.sentinelDeleted ?? 0) !== 1 ? 's' : ''} from ObjectNames.`,
          (res.virusFixed ?? 0) > 0
            ? `Reassigned ${res.virusFixed.toLocaleString()} merged virus record${res.virusFixed !== 1 ? 's' : ''} to new IDs.`
            : '',
          (res.virusPhantomDeleted ?? 0) > 0
            ? `Removed ${res.virusPhantomDeleted.toLocaleString()} phantom virus ObjectNames row${res.virusPhantomDeleted !== 1 ? 's' : ''} (no aliases).`
            : '',
          (res.virusAliasesMoved ?? 0) > 0
            ? `Moved ${res.virusAliasesMoved.toLocaleString()} misplaced virus alias${res.virusAliasesMoved !== 1 ? 'es' : ''} to correct IDs.`
            : '',
          (res.orgsSynced ?? 0) > 0
            ? `Synced organisms for ${(res.orgsSynced).toLocaleString()} ObjectNames row${res.orgsSynced !== 1 ? 's' : ''}.`
            : 'ObjectNames organisms up to date.',
        ].filter(Boolean).join(' '),
      });
      setObjNamesConflicts(res.conflicts || []);
    } else {
      setCleanObjNamesResult({ ok: false, message: res.error });
    }
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Database</h1>
      </div>

      {/* Dict-refresh confirmation modal */}
      {dictConfirming && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-title">⚠ Restore dictionaries from deployed dictionaries</div>
            <p className="text-sm" style={{ marginBottom: 16 }}>
              This will <strong>erase all dictionary modifications</strong> made after{' '}
              <strong>{latestDate ? new Date(latestDate).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '(unknown)'}</strong> and
              re-import everything from the Elsevier NLP installation files.
            </p>
            <p className="text-sm" style={{ marginBottom: 16, color: 'var(--danger)' }}>
              Any aliases added or edited in the app that have not been exported to files will be lost.
            </p>
            <p className="text-sm" style={{ marginBottom: 16, color: 'var(--danger)' }}>
              The created_at and updated_at fields will be reset for all records in all tables: the files do not hold them, so they are set to the modification date of the imported files (not the original dates of the records).
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDictConfirming(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDictRefresh}>Yes, Restore</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Database ──────────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">Database</div>
        <div className="alert alert-info" style={{ marginBottom: 12 }}>
          The database is managed automatically by NLPmanager (embedded PostgreSQL).
          No configuration is required.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={handleBackup}
            disabled={!!dbOp || dictRunning} style={{ minWidth: 160, borderColor: '#4a9', color: '#4a9' }}>
            {dbOp === 'backup'
              ? <><span className="spinner" /> {backupProgress?.merging ? 'Compressing…' : 'Backing up…'}</>
              : '💾 Backup Database'}
          </button>
          <button className="btn btn-danger"
            disabled={
              (restoreMode === 'deployed' ? (dictRunning || !!dateError) : false) ||
              (restoreMode === 'backup' ? !!dbOp : false) ||
              (restoreMode === 'backupFile' ? (dictRunning || !selectedBackup) : false)
            }
            onClick={() => {
              if (restoreMode === 'deployed') setDictConfirming(true);
              else if (restoreMode === 'backup') handleRestore();
              else handleRestoreFromBackupFile();
            }}
            style={{ minWidth: 200 }}>
            {(restoreMode === 'deployed' || restoreMode === 'backupFile') && dictRunning
              ? <><span className="spinner" /> Restoring…</>
              : restoreMode === 'backup' && dbOp === 'restore'
              ? <><span className="spinner" /> {
                  restoreProgress?.phase === 'reading'  ? 'Decompressing…' :
                  restoreProgress?.phase === 'lookups'  ? 'Rebuilding indexes…' :
                  restoreProgress?.phase === 'vacuum'   ? 'Compressing…' :
                  'Restoring…'
                }</>
              : '🔄 Restore dictionaries'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
            <input type="radio" name="restoreMode" value="backup"
              checked={restoreMode === 'backup'} onChange={() => setRestoreMode('backup')} />
            from database backup
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
            <input type="radio" name="restoreMode" value="deployed"
              checked={restoreMode === 'deployed'} onChange={() => setRestoreMode('deployed')} />
            from deployed dictionaries
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
            <input type="radio" name="restoreMode" value="backupFile"
              checked={restoreMode === 'backupFile'}
              onChange={() => { setRestoreMode('backupFile'); loadBackupFiles(); }} />
            from dictionaries backup
          </label>
        </div>
        {restoreMode === 'backupFile' && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {backupFilesError
              ? <span style={{ fontSize: 12, color: 'var(--danger, #c33)' }}>✗ {backupFilesError}</span>
              : backupFiles.length === 0
              ? <span className="text-xs text-muted">No backup files found in MEDSCAN\DictionaryBackup.</span>
              : <>
                  <select className="form-control" style={{ maxWidth: 420, fontSize: 13 }}
                    value={selectedBackup}
                    onChange={e => setSelectedBackup(e.target.value)}>
                    {backupFiles.map(b => (
                      <option key={b.path} value={b.path}>{b.name}</option>
                    ))}
                  </select>
                  <button className="btn btn-secondary" style={{ fontSize: 12 }}
                    onClick={loadBackupFiles} disabled={dictRunning}>
                    ↻ Refresh
                  </button>
                </>
            }
          </div>
        )}
        {dateError && restoreMode === 'deployed' && (
          <div className="alert alert-danger" style={{ marginTop: 8, marginBottom: 0 }}>{dateError}</div>
        )}
        <div className="text-xs text-muted mt-8">
          <span style={{ fontFamily: 'monospace', color: '#4a9' }}>Backup Database</span> saves all dictionary tables to a <strong>.nlpdb</strong> file.{' '}
          <span style={{ fontFamily: 'monospace', color: 'var(--danger, #c55)' }}>Restore dictionaries from deployed dictionaries</span> re-imports from Elsevier NLP installation files.{' '}
          <span style={{ fontFamily: 'monospace', color: 'var(--danger, #c55)' }}>Restore dictionaries from database backup</span> replaces all dictionary data from a previously saved <strong>.nlpdb</strong> file.{' '}
          <span style={{ fontFamily: 'monospace', color: 'var(--danger, #c55)' }}>Restore dictionaries from dictionaries backup</span> re-imports from a ZIP saved by Deploy Dictionary.
        </div>
        {restoreMode === 'deployed' && latestDate && (
          <div className="text-xs text-muted" style={{ marginTop: 4 }}>
            Latest NLP installation date: <strong>{new Date(latestDate).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</strong>
          </div>
        )}
        {backupProgress && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted, #888)',
                        background: 'var(--bg-subtle, rgba(0,0,0,.04))', borderRadius: 6,
                        padding: '6px 10px', lineHeight: 1.6 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 36, color: '#4a9', fontWeight: 600 }}>
                {(() => { const s = backupProgress.elapsedSec; return s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`; })()}
              </span>
              <span>
                Started {backupProgress.startedAt instanceof Date
                  ? backupProgress.startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : ''}
              </span>
              {backupProgress.merging
                ? <span style={{ color: '#4a9' }}>Compressing to .gz…</span>
                : backupProgress.activeTables.size > 0
                ? <span>Exporting: <strong>{[...backupProgress.activeTables].join(', ')}</strong></span>
                : null}
            </div>
            {backupProgress.doneTables.length > 0 && (
              <div style={{ marginTop: 2, color: 'var(--text-muted, #888)', fontSize: 11 }}>
                Done: {backupProgress.doneTables.join(' · ')}
              </div>
            )}
          </div>
        )}
        {restoreProgress && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted, #888)',
                        background: 'var(--bg-subtle, rgba(0,0,0,.04))', borderRadius: 6,
                        padding: '6px 10px', lineHeight: 1.6 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 36, color: '#c8a', fontWeight: 600 }}>
                {(() => { const s = restoreProgress.elapsedSec; return s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s`; })()}
              </span>
              <span>
                Started {restoreProgress.startedAt instanceof Date
                  ? restoreProgress.startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : ''}
              </span>
              {restoreProgress.phase === 'choosing'
                ? <span>Waiting for backup file selection…</span>
                : restoreProgress.phase === 'reading'
                ? <span>Decompressing backup file…</span>
                : restoreProgress.phase === 'lookups'
                ? <span style={{ color: '#c8a' }}>Rebuilding indexes…</span>
                : restoreProgress.phase === 'vacuum'
                ? <span style={{ color: '#c8a' }}>Compressing: <strong>{restoreProgress.vacuumTable}</strong></span>
                : restoreProgress.activeTables.size > 0
                ? <span>Inserting: <strong>{[...restoreProgress.activeTables].join(', ')}</strong></span>
                : null}
            </div>
            {restoreProgress.doneTables.length > 0 && (
              <div style={{ marginTop: 2, color: 'var(--text-muted, #888)', fontSize: 11 }}>
                Done: {restoreProgress.doneTables.join(' · ')}
              </div>
            )}
          </div>
        )}
        {dbResult && (
          <div style={{ marginTop: 8, fontSize: 12, color: dbResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)',
                        display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <span style={{ flex: 1 }}>{dbResult.message}</span>
            <button onClick={() => setDbResult(null)} title="Dismiss"
              style={{ background:'none', border:'none', cursor:'pointer', fontSize:16, lineHeight:1,
                       color:'inherit', opacity:0.55, padding:'0 2px', flexShrink:0 }}>×</button>
          </div>
        )}
        {dictDone && !dictRunning && (
          <div className="alert alert-success" style={{ marginTop: 8, marginBottom: 0 }}>Restore complete.</div>
        )}
        {dictLog.length > 0 && (
          <div ref={logRef} className="log-output" style={{ marginTop: 8, maxHeight: 'calc(100vh - 420px)', overflowY: 'auto' }}>
            {dictLog.map((l, i) => (
              <div key={i} className={l.startsWith('ERROR') ? 'log-err' : ''}>{l}</div>
            ))}
          </div>
        )}
      </div>

      {/* ── Database maintenance ─────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">Database maintenance</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={handleVacuum}
            disabled={!!dbOp} style={{ minWidth: 180 }}
            title="Runs VACUUM FULL + ANALYZE on all dictionary tables to reclaim disk space">
            {dbOp === 'vacuum' ? <><span className="spinner" /> Compressing…</> : '🗜 Compress Database'}
          </button>
          <button className="btn btn-secondary" onClick={handleRetokenize}
            disabled={!!dbOp || retokenizing} style={{ minWidth: 200 }}
            title="Re-applies updated tokenization rules to affected aliases only">
            {retokenizing ? <><span className="spinner" /> Retokenizing…</> : '🔤 Retokenize Aliases'}
          </button>
          <button className="btn btn-secondary" onClick={handleCleanObjectNames}
            disabled={cleaningObjNames} style={{ minWidth: 200 }}
            title="Removes ObjectNames rows with no aliases in any dictionary table, and removes exact duplicates">
            {cleaningObjNames ? <><span className="spinner" /> Cleaning…</> : '🧹 Clean ObjectNames'}
          </button>
          <button className="btn btn-secondary" onClick={handleDeduplicateAliases}
            disabled={deduplicating} style={{ minWidth: 200 }}
            title="Removes duplicate aliases from dictionary tables — keeps one copy when the same entity has multiple rows with the same normalized (Medscan) form and match type">
            {deduplicating ? <><span className="spinner" /> Deduplicating…</> : '🔁 Deduplicate Aliases'}
          </button>
          <button className="btn btn-secondary" onClick={handleFillAllCartridges}
            disabled={fillingCarts} style={{ minWidth: 200 }}
            title="Sets cartridges column on xwords term control tables to the full list of available cartridges (spelling and bracketstop are global — no cartridges column)">
            {fillingCarts ? <><span className="spinner" /> Filling…</> : '📦 Fill All Cartridges'}
          </button>
          {fillCartsResult && (
            <span style={{ fontSize: 12, color: fillCartsResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)',
                           display:'inline-flex', alignItems:'center', gap:4 }}>
              {fillCartsResult.message}
              <button onClick={() => setFillCartsResult(null)} title="Dismiss"
                style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                         color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
            </span>
          )}
          {retokenizeResult && (
            <span style={{ fontSize: 12, color: retokenizeResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)',
                           display:'inline-flex', alignItems:'center', gap:4 }}>
              {retokenizeResult.message}
              <button onClick={() => setRetokenizeResult(null)} title="Dismiss"
                style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                         color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
            </span>
          )}
          {cleanObjNamesResult && (
            <span style={{ fontSize: 12, color: cleanObjNamesResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)',
                           display:'inline-flex', alignItems:'center', gap:4 }}>
              {cleanObjNamesResult.message}
              <button onClick={() => setCleanObjNamesResult(null)} title="Dismiss"
                style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                         color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
            </span>
          )}
          {dedupResult && (
            <span style={{ fontSize: 12, color: dedupResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)',
                           display:'inline-flex', alignItems:'center', gap:4 }}>
              {dedupResult.message}
              <button onClick={() => setDedupResult(null)} title="Dismiss"
                style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                         color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
            </span>
          )}
          {vacuumResult && (
            <span style={{ fontSize: 12, color: vacuumResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)',
                           display:'inline-flex', alignItems:'center', gap:4 }}>
              {vacuumResult.message}
              <button onClick={() => setVacuumResult(null)} title="Dismiss"
                style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                         color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
            </span>
          )}
        </div>
        {vacuumDetails && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text-muted)' }}>Per-table details</summary>
            <table style={{ marginTop: 6, fontSize: 11, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Table', 'Before', 'After', 'Freed'].map(h => (
                    <th key={h} style={{ padding: '2px 12px 2px 0', textAlign: 'left', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vacuumDetails.map(({ table, before, after }) => {
                  const fmt = (b) => b >= 1048576 ? `${(b/1048576).toFixed(1)} MB` : `${(b/1024).toFixed(0)} KB`;
                  const freed = before - after;
                  return (
                    <tr key={table}>
                      <td style={{ padding: '2px 12px 2px 0', fontFamily: 'monospace' }}>{table}</td>
                      <td style={{ padding: '2px 12px', textAlign: 'right' }}>{fmt(before)}</td>
                      <td style={{ padding: '2px 12px', textAlign: 'right' }}>{fmt(after)}</td>
                      <td style={{ padding: '2px 0', textAlign: 'right', color: freed > 0 ? 'var(--success, #2a9)' : 'var(--text-muted)' }}>
                        {freed > 0 ? `-${fmt(freed)}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        )}
        <div className="text-xs text-muted mt-8">
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>Compress Database</span> runs VACUUM FULL + ANALYZE to reclaim disk space after bulk imports.{' '}
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>Retokenize Aliases</span> re-applies updated tokenization rules to all stored tokens (run after updating the app).{' '}
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>Clean ObjectNames</span> removes entity records that have no aliases in any dictionary table, and removes duplicate entries with the same NLP ID and URN.{' '}
          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>Deduplicate Aliases</span> removes duplicate rows from dictionary tables where the same entity has multiple aliases with the same normalized (Medscan) form and match type (differences in cartridges or organisms are disregarded).
        </div>
        {objNamesConflicts !== null && (
          <div style={{ marginTop: 12 }}>
            {objNamesConflicts.length === 0 ? (
              <div className="alert alert-success" style={{ fontSize: 12, marginBottom: 0 }}>
                No remaining conflicts in ObjectNames — all NLP IDs have unique URNs and names.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: 'var(--warning, #c80)' }}>
                  ⚠ {objNamesConflicts.length.toLocaleString()} NLP ID{objNamesConflicts.length !== 1 ? 's' : ''} with conflicting URNs or names in ObjectNames
                  {objNamesConflicts.length === 2000 ? ' (showing first 2000)' : ''}
                </div>
                <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 320 }}>
                  <table className="data-table" style={{ width: '100%', fontSize: 12, tableLayout: 'fixed' }}>
                    <colgroup>
                      <col style={{ width: 90 }} />
                      <col />
                      <col />
                    </colgroup>
                    <thead style={{ position: 'sticky', top: 0, background: 'var(--surface-2, #1e2030)', zIndex: 1 }}>
                      <tr>
                        <th>NLP ID</th>
                        <th>Names</th>
                        <th>URNs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {objNamesConflicts.map((c, i) => (
                        <tr key={i}>
                          <td className="mono">{c.medscanId}</td>
                          <td style={{ wordBreak: 'break-word', fontSize: 11 }}>
                            {c.names.map((name, ni) => (
                              <React.Fragment key={ni}>
                                {ni > 0 && <br />}
                                {onEditRecord ? (
                                  <button
                                    className="link-btn"
                                    style={{ textAlign: 'left', fontSize: 11 }}
                                    title={`Open NLP ID ${c.medscanId} in Edit Record`}
                                    onClick={() => onEditRecord(c.medscanId)}
                                  >{name}</button>
                                ) : name}
                              </React.Fragment>
                            ))}
                          </td>
                          <td style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, color: 'var(--text-muted)' }}>
                            {c.urns.join('\n')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Records: Export / Import ──────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">Records</div>

        {/* Export Records */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
          <button className="btn btn-secondary" onClick={handleExportRecords}
            disabled={exporting} style={{ minWidth: 160, borderColor: '#4a9', color: '#4a9' }}>
            {exporting ? <><span className="spinner" /> Exporting…</> : '📤 Export Records'}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            Updated from
            <input type="date" className="form-control" style={{ width: 150 }}
              value={exportDateFrom} onChange={e => setExportDateFrom(e.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            to
            <input type="date" className="form-control" style={{ width: 150 }}
              value={exportDateTo} onChange={e => setExportDateTo(e.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={exportCuratedOnly} onChange={e => setExportCuratedOnly(e.target.checked)} />
            Curated records only
          </label>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            Format:
            {['json', 'csv'].map(fmt => (
              <label key={fmt} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}>
                <input type="radio" name="exportFormat" value={fmt}
                  checked={exportFormat === fmt} onChange={() => setExportFormat(fmt)} />
                {fmt.toUpperCase()}
              </label>
            ))}
          </span>
          {exportResult && (
            <span style={{ fontSize: 12, color: exportResult.ok ? 'var(--success, #2a9)' : 'var(--danger, #c33)',
                           display:'inline-flex', alignItems:'center', gap:4 }}>
              {exportResult.message}
              <button onClick={() => setExportResult(null)} title="Dismiss"
                style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, lineHeight:1,
                         color:'inherit', opacity:0.55, padding:'0 2px' }}>×</button>
            </span>
          )}
        </div>
        <div className="text-xs text-muted mt-4" style={{ marginBottom: 14 }}>
          Exports all alias rows: NLP ID, Name, URN, Alias, Dictionary, Flag, Organisms, Cartridges, Curated, Deleted, Dates.
          Leave date fields blank to export all. Limit: 500 000 rows.
        </div>

        {/* Import Records */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
          <label className="btn btn-danger" style={{ minWidth: 160, cursor: 'pointer', marginBottom: 0 }}>
            📥 Import Records
            <input type="file" accept=".json,.csv" style={{ display: 'none' }} onChange={handlePickImportFile} />
          </label>
          {importFileName && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{importFileName}</span>
          )}
        </div>
        {importRows !== null && (
          <>
            {importRows.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--danger, #c33)', marginBottom: 8 }}>
                No valid rows found in file (check format).
              </div>
            ) : (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 6 }}>
                  <strong>{importRows.length.toLocaleString()}</strong> rows to import:&nbsp;
                  {(() => {
                    const counts = {};
                    importRows.forEach(r => { const t = r[4]?.trim(); if (t) counts[t] = (counts[t] || 0) + 1; });
                    return Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join(' · ');
                  })()}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button className="btn btn-danger" onClick={handleConfirmImport}
                    disabled={importing} style={{ minWidth: 160 }}>
                    {importing ? <><span className="spinner" /> Importing…</> : '📥 Confirm Import'}
                  </button>
                  {importProgress && (
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {importProgress.current} / {importProgress.total}
                    </span>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        {importResult && (
          <div style={{ fontSize: 12, marginTop: 6 }}>
            <span style={{ color: importResult.ok ? 'var(--success, #2a9)' : 'var(--warning, #c80)' }}>
              Inserted: {importResult.inserted}, Skipped: {importResult.skipped}
            </span>
            {importResult.bdeletedSkipped > 0 && (
              <div style={{ color: 'var(--warning, #c80)', marginTop: 4 }}>
                {importResult.bdeletedSkipped} {importResult.bdeletedSkipped === 1 ? 'alias was' : 'aliases were'} found in bDeleted trash and were not imported.
              </div>
            )}
            {importResult.errors.length > 0 && (
              <div style={{ color: 'var(--danger, #c33)', marginTop: 4 }}>
                {importResult.errors.slice(0, 5).join(' | ')}
                {importResult.errors.length > 5 && ` … and ${importResult.errors.length - 5} more`}
              </div>
            )}
          </div>
        )}
        <div className="text-xs text-muted mt-4">
          Reads a JSON or CSV file exported by Export Records. Rows already present (same NLP ID + alias) are skipped.
        </div>
      </div>

      {/* ── Deploy dictionaries ──────────────────────────────────────────── */}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="card-header">Deploy dictionaries</div>
        <DbExport />
      </div>

    </div>
  );
}
