import React, { useEffect, useState } from 'react';
import { T, FONT } from '../theme';
import { listChannels } from '../lib/db';

export default function Navbar({
  tabs,
  activeTab,
  onTab,
  isMobile,
  userEmail,
  onSignOut,
  hasActiveAutomation,
  idleVideoCount,
  onReturnToAutomation,
  onHome,
  onSelectChannel,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // "Canali" submenu. On desktop it's hover-driven (onMouseEnter/Leave on the row); on mobile,
  // where there is no hover, the same state is toggled by tapping the row.
  const [channelsOpen, setChannelsOpen] = useState(false);
  // "Impostazioni account" section — click-toggled on both platforms.
  const [accountOpen, setAccountOpen] = useState(false);
  // null = not loaded yet. Fetched fresh every time the menu opens so a channel created / renamed /
  // deleted elsewhere in the app is always reflected here without any cross-component wiring.
  const [channels, setChannels] = useState(null);

  useEffect(() => {
    if (!menuOpen) {
      // Collapse the sub-sections so the menu always reopens in its top-level state.
      setChannelsOpen(false);
      setAccountOpen(false);
      return;
    }
    let cancelled = false;
    listChannels()
      .then((list) => {
        if (cancelled) return;
        // Newest first — created_at is immutable, unlike listChannels' own updated_at order which
        // the automation cycle reshuffles constantly (same reasoning as ChannelsListStep).
        setChannels([...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
      })
      .catch((err) => {
        console.error('[Navbar] failed to load channels for the nav menu', err);
        if (!cancelled) setChannels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [menuOpen]);

  function selectChannel(channel) {
    setMenuOpen(false);
    setChannelsOpen(false);
    onSelectChannel?.(channel);
  }

  const hamburger = (
    <button
      onClick={() => setMenuOpen((v) => !v)}
      aria-label="Menu"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
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

  // WiSiVERSE wordmark pattern: the "WiSi" oval mark (logo-wisi.png) + the property name ("TUBE")
  // as text alongside it, together forming "WiSiTUBE" — never the full word spelled out as plain
  // text. The whole lockup is one clickable control back to home (the Channels list).
  const brand = (
    <button
      onClick={onHome}
      aria-label="WiSiTUBE — home"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
      }}
    >
      <img
        src="/logo-wisi.png"
        alt=""
        style={{ height: 26, display: 'block' }}
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
        TUBE
      </span>
    </button>
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

  // Always visible now — this is the entry point to the permanent automation status dashboard
  // (AutomationMirrorStep.jsx: live mirror when a run is active, plus the always-present "Videos in
  // progress"/"Recently completed" sections regardless). The pulse animation is the only thing still
  // gated on hasActiveAutomation (see App.jsx's currentAutomationRun) — a purely visual "something's
  // happening right now" accent, not a presence/absence toggle for the button itself.
  const returnBadge = (
    <button
      onClick={onReturnToAutomation}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: hasActiveAutomation ? T.yellow : T.surface,
        color: hasActiveAutomation ? '#FFFFFF' : T.textSecondary,
        border: hasActiveAutomation ? 'none' : `1px solid ${T.border}`,
        borderRadius: 3,
        padding: '7px 12px',
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
        fontFamily: FONT.ui,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        animation: hasActiveAutomation ? 'wisiPulse 1.6s infinite' : 'none',
      }}
    >
      {hasActiveAutomation ? '👁 Return to current generation' : '👁 Automation status'}
      {/* Messaging-app-style notification badge — count of videos genuinely idle (waitingReason
          'idle' from src/lib/db.js's listIncompleteVideos, polled in App.jsx), NOT videos
          legitimately waiting on Gemini Batch — those aren't stuck, there's nothing to flag. */}
      {idleVideoCount > 0 && (
        <span
          style={{
            position: 'absolute',
            top: -6,
            right: -6,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            borderRadius: 8,
            background: T.primary,
            color: '#FFFFFF',
            fontSize: 10,
            fontWeight: 700,
            fontFamily: FONT.ui,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
            border: '1.5px solid #FFFFFF',
          }}
        >
          {idleVideoCount > 99 ? '99+' : idleVideoCount}
        </span>
      )}
    </button>
  );

  const menuItemStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    width: '100%',
    background: 'transparent',
    border: 'none',
    padding: '9px 10px',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    fontFamily: FONT.ui,
    color: T.text,
    cursor: 'pointer',
    textAlign: 'left',
  };

  const channelItemStyle = {
    display: 'block',
    width: '100%',
    background: 'transparent',
    border: 'none',
    padding: '8px 10px',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    fontFamily: FONT.ui,
    color: T.text,
    cursor: 'pointer',
    textAlign: 'left',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const hintStyle = { padding: '8px 10px', fontSize: 11, color: T.textMuted, fontFamily: FONT.ui };

  // Desktop: a flyout panel to the right of the menu. Mobile: an inline, indented list under the row.
  const submenuStyle = isMobile
    ? {
        display: 'flex',
        flexDirection: 'column',
        marginLeft: 4,
        paddingLeft: 8,
        borderLeft: `2px solid ${T.border}`,
        maxHeight: 260,
        overflowY: 'auto',
      }
    : {
        position: 'absolute',
        top: 0,
        left: '100%',
        minWidth: 220,
        maxHeight: 320,
        overflowY: 'auto',
        background: '#FFFFFF',
        border: `1px solid ${T.border}`,
        borderRadius: 6,
        padding: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.10)',
        zIndex: 200,
      };

  const channelList = (
    <>
      {channels === null && <div style={hintStyle}>Caricamento…</div>}
      {channels?.length === 0 && <div style={hintStyle}>Nessun canale</div>}
      {channels?.map((c) => (
        <button
          key={c.id}
          style={channelItemStyle}
          onClick={() => selectChannel(c)}
          onMouseEnter={(e) => (e.currentTarget.style.background = T.surface)}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {c.name || 'Canale senza nome'}
        </button>
      ))}
    </>
  );

  const menuPanel = (
    <div
      role="menu"
      style={{
        marginTop: 10,
        width: isMobile ? '100%' : 280,
        maxWidth: '100%',
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        background: '#FFFFFF',
        padding: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {/* ---- Canali ---- */}
      <div
        style={{ position: 'relative' }}
        onMouseEnter={isMobile ? undefined : () => setChannelsOpen(true)}
        onMouseLeave={isMobile ? undefined : () => setChannelsOpen(false)}
      >
        <button
          style={menuItemStyle}
          onClick={isMobile ? () => setChannelsOpen((v) => !v) : undefined}
          aria-haspopup="menu"
          aria-expanded={channelsOpen}
        >
          <span>Canali</span>
          <span aria-hidden style={{ color: T.textMuted }}>{isMobile ? (channelsOpen ? '▾' : '▸') : '▸'}</span>
        </button>
        {channelsOpen && <div style={submenuStyle}>{channelList}</div>}
      </div>

      {/* ---- Impostazioni account ---- */}
      <div>
        <button style={menuItemStyle} onClick={() => setAccountOpen((v) => !v)} aria-expanded={accountOpen}>
          <span>Impostazioni account</span>
          <span aria-hidden style={{ color: T.textMuted }}>{accountOpen ? '▾' : '▸'}</span>
        </button>
        {accountOpen && (
          <div style={{ padding: '2px 10px 10px' }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: T.textSecondary,
                fontFamily: FONT.ui,
              }}
            >
              Email
            </div>
            <div style={{ fontSize: 12, color: T.text, fontFamily: FONT.ui, marginTop: 2 }}>{userEmail || '—'}</div>
            <div style={{ fontSize: 11, color: T.textMuted, fontFamily: FONT.ui, marginTop: 8 }}>
              Foto profilo e altre opzioni in arrivo.
            </div>
          </div>
        )}
      </div>

      {/* ---- Sign out ---- */}
      <button
        style={{ ...menuItemStyle, color: T.primary }}
        onClick={() => {
          setMenuOpen(false);
          onSignOut?.();
        }}
      >
        Sign out
      </button>

      {/* ---- Ecosystem footer chrome (unchanged) ---- */}
      <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 4, paddingTop: 8, paddingLeft: 10, paddingRight: 10, paddingBottom: 4 }}>
        <a
          href="https://wisiverse.com"
          target="_blank"
          rel="noreferrer"
          style={{ color: T.primary, fontFamily: FONT.ui, fontWeight: 700, fontSize: 12, textTransform: 'uppercase', textDecoration: 'none' }}
        >
          wisiverse.com →
        </a>
        <div style={{ color: T.textSecondary, fontSize: 11, fontFamily: FONT.ui, marginTop: 4 }}>
          WisiTube — AI faceless video studio. Part of the WiSiVERSE ecosystem.
        </div>
      </div>
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
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {pills}
              {returnBadge}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              {hamburger}
              {brand}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {returnBadge}
              {pills}
            </div>
          </div>
        )}
        {menuOpen && menuPanel}
      </div>
    </nav>
  );
}
