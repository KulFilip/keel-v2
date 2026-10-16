# 25 · A plugin in keel TUI (`contributes.tui`)

keel 0.18.3. A plugin can add **commands** and one **panel** to keel TUI (keel's terminal app, `keel2 tui`). They are
written as data in the plugin's `keel-plugin.yml`, under `contributes.tui`. keel TUI never runs a plugin's code: each
command calls the plugin's own api routes and shows the answer the way the manifest says.

```
keel-plugin.yml                     keel's api                                   keel TUI
contributes.tui ──▶ GET /api/tui/plugins?project=<id>  (checked again here) ──▶  /git status · /git log · /git diff
                                                                                 Ctrl+G: the Branch panel
/git status ─────▶ GET /api/projects/<id>/git/status  (the plugin's own route) ──▶ "keel/health · base main · ahead 2"
                                                                                  "M  src/app.ts"
```

## The Git plugin's (plugins/git/keel-plugin.yml)

```yaml
contributes:
  tui:
    commands:
      - name: git
        args: "<status|log|diff [path]>"
        summary: the branch and its changes, its last commits, or the uncommitted diff
        sub:
          status:
            summary: the branch, how far from its base, and the files that changed
            call: { path: "/projects/{pid}/git/status" }
            show: { title: "{branch} · base {base} · ahead {ahead} · behind {behind}", items: changes, line: "{status}  {path}", empty: "nothing changed" }
          log:
            summary: the last commits on this branch
            call: { path: "/projects/{pid}/git/log" }
            show: { items: ".", line: "{sha}  {date}  {author}  {subject}", max: 20 }
          diff:
            summary: the uncommitted changes as a diff (one file with a path)
            call: { path: "/projects/{pid}/git/diff?path={arg}" }
            show: { diff: diff, empty: "no uncommitted change" }
    panel:
      title: Branch
      key: g
      every: 10
      call: { path: "/projects/{pid}/git/status" }
      show: { title: "{branch} · base {base} · ↑{ahead} ↓{behind}", items: changes, line: "{status}  {path}", empty: "clean", max: 6 }
```

## The fields

| Field | What it is |
|-------|------------|
| `commands[].name` | the command: the plugin's name (`git`) or `<name>-<word>` (`git-pr`). keel's own commands win: a plugin cannot replace `/status` |
| `args`, `summary` | what `/help` and Tab show (help lists plugins' commands under **Plugins**) |
| `sub` | subcommands by their first word (`/git status`); or, instead, one `call` (+ `show`, `confirm`) for the whole command |
| `call.path` | an api path under `/api`: **only the plugin's own routes**, `/projects/{pid}/<name>/…` (or `/<name>/…`). `{pid}` is the project, `{arg}` the person's words after the (sub)command; both are URL-encoded |
| `call.method` | `GET` (the default) or `POST` with `body`. A `POST` changes something, so it **must** have `confirm`: keel TUI asks that question (amber, yes/no) before it calls |
| `show.title` | a template for the first line: `{field}` of the answer, `{a.b}` for a nested one |
| `show.items`, `show.line` | the answer's list (a field, or `.` when the answer is the list) and the template of each line; `max` cuts it, `empty` is said when it is empty |
| `show.diff` | a field holding a unified diff: shown with line numbers, green and red |
| `panel` | one panel: `title`, a `key` (Ctrl+<key>: one letter, not keel TUI's own a, b, c, f, u), `every` (5–3600 seconds), a `GET` call and a `show` |

Without `show`, keel TUI prints the answer as JSON.

## Trust

`contributes.tui` is data, so it needs no more trust than the plugin already has: the routes it calls are the plugin's
own, served by keel's api with keel's checks (the plugin must be on for the project, the person's sign-in key). The rules
are checked three times: `keel-plugin lint` (tools/keel-plugin, `_tui`), keel's api when it lists them
(`keel.api.tui.TuiPluginService`: a wrong entry is left out, `problems` says why), and keel TUI (a name keel has wins).
Code in the TUI process from a plugin would need keel's signed, trusted-publisher rules (03-security.md) and is not
supported.

## Where it is

- api: `GET /api/tui/plugins?project=<id>` → `{plugins: [{name, title, version, commands, panel}], problems: [{plugin, error}]}`
  (a per-project plugin only where it is on). `api/src/main/kotlin/keel/api/tui/TuiPlugins.kt`, `TuiPluginsApiTest`
- lint: `tools/keel-plugin/keel_plugin/manifest.py` `_tui`, `tests/test_lint_tui.py`
- keel TUI: `cli/src/core/plugins.ts` (the commands, the templates, the panel), `cli/src/ui/parts.tsx` `PluginPanel`
- the Git plugin's routes it uses: `/git/status`, `/git/log` and (new in 0.18.3) `/git/diff?path=`
