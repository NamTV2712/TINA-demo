"use client";
/** SetupGate — the ADMIN first-run wizard (first-run onboarding design, 2026-07-09). Sits inside
 *  AuthGate: once the bootstrap-claimed admin signs in, this walks the two things a meeting needs
 *  — the agent model and the transcription backend — each SMOKE-TESTED inline against the real
 *  backend (the same /api/{models,transcription}/test edges Settings → Models ships), writing the
 *  GLOBAL platform settings (this is the instance-wide admin flow; per-user overrides stay in
 *  Settings). Durable state lives in the platform-settings "setup" key, so the wizard shows once
 *  per INSTANCE, never per browser. Non-admins (the setup probe 404s → null) fall straight
 *  through — they can never see or affect instance setup.
 *
 *  Every step is skippable (the terminal must never hold the UI hostage); skipped steps are
 *  recorded so Settings can nudge later. */
import { useEffect, useState, type CSSProperties } from "react";
import {
  getGlobalSetting, setGlobalSetting, testModels, testTranscription,
  type ConfigTestResult, type GlobalSetting,
} from "../surfaces/settingsApi";
import { ChatGPTModelInput } from "../surfaces/chatGPTModelInput";

/** Show the wizard? null = not an admin (probe 404s); completed set = already ran. */
export function shouldShowSetup(setup: GlobalSetting | null): boolean {
  if (setup === null) return false;
  return setup.completed !== "true";
}

type Phase = "checking" | "hidden" | "wizard";
type StepState = "done" | "skipped";

const card: CSSProperties = {
  position: "relative",
  border: "1px solid var(--line2)", borderRadius: 10, padding: "13px 15px",
  display: "flex", flexDirection: "column", gap: 6, cursor: "pointer",
};
/** Visually hidden but still focusable — the real radio behind each provider card. */
const srOnly: CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};
const cardSel: CSSProperties = { ...card, border: "1px solid var(--accent)", background: "var(--panel2)" };
const field: CSSProperties = {
  width: "100%", boxSizing: "border-box", fontSize: 12.5, padding: "8px 10px", borderRadius: 7,
  border: "1px solid var(--line2)", background: "var(--panel2)", color: "var(--t1)",
};
const primaryBtn: CSSProperties = {
  background: "var(--accent)", color: "var(--on-accent)", border: "none", borderRadius: 7,
  padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer",
};
const quietBtn: CSSProperties = {
  background: "transparent", color: "var(--t2)", border: "1px solid var(--line2)", borderRadius: 7,
  padding: "8px 14px", fontSize: 12.5, cursor: "pointer",
};
const label: CSSProperties = {
  fontSize: 10.5, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--t3)", fontWeight: 600,
};

function TestLine({ res, err, busy }: { res: ConfigTestResult | null; err: string | null; busy: boolean }) {
  if (busy) return <span style={{ fontSize: 11.5, color: "var(--t3)" }}>Testing…</span>;
  if (err) return <span role="alert" style={{ fontSize: 11.5, color: "var(--danger)" }}>⚠ {err}</span>;
  if (!res) return null;
  return (
    <span style={{ fontSize: 11.5, color: res.ok ? "var(--green)" : "var(--danger)", lineHeight: 1.5 }}>
      {res.ok ? "✓" : "✗"} {res.summary}
    </span>
  );
}

/** Step 1 — agent model: Claude subscription on this machine (detect via the real test edge) or a
 *  custom OpenRouter/OpenAI-compatible endpoint. */
function ModelsStep({ onNext }: { onNext: (state: StepState) => void }) {
  type Choice = "subscription" | "openai-subscription" | "openai-api" | "antigravity" | "bedrock" | "custom";
  const [choice, setChoice] = useState<Choice>("subscription");
  const [detect, setDetect] = useState<ConfigTestResult | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [model, setModel] = useState("");
  const [res, setRes] = useState<ConfigTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chatgptConnected, setChatgptConnected] = useState(false);
  const [antigravityAcknowledged, setAntigravityAcknowledged] = useState(false);
  const [antigravitySaved, setAntigravitySaved] = useState(false);

  const recheck = () => {
    setDetecting(true);
    testModels().then((r) => { setDetect(r); setDetecting(false); })
      .catch((e: unknown) => { setDetect({ ok: false, summary: e instanceof Error ? e.message : String(e) }); setDetecting(false); });
  };
  useEffect(recheck, []);
  useEffect(() => {
    let on = true;
    fetch("/api/models/openai/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { connected: false }))
      .then((d: { connected?: boolean }) => on && setChatgptConnected(d.connected === true))
      .catch(() => undefined);
    return () => { on = false; };
  }, []);

  const detected = !detecting && detect?.ok === true;

  const saveAndTest = async (selected: Choice = choice) => {
    setBusy(true); setErr(null); setRes(null);
    try {
      if (selected === "custom") {
        await setGlobalSetting("models", {
          mode: "custom", base_url: baseUrl.trim(), api_key: apiKey.trim(), model: model.trim(),
        });
      } else if (selected === "openai-api") {
        await setGlobalSetting("models", {
          mode: "openai-api", base_url: "https://api.openai.com/v1", api_key: apiKey.trim(), model: model.trim(),
        });
      } else if (selected === "bedrock") {
        await setGlobalSetting("models", {
          mode: "bedrock", region: region.trim(), api_key: apiKey.trim(), model: model.trim(),
        });
      } else if (selected === "antigravity") {
        if (!antigravityAcknowledged) throw new Error("Acknowledge the Antigravity Terms warning before continuing.");
        await setGlobalSetting("models", {
          mode: "antigravity", api_key: apiKey.trim(), model: model.trim(),
          antigravity_terms_acknowledged: "true",
        });
        setAntigravitySaved(true);
        return;
      } else if (selected === "openai-subscription") {
        await setGlobalSetting("models", { mode: "openai-subscription", model: model.trim() });
      } else {
        await setGlobalSetting("models", { mode: "subscription" });
      }
      setRes(await testModels());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connectChatGPT = async () => {
    const popup = window.open("about:blank", "tina-chatgpt-signin", "popup,width=520,height=720");
    setBusy(true); setErr(null); setRes(null);
    try {
      await setGlobalSetting("models", { mode: "openai-subscription", model: model.trim() });
      const response = await fetch("/api/models/openai/start", { method: "POST", cache: "no-store" });
      const body = await response.json().catch(() => ({})) as { authorization_url?: string; error?: string };
      if (!response.ok || !body.authorization_url) throw new Error(body.error || `Sign-in failed (${response.status})`);
      if (popup) popup.location.href = body.authorization_url;
      else window.location.href = body.authorization_url;
    } catch (e: unknown) {
      popup?.close();
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      let localAlias = false;
      try {
        const sender = new URL(event.origin), app = new URL(window.location.href);
        localAlias = sender.protocol === "http:" && app.protocol === "http:"
          && sender.hostname === "127.0.0.1" && app.hostname === "localhost" && sender.port === app.port;
      } catch { /* invalid origin */ }
      if ((event.origin !== window.location.origin && !localAlias)
          || event.data?.type !== "tina-chatgpt-connected") return;
      setChatgptConnected(true);
      setErr(null); setRes(null);
      if (model.trim()) void saveAndTest("openai-subscription");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // The popup completion should use the latest model value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const canContinue = (choice === "subscription" && detected) || res?.ok === true
    || (choice === "antigravity" && antigravityAcknowledged && antigravitySaved);

  return (
    <>
      <div style={{ fontSize: 19, fontWeight: 650, color: "var(--t1)" }}>How should the agent think?</div>
      <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5 }}>
        Pick the model provider for chat, briefs, and meeting notes. You can change this anytime in
        Settings → Models.
      </div>

      <div className="choice-card" style={choice === "subscription" ? cardSel : card} onClick={() => setChoice("subscription")}>
        <input type="radio" name="model-provider" id="mp-subscription" style={srOnly}
          checked={choice === "subscription"} onChange={() => setChoice("subscription")} />
        <label htmlFor="mp-subscription" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--t1)", cursor: "pointer" }}>
          <Radio on={choice === "subscription"} /> Claude subscription on this machine
          {detecting
            ? <Badge tone="muted">checking…</Badge>
            : detected ? <Badge tone="ok">detected</Badge> : <Badge tone="warn">not detected</Badge>}
        </label>
        <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, marginLeft: 22 }}>
          Uses the Claude Code credentials already on this computer. No API key needed.
        </div>
        {!detecting && !detected && (
          <div style={{ marginLeft: 22, display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ fontSize: 11.5, color: "var(--t2)", lineHeight: 1.5 }}>
              No Claude credentials detected in the deployment environment. Set up a model
              provider via <code style={{ fontSize: 11, fontFamily: "var(--mono)", background: "var(--panel2)", padding: "1px 4px", borderRadius: 3 }}>HOST_CLAUDE_CREDENTIALS</code>{" "}
              in deployment settings or select the "OpenRouter or custom endpoint" option above.
              You can change this later in Settings → Models.
            </div>
            {detect && !detect.ok && <TestLine res={detect} err={null} busy={false} />}
            <button style={{ ...quietBtn, alignSelf: "flex-start" }} onClick={(e) => { e.stopPropagation(); recheck(); }}>
              Re-check
            </button>
          </div>
        )}
        {detected && choice === "subscription" && (
          <div style={{ marginLeft: 22 }}><TestLine res={detect} err={null} busy={false} /></div>
        )}
      </div>

      <div className="choice-card" style={choice === "openai-subscription" ? cardSel : card} onClick={() => setChoice("openai-subscription")}>
        <input type="radio" name="model-provider" id="mp-openai-subscription" style={srOnly}
          checked={choice === "openai-subscription"} onChange={() => setChoice("openai-subscription")} />
        <label htmlFor="mp-openai-subscription" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--t1)", cursor: "pointer" }}>
          <Radio on={choice === "openai-subscription"} /> ChatGPT plan (Codex app-server)
          {chatgptConnected && <Badge tone="ok">connected</Badge>}
        </label>
        <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, marginLeft: 22 }}>
          Connect your ChatGPT account and allow TINA to use eligible plan usage. Requests count toward that account&rsquo;s usage.
        </div>
        {choice === "openai-subscription" && (
          <div style={{ marginLeft: 22, display: "flex", flexDirection: "column", gap: 7 }}>
            <ChatGPTModelInput value={model} onChange={setModel} style={field} />
            <button style={{ ...quietBtn, alignSelf: "flex-start", opacity: busy ? 0.5 : 1 }} disabled={busy}
              onClick={(e) => { e.stopPropagation(); void connectChatGPT(); }}>
              {busy ? "Connecting…" : chatgptConnected ? "Reconnect with ChatGPT" : "Continue with ChatGPT"}
            </button>
            {chatgptConnected && <button style={{ ...quietBtn, alignSelf: "flex-start", opacity: busy ? 0.5 : 1 }} disabled={busy}
              onClick={(e) => { e.stopPropagation(); void saveAndTest("openai-subscription"); }}>
              {busy ? "Testing…" : "Save & test"}
            </button>}
          </div>
        )}
      </div>

      <div className="choice-card" style={choice === "openai-api" ? cardSel : card} onClick={() => setChoice("openai-api")}>
        <input type="radio" name="model-provider" id="mp-openai-api" style={srOnly}
          checked={choice === "openai-api"} onChange={() => setChoice("openai-api")} />
        <label htmlFor="mp-openai-api" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--t1)", cursor: "pointer" }}>
          <Radio on={choice === "openai-api"} /> OpenAI API key
        </label>
        <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, marginLeft: 22 }}>
          API usage is billed through your OpenAI API account, separately from your ChatGPT plan.
        </div>
        {choice === "openai-api" && (
          <div style={{ marginLeft: 22, display: "flex", flexDirection: "column", gap: 7 }}>
            <input style={field} placeholder="OpenAI API key" value={apiKey} type="password" onChange={(e) => setApiKey(e.target.value)} />
            <input style={field} placeholder="OpenAI API model ID" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
        )}
      </div>

      <div className="choice-card" style={choice === "antigravity" ? cardSel : card} onClick={() => setChoice("antigravity")}>
        <input type="radio" name="model-provider" id="mp-antigravity" style={srOnly}
          checked={choice === "antigravity"} onChange={() => setChoice("antigravity")} />
        <label htmlFor="mp-antigravity" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--t1)", cursor: "pointer" }}>
          <Radio on={choice === "antigravity"} /> Google Antigravity CLI (agy)
        </label>
        <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, marginLeft: 22 }}>
          Use a Gemini API key or Gemini Enterprise credential. This choice affects agent turns; meeting summaries keep using the deployment completion provider. Access is checked on the first agent turn.
        </div>
        {choice === "antigravity" && (
          <div style={{ marginLeft: 22, display: "flex", flexDirection: "column", gap: 8 }}>
            <div role="alert" style={{ border: "1px solid var(--danger)", borderRadius: 8, padding: "10px 12px", background: "color-mix(in srgb, var(--danger) 8%, transparent)", color: "var(--t2)", fontSize: 12, lineHeight: 1.5 }}>
              Google says third-party access to Antigravity violates its Terms of Service. Using a consumer-plan login with <code>agy</code> inside TINA is unsupported and may lead to account suspension or termination. Acknowledgment does not make it permitted. Use a Gemini API key or Gemini Enterprise for TINA.
            </div>
            <input style={field} placeholder="Gemini API key (optional)" value={apiKey} type="password" onChange={(e) => { setApiKey(e.target.value); setAntigravitySaved(false); }} />
            <input style={field} placeholder="Antigravity model ID (optional)" value={model} onChange={(e) => { setModel(e.target.value); setAntigravitySaved(false); }} />
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 11.5, color: "var(--t2)", lineHeight: 1.5 }}>
              <input type="checkbox" checked={antigravityAcknowledged} onChange={(e) => { setAntigravityAcknowledged(e.target.checked); setAntigravitySaved(false); }} />
              I have read this warning and acknowledge the account risk.
            </label>
            <button style={{ ...quietBtn, alignSelf: "flex-start", opacity: busy || !antigravityAcknowledged ? 0.5 : 1 }}
              disabled={busy || !antigravityAcknowledged}
              onClick={(e) => { e.stopPropagation(); void saveAndTest("antigravity"); }}>
              {busy ? "Saving…" : antigravitySaved ? "Saved" : "Save provider"}
            </button>
            {antigravitySaved && <span role="status" style={{ fontSize: 11.5, color: "var(--t3)" }}>Authentication and model access will be checked on the first agent turn.</span>}
          </div>
        )}
      </div>

      <div className="choice-card" style={choice === "bedrock" ? cardSel : card} onClick={() => setChoice("bedrock")}>
        <input type="radio" name="model-provider" id="mp-bedrock" style={srOnly}
          checked={choice === "bedrock"} onChange={() => setChoice("bedrock")} />
        <label htmlFor="mp-bedrock" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--t1)", cursor: "pointer" }}>
          <Radio on={choice === "bedrock"} /> AWS Bedrock
        </label>
        <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, marginLeft: 22 }}>
          Use a Bedrock API key with a Claude model enabled in your AWS account. Short-term keys expire and may need renewal.
        </div>
        {choice === "bedrock" && (
          <div style={{ marginLeft: 22, display: "flex", flexDirection: "column", gap: 7 }}>
            <input style={field} placeholder="AWS region (e.g. us-east-1)" value={region} onChange={(e) => setRegion(e.target.value)} />
            <input style={field} placeholder="Bedrock API key" value={apiKey} type="password" onChange={(e) => setApiKey(e.target.value)} />
            <input style={field} placeholder="Claude model ID enabled in your AWS region" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
        )}
      </div>

      <div className="choice-card" style={choice === "custom" ? cardSel : card} onClick={() => setChoice("custom")}>
        <input type="radio" name="model-provider" id="mp-custom" style={srOnly}
          checked={choice === "custom"} onChange={() => setChoice("custom")} />
        <label htmlFor="mp-custom" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--t1)", cursor: "pointer" }}>
          <Radio on={choice === "custom"} /> OpenRouter or custom endpoint
        </label>
        <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, marginLeft: 22 }}>
          Any Anthropic/OpenAI-compatible endpoint. Bring your own key.
        </div>
        {choice === "custom" && (
          <div style={{ marginLeft: 22, display: "flex", flexDirection: "column", gap: 7 }}>
            <input style={field} placeholder="https://openrouter.ai/api/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <input style={field} placeholder="API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <input style={field} placeholder="Model — e.g. anthropic/claude-sonnet-4.5" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 24 }}>
        {choice === "custom" && (
          <button style={{ ...quietBtn, opacity: busy || !baseUrl.trim() ? 0.5 : 1 }} disabled={busy || !baseUrl.trim()}
            onClick={() => void saveAndTest("custom")}>
            {busy ? "Testing…" : "Save & test"}
          </button>
        )}
        {choice === "openai-api" && (
          <button style={{ ...quietBtn, opacity: busy || !apiKey.trim() || !model.trim() ? 0.5 : 1 }} disabled={busy || !apiKey.trim() || !model.trim()}
            onClick={() => void saveAndTest("openai-api")}>{busy ? "Testing…" : "Save & test"}</button>
        )}
        {choice === "bedrock" && (
          <button style={{ ...quietBtn, opacity: busy || !apiKey.trim() || !region.trim() || !model.trim() ? 0.5 : 1 }} disabled={busy || !apiKey.trim() || !region.trim() || !model.trim()}
            onClick={() => void saveAndTest("bedrock")}>{busy ? "Testing…" : "Save & test"}</button>
        )}
        <TestLine res={res} err={err} busy={false} />
      </div>

      <Foot
        onSkip={() => onNext("skipped")}
        next={
          <button style={{ ...primaryBtn, opacity: canContinue ? 1 : 0.5 }} disabled={!canContinue}
            onClick={async () => {
              // Subscription path: persist the explicit choice so the instance default is declared.
              if (choice === "subscription" && !res) {
                try { await setGlobalSetting("models", { mode: "subscription" }); } catch { /* declarative only */ }
              }
              onNext("done");
            }}>
            Continue
          </button>
        }
      />
    </>
  );
}

/** Step 2 — transcription: connect to a self-hosted OpenAI-compatible STT service. */
function TranscriptionStep({ onNext }: { onNext: (state: StepState) => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [res, setRes] = useState<ConfigTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The deployment env may already carry a working backend —
  // surface that: a green pre-test means "you can just continue".
  useEffect(() => {
    testTranscription().then(setRes).catch(() => undefined);
  }, []);

  const saveAndTest = async () => {
    setBusy(true); setErr(null);
    try {
      await setGlobalSetting("transcription", { url: url.trim(), token: token.trim() });
      setRes(await testTranscription());
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const dirty = !!url.trim();

  return (
    <>
      <div style={{ fontSize: 19, fontWeight: 650, color: "var(--t1)" }}>Self-hosted transcription</div>
      <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5 }}>
        Point meeting bots at an OpenAI-compatible transcription endpoint you control.
      </div>

      <div style={cardSel}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--t1)" }}>
          <Radio on /> OpenAI-compatible endpoint
        </div>
        <div style={{ fontSize: 11.5, color: "var(--t3)", lineHeight: 1.5, marginLeft: 22 }}>
          Use a local or private STT service. The URL must be reachable from the TINA meeting service.
        </div>
        <div style={{ marginLeft: 22, display: "flex", flexDirection: "column", gap: 7 }}>
          <input style={field} placeholder="http://transcription:8083" value={url} onChange={(e) => setUrl(e.target.value)} />
          <input style={field} placeholder="API key (optional)" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 24 }}>
        <button style={{ ...quietBtn, opacity: busy || !dirty ? 0.5 : 1 }} disabled={busy || !dirty}
          onClick={() => void saveAndTest()}>
          {busy ? "Testing…" : "Save & test"}
        </button>
        <TestLine res={res} err={err} busy={busy} />
      </div>

      <Foot
        onSkip={() => onNext("skipped")}
        next={
          <button style={{ ...primaryBtn, opacity: res?.ok ? 1 : 0.5 }} disabled={!res?.ok} onClick={() => onNext("done")}>
            Finish setup
          </button>
        }
      />
    </>
  );
}

function Radio({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" style={{
      width: 13, height: 13, borderRadius: "50%", flex: "none", boxSizing: "border-box",
      border: on ? "4px solid var(--accent)" : "1.5px solid var(--t3)",
    }} />
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "muted"; children: React.ReactNode }) {
  const color = tone === "ok" ? "var(--green)" : tone === "warn" ? "var(--warn, #d3ab5f)" : "var(--t3)";
  return (
    <span style={{ fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", fontWeight: 650,
      color, border: `1px solid ${color}`, borderRadius: 4, padding: "1px 6px", opacity: 0.9 }}>
      {children}
    </span>
  );
}

function Foot({ onSkip, next }: { onSkip: () => void; next: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
      marginTop: 10, paddingTop: 14, borderTop: "1px dashed var(--line2)" }}>
      <button onClick={onSkip}
        style={{ background: "none", border: "none", color: "var(--t3)", fontSize: 12, cursor: "pointer", textDecoration: "underline", padding: 0 }}>
        Skip for now
      </button>
      {next}
    </div>
  );
}

function Steps({ at }: { at: 1 | 2 }) {
  const dot = (n: number, label: string) => {
    const on = at === n, done = at > n;
    return (
      <span key={n} style={{ display: "flex", alignItems: "center", gap: 6, color: on ? "var(--t1)" : "var(--t3)", fontSize: 11.5 }}>
        <span style={{
          width: 18, height: 18, borderRadius: "50%", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700,
          background: on ? "var(--accent)" : done ? "var(--panel2)" : "transparent",
          color: on ? "var(--on-accent)" : done ? "var(--green)" : "var(--t3)",
          border: on ? "none" : "1px solid var(--line2)",
        }}>{done ? "✓" : n}</span>
        {label}
      </span>
    );
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {dot(1, "Agent model")}
      <span style={{ width: 24, height: 1, background: "var(--line2)" }} />
      {dot(2, "Transcription")}
    </div>
  );
}

export function SetupGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [states, setStates] = useState<{ models?: StepState; transcription?: StepState }>({});

  useEffect(() => {
    let on = true;
    getGlobalSetting("setup")
      .then((v) => on && setPhase(shouldShowSetup(v) ? "wizard" : "hidden"))
      .catch(() => on && setPhase("hidden")); // fail-safe: never block the workbench on the probe
    return () => { on = false; };
  }, []);

  if (phase === "checking") return <div style={{ height: "100vh", background: "var(--bg)" }} />;
  if (phase === "hidden") return <>{children}</>;

  const advance = (key: "models" | "transcription", state: StepState) => {
    const next = { ...states, [key]: state };
    setStates(next);
    // Persist per-step state as it happens — a mid-wizard reload resumes honestly.
    void setGlobalSetting("setup", { [key]: state }).catch(() => undefined);
    if (key === "models") setStep(2);
    else setStep(3);
  };

  const finish = () => {
    void setGlobalSetting("setup", { completed: "true" }).catch(() => undefined);
    // The admin→user onboarding seam: "Go to Meetings" must actually LAND on Meetings. The
    // workbench's layout store initializes its rail from this persisted key (layout.ts LS_LIST)
    // and it is created only when the workbench mounts — i.e. after this gate unhides — so a
    // plain localStorage write is the whole hand-off.
    try { localStorage.setItem("tina.terminal.activeList.v1", "meetings"); } catch { /* noop */ }
    setPhase("hidden");
  };

  return (
    <div style={{ height: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", overflowY: "auto" }}>
      <div style={{ width: 520, maxWidth: "94vw", background: "var(--panel)", border: "1px solid var(--line2)",
        borderRadius: 12, padding: 26, display: "flex", flexDirection: "column", gap: 14, boxShadow: "0 8px 32px rgba(0,0,0,.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={label}>Set up your instance</span>
          {step < 3 && <Steps at={step as 1 | 2} />}
        </div>
        {step === 1 && <ModelsStep onNext={(s) => advance("models", s)} />}
        {step === 2 && <TranscriptionStep onNext={(s) => advance("transcription", s)} />}
        {step === 3 && (
          <>
            <div style={{ fontSize: 19, fontWeight: 650, color: "var(--t1)" }}>You&rsquo;re set ✓</div>
            <div style={{ fontSize: 12.5, color: "var(--t2)", lineHeight: 1.8 }}>
              <div style={{ color: states.models === "done" ? "var(--green)" : "var(--t3)" }}>
                {states.models === "done" ? "✓ Agent model configured and tested" : "○ Agent model skipped — finish it in Settings → Models"}
              </div>
              <div style={{ color: states.transcription === "done" ? "var(--green)" : "var(--t3)" }}>
                {states.transcription === "done" ? "✓ Transcription configured and tested" : "○ Transcription skipped — finish it in Settings → Models"}
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5 }}>
              Everything a meeting needs is wired up. Next: get a meeting in front of a bot — connect
              your calendar, plan a meeting, or drop a bot on a running Meet.
            </div>
            <div>
              <button style={primaryBtn} onClick={finish}>Go to Meetings</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
