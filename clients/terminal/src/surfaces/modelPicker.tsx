"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { fallbackChoicesForMode, hasLiveCatalog, type ModelChoice } from "./modelCatalog";
import { fetchModelCatalog } from "./settingsApi";
import { ApiError } from "./apiClient";

const CUSTOM_VALUE = "__custom__";
const CUSTOM_LABEL = "Custom model…";

/** Model field with a pickable list, a live provider catalogue, and an explicit custom entry.
 *
 *  The list is the provider's own answer for the entered credential (`/api/models/catalog`); the
 *  small built-in suggestions render while that request is in flight or when the provider cannot be
 *  reached. "Custom model…" reveals a free-text ID field, which is also shown automatically when the
 *  saved value is not in the list (a newer or account-only model).
 */
export function ModelPicker({
  ariaLabel, value, onChange, mode, apiKey, region, requiresTools = true, suggestDefault = false, emptyLabel = "Provider default", style,
}: {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  mode: string;
  apiKey?: string;
  region?: string;
  requiresTools?: boolean;
  suggestDefault?: boolean;
  emptyLabel?: string;
  style?: CSSProperties;
}) {
  const fallback = useMemo(() => fallbackChoicesForMode(mode) ?? [], [mode]);
  const [choices, setChoices] = useState<ModelChoice[]>(fallback);
  const [status, setStatus] = useState<"idle" | "loading" | "live" | "fallback">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [liveScope, setLiveScope] = useState("");
  const [custom, setCustom] = useState(() => value !== "" && !fallback.some((choice) => choice.id === value));
  const [chosenCustom, setChosenCustom] = useState(false);

  useEffect(() => {
    setChoices(fallback);
  }, [fallback]);

  useEffect(() => {
    if (!hasLiveCatalog(mode)) {
      setStatus("idle");
      setNotice(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    // Debounce: a key is typed one character at a time, and a request per keystroke would burn the
    // provider's rate limit (and the user's patience) for answers that are already stale.
    const timer = setTimeout(async () => {
      setStatus("loading");
      try {
        const live = await fetchModelCatalog(mode, apiKey, controller.signal, region);
        if (!active) return;
        setChoices(live.map((model) => ({
          id: model.id, label: model.name || model.id, supportsTools: model.supports_tools,
        })));
        setLiveScope(`${mode}:${region ?? ""}`);
        setStatus("live");
        setNotice(live.length ? null : "The provider listed no chat models.");
      } catch (error: unknown) {
        if (!active || controller.signal.aborted) return;
        setChoices(fallback);
        setStatus("fallback");
        setNotice(error instanceof ApiError ? error.detail
          : error instanceof Error ? error.message : "Could not load models from the provider.");
      }
    }, 600);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [mode, apiKey, region, fallback]);

  useEffect(() => {
    // A value the current list does not carry (a saved ID, an account-only model) must stay visible:
    // showing the first option instead would hide what is actually saved. While the live request is
    // in flight the fallback IS `choices`, so this only flips once the provider has answered. A live
    // list that later contains the value closes the box unless the user explicitly chose custom.
    if (value && choices.some((choice) => choice.id === value)) {
      setCustom(false);
      setChosenCustom(false);
      return;
    }
    if (chosenCustom) return;
    if (!value) {
      setCustom(false);
      return;
    }
    setCustom(!choices.some((choice) => choice.id === value));
  }, [value, choices, chosenCustom]);

  useEffect(() => {
    // Draft suggestion only: Save still owns persistence. Meeting model keeps its inherit option.
    if (suggestDefault && status === "live" && liveScope === `${mode}:${region ?? ""}` && !value && !chosenCustom && choices.length) {
      onChange(choices[0].id);
    }
  }, [suggestDefault, status, liveScope, mode, region, value, chosenCustom, choices, onChange]);

  const unsupportedChat = requiresTools && choices.some((choice) => choice.id === value && choice.supportsTools === false);
  const hint = unsupportedChat
    ? "This model supports meeting summaries only. Choose a model with tool calling for chat."
    : custom
    ? mode === "bedrock"
      ? `This ID is not in the current regional list. Choose a suggested model above, or enter an exact ID from working AWS code. ${notice ?? ""}`
      : "Type any model ID. Leave it blank to use the default."
    : status === "loading"
      ? "Loading models from the provider…"
      : status === "fallback"
        ? `${notice ?? "Could not load models from the provider."} Showing built-in suggestions — use ${CUSTOM_LABEL} for another ID.`
        : status === "live"
          ? mode === "bedrock"
            ? `${choices.length} regional model/profile suggestions. Access depends on your account; save and test the selected model.`
            : `${choices.length} model${choices.length === 1 ? "" : "s"} available from the provider.`
          : emptyLabel;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
      <select
        aria-label={ariaLabel}
        value={custom ? CUSTOM_VALUE : value}
        onChange={(event) => {
          const next = event.target.value;
          if (next === CUSTOM_VALUE) {
            setChosenCustom(true);
            setCustom(true);
            onChange("");
          } else {
            setChosenCustom(false);
            setCustom(false);
            onChange(next);
          }
        }}
        style={{ ...style, width: "100%", minWidth: 0 }}
      >
        <option value="">{emptyLabel}</option>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id} disabled={requiresTools && choice.supportsTools === false}>
            {choice.label === choice.id ? choice.id : `${choice.label} — ${choice.id}`}
            {requiresTools && choice.supportsTools === false ? " (meeting summaries only)" : ""}
          </option>
        ))}
        <option value={CUSTOM_VALUE}>{CUSTOM_LABEL}</option>
      </select>
      {custom && (
        <input
          aria-label={`${ariaLabel} (custom)`}
          value={value}
          placeholder="Enter a model ID"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          style={style}
        />
      )}
      <span aria-live="polite" style={{ fontSize: 11, color: "var(--t3)", lineHeight: 1.4 }}>
        {hint}
      </span>
    </div>
  );
}
