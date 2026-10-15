# Rule pack format (schema 1)

A **rule pack** is one YAML file of rules that keel's guard applies to every agent: before the action where the
engine allows it, and after each step for every engine. A project keeps its packs in `.keel/rules/<name>.yaml`
(shared with the team through git). The same file is the unit keel's library ships, Import and Export move, and a
marketplace can publish **unchanged**: its header is shaped like a plugin's `keel-plugin.yml`.

This format is final from keel v2 0.17.2. A later change gets `schema: 2`; keel keeps reading schema 1.

## Example

```yaml
schema: 1                      # required: the format's version
kind: rules                    # optional (default rules): a rule pack, not a plugin
name: no-new-dependencies      # required: the pack's id and its file name; [a-z0-9-], at most 64
title: No new dependencies     # required: a few words for people
version: 1.0.0                 # required: MAJOR.MINOR.PATCH (a -pre suffix is fine)
publisher: keel                # optional (default local): who publishes it; [a-z0-9-]
summary: Agents never add a package, inside or outside a flow.     # optional: one sentence
stack: node                    # optional: the stack it is for (spring, node, python ...), a hint for people
requires:                      # optional
  keel: ">=0.17.2"             #   a version range keel must meet ('>=0.17.2,<1.0.0'); a pack that does not fit is not used
  plugins: {}                  #   plugin name → version range ('' = any); a list of names is also accepted
rules:                         # required: at least one
  - id: no-install             # required: unique in the pack; [a-z0-9-]
    kind: bash                 # required: bash | edit | read | mcp
    match: [npm install, pnpm add]          # required: a text or a list of texts
    how: contains              # optional: contains | glob | name | regex (default: bash contains, edit/read glob, mcp name)
    phases: all                # optional: all (default) | in-flow | none (outside a flow) | [green, refactor, ...]
    lanes: [web]               # optional: only in this lane of a red/green step (api | web)
    except: ["**/*.lock"]      # optional, edit/read: these paths pass
    reason: Adding a package is a person's decision.   # required: the agent reads it when it is refused
```

## What each rule kind checks

| kind | the target | `match` with the default `how` |
|---|---|---|
| `bash` | the whole shell command | the command contains one of the texts |
| `edit` | the file a write, an edit, a patch or a shell redirect changes | a glob on the repo-relative path (`src/scores/**`) |
| `read` | the file a read opens | a glob on the repo-relative path |
| `mcp` | the MCP tool's full name (`mcp__<server>__<tool>`) | the name contains one of the texts |

A pack rule **only refuses**: it never allows what keel's own rules refuse. An unlock ("allow this file in this phase")
passes an `edit` rule, like the phase matrix. The refusal the agent reads ends with `(rule <pack>/<rule>)`.
`rules.off: [pack/<name>]` in `.keel/config.yml` switches a whole pack off.

## Installed packs and where they came from

Next to the packs, `.keel/rules/.installed.json` records each installed pack, so the pack file stays exactly as
published:

```json
{ "no-new-dependencies": { "version": "1.0.0", "source": "library", "at": "2026-10-16T08:00:00Z" } }
```

`source` is `library` (keel's own library, `content/rules/`), `file` (written on the Rules page or imported from a file;
also any pack file with no record) or `marketplace`. keel's built-in rules are not packs; the Rules page shows them as
`keel (built in)`. A pack installed from the library or the marketplace and then changed on the Rules page keeps its
source and is marked `edited`. Agents can never change `.keel/rules/` (the guard's `keel-rules` bucket).

## Installing, by name and version

| what | api (`/api/projects/{pid}/...`) |
|---|---|
| the installed packs, with `source`, `version`, `off`, `edited`, `update` (a newer library version) | `GET rule-packs` |
| install from keel's library | `POST rule-packs/install {source: "library", name, version?}` |
| install a file (the Rules page's Import) | `POST rule-packs/install {source: "file", yaml}` |
| install what a marketplace fetched | `POST rule-packs/install {source: "marketplace", yaml, name?, version?}` |
| upgrade or downgrade (another version is installed) | the same, with `replace: true` (otherwise 409) |
| uninstall | `POST rule-packs/uninstall {name}` |
| export (`<name>-<version>.rules.yaml`) | `GET rules/packs/{name}/export` |

The same name and version again is refused (409, "installed already"). A pack whose `requires.keel` does not fit this
keel is refused (422). `name` and `version`, when sent, must equal the pack's own. Install and uninstall need the MCP
**admin** level. keel checks a pack before it saves it; the Rules page's "Check and try it" also says which of the
project's recent tool calls it would have refused (`POST rules/check {yaml}`).

`requires.plugins` is shown on the Rules page and kept for a marketplace to resolve; keel's guard does not need a
plugin to apply a pack.
