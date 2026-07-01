// WiSiVERSE design system tokens — do not deviate.
export const T = {
  bg: '#FFFFFF',
  surface: '#F8F8F8',
  surfaceAlt: '#F0F0F0',
  border: '#E8E8E8',
  text: '#111111',
  textSecondary: '#666666',
  textMuted: '#AAAAAA',
  primary: '#E8352A',
  primaryLight: 'rgba(232,53,42,0.06)',
  primaryBorder: 'rgba(232,53,42,0.18)',
  green: '#00996A',
  yellow: '#B87000',
};

export const FONT = {
  ui: "'Syne', sans-serif",
  mono: "'DM Mono', monospace",
  display: 'Georgia, serif',
};

export const card = {
  background: '#FFFFFF',
  border: `1px solid ${T.border}`,
  borderRadius: 6,
  padding: 24,
};

export const label = {
  fontSize: 11,
  fontWeight: 700,
  color: T.textSecondary,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontFamily: FONT.ui,
};

export const btnPrimary = {
  background: T.primary,
  color: '#FFFFFF',
  border: `1px solid ${T.primary}`,
  borderRadius: 3,
  padding: '10px 18px',
  fontSize: 12,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  fontFamily: FONT.ui,
};

export const btnGhost = {
  background: 'transparent',
  color: T.textSecondary,
  border: `1px solid ${T.border}`,
  borderRadius: 3,
  padding: '10px 18px',
  fontSize: 12,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  fontFamily: FONT.ui,
};

export const inputStyle = {
  width: '100%',
  padding: '10px 12px',
  border: `1px solid ${T.border}`,
  borderRadius: 4,
  fontSize: 13,
  fontFamily: FONT.ui,
  color: T.text,
  background: '#FFFFFF',
};

export const mono = { fontFamily: FONT.mono };
