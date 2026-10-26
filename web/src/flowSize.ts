// keel 0.18.12 "pick the size for me": from the words of a request, the keel flow that fits (quick, implement, small,
// change, feature, or fix for a bug), with the reason in a few words. The person still chooses; this only marks one.

/** The flows a request can be sized into, smallest first, with what each is for in one line. */
export const SIZE_FLOWS: { id: string; about: string }[] = [
  { id: "quick", about: "one agent, the tests, one look, one commit" },
  {
    id: "address",
    about: "a review comment or test code only: one agent, the tests, one look",
  },
  { id: "implement", about: "the code, then its tests; done when they pass" },
  { id: "small", about: "a short plan, test-first, one review" },
  { id: "change", about: "1–3 criteria, test-first, then ship" },
  { id: "feature", about: "spec, contract, criteria, reviews, ship" },
];

const NO_TEST_FIRST =
  /\b(code first|no tests? first|without tdd|tests? (after|afterwards|later)|just implement)\b/i;
const BIG =
  /\b(migrations?|database|schema|tables?|auth\w*|log ?in|permissions?|roles?|contract|openapi|new (page|screen|service)|dashboard|integrat\w+|payments?|redesign\w*|several|multiple|endpoints)\b/i;
const BUG =
  /\b(bugs?|broken|break(s|ing)?|crash\w*|errors?|fails?|failing|wrong|regression|exception|doesn'?t work|not working)\b/i;
const TINY =
  /\b(typos?|wording|spelling|renam\w+|labels?|texts?|colou?rs?|spacing|margins?|padding|icons?|tooltips?|config\w*|settings?|bump|versions?|comments?|readme|docs?|log messages?|translations?|titles?)\b/i;

// 0.18.56 a change to test code only (every file the request names is a test, by keel's path roles: engine
// rules._TEST_PATH) has no new behaviour for a failing test to describe: the address flow, not a test-first one
const CODE_FILE =
  /(?<![\w@.-])((?:[\w@.-]+\/)*[\w@-]+(?:\.[\w-]+)*\.(?:php|kt|kts|java|ts|tsx|js|jsx|mjs|cjs|py|go|rb|cs|scala|swift|rs|vue|svelte|ex|exs|dart|groovy))(?![\w-])/g;
const TEST_PATH = [
  /(^|\/)(test|tests|__tests__|spec)\//,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go|rb|exs?)$/,
  /_spec\.rb$/,
  /\.(test|spec)\.(ts|tsx|js|jsx)$/,
  /Test\.(kt|java|php)$/,
  /Tests\.(kt|java)$/,
  /(^|\/)src\/test\//,
  /(^|\/)src\/integrationTest\//,
];

/** The code files a request names, when every one of them is a test file (else []). */
export function testOnlyFiles(text: string): string[] {
  const files = [...new Set([...text.matchAll(CODE_FILE)].map((m) => m[1]))];
  return files.length && files.every((f) => TEST_PATH.some((re) => re.test(f)))
    ? files
    : [];
}

/** The flow that fits these words (only one of `available`), and why; null when there are no words yet. */
export function suggestFlow(
  text: string,
  available: string[],
): { id: string; why: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const has = (id: string) => available.includes(id);
  const pick = (ids: string[], why: string) => {
    const id = ids.find(has);
    return id ? { id, why } : null;
  };
  const bullets = text
    .split("\n")
    .filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)).length;
  const word = (re: RegExp) => (re.exec(text)?.[0] ?? "").toLowerCase();
  if (testOnlyFiles(text).length)
    return pick(["address", "quick"], "only test code changes");
  if (NO_TEST_FIRST.test(text))
    return pick(
      ["implement", "small"],
      "you want the code first, then its tests",
    );
  if (BIG.test(text))
    return pick(
      ["feature", "change"],
      `it touches ${word(BIG)}: worth a spec and the full checks`,
    );
  if (words.length > 120 || bullets >= 5)
    return pick(
      ["feature", "change"],
      "a long request: worth a spec and its criteria",
    );
  if (BUG.test(text)) {
    return words.length <= 30
      ? pick(
          ["quick", "fix"],
          "a small bug: one agent fixes it with a test, you look once",
        )
      : pick(["fix", "change"], "a bug: first reproduce it as a failing test");
  }
  if (TINY.test(text) && words.length <= 40)
    return pick(["quick", "small"], `a small, clear change (${word(TINY)})`);
  if (words.length <= 60)
    return pick(
      ["small", "change"],
      "a small feature: a short plan and 1–3 criteria",
    );
  return pick(
    ["change", "feature"],
    "a medium change: 1–3 criteria, keel hands it over when it is bigger",
  );
}
