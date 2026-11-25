import React, { useState, useRef, useCallback } from 'react';
import RunnerScreen from './screens/RunnerScreen';
import ResultsScreen from './screens/ResultsScreen';
import DictionaryScreen from './screens/DictionaryScreen';
import PatternEditorScreen from './screens/PatternEditorScreen';
import SettingsScreen from './screens/SettingsScreen';
import LiteratureScreen from './screens/LiteratureScreen';
import PipelineScreen from './screens/PipelineScreen';
import DatabaseScreen from './screens/DatabaseScreen';
import ReaderScreen from './screens/ReaderScreen';
import ChemNamesApprovalHost from './components/ChemNamesApprovalHost';
import FindBar from './components/FindBar';

const NAV = [
  { id: 'reader',     label: 'Reader',               icon: '📖' },
  { id: 'literature', label: 'Literature', icon: '📥' },
  { id: 'runner',     label: 'NLP Runner',          icon: '▶' },
  { id: 'results',    label: 'Results',              icon: '📊' },
  { id: 'dict',       label: 'Dictionary',           icon: '📚' },
  { id: 'patterns',   label: 'Patterns',             icon: '🔧' },
  { id: 'pipeline',   label: 'Pipeline',             icon: '🔬' },
  { id: 'database',   label: 'Database',             icon: '🗄' },
  { id: 'settings',   label: 'Settings',             icon: '⚙' },
];

export default function App() {
  const [screen, setScreen] = useState('runner');
  const [resultFiles, setResultFiles] = useState([]);
  const [litPush,  setLitPush]  = useState({ text: '', seq: 0 });
  const [dictPush, setDictPush] = useState({ msId: null, seq: 0 });
  const [memory, setMemory] = useState(null);                         // relations of the Reader for the Results viewer (as an RNEF file)
  const [tableData, setTableData] = useState(null);                   // a table for the Results viewer (the sentences of the Reader)

  const contentRef    = useRef(null);
  const scrollPos     = useRef({});  // screen id → saved scrollTop

  // Save scroll for the current screen, switch, then restore for the target screen.
  const goScreen = useCallback((next) => {
    setScreen(prev => {
      if (contentRef.current) scrollPos.current[prev] = contentRef.current.scrollTop;
      return next;
    });
    // Restore after the new screen has rendered
    requestAnimationFrame(() => {
      if (contentRef.current) {
        contentRef.current.scrollTop = scrollPos.current[next] ?? 0;
      }
    });
  }, []);

  const handleRunComplete = (files) => {
    setResultFiles(files);
    if (files.length > 0) goScreen('results');
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-logo">NLPmanager</div>
        <nav className="sidebar-nav">
          {NAV.map(n => (
            <div
              key={n.id}
              className={`nav-item ${screen === n.id ? 'active' : ''}`}
              onClick={() => goScreen(n.id)}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </div>
          ))}
        </nav>
        <div style={{ padding: '12px 16px', fontSize: '11px', color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>
          Elsevier NLP Manager v1.0
        </div>
      </aside>
      <main className="content" ref={contentRef}>
        <div style={{ display: screen === 'reader'     ? 'contents' : 'none' }}><ReaderScreen onShowTable={(t) => { setTableData({ ...t, seq: Date.now() }); goScreen('results'); }} onShowRelations={(r) => { setTableData(null); setMemory({ ...r, seq: Date.now() }); goScreen('results'); }} /></div>
        <div style={{ display: screen === 'literature' ? 'contents' : 'none' }}><LiteratureScreen litPush={litPush} isActive={screen === 'literature'} /></div>
        <div style={{ display: screen === 'runner'    ? 'contents' : 'none' }}><RunnerScreen onRunComplete={handleRunComplete} /></div>
        <div style={{ display: screen === 'results'   ? 'contents' : 'none' }}><ResultsScreen initialFiles={resultFiles} tableData={tableData} memory={memory} onBackFromTable={() => goScreen('reader')} onCloseTable={() => setTableData(null)} onNodeIdClick={msId => { setDictPush(p => ({ msId, seq: p.seq + 1 })); goScreen('dict'); }} /></div>
        <div style={{ display: screen === 'dict'      ? 'contents' : 'none' }}><DictionaryScreen dictPush={dictPush} onFindLiterature={q => { setLitPush(p => ({ text: q, seq: p.seq + 1 })); goScreen('literature'); }} /></div>
        <div style={{ display: screen === 'patterns'  ? 'contents' : 'none' }}><PatternEditorScreen /></div>
        <div style={{ display: screen === 'pipeline'  ? 'contents' : 'none' }}><PipelineScreen onEditRecord={msId => { setDictPush(p => ({ msId, aliases: null, seq: p.seq + 1 })); goScreen('dict'); }} /></div>
        <div style={{ display: screen === 'database'  ? 'contents' : 'none' }}><DatabaseScreen onEditRecord={msId => { setDictPush(p => ({ msId, aliases: null, seq: p.seq + 1 })); goScreen('dict'); }} /></div>
        <div style={{ display: screen === 'settings'  ? 'contents' : 'none' }}><SettingsScreen onEditRecord={msId => { setDictPush(p => ({ msId, aliases: null, seq: p.seq + 1 })); goScreen('dict'); }} /></div>
      </main>
      <ChemNamesApprovalHost />
      <FindBar />
    </div>
  );
}
