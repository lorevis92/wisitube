import React, { useState } from 'react';
import { T, FONT } from '../theme';

export default function Navbar({ tabs, activeTab, onTab, isMobile, userEmail, onSignOut }) {
  const [menuOpen, setMenuOpen] = useState(false);

  const hamburger = (
    <button
      onClick={() => setMenuOpen((v) => !v)}
      aria-label="Menu"
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: 3,
        padding: '7px 10px',
        background: '#FFFFFF',
        fontSize: 14,
        lineHeight: 1,
        color: T.text,
      }}
    >
      ☰
    </button>
  );

  const brand = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <img
        src="/logo-wisitube.png"
        alt="WisiTube"
        style={{ height: 28 }}
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
      <span
        style={{
          color: T.primary,
          textTransform: 'uppercase',
          fontFamily: FONT.ui,
          fontWeight: 800,
          fontSize: 16,
          letterSpacing: '0.03em',
        }}
      >
        WisiTube
      </span>
    </div>
  );

  const pills = (
    <div
      style={{
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: 3,
        padding: 3,
        display: 'flex',
        gap: 2,
        width: isMobile ? '100%' : 'auto',
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onTab(tab.id)}
            disabled={tab.disabled}
            style={{
              flex: isMobile ? 1 : 'none',
              background: active ? T.primary : 'transparent',
              color: active ? '#FFFFFF' : tab.disabled ? T.textMuted : '#666666',
              border: 'none',
              borderRadius: 3,
              padding: '7px 12px',
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontFamily: FONT.ui,
              cursor: tab.disabled ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <nav
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 100,
        background: '#FFFFFF',
        borderBottom: `1px solid ${T.border}`,
      }}
    >
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: isMobile ? '10px 14px' : '12px 20px' }}>
        {isMobile ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              {hamburger}
              {brand}
              <div style={{ width: 34 }} />
            </div>
            <div style={{ marginTop: 10 }}>{pills}</div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {hamburger}
              {brand}
            </div>
            {pills}
          </div>
        )}
        {menuOpen && (
          <div
            style={{
              marginTop: 10,
              border: `1px solid ${T.border}`,
              borderRadius: 4,
              background: '#FFFFFF',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <a
              href="https://wisiverse.com"
              target="_blank"
              rel="noreferrer"
              style={{ color: T.primary, fontFamily: FONT.ui, fontWeight: 700, fontSize: 12, textTransform: 'uppercase', textDecoration: 'none' }}
            >
              wisiverse.com →
            </a>
            <span style={{ color: T.textSecondary, fontSize: 11, fontFamily: FONT.ui }}>
              WisiTube — AI faceless video studio. Part of the WiSiVERSE ecosystem.
            </span>
            {userEmail && (
              <div
                style={{
                  marginTop: 4,
                  paddingTop: 10,
                  borderTop: `1px solid ${T.border}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ color: T.text, fontSize: 12, fontFamily: FONT.ui }}>{userEmail}</span>
                <button
                  onClick={onSignOut}
                  style={{
                    background: 'transparent',
                    color: T.textSecondary,
                    border: `1px solid ${T.border}`,
                    borderRadius: 3,
                    padding: '6px 12px',
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    fontFamily: FONT.ui,
                    cursor: 'pointer',
                  }}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
