import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../proxyAuth", () => ({ resolveApiKey: async () => "user-key" }));
vi.mock("../tokens/currentUser", () => ({ currentUser: async () => ({ ok: true, userId: "1" }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
import { POST } from "../stt/route";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("dictation timing propagation", () => {
  it("carries capture metadata to ASR and the correlation/timing headers back to the browser", async () => {
    vi.stubEnv("TINA_ADMIN_API_URL", "http://identity.test");
    vi.stubEnv("TINA_INTERNAL_API_SECRET", "INTERNAL-SECRET");
    const requestId = "11111111-1111-4111-8111-111111111111";
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ backend: "funasr", url: "http://asr.test", model: "custom" }))
      .mockResolvedValueOnce(Response.json({ text: "speech", segments: [] }, { headers: {
        "X-ASR-Request-ID": requestId, "Server-Timing": "asr_queue;dur=2, asr_inference;dur=100",
      } }));
    vi.stubGlobal("fetch", fetch);
    const response = await POST(new Request("http://127.0.0.1/api/stt", {
      method: "POST", body: new Uint8Array(1000), headers: { "X-ASR-Capture-Ms": "42" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-ASR-Request-ID")).toBe(requestId);
    expect(response.headers.get("Server-Timing")).toContain("asr_inference;dur=100");
    const headers = fetch.mock.calls[1][1].headers;
    expect(headers["X-ASR-Source"]).toBe("dictation");
    expect(headers["X-ASR-Capture-Ms"]).toBe("42");
    expect(headers["X-Internal-Secret"]).toBeUndefined();
  });
});
