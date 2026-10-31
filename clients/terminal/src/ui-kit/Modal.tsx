"use client";
/** Modal — a minimal centered overlay dialog: dimmed backdrop, Esc / backdrop-click to close, a titled
 *  card. Portaled to <body> so it escapes the sidebar's overflow/stacking context. Used for creation
 *  dialogs (attach repo, …) that shouldn't live inline in the workspaces list.
 *
 *  A11y contract: the first form field (or the close button) takes focus on open, Tab / Shift+Tab
 *  cycle inside the card (focus trap), Esc closes, and focus returns to the opener on unmount. */
import { useEffect, useRef, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, onClose, children, width = 400 }: {
  title: string; onClose: () => void; children: ReactNode; width?: number;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Latest onClose without re-running the mount effect (callers pass inline lambdas).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    const focusables = () => (card ? Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)) : []);
    // Creation dialogs open on their first field; anything else opens on the close button.
    const firstField = card?.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
    );
    (firstField ?? focusables()[0] ?? card)?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== "Tab" || !card) return;
      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) { e.preventDefault(); card.focus({ preventScroll: true }); return; }
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === card)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    // Capture phase: the topmost dialog wins Esc before the workbench's nav.back handler.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener?.focus?.({ preventScroll: true });
    };
  }, []);

  const backdrop: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 };
  const card: CSSProperties = { width: "100%", maxWidth: width, boxSizing: "border-box", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,.45)", padding: 18 };
  const head: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, paddingBottom: 13, borderBottom: "1px solid var(--line)" };
  const close: CSSProperties = { background: "none", border: "none", padding: "0 3px", cursor: "pointer", color: "var(--t3)", fontSize: 17, lineHeight: 1 };

  const body = (
    // mousedown on the backdrop itself (not a child) closes — avoids closing on a drag that ends outside.
    <div style={backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={cardRef} style={card} role="dialog" aria-modal="true" aria-label={title}>
        <div style={head}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--t1)" }}>{title}</div>
          <button type="button" style={close} onClick={onClose} aria-label="Close dialog" title="Close (Esc)">×</button>
        </div>
        {children}
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(body, document.body) : null;
}
