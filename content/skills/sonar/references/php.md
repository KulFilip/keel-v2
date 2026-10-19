# Sonar — PHP / Symfony

- **Type everything**: parameter, return and property types; `declare(strict_types=1);` in new files.
- **No `@` error suppression**, no `eval`, no `exit`/`die` in application code.
- **Catch specific exceptions**, never an empty `catch (\Exception $e) {}`.
- **PSR naming**: classes `PascalCase`, methods and variables `camelCase`, constants `UPPER_CASE`.
- **A literal used 3+ times → a class constant.**
- **No unused `use` statements, private methods or parameters.**
- **Methods ≤ 7 parameters** — a DTO or a command object.
- **Doctrine**: no DQL or SQL built by concatenation — `setParameter()`.
- **Symfony**: no secrets in `.env` committed values or `config/*.yaml` — `%env()%` and the
  secrets vault; no `dump()`/`dd()` left in.
- **Tests (PHPUnit)**: each test asserts (`expectException` counts); no `markTestSkipped`;
  no `sleep()`.
