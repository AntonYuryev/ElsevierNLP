import React, { useEffect, useState } from 'react';
import { setChemNamesApprovalHandler } from '../../shared/casDictionary';

// Single approval dialog used by addToCasDictionary() (shared/casDictionary.js).
// Mounted once in App.jsx so every screen can trigger it.
export default function ChemNamesApprovalHost() {
  const [req, setReq] = useState(null); // { missingByAlias, resolve }

  useEffect(() => {
    setChemNamesApprovalHandler(missingByAlias => new Promise(resolve => setReq({ missingByAlias, resolve })));
    return () => setChemNamesApprovalHandler(null);
  }, []);

  if (!req) return null;
  const done = (ok) => { req.resolve(ok); setReq(null); };
  const nTokens = new Set(req.missingByAlias.flatMap(x => x.tokens)).size;

  return (
    <div className="modal-backdrop" style={{ zIndex: 10000 }}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-title">Missing chemNames tokens</div>
        <p style={{ fontSize: 13, marginBottom: 10 }}>
          {nTokens} token{nTokens !== 1 ? 's' : ''} used by the CASdictionary alias{req.missingByAlias.length !== 1 ? 'es' : ''} below
          do not exist in chemNames. Without them the alias cannot be matched in text.
        </p>
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto', marginBottom: 12 }}>
          <table className="data-table">
            <thead><tr><th>Alias</th><th>Missing tokens</th></tr></thead>
            <tbody>
              {req.missingByAlias.map(({ alias, tokens }) => (
                <tr key={alias}>
                  <td style={{ fontWeight: 600 }}>{alias}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 11 }}>{tokens.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Add the missing tokens to chemNames and continue adding to CASdictionary?
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={() => done(false)}>No — cancel</button>
          <button className="btn btn-primary" onClick={() => done(true)}>Yes — add tokens &amp; continue</button>
        </div>
      </div>
    </div>
  );
}
