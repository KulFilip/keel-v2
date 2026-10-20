# Third-party notices (keel TUI)

keel TUI bundles React, Ink, chalk and highlight.js (their licenses travel in `dist/keel-tui.mjs`'s dependencies'
packages). Ideas and small pieces of code were also taken from:

## xal

https://github.com/xal-sh/xal — a terminal coding harness. keel TUI took its way of using colour (docs/plans/keel-tui.md,
"What we took from xal"). Adapted code, each file keeps this notice:

- `src/core/theme.ts`: the idea of roles on the terminal's own ANSI colours (keel TUI 0.18's TERMINAL palette; the
  palettes are keel's own since the colour roles of fix/tui-colors) — from `apps/cli/src/plugins/tui/theme/colors.ts`
- `src/core/diff.ts`: `classifyDiff` (line numbers from the hunk headers) — from `apps/cli/src/plugins/tui/output/diff.ts`
- `src/core/markdown.ts`: the table layout (`fitColumns`: shrink the widest column, grow the most cramped) and the bullets
  by depth — from `apps/cli/src/plugins/tui/markdown/render.ts`

```
MIT License

Copyright (c) 2026 Saeed Vaziry

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
