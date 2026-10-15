# 18 · Step 5 report: each plugin can live in its own repo

The spec is the "Step 5" part of [16-steps5-7-contract.md](16-steps5-7-contract.md) (and the template repo of step 7).
Everything was built and tested **on this computer**. Nothing was pushed. No repo, release or secret was made.

## The idea in one picture

```
 keel-studio/keel-plugin-jira (its own repo)            MiladNalbandi/keel-v2
 ───────────────────────────────────────────            ─────────────────────
 keel-plugin.yml  api/  web/  …                         scripts/build-plugin-repo.sh   (keel's build, for one plugin)
 keel.ref ── a keel-v2 commit ─────────────────────▶    plugins/  product/  api/  web/  engine/
 .github/workflows/ci.yml       (push, pull request)      ▲
 .github/workflows/release.yml  (tag v1.2.0)             │ 1 checkout keel-v2 at keel.ref
        │                                                 │ 2 jira into keel/plugins/jira/
        │                                                 │ 3 tasks (jira needs it): tasks' repo at a tag that fits,
        │                                                 │   or keel-v2's own copy
        │                                                 │ 4 keel's tests and build, pack, lint
        ▼
 GitHub release v1.2.0:  jira-1.2.0.kplug  +  .minisig  (signed with the org secret KEEL_PUBLISHER_KEY)
        │
        ▼
 keel-v2's plugins.lock:  jira 1.2.0 https://github.com/…/jira-1.2.0.kplug sha256:…
        │
        ▼
 docker build --build-arg PLUGINS=lock   download → sha256 → signature (content/trust/keel.pub) → lint → the image
```

A plugin repo has **only the plugin**. It does not copy keel's build. It builds with keel's own build, at a fixed
keel-v2 commit (`keel.ref`). No SDK package goes to PyPI, npm or Maven.

## What was built

| file                                     | what it does                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/build-plugin-repo.sh`           | the build of a plugin repo: the plugin into `plugins/<name>/` (Product: `product/`), the plugins it needs (their repo at the newest release tag that fits, else keel's copy), engine tests, api tests + jar, web tests + build, pack, lint |
| `docs/plugins/plugin-repo/`              | the files every first-party plugin repo gets: `ci.yml`, `release.yml`, `keel.ref`, the repo page (`.github/README.md`), `.gitignore`                                                                                                       |
| `docs/plugins/tools/split-plugin.sh`     | makes a plugin's repo **with its history** (`git subtree split`), adds the files above, `keel.ref` = this commit, one commit. Never pushes; `--push` only prints the commands. `--template` makes the template repo                        |
| `docs/plugins/template-repo/`            | `keel-studio/keel-plugin-template` for other publishers: what `keel-plugin new example` makes, CI, a release with **their own key** (`PUBLISHER_KEY`), a README: new → dev → lint → keygen → tag → marketplace                             |
| `plugins.lock`                           | one line per released plugin: `<name> <version> <url> sha256:<hex>`. Empty now (only comments): nothing is released yet                                                                                                                    |
| `Dockerfile`                             | `ARG PLUGINS=source` (the default, as before) or `PLUGINS=lock` (the released plugins of the lock)                                                                                                                                         |
| `scripts/fetch-locked-plugins.sh`        | what `PLUGINS=lock` runs: download, sha256, signature, lint, the manifest is the lock's line, every needed plugin is locked, unpack as `<name>/<version>/`. `--check` checks the lock only (CI runs it)                                    |
| `scripts/update-plugins-lock.sh [name…]` | writes the lock's lines from the newest releases in keel-studio (gh). It checks each file's signature and lint first                                                                                                                       |
| `scripts/plugin_versions.py`             | versions and ranges as keel's resolver reads them (used by the scripts above)                                                                                                                                                              |
| `setup-signing-keys.sh --org`            | also stores the keel key as keel-studio's **organisation** secret `KEEL_PUBLISHER_KEY` (the plugin repos sign with it)                                                                                                                     |
| `e2e/repos/e2e.py`                       | the proof below                                                                                                                                                                                                                            |

**Every part is optional.** The build runs only the steps for the parts a plugin has: no engine tests → no engine
step; no api → no Gradle; a web part without `index.tsx` (what `keel-plugin new` makes) is packed as it is.

## Decisions (they are also in the contract, "Settled when it was built")

- **The build steps live in keel-v2**, in one script, at `keel.ref`. The repos' workflows only check keel out and call
  it. So a change to keel's build needs no change in twelve repos.
- **`PLUGINS=lock` means exactly the lock.** It never mixes released plugins with `plugins/`. So **Tasks comes from
  the lock too**: Jira needs Tasks, so the lock must list Tasks, or the build stops ("jira 1.0.0 needs tasks, which
  plugins.lock does not lock"). An empty lock stops the build too (it would make an image without plugins).
- **The test key never goes into the repo.** The lock and `content/` are a small build stage, `plugins-lock`. The test
  gives its own folder with `--build-context plugins-lock=<folder>`. There is no build argument for the key.
- **The repo page is `.github/README.md`**, so it never gets into the package (the package stays the same as keel's).
- keel's other plugins stay in `keel/plugins/` during a plugin's build: some web tests run a plugin inside keel's full
  menu (Wiki checks it comes right after Graph).
- A tag whose manifest is another version (its release was refused) is passed over when a plugin needs that plugin.

## The proof

`python3 e2e/repos/e2e.py`: **50 checks passed** (about 7 minutes). No network to GitHub, no push, a test key.

1. **Repos.** `split-plugin.sh` made the repos of `tasks`, `wiki` and `jira` with their history (jira: 4 commits +
   the repo commit), `keel.ref` = HEAD, the commit ends with the KeelBot line, no remote. And the template repo.
2. **CI, as GitHub would run it.** The e2e reads each repo's `ci.yml` and `release.yml` and runs the steps here:
   `actions/checkout` clones this checkout (keel-v2) or the plugin repo, `run:` steps run with `bash -eo pipefail`,
   `${{ }}` values, `GITHUB_OUTPUT`, a stand-in `gh` that keeps each release in a folder. `act` is not needed.
   - tasks, wiki, jira: CI passes (wiki: engine tests, api tests + jar, web tests + build; jira: api and web, no engine
     step). Each `.kplug` passes lint.
   - **jira's CI took tasks from tasks' repo at its tag `v1.0.0`** (it needs tasks).
   - `release.yml` **refused the tag `v9.9.9`** ("keel-plugin.yml says 1.0.0") and **a missing key**, before any build.
   - On `v1.0.0` each release built, signed (test key) and released `.kplug` + `.minisig`; each verifies.
   - The template (`example`: engine, a ready web part, content, no api): CI passes; its release signs with the
     publisher's own key and checks it with `.github/publisher.pub`.
3. **Lock.** The releases served by a local HTTP server; `fetch-locked-plugins.sh` checked and unpacked all three.
4. **Image.** `docker build --build-arg PLUGINS=lock --build-arg PLUGINS_LOCK_ALLOW_HTTP=1 --build-arg INSTALL_CLIS=0
--build-context plugins-lock=<test lock + test key>` → `keel-v2:s5-lock`. Its `/opt/keel-v2/plugins` has exactly
   `jira/1.0.0`, `tasks/1.0.0`, `wiki/1.0.0`. A throw-away `keel-s5` on 127.0.0.1:8093:
   `/api/plugin-host` lists **tasks, jira and wiki 1.0.0, source `image`, no problems**; their web parts load. The same
   build **without keel.pub** stops ("content/trust/keel.pub is missing … build with PLUGINS=source"), and with the
   repo's empty lock it stops ("locks no plugin").
5. **A normal build is unchanged.** The plugins stage of `docker build` (PLUGINS=source) has the **same 11 plugins and
   the same 90 files (sha256)** as the Dockerfile before step 5 (`fca8ec9`).

The container, its volume and the `keel-v2:s5-*` images were removed at the end.

**Other checks:** `tools/keel-plugin` tests: 169 passed (41 new for step 5: versions, the build of a content-only
plugin, the template, needed plugins from keel or from a repo tag, split, the lock's format, a wrong sha256, a bad
signature, no key, http without the test flag, a missing needed plugin, update-plugins-lock with a stand-in gh, and 2
for `--org`). `scripts/no-v1.sh --strict`: clean. `bash -n` on the new scripts (shellcheck is not on this computer;
CI runs it). The engine, api and web suites were not run again: step 5 did not change their build files (Gradle, Vite,
`test-plugins.sh`, `build-plugin.sh`); the e2e ran their plugin builds and tests for tasks, wiki and jira.

## What Milad does (outward steps, only when you say so)

1. **Keys, with the org secret.** If the keys are not made yet:
   `docs/plugins/tools/setup-signing-keys.sh --org`. It also stores `KEEL_PUBLISHER_KEY` as keel-studio's
   organisation secret. If you made them before without `--org` and nothing is released yet, run it again with
   `--org` (it makes new keys). Commit `content/trust/*.pub` and `publishers/keel.yml` on `plugin-base`.
2. **Split and push a plugin** (start with one, for example wiki), on a `plugin-base` checkout that has step 5:

   ```
   docs/plugins/tools/split-plugin.sh wiki /tmp/keel-plugin-wiki --push
   ```

   It prints the push commands. The keel-studio repo has a starter README, so the push is `--force`. The repo must
   be public.

3. **The template:** `docs/plugins/tools/split-plugin.sh --template /tmp/keel-plugin-template --push`, push, then
   `gh repo edit keel-studio/keel-plugin-template --template`.
4. **First release** from the repo: `git tag v1.0.0 && git push origin v1.0.0`. Then do not release that plugin from
   keel-v2's `plugins-release.yml` any more ([14-publishing.md](14-publishing.md)).
5. **Lock it:** `scripts/update-plugins-lock.sh wiki`, commit `plugins.lock`. When every plugin has a release, decide
   to build with `PLUGINS=lock` (docker.yml, a build argument), and later remove `plugins/` from keel-v2.
