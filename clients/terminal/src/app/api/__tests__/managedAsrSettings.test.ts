import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("../admin/gate", () => ({ requireAdmin: vi.fn() }));
import { requireAdmin } from "../admin/gate";
import { GET, PUT } from "../admin/settings/[key]/route";
beforeEach(() => {
  vi.mocked(requireAdmin).mockResolvedValue({ email: "admin@example.test", userId: 1 });
  vi.stubEnv("TINA_ADMIN_API_URL", "http://identity.test");vi.stubEnv("TINA_INTERNAL_API_SECRET", "internal-private");
});
afterEach(() => { vi.unstubAllGlobals();vi.unstubAllEnvs();vi.clearAllMocks(); });
it("keeps the managed VieGem token write-only for the browser on read and save", async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ key: "transcription", value: {
    viegem_url: "http://host.docker.internal:18005", viegem_token: "managed-worker-private", gipformer_token: "managed-gipformer-private" } }));
  vi.stubGlobal("fetch",fetch);
  const ctx={params:Promise.resolve({key:"transcription"})};
  const read=await GET(new NextRequest("http://terminal.test/api/admin/settings/transcription"),ctx);
  expect((await read.json()).value).toEqual({viegem_url:"http://host.docker.internal:18005"});
  const write=await PUT(new NextRequest("http://terminal.test/api/admin/settings/transcription",{method:"PUT",body:JSON.stringify({viegem_token:"managed-worker-private"})}),ctx);
  const body = await write.text();
  expect(body).not.toContain("managed-worker-private");
  expect(body).not.toContain("managed-gipformer-private");
  expect(fetch.mock.calls[1][1].body).toContain("managed-worker-private");
});
it("rejects non-admins before querying stored worker credentials",async()=>{
  vi.mocked(requireAdmin).mockResolvedValue(null);const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  const r=await GET(new NextRequest("http://terminal.test/api/admin/settings/transcription"),{params:Promise.resolve({key:"transcription"})});
  expect(r.status).toBe(404);expect(fetch).not.toHaveBeenCalled();
});
