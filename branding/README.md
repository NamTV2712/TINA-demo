# Tina brand kit

[English](README.md) | [Tiếng Việt](README.vi.md)

Tina is an attentive meeting companion, expressed through calm teal, warm paper,
rounded line icons and clear Vietnamese/English typography. The user confirmed
the name and color direction; the logo, typography and suggested tagline are
this kit's design interpretation.

## Open and use

Open [preview.html](preview.html) directly in a browser. Keep this directory
intact: it works offline, without a server, package install or external fonts.
The theme button switches light/dark; the initial theme follows the system.
See [the icon board](icons/preview.html) for native 24px, double-size 48px and
inverse specimens.

| Asset | File |
|---|---|
| Primary logo, light backgrounds | [tina-primary.svg](logos/tina-primary.svg) |
| Inverse logo, dark backgrounds | [tina-inverse.svg](logos/tina-inverse.svg) |
| Monochrome dark / light | [dark](logos/tina-mono-dark.svg) / [light](logos/tina-mono-light.svg) |
| Standalone mark | [primary](logos/tina-mark.svg) / [inverse](logos/tina-mark-inverse.svg) |
| Browser icon | [favicon.svg](favicon.svg) |
| Semantic colors, type and spacing | [tokens.json](tokens.json) / [tokens.css](tokens.css) |
| Twelve editable icons | [icons/](icons/) / [style-spec.json](icons/style-spec.json) |

## Logo

The conversation frame and T signify listening, not task approval. Lettering is
editable vector geometry, not a required font. Preserve the aspect ratio.
Use at least 16px clearspace at the 112px artboard height, scaling proportionally.
Recommended minimum: full logo 104px wide; standalone mark 24px wide.
The favicon is the small-size exception; do not use the full wordmark at 16px.
Do not stretch, outline, rotate, add effects or recolor individual letters.
Use primary on light, inverse on dark and monochrome when only one ink is needed.

## Typography and voice

UI: Segoe UI, system-ui, sans-serif. Display: Georgia, serif.
These are local font stacks; no font files are redistributed. Noto Sans / Noto
Serif with Vietnamese subsets are the documented future cross-platform option,
not a bundled dependency. Body 16px/1.65, labels 14px/1.5; allow tone-mark space.
Keep Vietnamese and English equally legible, including code-switching.

Suggested line: **Lắng nghe rõ. Cùng làm đúng.** /
**Listen clearly. Act together.**

Write calmly and precisely. Say “Bản nháp / Draft” and “Chờ xác nhận / Awaiting
confirmation”, not “Done” before human decisions. Tina proposes; a reviewer
approves a revision before its assignee confirms responsibility. Never imply
perfect transcription or automatic commitment.

## Tokens and icons

Load `tokens.css`; apply `data-theme="dark"` to the root element for dark mode.
Use semantic names such as `--ink`, `--surface`, `--brand` rather than hard-coded
palette colors. Teal is branding; task state uses its own foreground/background
pair with an explicit label. Decorative `--line` is not a control boundary;
use `--control-line` for controls.

Icons: 24px viewBox, 1.5px strokes, round caps/joins, `currentColor`.
Inline SVG inherits CSS text color; an SVG loaded through `<img>` does not
inherit its parent's `color`. Decorative inline SVG needs `aria-hidden="true"`;
an icon-only button needs an accessible name on the button. Never use an icon
or color as the only task-state explanation.

All files are editable source assets. This preview illustrates branding, not a
working meeting application. No backend, AWS resources or app framework is added.
