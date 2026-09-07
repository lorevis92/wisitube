import React, { useCallback, useEffect, useRef, useState } from 'react';
import { T, FONT, card, btnPrimary, btnGhost } from '../theme';

// Promise-based confirm / alert with the app's own modal look (blur overlay + centered card, same
// as the "Generate companion Short" / ImageLightbox modals) — a drop-in for window.confirm /
// window.alert, which don't match anything else in the UI.
//
//   const { confirm, notify, dialog } = useConfirm();
//   if (!(await confirm({ title, body, danger: true }))) return;     // -> boolean
//   await notify({ title, body });                                   // -> void
//   ...render {dialog} once, anywhere in the component's tree.
//
// A string is accepted anywhere `body` is: confirm('Delete this?'), notify('Done.').
export function useConfirm() {
  const [state, setState] = useState(null);
  const resolverRef = useRef(null);

  const open = useCallback((cfg) => {
    return new Promise((resolve) => {
      // If a dialog is somehow already open, resolve it as dismissed before replacing it.
      if (resolverRef.current) resolverRef.current(cfg.mode === 'confirm' ? false : undefined);
      resolverRef.current = resolve;
      setState(cfg);
    });
  }, []);

  const confirm = useCallback(
    (opts = {}) => {
      const o = typeof opts === 'string' ? { body: opts } : opts;
      return open({
        mode: 'confirm',
        title: o.title || 'Are you sure?',
        body: o.body || '',
        confirmLabel: o.confirmLabel || 'Confirm',
        cancelLabel: o.cancelLabel || 'Cancel',
        danger: !!o.danger,
      });
    },
    [open]
  );

  const notify = useCallback(
    (opts = {}) => {
      const o = typeof opts === 'string' ? { body: opts } : opts;
      return open({ mode: 'alert', title: o.title || '', body: o.body || '', confirmLabel: o.okLabel || 'OK' });
    },
    [open]
  );

  const settle = useCallback((result) => {
    const r = resolverRef.current;
    resolverRef.current = null;
    setState(null);
    if (r) r(result);
  }, []);

  const dialog = state ? (
    <ConfirmModal
      state={state}
      onConfirm={() => settle(state.mode === 'confirm' ? true : undefined)}
      onCancel={() => settle(state.mode === 'confirm' ? false : undefined)}
    />
  ) : null;

  return { confirm, notify, dialog };
}

function ConfirmModal({ state, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      // Enter confirms a plain confirm / dismisses an alert — but never a destructive one, where
      // an accidental keypress shouldn't be able to trigger the irreversible action.
      else if (e.key === 'Enter' && !state.danger) onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel, state.danger]);

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 3000,
        background: 'rgba(0,0,0,0.5)',
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
        style={{ ...card, width: '100%', maxWidth: 400, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        {state.title && <div style={{ fontFamily: FONT.ui, fontSize: 15, fontWeight: 700, color: T.text }}>{state.title}</div>}
        {state.body && (
          <div style={{ fontFamily: FONT.ui, fontSize: 12.5, color: T.textSecondary, lineHeight: 1.6, whiteSpace: 'pre-line' }}>
            {state.body}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
          {state.mode === 'confirm' && (
            <button onClick={onCancel} style={{ ...btnGhost, padding: '8px 14px', fontSize: 12 }}>
              {state.cancelLabel}
            </button>
          )}
          <button
            autoFocus={!state.danger}
            onClick={onConfirm}
            style={{
              ...(state.danger ? btnGhost : btnPrimary),
              ...(state.danger ? { color: T.primary, borderColor: T.primaryBorder } : {}),
              padding: '8px 14px',
              fontSize: 12,
            }}
          >
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
