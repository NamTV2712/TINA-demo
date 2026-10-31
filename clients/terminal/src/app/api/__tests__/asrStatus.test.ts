import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../admin/gate", () => ({ requireAdmin: vi.fn() }));
import { requireAdmin } from "../admin/gate";
import { GET } from "../admin/asr-status/route";
import { asrStatusEndpoint } from "../../../lib/asrStatus";

const fixture = () => JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../core/meetings/contracts/asr-status.v1/golden/Status.json"), "utf8"));

beforeEach(() => {
  vi.mocked(requireAdmin).mockResolvedValue({ email: "admin@example.test", userId: 1 });
  vi.stubEnv("TINA_ADMIN_API_URL", "http://identity.test");
  vi.stubEnv("TINA_INTERNAL_API_SECRET", "INTERNAL-SECRET");
  vi.stubEnv("TRANSCRIPTION_SERVICE_URL", "http://wrong-default.test");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("admin ASR status", () => {
  it("rejects non-admins before any upstream request", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(null);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await GET()).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves exactly the selected backend and strips secret/unknown fields", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ backend: "funasr", url: "http://asr.test/v1/audio/transcriptions", token: "ENDPOINT-TOKEN" }))
      .mockResolvedValueOnce(Response.json({ ...fixture(), api_key: "PRIVATE-KEY" }));
    vi.stubGlobal("fetch", fetch);
    const response = await GET();
    const data = await response.json();
    expect(data.state).toBe("ready");
    expect(data.service.model.asr_model).toBe("Qwen/Qwen3-ASR-0.6B");
    expect(fetch.mock.calls[1][0]).toBe("http://asr.test/status");
    expect(fetch.mock.calls[1][1].headers).toEqual({ Authorization: "Bearer ENDPOINT-TOKEN" });
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE-KEY|ENDPOINT-TOKEN|INTERNAL-SECRET/);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed when identity resolution fails", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("private diagnostic")); vi.stubGlobal("fetch", fetch);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain("private diagnostic");
  });

  it("distinguishes unsupported diagnostics and network failure", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ backend: "custom", url: "http://asr.test" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 })); vi.stubGlobal("fetch", fetch);
    expect((await (await GET()).json()).state).toBe("unsupported");
    fetch.mockResolvedValueOnce(Response.json({ backend: "custom", url: "http://asr.test" }))
      .mockRejectedValueOnce(new Error("unreachable"));
    expect((await (await GET()).json()).state).toBe("unreachable");
  });

  it("rejects a malformed successful diagnostics body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ backend: "funasr", url: "http://asr.test" }))
      .mockResolvedValueOnce(Response.json({ requests: { total: 0 } })));
    const data = await (await GET()).json();
    expect(data.state).toBe("unsupported");
    expect(data.service).toBeNull();
  });

  it("does not route an unconfigured named backend to the env floor", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ backend: "funasr" })); vi.stubGlobal("fetch", fetch);
    expect((await (await GET()).json()).state).toBe("unconfigured");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("supports a base URL and the complete transcription endpoint", () => {
    expect(asrStatusEndpoint("http://asr.test/")).toBe("http://asr.test/status");
    expect(asrStatusEndpoint("http://asr.test/prefix/v1/audio/transcriptions/")).toBe("http://asr.test/prefix/status");
  });
});
