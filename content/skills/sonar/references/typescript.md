# Sonar — TypeScript / JavaScript / React

- **No `any`** where a type is known; no unnecessary type assertions (`as X` on something already `X`).
- **Optional chaining** (`a?.b`) instead of `a && a.b`.
- **Every promise is awaited or handled** — no floating promises; no `await` on a non-promise;
  no `async` function passed where a void callback is expected (`onClick={async () => …}` that
  can reject unhandled).
- **No array index as a React `key`** (S6479) — use a stable id.
- **No new object or function as a Context `value`** on every render — `useMemo` it.
- **Hooks**: dependency arrays complete; no hook inside a condition.
- **No nested ternaries in JSX** (S3358) — an early return or a small component.
- **No `console.log`** left in; no `debugger`.
- **Functions nested more than 4 deep** are reported — extract them.
- **Unused imports, variables and props** are reported — delete them.
- **Accessibility**: a `<label>` for each form control, `alt` on images, buttons for actions —
  Sonar's a11y rules overlap with the `web-implementation` skill's accessibility page.
- **Tests (Vitest)**: each `it` asserts; no `it.skip` / `xit`; no fixed `setTimeout` waits —
  `findBy*` / `waitFor`.
