import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
vi.mock("../tokens/currentUser", () => ({ currentUser: vi.fn() }));
import { currentUser } from "../tokens/currentUser";
import { GET, POST } from "../transcription/runtime/route";
beforeEach(() => {
  vi.mocked(currentUser).mockResolvedValue({ ok: true, userId: "7", apiKey: "private" } as never);
  vi.stubEnv("TINA_ASR_CONTROL_URL", "http://host.test:18007");
  vi.stubEnv("TINA_INTERNAL_API_SECRET", "internal-private");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
const request = (payload: object, origin = "http://terminal.test") => new NextRequest("http://terminal.test/api/transcription/runtime", {
  method: "POST", body: JSON.stringify(payload), headers: { origin },
});
it("scopes runtime changes to the verified account and sends only a derived control key", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ account: { backend: "gipformer" } })); vi.stubGlobal("fetch", fetch);
  expect((await POST(request({ backend: "gipformer", enabled: true, revision: 4 }))).status).toBe(200);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ backend: "gipformer", enabled: true, revision: 4, user_id: "7" });
  expect(fetch.mock.calls[0][1].headers["X-ASR-Control-Key"]).toBe(createHmac("sha256", "internal-private").update("tina-asr-control:v1").digest("hex"));
  expect(JSON.stringify(fetch.mock.calls)).not.toContain("internal-private");
});
it("rejects caller-supplied identities, cross-origin writes and signed-out requests", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  expect((await POST(request({ backend: "gipformer", enabled: true, revision: 0, user_id: "9" }))).status).toBe(422);
  expect((await POST(request({ backend: "viegem", enabled: true, revision: 0 }, "http://attacker.test"))).status).toBe(403);
  vi.mocked(currentUser).mockResolvedValue({ ok: false } as never);
  expect((await GET(new NextRequest("http://terminal.test/api/transcription/runtime"))).status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});
it("accepts the browser's public loopback port behind Docker while refusing a different port", async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ account: { backend: "viegem" } })));
  vi.stubGlobal("fetch", fetch);
  const make = (origin: string) => new NextRequest("http://0.0.0.0:3000/api/transcription/runtime", { method: "POST",
    headers: { host: "127.0.0.1:23000", origin }, body: JSON.stringify({ backend: "viegem", enabled: true, revision: 0 }) });
  expect((await POST(make("http://127.0.0.1:23000"))).status).toBe(200);
  expect((await POST(make("http://localhost:23000"))).status).toBe(200);
  expect((await POST(make("http://127.0.0.1:23001"))).status).toBe(403);
});
