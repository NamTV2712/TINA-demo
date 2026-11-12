"use client";
import { useState, type FormEvent } from "react";

/** Production demo login; mounted only when /api/auth/password says it is configured. */
export function PasswordSignIn({ claiming }: { claiming: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ email, password }),
      });
      if (response.ok) {
        window.location.reload();
        return;
      }
      const data = await response.json().catch(() => ({})) as { error?: string };
      setError(data.error || "Sign-in failed");
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: 7,
    padding: "9px 10px", color: "var(--t1)", fontSize: 13, outline: "none",
  };
  const active = Boolean(email.trim() && password && !busy);

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label htmlFor="tina-login-email" style={{ color: "var(--t2)", fontSize: 12 }}>Email</label>
      <input id="tina-login-email" type="email" required autoComplete="username"
        value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="admin@example.com" style={inputStyle} />
      <label htmlFor="tina-login-password" style={{ color: "var(--t2)", fontSize: 12 }}>Password</label>
      <input id="tina-login-password" type="password" required autoComplete="current-password"
        value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
      {error && <div role="alert" style={{ color: "var(--danger)", fontSize: 12 }}>{error}</div>}
      <button type="submit" disabled={!active}
        style={{ background: active ? "var(--accent)" : "var(--panel2)",
          color: active ? "var(--on-accent)" : "var(--t3)", border: "none", borderRadius: 7,
          padding: "10px", fontSize: 13, fontWeight: 600, cursor: active ? "pointer" : "default" }}>
        {busy ? "Signing in…" : claiming ? "Sign in as administrator" : "Sign in"}
      </button>
    </form>
  );
}
