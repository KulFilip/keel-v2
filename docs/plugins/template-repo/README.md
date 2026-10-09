# keel plugin template

Start a [keel](https://github.com/MiladNalbandi/keel-v2) plugin from this repo: press **Use this template** on GitHub.
You get a small plugin that works (`example`: an engine part, a web part and a content folder), a CI that builds and
tests it with keel's own build, and a release workflow that signs it with **your** key.

```
keel-plugin.yml          the manifest: name, version, what it needs, its parts, its permissions
engine/                  keel_plugin_example: the Python part (actions, agent tools, hooks)
web/index.js             the web part (pages and slots), an ES module; or web/index.tsx, built by keel's build
content/                 workflows, agents, skills
keel.ref                 the keel-v2 commit your plugin is built against
.github/workflows/       ci.yml (every push and pull request), release.yml (a tag v<version>)
```

The whole guide is keel's
[publish your plugin](https://github.com/MiladNalbandi/keel-v2/blob/plugin-base/docs/plugins/17-publish-your-plugin.md).
The short way is below.

## The way: new → dev → lint → keygen → tag → marketplace

```
 1 new       2 dev              3 lint           4 keygen             5 tag v0.1.0         6 pull request
 ─────       ─────              ──────           ────────             ────────────         ──────────────
 your repo   try it in your     the checks keel  your key pair:       release.yml builds,  keel-marketplace:
 from this   running keel       and the catalog  secret → repo        signs, makes the     publishers/<you>.yml
 template    (unsigned)         run              secret, public →     GitHub release       plugins/<name>.yml
                                                 .github/publisher.pub
```

`keel-plugin` is keel's tool for plugins. Run it with [uv](https://docs.astral.sh/uv/):

```
alias keel-plugin='uvx --from "git+https://github.com/MiladNalbandi/keel-v2@plugin-base#subdirectory=tools/keel-plugin" keel-plugin'
```

### 1. New

Press **Use this template**, then give the plugin its own name. The name is `a-z`, `0-9` and `-`; every name the
plugin adds starts with it (actions `<name>:do`, events `<name>.done`, agent tools `<name>_read`, tables
`<name>_items`).

- In `keel-plugin.yml`: `name`, `title`, `summary`, `publisher` (your publisher id), `repo`.
- Rename `engine/keel_plugin_example/` to `engine/keel_plugin_<name>/` (with `_` for `-`), and the `package` in
  `parts.engine`. Remove the parts you do not use.
- Or start fresh: `keel-plugin new <name> --publisher <you>`, and copy `.github/` and `keel.ref` from here.

### 2. Dev: try it in your keel

With keel running on your computer (`keel2 start`):

```
keel-plugin dev . --keel http://127.0.0.1:8080
```

It builds and packs the plugin (not signed), installs the file into your keel and restarts it. keel says the file is
unsigned: that is fine on your own computer, never for other people.

### 3. Lint

```
keel-plugin lint .
```

The same checks keel and the marketplace run: the manifest, the names and their prefix, the parts, no links, no code
from the internet in the web part. CI runs them on every push, and also builds and tests the plugin with keel's build.

### 4. Keygen: your signing key

```
keel-plugin keygen <you>                         # <you>.key (secret) and <you>.pub (public)
gh secret set PUBLISHER_KEY < <you>.key          # the release workflow signs with it
cp <you>.pub .github/publisher.pub               # the release checks the secret against it
```

Then put `<you>.key` somewhere safe (a password manager) and delete the file. **Never commit it.** (`.gitignore` has
`*.key`.) If someone may know it, make a new key and tell the marketplace.

### 5. Tag: your first release

Set `version` in `keel-plugin.yml` (and `VERSION` in the engine package), commit, then:

```
git tag v0.1.0 && git push origin v0.1.0
```

`release.yml` checks that the tag is `v` + the manifest's version, builds and tests, signs with `PUBLISHER_KEY` and
makes the GitHub release with `<name>-0.1.0.kplug` and `<name>-0.1.0.kplug.minisig`. The repo must be **public**:
keel downloads the files without a token.

### 6. The marketplace: a pull request

Open a pull request to [keel-studio/keel-marketplace](https://github.com/keel-studio/keel-marketplace) with two files:

```yaml
# publishers/<you>.yml
name: <you>
title: Your Name
keys: [RWQ…] # the line in your .pub file that starts with RW (public: safe to share)
```

```yaml
# plugins/<name>.yml
name: <name>
title: "Your Plugin"
publisher: <you>
repo: https://github.com/<you>/keel-plugin-<name>
category: other # code, review, knowledge, tickets, product or other
summary: "One sentence that says what it does for the person."
tags: [one, two]
trust: code # content (only content/), web (adds pages) or code (an engine or api part)
```

The pull request's check lints your newest release and checks its signature with your key. After the merge, keel
lists your plugin within the hour. A new publisher is **not verified**: people can install a content-only plugin, but
a web or code plugin only when they allow unverified publishers. The guide says how to become verified.

## Build against a newer keel

Put a newer keel-v2 commit in `keel.ref` (a pull request: CI shows if your plugin still builds).

## License

MIT (change it to yours).
