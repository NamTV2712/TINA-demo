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
  ariaLabel, value, onChange, mode, apiKey, emptyLabel = "Provider default", style,
}: {
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  mode: string;
  apiKey?: string;
  emptyLabel?: string;
  style?: CSSProperties;
}) {
  const fallback = useMemo(() => fallbackChoicesForMode(mode) ?? [], [mode]);
  const [choices, setChoices] = useState<ModelChoice[]>(fallback);
  const [status, setStatus] = useState<"idle" | "loading" | "live" | "fallback">("idle");
  const [notice, setNotice] = useState<string | null>(null);
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
        const live = await fetchModelCatalog(mode, apiKey, controller.signal);
        if (!active) return;
        setChoices(live.map((model) => ({ id: model.id, label: model.name || model.id })));
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
  }, [mode, apiKey, fallback]);

  useEffect(() => {
    // A saved ID that is not in the list must remain visible and editable; a live list that later
    // contains it may close the custom box unless the user explicitly chose custom mode.
    if (chosenCustom) return;
    if (!value) {
      setCustom(false);
      return;
    }
    setCustom(!choices.some((choice) => choice.id === value) && !fallback.some((choice) => choice.id === value));
  }, [value, choices, fallback, chosenCustom]);

  const hint = custom
    ? "Type any model ID. Leave it blank to use the default."
    : status === "loading"
      ? "Loading models from the provider…"
      : status === "fallback"
        ? `${notice ?? "Could not load models from the provider."} Showing built-in suggestions — use ${CUSTOM_LABEL} for another ID.`
        : status === "live"
          ? `${choices.length} model${choices.length === 1 ? "" : "s"} available from the provider.`
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
          <option key={choice.id} value={choice.id}>
            {choice.label === choice.id ? choice.id : `${choice.label} — ${choice.id}`}
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
