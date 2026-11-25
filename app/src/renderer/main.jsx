import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// A render error used to leave a black window; show the error and let the user continue instead.
class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[render error]', error, info?.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, color: 'var(--text, #ddd)', fontFamily: 'sans-serif' }}>
        <h3 style={{ marginTop: 0 }}>Something went wrong in this screen</h3>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: 0.85 }}>{String(this.state.error?.stack || this.state.error)}</pre>
        <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>{' '}
        <button className="btn btn-secondary" onClick={() => window.location.reload()}>Reload app</button>
      </div>
    );
  }
}

// A native confirm() / alert() / prompt() leaves the text boxes of the page unable to take input (Electron on Windows): hand the focus back to the page right after one.
for (const name of ['confirm', 'alert', 'prompt']) {
  const native = window[name].bind(window);
  window[name] = (...args) => {
    const r = native(...args);
    setTimeout(() => { try { window.api && window.api.refocus && window.api.refocus(); } catch (_) { /* optional */ } }, 0);
    return r;
  };
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
