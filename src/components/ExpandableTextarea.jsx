import React, { useEffect, useState } from 'react';
import { T, FONT, btnPrimary, inputStyle } from '../theme';

// Drop-in replacement for a raw <textarea> used for any substantial block of text (narration,
// image prompts, editorial/creative-direction notes, character bible fields…) — same compact size,
// same styling, same value/onChange/onBlur contract as a native textarea (every other prop is
// forwarded as-is), plus a small "⤢" expand affordance that opens the same value in a full-screen,
// blurred overlay (same visual pattern as ImageLightbox.jsx) with a much taller textarea for
// comfortable editing of long text. There is exactly one value of truth: the overlay's textarea
// calls the SAME onChange prop on every keystroke, so the parent's state stays live and in sync
// whether the user types in the compact box or the expanded one — nothing here duplicates state or
// buffers an edit to commit later.
//
// onBlur (if provided) is what most callers use for autosave-on-blur (see ChannelDashboardStep.jsx,
// AutomationStep.jsx) — it fires normally when the compact textarea loses focus (native DOM
// behavior, unchanged), and is also invoked when the overlay closes (Done / click outside /
// Escape), since closing the overlay is the expanded-editing equivalent of blurring the field.
export default function ExpandableTextarea({ value, onChange, onBlur, style, ...rest }) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  function close() {
    setExpanded(false);
    onBlur?.();
  }

  return (
    <>
      <div
        style={{ position: 'relative' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <textarea
          value={value}
          onChange={onChange}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          onFocus={() => setFocused(true)}
          style={style}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title="Expand to edit"
          aria-label="Expand to edit"
          style={{
            position: 'absolute',
            top: 5,
            right: 5,
            width: 20,
            height: 20,
            padding: 0,
            border: `1px solid ${T.border}`,
            borderRadius: 3,
            background: 'rgba(255,255,255,0.9)',
            color: T.textSecondary,
            fontSize: 11,
            lineHeight: 1,
            cursor: 'pointer',
            opacity: hovered || focused ? 1 : 0,
            transition: 'opacity 0.15s',
          }}
        >
          ⤢
        </button>
      </div>

      {expanded && (
        <div
          onClick={close}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 760,
              background: '#FFFFFF',
              borderRadius: 6,
              border: `1px solid ${T.border}`,
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              boxShadow: '0 8px 40px rgba(0,0,0,0.35)',
            }}
          >
            <textarea
              autoFocus
              value={value}
              onChange={onChange}
              placeholder={rest.placeholder}
              disabled={rest.disabled}
              style={{
                ...inputStyle,
                minHeight: '60vh',
                fontSize: 14,
                lineHeight: 1.6,
                resize: 'vertical',
                fontFamily: FONT.ui,
              }}
            />
            <button onClick={close} style={{ ...btnPrimary, alignSelf: 'flex-end' }}>
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
}
