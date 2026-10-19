# Sonar — Kotlin / Spring

- **Prefer `val`**; a `var` that is never reassigned is reported.
- **No `!!`** — use `?:`, `requireNotNull(x) { "…" }` or a smart cast. `!!` is a likely NPE.
- **No empty or swallowing `catch (e: Exception) {}`.** Catch the specific exception; let the
  `@ControllerAdvice` map the rest.
- **No `println`** — use the class logger. Never log a request body, a token or a password.
- **`when` over long `if/else if` chains**, and always with an `else` (or exhaustive over a sealed type).
- **Constants**: a literal repeated 3+ times → `private const val` in a `companion object` or top level.
- **Functions ≤ 7 parameters** — group them in a `data class` (a request or command object).
- **Coroutines**: no `GlobalScope`, no `runBlocking` in production code.
- **Spring**: constructor injection, not field `@Autowired`; no `@Transactional` on private
  methods (it does nothing); `@RequestMapping` with an explicit method.
- **Tests (JUnit 5)**: test classes and methods without `public`; one call inside an
  `assertThrows {}` lambda; expected value first in `assertEquals(expected, actual)`; no
  `Thread.sleep`.
