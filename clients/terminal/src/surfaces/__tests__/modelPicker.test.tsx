import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ModelPicker } from "../modelPicker";
import { fallbackChoicesForMode, hasLiveCatalog, INTELLIGENCE_OPTIONS } from "../modelCatalog";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    models: [
      { id: "deepseek-chat", name: "deepseek-chat" },
      { id: "deepseek-reasoner", name: "deepseek-reasoner" },
    ],
  })));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("modelCatalog", () => {
  it("keeps a fallback list only for providers a picker can render", () => {
    expect(fallbackChoicesForMode("deepseek")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "deepseek-flash" }),
    ]));
    expect(fallbackChoicesForMode("")).toBeNull();
    expect(fallbackChoicesForMode(undefined)).toBeNull();
    expect(fallbackChoicesForMode("custom")).toBeNull();
    expect(fallbackChoicesForMode("bedrock")).toBeNull();
    expect(fallbackChoicesForMode("openai-subscription")).toBeNull();
  });

  it("uses a live catalogue only for providers with a list endpoint", () => {
    expect(hasLiveCatalog("groq")).toBe(true);
    expect(hasLiveCatalog("openai-api")).toBe(true);
    expect(hasLiveCatalog("subscription")).toBe(false);
    expect(hasLiveCatalog("")).toBe(false);
  });

  it("offers intelligence as its own choice, not part of the model name", () => {
    expect(INTELLIGENCE_OPTIONS.map((option) => option.value)).toEqual(["", "low", "medium", "high", "xhigh"]);
    expect(INTELLIGENCE_OPTIONS[0].label).toBe("Auto — model default");
    expect(INTELLIGENCE_OPTIONS.at(-1)?.label).toBe("Maximum — deepest thinking");
  });
});

describe("ModelPicker", () => {
  it("replaces the fallback list with the provider's live models", async () => {
    render(<ModelPicker ariaLabel="Chat model" value="" onChange={() => undefined}
      mode="deepseek" emptyLabel="Provider default — deepseek-flash" />);

    expect(await screen.findByRole("option", { name: "deepseek-reasoner" }, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText("2 models available from the provider.")).toBeTruthy();
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body).toEqual({ mode: "deepseek" });
  });

  it("sends a typed key with the catalogue request, but never a masked read-back", async () => {
    render(<ModelPicker ariaLabel="Chat model" value="" onChange={() => undefined}
      mode="groq" apiKey="gsk_draft_key" />);

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)))
      .toEqual({ mode: "groq", api_key: "gsk_draft_key" });

    cleanup();
    vi.mocked(fetch).mockClear();
    render(<ModelPicker ariaLabel="Chat model" value="" onChange={() => undefined}
      mode="groq" apiKey="********abcd" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)))
      .toEqual({ mode: "groq" });
  });

  it("keeps the built-in suggestions when the provider cannot answer", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("The provider is offline."));
    render(<ModelPicker ariaLabel="Chat model" value="deepseek-flash" onChange={() => undefined}
      mode="deepseek" />);

    expect(await screen.findByText(/Showing built-in suggestions/, {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole("option", { name: "DeepSeek Flash — deepseek-flash" })).toBeTruthy();
  });

  it("reveals a free-text field only after choosing Custom model…", () => {
    const onChange = vi.fn();
    render(<ModelPicker ariaLabel="Chat model" value="" onChange={onChange} mode="deepseek" />);

    expect(screen.queryByLabelText("Chat model (custom)")).toBeNull();
    fireEvent.change(screen.getByLabelText("Chat model"), { target: { value: "__custom__" } });

    const input = screen.getByLabelText("Chat model (custom)") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "deepseek-account-only" } });
    expect(onChange).toHaveBeenLastCalledWith("deepseek-account-only");
  });

  it("keeps a saved model that the list does not contain editable", () => {
    render(<ModelPicker ariaLabel="Chat model" value="deepseek-next" onChange={() => undefined}
      mode="deepseek" />);

    expect((screen.getByLabelText("Chat model") as HTMLSelectElement).value).toBe("__custom__");
    expect((screen.getByLabelText("Chat model (custom)") as HTMLInputElement).value).toBe("deepseek-next");
  });

  it("closes the custom box when the live list confirms the saved ID", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      models: [{ id: "deepseek-v4", name: "DeepSeek V4" }],
    }));
    render(<ModelPicker ariaLabel="Chat model" value="deepseek-v4" onChange={() => undefined}
      mode="deepseek" />);

    await waitFor(() => expect((screen.getByLabelText("Chat model") as HTMLSelectElement).value)
      .toBe("deepseek-v4"), { timeout: 3000 });
  });

  it("labels the empty choice for a meeting model", () => {
    render(<ModelPicker ariaLabel="Meeting model" value="" onChange={() => undefined}
      mode="deepseek" emptyLabel="Same as chat model" />);

    expect(screen.getByRole("option", { name: "Same as chat model" })).toBeTruthy();
  });
});
