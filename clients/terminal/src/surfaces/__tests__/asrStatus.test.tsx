import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AsrStatusPanel } from "../asrStatus";

const fixture = () => JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../core/meetings/contracts/asr-status.v1/golden/Status.json"), "utf8"));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("ASR status page", () => {
  it("shows actual model, device, stages, request ID and client source", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ backend: "funasr", state: "ready", checked_at_ms: Date.now(), service: fixture() })));
    render(<AsrStatusPanel />);
    await screen.findByText("Qwen/Qwen3-ASR-0.6B");
    expect(screen.getByText("MPS")).toBeTruthy();
    expect(screen.getByText("fsmn-vad", { exact: true })).toBeTruthy();
    expect(screen.getByText("11111111")).toBeTruthy();
    expect(screen.getByText("extension")).toBeTruthy();
    expect(screen.getByText("Queue wait")).toBeTruthy();
    expect(screen.getByText("Model pipeline")).toBeTruthy();
  });

  it("renders missing measurements as missing instead of zero", async () => {
    const service = fixture(); service.recent = []; service.requests = { total: 0, errors: 0 };
    Object.values(service.latency).forEach((value) => Object.assign(value as object, { count: 0, p50_ms: null, p95_ms: null }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ backend: "funasr", state: "ready", checked_at_ms: Date.now(), service })));
    render(<AsrStatusPanel />);
    await screen.findByText(/No ASR requests yet/);
    expect(screen.getAllByText("—").length).toBeGreaterThan(5);
    expect(screen.queryByText("0.0 ms")).toBeNull();
  });

  it("supports manual refresh and reports unavailable backend state", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ backend: "custom", state: "unsupported", checked_at_ms: Date.now(), service: null }));
    vi.stubGlobal("fetch", fetch);
    render(<AsrStatusPanel />);
    await screen.findByText("Diagnostics unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("shows an actionable permission error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    render(<AsrStatusPanel />);
    await screen.findByRole("alert");
    expect(screen.getByText(/Administrator access is required/)).toBeTruthy();
  });
});
