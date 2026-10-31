# Tina kit verification

[English](QA.md) | [Tiếng Việt](QA.vi.md)

Checked locally on 2026-09-28 with Chromium through Omowright and the resident
JavaScript kernel. These checks cover branding assets, not product functionality.

## Structural checks

- All 19 SVG files parsed with the browser XML parser without errors:
  six logo variants, favicon and twelve icons.
- Twelve icons have the documented 24px viewBox, currentColor stroke, 1.5px
  width and rounded caps/joins. Geometry and attributes match the inline board.
  An initial raw XML/HTML string comparison failed because serialization differs;
  normalized element/attribute comparison passed for all twelve.
- Both semantic themes and font/type/space/radius groups match JSON to CSS.
  CSS parsed through CSSStyleSheet; JSON parsed through JSON.parse.
- All 21 non-anchor asset/link references in the main preview resolve locally.
- Icon board includes 36 specimens: twelve at 24px, 48px and inverse 48px.

## Contrast

28 foreground/background combinations passed WCAG contrast targets: normal
text >=4.5:1 and control/focus >=3:1. This includes ink/muted on canvas/surface,
muted on subtle, primary normal/hover labels, all four state pairs,
control outline on surface, and focus on canvas/surface in both themes.

- Lowest tested text ratio: 5.21:1 (light muted on subtle).
- Lowest tested control ratio: 3.65:1 (light control-line on surface).
- Decorative separators are intentionally excluded from control criteria.

## Browser checks

- Main board viewed at desktop 1440px and iPhone 14 emulation, 390px.
- Light/dark screenshots inspected, including Vietnamese accents, all sections,
  mobile task card/footer and the fixed light logo panel in dark mode.
- No horizontal overflow at either tested width. All main-board images loaded.
- Mouse theme toggle updates theme and aria-pressed; Enter changes light to dark.
- Initial Tab reaches the skip link with a visible solid focus outline.
- Icon board at 390px has no horizontal overflow; its 24px/48px/inverse desktop
  specimens were visually inspected.
- Monochrome logo rendered after converting the T to a transparent mask cutout.
- One screenshot caught an incomplete paint; awaiting image decode and animation
  frames produced the complete panel. No application change was needed.

## Limits and reproduction

Open `preview.html` and `icons/preview.html` directly; repeat viewport, theme,
keyboard and asset checks described above. No server or install is required.
Screenshots were inspected in-session, not shipped as additional assets.

Biome diagnostics could not run because the configured executable is absent.
No framework, build pipeline or application test suite exists; none was installed
for this static kit. Browser/parser/contrast checks are the relevant checks here.
`git diff --check` exited successfully, but all project files are currently
untracked, so that command alone provides no coverage of these new assets.
No AWS check, deployment, paid API call or repository commit was performed.
