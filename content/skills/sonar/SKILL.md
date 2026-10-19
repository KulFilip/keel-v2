---
name: sonar
description: Write code and tests that pass SonarQube's quality gate on new code — complexity, duplication, dead code, test smells and security hotspots, with the per-language rules. Load in RED, GREEN and review-fix, before you stop.
---

# Sonar — code that passes the quality gate

Sonar judges **new code** only — the lines this branch adds or changes. Aim for the default
*Sonar way* gate unless the project's own gate is stricter (check `sonar-project.properties`, or
ask):

| Condition on new code | Pass when |
|---|---|
| Reliability (bugs) | rating A — no new bug |
| Security (vulnerabilities) | rating A — no new vulnerability |
| Maintainability (code smells) | rating A — and in practice: no new issue above *minor* |
| Security hotspots | 100% reviewed — so **do not write one** unless the AC needs it (below) |
| Coverage | ≥ 80% (keel's own changed-line floor is higher, so meeting keel meets this) |
| Duplicated lines | ≤ 3% |

Read your own diff against this page **before you stop** (keel runs the tests and commits after you), not
after Sonar complains. Then the language page: `references/kotlin.md`, `typescript.md`, `php.md` or
`python.md`. One page, not all four.

## Production code — the rules that fail gates most

1. **Cognitive complexity ≤ 15 per function** (S3776). Each `if`, loop, `catch`, `&&`/`||` chain and
   *nesting level* adds to it. Fix with early returns, guard clauses and a small private helper —
   not by splitting one function into two that call each other.
2. **No duplicated blocks.** Sonar counts ~10 identical lines (or ~100 tokens) as a duplicate. Each
   AC is written in its own context and will happily copy the last one: on the third copy, extract.
3. **The same string literal 3+ times → a constant** (S1192). Error messages, header names, JSON keys.
4. **No dead code**: unused imports, locals, private members and parameters; a value assigned and
   then overwritten before use (dead store); a condition that is always true or false.
5. **No commented-out code** (S125). Delete it — git has it.
6. **No empty blocks.** An empty `catch` hides a failure; an empty method needs a one-line comment
   saying why it is empty.
7. **Do not catch or throw the most generic exception type** (`Exception`, `Throwable`, bare
   `except:`). Catch what can actually happen; throw a specific or domain exception.
8. **≤ 7 parameters**, no nested ternaries (S3358), no identical branches in an `if`/`when`/`switch`.
9. **TODO comments are reported** (S1135, info). Do not leave one; if work is deferred, it belongs
   in the spec's out-of-scope section.

## Security hotspots — avoid writing them

A hotspot is not a bug, but the gate needs a human to mark each one reviewed on the server, and
nobody in the loop can. So **prefer the safe form**; if the AC truly needs the risky one, write it
and **say so in your report** (file:line and why), so the reviewer marks it on the server.

| Avoid | Write instead |
|---|---|
| a password, token or key in code or config (S2068) | read it from the environment or the secret store |
| `Random`/`Math.random()` for anything security-related (S2245) | `SecureRandom` / `crypto.randomUUID()` / `secrets` |
| MD5/SHA-1 for security (S4790) | SHA-256 or a password hash (bcrypt/argon2) |
| `http://` URLs to real services (S5332) | `https://` |
| SQL built by string concatenation (S2077) | bound parameters / the query builder |
| CORS `*` with credentials (S5122) | an explicit origin list from config |
| debug or stack traces in responses | a mapped error body |

## Tests — Sonar reads them too

- **Every test asserts something** (S2699). A test that only calls the code is reported, and it
  proves nothing anyway.
- **No sleeps in tests** (S2925). Wait on a condition or use a fake clock.
- **No disabled or skipped tests** (S1607). keel's audit refuses them too.
- Tests are excluded from coverage, but **not from duplication**: a pasted setup block is a
  duplicate. Use a fixture, a builder or a parameterized test.

## When Sonar runs

A project's Sonar scanner runs as one of its check tools in ship's static checks (the `lint` step, before
the pull request). A finding there is shown at the final review and fixed by the lint flow: a code change, so
cheaper to avoid now than to fix then.
