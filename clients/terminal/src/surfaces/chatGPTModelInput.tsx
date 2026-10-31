"use client";

import { useEffect, useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";

type ChatGPTModel = { id: string; name: string };

/** One editable combobox: select a linked-account model or type any model ID. */
export function ChatGPTModelInput({
  value, onChange, style,
}: {
  value: string;
  onChange: (value: string) => void;
  style?: CSSProperties;
}) {
  const listId = `tina-chatgpt-models-${useId().replace(/:/g, "")}`;
  const [models, setModels] = useState<ChatGPTModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/models/openai/catalog", { cache: "no-store" });
        const body = await response.json().catch(() => ({})) as { models?: ChatGPTModel[] };
        if (!response.ok) throw new Error("model catalog unavailable");
        if (active) {
          setModels(Array.isArray(body.models) ? body.models : []);
          setLoadFailed(false);
        }
      } catch {
        if (active) setLoadFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === "tina-chatgpt-connected") {
        void load();
      }
    };
    void load();
    window.addEventListener("message", onMessage);
    return () => {
      active = false;
      window.removeEventListener("message", onMessage);
    };
  }, []);

  const filteredModels = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return models;
    return models.filter((model) => `${model.name} ${model.id}`.toLocaleLowerCase().includes(term));
  }, [models, query]);

  const choose = (model: ChatGPTModel) => {
    onChange(model.id);
    setQuery("");
    setActiveIndex(0);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" && filteredModels.length) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, filteredModels.length - 1));
    } else if (event.key === "ArrowUp" && filteredModels.length) {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && open && filteredModels[activeIndex]) {
      event.preventDefault();
      choose(filteredModels[activeIndex]);
    }
  };

  const hint = loading
    ? "Loading models from your ChatGPT account…"
    : loadFailed
      ? "Could not load the list. You can still type a model ID."
      : models.length
        ? "Choose a model or type a model ID in this field."
        : "No models were listed. You can still type a model ID.";
  const comboStyle: CSSProperties = {
    display: "flex", alignItems: "center", width: "100%", minWidth: 0, boxSizing: "border-box",
    border: focused ? "1px solid var(--accent)" : style?.border || "1px solid var(--line)",
    borderRadius: style?.borderRadius || 6,
    background: style?.background || "var(--panel2)",
    color: style?.color || "var(--t1)",
    boxShadow: focused ? "0 0 0 2px color-mix(in srgb, var(--accent) 24%, transparent)" : undefined,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
      <div style={{ position: "relative" }} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setFocused(false);
        }
      }}>
        <div style={comboStyle}>
          <input
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-activedescendant={open && filteredModels[activeIndex] ? `${listId}-option-${activeIndex}` : undefined}
            value={value}
            placeholder="Choose or enter a model ID"
            autoComplete="off"
            onFocus={() => { setFocused(true); setOpen(true); setQuery(""); setActiveIndex(0); }}
            onChange={(event) => { onChange(event.target.value); setQuery(event.target.value); setActiveIndex(0); setOpen(true); }}
            onKeyDown={onKeyDown}
            style={{
              ...style, width: "100%", minWidth: 0, flex: 1, border: 0, borderRadius: 0,
              outline: "none", background: "transparent", boxShadow: "none", paddingRight: 0,
            }}
          />
          <button
            type="button"
            aria-label="Show ChatGPT models"
            aria-expanded={open}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setOpen((wasOpen) => !wasOpen);
              setQuery("");
              setActiveIndex(0);
            }}
            style={{
              flex: "none", alignSelf: "stretch", padding: "0 9px", border: 0,
              background: "transparent", color: "var(--t3)", fontSize: 15, cursor: "pointer",
            }}
          >
            ▾
          </button>
        </div>
        {open && (
          <div
            id={listId}
            role="listbox"
            aria-label="ChatGPT models"
            style={{
              position: "absolute", zIndex: 30, top: "calc(100% + 4px)", left: 0, right: 0,
              maxHeight: 240, overflowY: "auto", padding: 4, border: "1px solid var(--line2)",
              borderRadius: 7, background: "var(--panel)", boxShadow: "0 8px 24px rgba(0,0,0,.28)",
            }}
          >
            {loading && <div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--t3)" }}>Loading account models…</div>}
            {!loading && filteredModels.length === 0 && (
              <div style={{ padding: "8px 10px", fontSize: 11.5, color: "var(--t3)" }}>
                {loadFailed ? "Model list unavailable. Type an ID in the field." : "No matching model. Keep typing to use a custom ID."}
              </div>
            )}
            {filteredModels.map((model, index) => (
              <div
                key={model.id}
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={value === model.id}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(model)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                  padding: "8px 10px", borderRadius: 5, cursor: "pointer",
                  background: activeIndex === index ? "var(--panel2)" : "transparent",
                  color: "var(--t1)", fontSize: 12,
                }}
              >
                <span>{model.name}</span>
                <span style={{ color: "var(--t3)", fontFamily: "var(--mono)", fontSize: 10.5 }}>{model.id}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <span style={{ fontSize: 10.5, color: "var(--t3)", lineHeight: 1.35 }}>{hint}</span>
    </div>
  );
}
