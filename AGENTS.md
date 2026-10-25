# AGENTS.md

Hugo static site (SCSS in `assets/styles/`, templates in `layouts/`).

## Build / verify

- No `hugo` binary and no Docker in the sandbox. Do **not** try to build, and do **not** hand-edit `public/` — output is stale generated files committed in the repo.
- A dev server auto-builds on http://localhost:1313 (live reload). Verify changes with `curl`:
  - Page: `curl -s http://localhost:1313/ | grep <markup>`
  - CSS: `css=$(curl -s http://localhost:1313/ | grep -o '/styles/index.min[^"]*'); curl -s "http://localhost:1313$css" | grep -o '\.selector[^}]*}'`
- Allow a couple seconds after edits before curling; the fingerprint hash changes each build.

## opencode config

- `opencode.json` pre-approves read-only inspection (`curl` to :1313, `ls`, `grep`, `git status/diff/log`, image conversion) and asks before `git commit/push` or `rm`. Bump rules there if a routine command keeps prompting.

## Asset paths

- Files in `Website/` are design source; copy them into `static/` before referencing by URL (e.g. `static/ServicesBackground.svg` → `/ServicesBackground.svg`). Keep the design's original filename/casing.
- Compile-time assets (e.g. `assets/logo.svg`) go through Hugo `resources.Get`; runtime ones must live in `static/`.

## CSS layering gotcha

- `z-index: -1` on pseudo-elements renders them *behind* an ancestor's background (e.g. a blue block), so decorations vanish. Use stacking above 0 on the container: background `::before` z-index 0, decorative `::after` 1, content `position: relative; z-index: 2+`.

## Layout notes

- Page sections use `.about` / `.philosophy` / `.services`; responsive breakpoint is `48rem`.
- Brand colors: blue `#2793D3`, text `#4A494C`, gold `#EAB464`, services fill `#3E8CC9`.
- Logical page sections should go into separate CSS files to keep organized and simple