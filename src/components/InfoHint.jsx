import React, { useEffect, useRef, useState } from 'react';
import { T, FONT } from '../theme';

// Small circular "?" hint icon dropped next to a field/label to explain exactly what that field
// affects — purely explanatory, never interactive on its own. Hover reveals it on desktop; on
// mobile (no hover) a tap toggles it, and tapping anywhere else closes it. `text` is the exact
// explanation to show — no wording is invented here, callers always pass the real copy.
export default function InfoHint({ text, style }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDocPointerDown(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocPointerDown);
    return () => document.removeEventListener('mousedown', onDocPointerDown);
  }, [open]);

  if (!text) return null;

  return (
    <span
      ref={rootRef}
      style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle', marginLeft: 6, ...style }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label="More info"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: `1px solid ${T.textMuted}`,
          color: T.textMuted,
          fontSize: 9,
          fontWeight: 700,
          fontFamily: FONT.ui,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'help',
          userSelect: 'none',
          lineHeight: 1,
          flexShrink: 0,
          background: 'transparent',
        }}
      >
        ?
      </span>
      {open && (
        <span
          style={{
            position: 'absolute',
            bottom: '140%',
            left: 0,
            zIndex: 50,
            width: 240,
            maxWidth: '70vw',
            background: '#FFFFFF',
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            boxShadow: '0 4px 16px rgba(0,0,0,0.14)',
            padding: '8px 10px',
            fontSize: 11,
            fontWeight: 400,
            textTransform: 'none',
            letterSpacing: 'normal',
            lineHeight: 1.5,
            color: T.text,
            fontFamily: FONT.ui,
            pointerEvents: 'none',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
