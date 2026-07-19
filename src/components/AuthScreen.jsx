import React, { useState } from 'react';
import { T, FONT, card, label, btnPrimary, inputStyle } from '../theme';
import { supabase } from '../lib/supabase';

export default function AuthScreen() {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  function switchMode() {
    setMode((m) => (m === 'login' ? 'signup' : 'login'));
    setError('');
    setInfo('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!email.trim() || !password) {
      setError('Enter both email and password.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) throw signInError;
      } else {
        // This Supabase project is shared across the Wisi apps and its profile trigger filters on
        // this app metadata — without it, a WisiTube signup would leak into other apps' profiles.
        const { error: signUpError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { app: 'wisitube' } },
        });
        if (signUpError) throw signUpError;
        setInfo('Check your email to confirm your account, then sign in.');
      }
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: T.bg, padding: 20 }}>
      <div style={{ ...card, width: '100%', maxWidth: 380 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 22 }}>
          <img
            src="/logo-wisitube.png"
            alt="WisiTube"
            style={{ height: 36, marginBottom: 10 }}
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
              fontSize: 18,
              letterSpacing: '0.03em',
            }}
          >
            WisiTube
          </span>
        </div>

        <div style={label}>{mode === 'login' ? 'Sign in' : 'Create account'}</div>

        <form onSubmit={handleSubmit} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="email"
            style={inputStyle}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            style={inputStyle}
          />

          {error && <div style={{ fontSize: 12, color: T.primary, fontFamily: FONT.ui }}>{error}</div>}
          {info && <div style={{ fontSize: 12, color: T.green, fontFamily: FONT.ui }}>{info}</div>}

          <button type="submit" disabled={busy} style={{ ...btnPrimary, marginTop: 4, opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Sign up'}
          </button>
        </form>

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <button
            onClick={switchMode}
            style={{
              background: 'none',
              border: 'none',
              color: T.textSecondary,
              fontSize: 12,
              fontFamily: FONT.ui,
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}
