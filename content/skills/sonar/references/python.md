# Sonar — Python / Django

- **No bare `except:` and no `except Exception: pass`.** Catch what can happen; re-raise
  `SystemExit`/`KeyboardInterrupt` if you catch `BaseException`.
- **snake_case** for functions and variables, `PascalCase` for classes.
- **No mutable default arguments** (`def f(x=[])`).
- **A literal used 3+ times → a module constant.**
- **No unused imports, locals or parameters**; no `print()` left in — use `logging`.
- **Functions ≤ 7 parameters** — a dataclass.
- **Django**: no raw SQL by string formatting — ORM or `params=`; `DEBUG = False` outside dev
  settings; no hard-coded `SECRET_KEY`; `ALLOWED_HOSTS` never `['*']` in production settings.
- **Tests (pytest)**: each test asserts; no `@pytest.mark.skip`; no `time.sleep` — freeze time.
