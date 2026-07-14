import { useState } from "react";
import type { FormEvent } from "react";
import { login } from "./api";
import type { CurrentUser } from "./api";

const DEMO_ACCOUNTS = [
  { email: "alice@godoc.test", role: "Upload only (consultant)" },
  { email: "dana@godoc.test", role: "Upload only (consultant)" },
  { email: "bob@godoc.test", role: "Approve only (approver)" },
  { email: "carol@godoc.test", role: "Upload & approve (lead)" },
];

export default function Login({ onLogin }: { onLogin: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(email, password);
      onLogin(user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand-mark login-brand-mark">GD</div>
        <h1>Document Upload &amp; Acknowledgement</h1>
        <p className="subtitle">Sign in to continue</p>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit} className="upload-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button type="submit" className="primary-btn" disabled={busy}>
            {busy ? <span className="spinner" /> : "Sign in"}
          </button>
        </form>

        <div className="demo-accounts">
          <p className="demo-title">Demo accounts (password: password123)</p>
          <ul>
            {DEMO_ACCOUNTS.map((a) => (
              <li key={a.email}>
                <button
                  type="button"
                  className="demo-fill"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword("password123");
                  }}
                >
                  <code>{a.email}</code>
                  <span>{a.role}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
