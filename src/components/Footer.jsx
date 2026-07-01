import React from 'react';
import { T, FONT } from '../theme';

export default function Footer({ isMobile }) {
  return (
    <footer
      style={{
        borderTop: `1px solid ${T.border}`,
        background: T.surface,
        padding: 20,
        marginTop: 40,
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <img
            src="/logo-wisiverse.png"
            alt="WiSiVERSE"
            style={{ height: 32 }}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <span style={{ fontFamily: FONT.ui, fontSize: 11, color: '#666666' }}>
            Part of the WiSiVERSE ecosystem
          </span>
        </div>
        <a
          href="https://wisiverse.com"
          target="_blank"
          rel="noreferrer"
          style={{
            color: T.primary,
            fontFamily: FONT.ui,
            fontWeight: 700,
            fontSize: 12,
            textTransform: 'uppercase',
            textDecoration: 'none',
            letterSpacing: '0.04em',
          }}
        >
          wisiverse.com →
        </a>
      </div>
    </footer>
  );
}
