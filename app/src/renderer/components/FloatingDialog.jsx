import React, { useEffect, useRef, useState } from 'react';

// A dialog that does not block the screen: drag it by its title bar, resize it by the corner handle (bottom right).
// Two of them can stand side by side; the one clicked last comes to the front.
let zTop = 10000;

export default function FloatingDialog({ title, width = 900, dock = null, children }) {
  const w = Math.min(width, Math.round(window.innerWidth * (dock ? 0.48 : 0.96)));
  const [pos, setPos] = useState(() => ({
    x: dock === 'left' ? 8 : dock === 'right' ? Math.max(8, window.innerWidth - w - 8) : Math.max(8, Math.round((window.innerWidth - w) / 2)),
    y: dock ? 8 : 24,
  }));
  const [z, setZ] = useState(() => ++zTop);
  const drag = useRef(null);
  const box = useRef(null);

  useEffect(() => {
    const move = (e) => {
      if (!drag.current) return;
      const r = box.current?.getBoundingClientRect();
      const x = Math.min(Math.max(8 - (r ? r.width - 120 : 0), e.clientX - drag.current.dx), window.innerWidth - 120);
      const y = Math.min(Math.max(0, e.clientY - drag.current.dy), window.innerHeight - 40);
      setPos({ x, y });
    };
    const up = () => { drag.current = null; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.userSelect = ''; };
  }, []);

  const front = () => { if (z !== zTop) setZ(++zTop); };
  const startDrag = (e) => {
    if (e.button !== 0) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    document.body.style.userSelect = 'none';
  };

  return (
    <div ref={box} className="modal" onMouseDown={front}
      style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: z, width: w, maxWidth: '98vw', maxHeight: 'calc(100vh - 16px)', minWidth: 360, minHeight: 160,
               padding: 0, overflow: 'auto', resize: 'both', boxSizing: 'border-box' }}>
      <div onMouseDown={startDrag} title="Drag to move"
        style={{ position: 'sticky', top: 0, zIndex: 1, padding: '12px 24px', cursor: 'move', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
                 fontSize: 15, fontWeight: 700, userSelect: 'none' }}>
        {title}
      </div>
      <div style={{ padding: '14px 24px 24px' }}>{children}</div>
    </div>
  );
}
