import { afterEach, describe, expect, it, vi } from "vitest";

/** Mutable cookie jar the mocked next/headers reads from. */
let jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

import { resolveApiKey } from "../proxyAuth";
import { GET as catchAllGet, POST as catchAllPost, PUT as catchAllPut, PATCH as catchAllPatch } from "../[...path]/route";

function makeReq(search = ""): import("next/server").NextRequest {
  return { method: "GET", headers: new Headers(), nextUrl: { search } } as unknown as import("next/server").NextRequest;
}

function makeReqM(method: string, body = "", search = ""): import("next/server").NextRequest {
  return { method, headers: new Headers(), nextUrl: { search }, text: async () => body } as unknown as import("next/server").NextRequest;
}

afterEach(() => {
  jar = new Map();
  delete process.env.TINA_API_KEY;
  delete process.env.TINA_BOT_API_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveApiKey — cookie token with env fallback", () => {
  it("prefers the tina-token cookie", async () => {
    jar.set("tina-token", "user-token-123");
    process.env.TINA_API_KEY = "env-key";
    process.env.TINA_BOT_API_KEY = "bot-key";
    expect(await resolveApiKey()).toBe("user-token-123");
  });

  it("falls back to TINA_API_KEY, then TINA_BOT_API_KEY", async () => {
    process.env.TINA_API_KEY = "env-key";
    process.env.TINA_BOT_API_KEY = "bot-key";
    expect(await resolveApiKey()).toBe("env-key");

    delete process.env.TINA_API_KEY;
    expect(await resolveApiKey()).toBe("bot-key");

    delete process.env.TINA_BOT_API_KEY;
    expect(await resolveApiKey()).toBe("");
  });
});

describe("catch-all proxy — meetings domain forwards the cookie token as X-API-Key", () => {
  it("forwards a Meet launch body with the signed-in user's key and preserves admission response", async () => {
    jar.set("tina-token", "cookie-tok");
    const body = JSON.stringify({ platform: "google_meet", native_meeting_id: "abc-defg-hij", meeting_url: "https://meet.google.com/abc-defg-hij" });
    const upstream = vi.fn(async () => Response.json({ id: 42, status: "requested" }, { status: 201 }));
    vi.stubGlobal("fetch", upstream);
    const response = await catchAllPost(makeReqM("POST", body), { params: Promise.resolve({ path: ["bots"] }) });
    expect(upstream).toHaveBeenCalledWith(expect.stringMatching(/\/bots$/), expect.objectContaining({
      method: "POST", body, headers: { "X-API-Key": "cookie-tok", "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 42, status: "requested" });
  });

  it("injects the cookie token on a /bots call", async () => {
    jar.set("tina-token", "cookie-tok");
    const seen: { url?: string; key?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.key = (init?.headers as Record<string, string>)?.["X-API-Key"];
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    await catchAllGet(makeReq(), { params: Promise.resolve({ path: ["bots"] }) });

    expect(seen.url).toContain("/bots");
    expect(seen.key).toBe("cookie-tok");
  });

  it("falls back to TINA_BOT_API_KEY when no cookie is present", async () => {
    process.env.TINA_BOT_API_KEY = "legacy-bot-key";
    const seen: { key?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.key = (init?.headers as Record<string, string>)?.["X-API-Key"];
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    await catchAllGet(makeReq(), { params: Promise.resolve({ path: ["meetings"] }) });

    expect(seen.key).toBe("legacy-bot-key");
  });
});

describe("catch-all proxy — PATCH and PUT verbs forward (regression: handler exported only GET/POST/DELETE → 405)", () => {
  it("forwards PATCH to the agent domain, body intact (routine enable/disable)", async () => {
    jar.set("tina-token", "tok");
    const seen: { url?: string; method?: string; body?: unknown } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.method = init?.method;
        seen.body = init?.body;
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    await catchAllPatch(makeReqM("PATCH", JSON.stringify({ enabled: false })), {
      params: Promise.resolve({ path: ["routines", "daily", "enabled"] }),
    });

    expect(seen.method).toBe("PATCH");
    expect(seen.url).toContain("/agent/routines/daily/enabled");
    expect(seen.body).toBe(JSON.stringify({ enabled: false }));
  });

  it("forwards PUT to the meetings domain (schedule/cancel intent)", async () => {
    jar.set("tina-token", "tok");
    const seen: { url?: string; method?: string } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.method = init?.method;
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    await catchAllPut(makeReqM("PUT", JSON.stringify({ intent: "scheduled" })), {
      params: Promise.resolve({ path: ["meetings", "google_meet", "abc", "intent"] }),
    });

    expect(seen.method).toBe("PUT");
    expect(seen.url).toContain("/meetings/google_meet/abc/intent");
  });
});
