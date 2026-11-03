import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ModelPicker } from "../modelPicker";
import {
  fallbackChoicesForMode, hasLiveCatalog,
} from "../modelCatalog";

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
    expect(fallbackChoicesForMode("bedrock")).toEqual([]);
    expect(fallbackChoicesForMode("openai-subscription")).toBeNull();
  });

  it("uses a live catalogue only for providers with a list endpoint", () => {
    expect(hasLiveCatalog("groq")).toBe(true);
    expect(hasLiveCatalog("bedrock")).toBe(true);
    expect(hasLiveCatalog("openai-api")).toBe(true);
    expect(hasLiveCatalog("subscription")).toBe(false);
    expect(hasLiveCatalog("")).toBe(false);
  });


});

describe("ModelPicker", () => {
  it("keeps text-only models available for summaries and explains why chat cannot select them", async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json({ models: [
      { id: "allam-2-7b", name: "ALLaM 2 7B", supports_tools: false },
      { id: "qwen/qwen3.8-27b", name: "Qwen 3.8 27B" },
    ] }));
    render(<ModelPicker ariaLabel="Chat model" value="allam-2-7b" onChange={() => undefined}
      mode="groq" />);
    const chatOption = await screen.findByRole("option", { name: /ALLaM 2 7B.*meeting summaries only/ });
    expect((chatOption as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByText(/Choose a model with tool calling for chat/)).toBeTruthy();
    expect((screen.getByRole("option", { name: /Qwen 3.8 27B/ }) as HTMLOptionElement).disabled).toBe(false);
    cleanup();
    render(<ModelPicker ariaLabel="Meeting model" value="allam-2-7b" onChange={() => undefined}
      mode="groq" requiresTools={false} />);
    const summaryOption = await screen.findByRole("option", { name: "ALLaM 2 7B — allam-2-7b" });
    expect((summaryOption as HTMLOptionElement).disabled).toBe(false);
    expect(screen.queryByText(/Choose a model with tool calling for chat/)).toBeNull();
  });

  it("suggests a Bedrock chat model from the regional list without changing meeting inheritance", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ models: [
      { id: "us.anthropic.claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ] }));
    const onChange = vi.fn();
    render(<ModelPicker ariaLabel="Chat model" value="" onChange={onChange}
      mode="bedrock" region="us-east-1" suggestDefault />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("us.anthropic.claude-sonnet-4-6"));
    cleanup();
    onChange.mockClear();
    render(<ModelPicker ariaLabel="Meeting model" value="" onChange={onChange}
      mode="bedrock" region="us-east-1" />);
    await screen.findByText(/regional model\/profile suggestions/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns a typed Bedrock ID to the dropdown when the regional list contains it", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ models: [
      { id: "us.anthropic.claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ] }));
    render(<ModelPicker ariaLabel="Chat model" value="us.anthropic.claude-sonnet-4-6"
      onChange={() => undefined} mode="bedrock" region="us-east-1" />);
    await waitFor(() => expect((screen.getByLabelText("Chat model") as HTMLSelectElement).value)
      .toBe("us.anthropic.claude-sonnet-4-6"), { timeout: 3000 });
    expect(screen.queryByLabelText("Chat model (custom)")).toBeNull();
  });
  it("refreshes the Bedrock catalogue when the selected region changes", async () => {
    const { rerender } = render(<ModelPicker ariaLabel="Chat model" value="" onChange={() => undefined}
      mode="bedrock" apiKey="bedrock-draft" region="us-east-1" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)))
      .toEqual({ mode: "bedrock", api_key: "bedrock-draft", region: "us-east-1" });
    vi.mocked(fetch).mockClear();
    rerender(<ModelPicker ariaLabel="Chat model" value="" onChange={() => undefined}
      mode="bedrock" apiKey="bedrock-draft" region="eu-west-1" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)))
      .toEqual({ mode: "bedrock", api_key: "bedrock-draft", region: "eu-west-1" });
    expect(screen.getByText(/Access depends on your account/)).toBeTruthy();
  });


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
