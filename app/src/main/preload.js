const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // give the keyboard focus back to the page: after a native confirm() / alert() Electron leaves text boxes unable to take input
  refocus: () => ipcRenderer.send('app:refocus'),
  // Find in page (Ctrl+F)
  find: {
    run:      (a)  => ipcRenderer.invoke('find:run', a),
    stop:     ()   => ipcRenderer.invoke('find:stop'),
    keys:     (on) => ipcRenderer.send('find:keys', !!on),
    onClose:  (cb) => { const h = () => cb(); ipcRenderer.on('find:close', h); return () => ipcRenderer.removeListener('find:close', h); },
    onOpen:   (cb) => { const h = () => cb(); ipcRenderer.on('find:open', h); return () => ipcRenderer.removeListener('find:open', h); },
    onResult: (cb) => { const h = (_e, r) => cb(r); ipcRenderer.on('find:result', h); return () => ipcRenderer.removeListener('find:result', h); },
  },
  // Reader screen: load an article (URL / file) and run its text through the pipelines of the chosen cartridges
  reader: {
    fetchUrl: (url) => ipcRenderer.invoke('reader:fetchUrl', url),
    openFile: ()    => ipcRenderer.invoke('reader:openFile'),
    markup:    (a)  => ipcRenderer.invoke('reader:markup', a),
    relations: (a)  => ipcRenderer.invoke('reader:relations', a),
    onRelationsPart: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('reader:relations-part', h); return () => ipcRenderer.removeListener('reader:relations-part', h); },
    cancel:   ()    => ipcRenderer.invoke('reader:cancel'),
    corefAsk: (prompts) => ipcRenderer.invoke('reader:coref', { prompts }),
    onLlmProgress: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('reader:llm-progress', h); return () => ipcRenderer.removeListener('reader:llm-progress', h); },
    onCorefProgress: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('reader:coref-progress', h); return () => ipcRenderer.removeListener('reader:coref-progress', h); },
    onProgress: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('reader:progress', h); return () => ipcRenderer.removeListener('reader:progress', h); },
  },
  // LLM proxy — routes fetch through the main process to avoid CORS
  llm: {
    fetch: (args) => ipcRenderer.invoke('llm:fetch', args),
    // local LLM (Ollama on a port): state found at startup, re-probe, update events; conceptscan_llm location; the prompt sent with each sentence
    localState:    ()     => ipcRenderer.invoke('llm:local:state'),
    localRefresh:  ()     => ipcRenderer.invoke('llm:local:refresh'),
    onLocalUpdate: (cb)   => { const h = (_e, st) => cb(st); ipcRenderer.on('llm:local:update', h); return () => ipcRenderer.removeListener('llm:local:update', h); },
    findExe:       ()     => ipcRenderer.invoke('llm:exe:find'),
    tunnelStart:   (server) => ipcRenderer.invoke('llm:tunnel:start', { server }),
    tunnelStop:    ()     => ipcRenderer.invoke('llm:tunnel:stop'),
    tunnelState:   ()     => ipcRenderer.invoke('llm:tunnel:state'),
    onTunnelUpdate:(cb)   => { const h = (_e, st) => cb(st); ipcRenderer.on('llm:tunnel:update', h); return () => ipcRenderer.removeListener('llm:tunnel:update', h); },
    findPlink:     ()     => ipcRenderer.invoke('llm:plink:find'),
    // the LLM question/answer cache: "clear before each run" (memory only, off after a restart), clear it now
    cacheState:    ()     => ipcRenderer.invoke('llm:cache:get'),
    cacheSetClear: (on)   => ipcRenderer.invoke('llm:cache:setClear', on),
    cacheClearNow: ()     => ipcRenderer.invoke('llm:cache:clearNow'),
    onCacheFlag:   (cb)   => { const h = (_e, on) => cb(on); ipcRenderer.on('llm:cache:flag', h); return () => ipcRenderer.removeListener('llm:cache:flag', h); },
    defaultPrompt: (args) => ipcRenderer.invoke('llm:prompt:default', args),
    defaultReferentPrompt: () => ipcRenderer.invoke('llm:referent:default'),
  },
  centree: {
    test:       ()     => ipcRenderer.invoke('centree:test'),
    ontologies: (q)    => ipcRenderer.invoke('centree:ontologies', q),
    ontology:   (id)   => ipcRenderer.invoke('centree:ontology', id),
    term:       (args) => ipcRenderer.invoke('centree:term', args),      // { ontology, primaryId }
    classById:  (args) => ipcRenderer.invoke('centree:classById', args), // { ontology, classId }
    exactLabel: (args) => ipcRenderer.invoke('centree:exactLabel', args),// { ontology, label }
    search:     (args) => ipcRenderer.invoke('centree:search', args),    // { query, ontology?, from?, size? }
    branchCounts: (args) => ipcRenderer.invoke('centree:branchCounts', args),   // { runId, ontologyId, primaryIds } -> { ok, data:{ primaryId:{direct,total} } }
    ontologyShape: (ids) => ipcRenderer.invoke('centree:ontologyShape', ids),   // -> { ok, data:{ id:{roots,branches} } }
    downloadSelected: (args) => ipcRenderer.invoke('centree:downloadSelected', args),   // { runId, sources } -> { ok, file, count, per }
    ontologyStats: (ids) => ipcRenderer.invoke('centree:ontologyStats', ids),   // -> { ok, data:{ id:{classes,obsoleteClasses,properties,instances} } }
    listOntologies: () => ipcRenderer.invoke('centree:listOntologies'),   // -> { ok, data:[{id,name,loaded,version,lastLoaded,lastModified,type,keywords}] }
    fetchChanges: (args) => ipcRenderer.invoke('centree:fetchChanges', args),   // { runId, fromDate:'YYYY-MM-DD' } -> { ok, data:{ontologies:[{id,name,records}]} }
    prepare:    (args) => ipcRenderer.invoke('centree:prepare', args),           // { runId, ontologies, entityType } -> { ok, file, count }
    cancel:     (runId) => ipcRenderer.invoke('centree:cancel', runId),
    inspectDownload: (args) => ipcRenderer.invoke('centree:inspectDownload', args),   // { path:'/ontologies/download/x.zip' } -> { ok, file, bytes, entries:[{name,bytes,lines,head}] }
    branchChildren: (args) => ipcRenderer.invoke('centree:branchChildren', args),   // { ontologyId, parentClassId|null } -> { ok, data:[{classId,primaryId,label,numberOfChildren}] }
    classify:   (args) => ipcRenderer.invoke('centree:classify', args),            // { runId, ontologyId, primaryIds } -> { ok, data:{ primaryId:[ancestor ids] } }
    onProgress: (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on('centree:progress', h); return () => ipcRenderer.removeListener('centree:progress', h); },
    call:       (args) => ipcRenderer.invoke('centree:call', args),      // { method, path, query?, body? } for any other endpoint
  },
  // Settings
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s) => ipcRenderer.invoke('settings:set', s),
  },
  // Dialogs
  dialog: {
    openDir: (opts) => ipcRenderer.invoke('dialog:openDir', opts),
    openFiles: (format) => ipcRenderer.invoke('dialog:openFiles', format),
    openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  },
  // File system
  fs: {
    exists:           (p)       => ipcRenderer.invoke('fs:exists', p),
    listDir:          (p)       => ipcRenderer.invoke('fs:listDir', p),
    listDirDetailed:  (p)       => ipcRenderer.invoke('fs:listDirDetailed', p),
    quickPlaces:      ()        => ipcRenderer.invoke('fs:quickPlaces'),
    listDirRecursive: (p, ext) => ipcRenderer.invoke('fs:listDirRecursive', p, ext),
    readFile: (p) => ipcRenderer.invoke('fs:readFile', p),
    writeFile: (p, c) => ipcRenderer.invoke('fs:writeFile', p, c),
  },
  shell: {
    openFile:     (p)   => ipcRenderer.invoke('shell:openFile', p),
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  // MedScan
  medscan: {
    listCartridges:        () => ipcRenderer.invoke('medscan:listCartridges'),
    deployHtmlConverter:   (dir) => ipcRenderer.invoke('medscan:deployHtmlConverter', dir),
    run:             (opts) => ipcRenderer.invoke('medscan:run', opts),
    runCustom:       (opts) => ipcRenderer.invoke('medscan:runCustom', opts),
    buildCommands:   (opts) => ipcRenderer.invoke('medscan:buildCommands', opts),
    stopRun:         (id)   => ipcRenderer.invoke('medscan:stopRun', id),
    deployDicts:     (opts) => ipcRenderer.invoke('medscan:deployDicts', opts),
    mapDict:         (opts) => ipcRenderer.invoke('medscan:mapDict', opts),
    listOrganisms:   (p)    => ipcRenderer.invoke('medscan:listOrganisms', p),
    listBackups:     (opts) => ipcRenderer.invoke('medscan:listBackups', opts),
    restoreBackup:   (opts) => ipcRenderer.invoke('medscan:restoreBackup', opts),
    onRunEvent: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('run:event', handler);
      return () => ipcRenderer.removeListener('run:event', handler);
    },
    onDeployEvent: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('deploy:event', handler);
      return () => ipcRenderer.removeListener('deploy:event', handler);
    },
  },
  // Consyn OAuth + search
  consyn: {
    login:      ()      => ipcRenderer.invoke('consyn:login'),
    openSearch: (query) => ipcRenderer.invoke('consyn:openSearch', query),
  },
  // Literature download
  literature: {
    download:   (opts) => ipcRenderer.invoke('literature:download', opts),
    stop:       ()     => ipcRenderer.invoke('literature:stop'),
    testApiKey: (opts) => ipcRenderer.invoke('literature:testApiKey', opts),
    onEvent: (cb) => {
      ipcRenderer.on('literature:event', (_, data) => cb(data));
      return () => ipcRenderer.removeAllListeners('literature:event');
    },
  },
  // RNEF
  rnef: {
    parse:        (filePath) => ipcRenderer.invoke('rnef:parse', filePath),
    onParseProgress: (cb) => {
      const h = (_, d) => cb(d);
      ipcRenderer.on('rnef:progress', h);
      return () => ipcRenderer.removeListener('rnef:progress', h);
    },
    exportExcel:  (opts)     => ipcRenderer.invoke('results:exportExcel', opts),
    exportTable:  (opts)     => ipcRenderer.invoke('table:export', opts),
    exportRnef:   (opts)     => ipcRenderer.invoke('rnef:exportRnef', opts),
  },
  // DB
  db: {
    query:      (sql, params) => ipcRenderer.invoke('db:query', sql, params),
    queryArray: (sql, params) => ipcRenderer.invoke('db:queryArray', sql, params),
    bulkInsert: (args)       => ipcRenderer.invoke('db:bulkInsert', args),
    analyze:          (tables) => ipcRenderer.invoke('db:analyze', tables),
    migrate:   ()             => ipcRenderer.invoke('db:migrate'),
    resetPool: ()             => ipcRenderer.invoke('db:resetPool'),
    backup:             ()   => ipcRenderer.invoke('db:backup'),
    onBackupProgress:   (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('db:backup-progress', handler);
      return () => ipcRenderer.removeListener('db:backup-progress', handler);
    },
    restore:            ()   => ipcRenderer.invoke('db:restore'),
    onRestoreProgress:  (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('db:restore-progress', handler);
      return () => ipcRenderer.removeListener('db:restore-progress', handler);
    },
    vacuum:               ()      => ipcRenderer.invoke('db:vacuum'),
    retokenize:           ()      => ipcRenderer.invoke('db:retokenize'),
    cleanObjectNames:     ()      => ipcRenderer.invoke('db:cleanObjectNames'),
    deduplicateAliases:   ()      => ipcRenderer.invoke('db:deduplicateAliases'),
    fillAllCartridges:    ()      => ipcRenderer.invoke('db:fillAllCartridges'),
  },
  // New relation wizard (Patterns screen)
  relation: {
    macroDefs: (a) => ipcRenderer.invoke('relation:macroDefs', a),
    warmMacros: (a) => ipcRenderer.invoke('relation:warmMacros', a),
    findMacros: (a) => ipcRenderer.invoke('relation:findMacros', a),
    macroFiles: (a) => ipcRenderer.invoke('relation:macroFiles', a),
    addMacro: (a) => ipcRenderer.invoke('relation:addMacro', a),
    macroInfo: (a) => ipcRenderer.invoke('relation:macroInfo', a),
    editMacro: (a) => ipcRenderer.invoke('relation:editMacro', a),
    renameMacro: (a) => ipcRenderer.invoke('relation:renameMacro', a),
    recompilePlan: (a) => ipcRenderer.invoke('relation:recompilePlan', a),
    recompileAll: (a) => ipcRenderer.invoke('relation:recompileAll', a),
    recompileCancel: () => ipcRenderer.invoke('relation:recompileCancel'),
    onRecompileProgress: (cb) => {
      const handler = (_e, p) => cb(p);
      ipcRenderer.on('relation:recompileProgress', handler);
      return () => ipcRenderer.removeListener('relation:recompileProgress', handler);
    },
    readFile: (a) => ipcRenderer.invoke('relation:readFile', a),
    saveFile: (a) => ipcRenderer.invoke('relation:saveFile', a),
    checkFile: (a) => ipcRenderer.invoke('relation:checkFile', a),
    findSetDefs: (a) => ipcRenderer.invoke('relation:findSetDefs', a),
    compileFolder: (a) => ipcRenderer.invoke('relation:compileFolder', a),
    testPattern: (a) => ipcRenderer.invoke('relation:testPattern', a),
    otherCartridges: (a) => ipcRenderer.invoke('relation:otherCartridges', a),
    viewSet: (a) => ipcRenderer.invoke('relation:viewSet', a),
    findUsed: (a) => ipcRenderer.invoke('relation:findUsed', a),
    fixMacros: (a) => ipcRenderer.invoke('relation:fixMacros', a),
    relationMatches: (a) => ipcRenderer.invoke('relation:relationMatches', a),
    frameFolders: (a) => ipcRenderer.invoke('relation:frameFolders', a),
    findExtracting: (a) => ipcRenderer.invoke('relation:findExtracting', a),
    sentenceMarkup: (a) => ipcRenderer.invoke('relation:sentenceMarkup', a),
    otherCartridgeContexts: (a) => ipcRenderer.invoke('relation:otherCartridgeContexts', a),
    existingSets: (a) => ipcRenderer.invoke('relation:existingSets', a),
    macroPrompt: (a) => ipcRenderer.invoke('relation:macroPrompt', a),
    suggestContext: (a) => ipcRenderer.invoke('relation:suggestContext', a),
    frameCheck: (a) => ipcRenderer.invoke('relation:frameCheck', a),
    types:    (a) => ipcRenderer.invoke('relation:types', a),
    patternsFor: (a) => ipcRenderer.invoke('relation:patternsFor', a),
    info:     (a) => ipcRenderer.invoke('relation:info', a),
    entities: (a) => ipcRenderer.invoke('relation:entities', a),
    declare:  (a) => ipcRenderer.invoke('relation:declare', a),
    revert:   (a) => ipcRenderer.invoke('relation:revert', a),
    validate: (a) => ipcRenderer.invoke('relation:validate', a),
    generate: (a) => ipcRenderer.invoke('relation:generate', a),
    compile:  (a) => ipcRenderer.invoke('relation:compile', a),
  },
  // sdxml → msxml converter
  sdxml: {
    convert: (opts) => ipcRenderer.invoke('sdxml:convert', opts),
    onProgress: (cb) => {
      ipcRenderer.on('sdxml:progress', (_, data) => cb(data));
      return () => ipcRenderer.removeAllListeners('sdxml:progress');
    },
  },
  // NLP Filter files
  filter: {
    getDir: ()       => ipcRenderer.invoke('filter:getDir'),
    list:   ()       => ipcRenderer.invoke('filter:list'),
    read:   (p)      => ipcRenderer.invoke('filter:read', p),
    write:  (p, c)   => ipcRenderer.invoke('filter:write', { filePath: p, content: c }),
    create: (name)   => ipcRenderer.invoke('filter:create', name),
  },
  // Pipeline
  pipeline: {
    readIni:       (cartridgePath) => ipcRenderer.invoke('pipeline:readIni', cartridgePath),
    getUrnEntries: (opts)          => ipcRenderer.invoke('pipeline:getUrnEntries', opts),
    run:           (opts)          => ipcRenderer.invoke('pipeline:run', opts),
    runAll:        (opts)          => ipcRenderer.invoke('pipeline:runAll', opts),
    openLogs:      (cartridgePath) => ipcRenderer.invoke('pipeline:openLogs', cartridgePath),
    onEvent: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('pipeline:event', handler);
      return () => ipcRenderer.removeListener('pipeline:event', handler);
    },
    onAllEvent: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('pipeline:allEvent', handler);
      return () => ipcRenderer.removeListener('pipeline:allEvent', handler);
    },
  },
  // Dictionary refresh
  dict: {
    getLatestDate:          ()          => ipcRenderer.invoke('dict:getLatestDate'),
    refresh:                ()          => ipcRenderer.invoke('dict:refresh'),
    getMaxIdInRange:        (min, max)  => ipcRenderer.invoke('dict:getMaxIdInRange', min, max),
    listBackups:            ()          => ipcRenderer.invoke('dict:listBackups'),
    restoreFromBackupFile:  (zipPath)   => ipcRenderer.invoke('dict:restoreFromBackupFile', { zipPath }),
    onProgress:             (cb)        => ipcRenderer.on('dict:progress', (_, msg) => cb(msg)),
    offProgress:            ()          => ipcRenderer.removeAllListeners('dict:progress'),
  },
});
