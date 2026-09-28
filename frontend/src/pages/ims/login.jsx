import React, { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ROLE_HOME } from '../../auth/devUsers';

export default function Login() {
  const navigate = useNavigate();
  const { login, isAuthenticated, role } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Already logged in (e.g. hit the browser back button into "/") — bounce straight to the role's
  // home instead of showing the login form again. This is a push, not a replace: it keeps "/" as a
  // live entry in history (paired with the login redirect below also pushing) so the back button
  // always has an in-app entry to land on, which immediately bounces forward again — the back button
  // ends up just refreshing the current authenticated page instead of exiting the app entirely.
  if (isAuthenticated) {
    return <Navigate to={ROLE_HOME[role] || '/adminDashboard'} />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const authed = await login(username, password);
      const dest = ROLE_HOME[authed.role] || '/adminDashboard';
      navigate(dest);
    } catch (err) {
      setError(err.message || 'Login failed');
      setBusy(false);
    }
  };

  return (
    <div>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
        .custom-jakarta, .custom-jakarta input, .custom-jakarta button, .custom-jakarta label {
          font-family: 'Plus Jakarta Sans', sans-serif !important;
        }
      `}</style>

      <div
        className="custom-jakarta min-h-screen flex items-center justify-center antialiased bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url('/blue-bg2.jpg')` }}
      >
        <div className="w-full max-w-xs sm:max-w-md mx-4 p-4 sm:p-8 rounded-2xl sm:rounded-3xl bg-white/30 backdrop-blur-xl border border-white/100 shadow-2xl transition-all duration-500 hover:shadow-[0_0_40px_rgba(56,189,248,0.5)] hover:border-white/100 hover:bg-white/35">
          <div className="flex justify-center mb-2 sm:mb-4">
            <img
              src="/aski.png"
              alt="Logo"
              className="w-28 h-auto sm:w-64 object-contain rounded-2xl drop-shadow-md transition-all duration-300"
            />
          </div>

          <h1 className="text-xl sm:text-3xl font-bold text-black-800 text-center mb-4 sm:mb-8 tracking-tight">
            AMPC Inventory
          </h1>

          <form className="space-y-3 sm:space-y-5" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="username" className="block text-xs sm:text-sm font-semibold text-slate-700 mb-1 sm:mb-1.5">
                Username
              </label>
              <input
                type="text"
                id="username"
                name="username"
                required
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-white/25 backdrop-blur-md border border-white/60 text-slate-800 placeholder-slate-500/80 shadow-[inset_0_1px_2px_rgba(255,255,255,0.6),0_4px_12px_rgba(0,0,0,0.05)] focus:outline-none focus:ring-2 focus:ring-white/80 focus:bg-white/40 focus:border-white transition-all duration-200"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs sm:text-sm font-semibold text-slate-700 mb-1 sm:mb-1.5">
                Password
              </label>
              <input
                type="password"
                id="password"
                name="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                className="w-full px-3.5 py-2.5 sm:px-4 sm:py-3 rounded-xl bg-white/25 backdrop-blur-md border border-white/60 text-slate-800 placeholder-slate-500/80 shadow-[inset_0_1px_2px_rgba(255,255,255,0.6),0_4px_12px_rgba(0,0,0,0.05)] focus:outline-none focus:ring-2 focus:ring-white/80 focus:bg-white/40 focus:border-white transition-all duration-200"
              />
            </div>

            {error && (
              <p role="alert" className="text-xs sm:text-sm font-semibold text-rose-700 bg-rose-100/80 border border-rose-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <div className="pt-2 sm:pt-6">
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 sm:py-3.5 mt-1 sm:mt-2 rounded-full flex items-center justify-center text-sm sm:text-base text-slate-900 font-bold tracking-wide border border-white/80 backdrop-blur-md shadow-[inset_0_2px_4px_rgba(255,255,255,0.8),inset_0_-2px_4px_rgba(0,0,0,0.1),0_8px_20px_rgba(56,189,248,0.35)] transition-all duration-300 hover:shadow-[inset_0_2px_6px_rgba(255,255,255,1),0_12px_28px_rgba(56,189,248,0.5)] hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] bg-gradient-to-r from-sky-200 via-sky-300 to-blue-400 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {busy ? 'Signing in…' : 'Log in'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
