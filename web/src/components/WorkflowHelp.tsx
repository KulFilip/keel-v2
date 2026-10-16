// "The fields of a workflow": a short reference under each workflow YAML editor (the YAML tab, Import, New workflow),
// like the rule pack's (RuleDrawers PackHelp). The keys and kinds are the engine's (keel_engine/workflows/model.py Step,
// validate.py), each with an example from keel's own workflows (content/workflows/*.yaml).

export const WORKFLOW_DOCS = "https://github.com/MiladNalbandi/keel-v2/blob/main/docs/CONTRACT.md#workflow-keys-engine-generic";
export const WORKFLOW_EXAMPLES = "https://github.com/MiladNalbandi/keel-v2/tree/main/content/workflows";

const HEAD: [string, string, string][] = [
  ["id", "lower-case, digits, dashes; keel tells workflows apart by it", "id: hotfix"],
  ["name", "a few words (required)", "name: Hotfix"],
  ["version", "a whole number", "version: 1"],
  ["keel_rules", "true keeps the locked steps (gates, test checks)", "keel_rules: true"],
  ["based_on", "the keel workflow it copies", "based_on: keel/fix"],
  ["needs_plugins", "plugins it needs to run (optional)", "needs_plugins: [db]"],
  ["steps", "the steps, run from the top down", "steps:"],
];

const KINDS: [string, string, string][] = [
  ["agent", "asks an agent (tokens); needs agent", "- { id: red, kind: agent, name: red, agent: test-author }"],
  ["code", "runs plain code (no tokens); needs action", "- { id: verify_red, kind: code, name: verify red, action: verify_red+commit }"],
  ["gate", "waits for a person", "- { id: plan_ok, kind: gate, name: plan approval, back: plan }"],
  ["branch", "yes goes on, no goes to `no`; decided by when, a run: command or an agent", "- { id: reproduced, kind: branch, name: reproduced, when: { marker: REPRO, equals: confirmed }, 'no': repro }"],
  ["parallel", "several agents at once (agent, lanes or from)", "- { id: reviewers, kind: parallel, name: reviewers, agent: reviewer, from: review_lenses }"],
  ["include", "the steps of another workflow here", "- { id: ship, kind: include, name: ship, flow: ship }"],
];

const KEYS: [string, string, string][] = [
  ["id · kind · name", "every step has them; ids are unique", "id: green"],
  ["phase", "a keel phase (spec, red, green, review, final-review …)", "phase: red"],
  ["agent · model", "the agent of an agent or parallel step; model default = the agent's", "agent: implementer"],
  ["action", "keel actions (verify_red, commit, report …), a plugin block, or run: <command>; + runs two", "action: \"run: npm test\""],
  ["per_ac", "runs once for each acceptance criterion (these steps sit together)", "per_ac: true"],
  ["back", "a gate's (or code step's) send-back target: an earlier step", "back: plan"],
  ["no", "a branch's target when the answer is no (quote it: YAML reads no as false)", "'no': repro"],
  ["lock", "a keel rule: it stays while keel_rules is on", "lock: true"],
  ["markers", "values read from the agent's last text (REPRO: confirmed)", "markers: [REPRO]"],
  ["when", "a branch's question, or when a step runs / a gate pauses", "when: { marker: REPRO, equals: confirmed }"],
  ["rounds · after_rounds", "fix attempts before keel asks; where failures go after them", "rounds: 2"],
  ["then", "a code step's next step: end, continue or a step id", "then: end"],
  ["choices", "a gate's named exits (a map) or per-item choices (a list)", "choices: { try_again: measure, go_on: report }"],
  ["for_each · per_item", "a loop over a list in the flow's data", "for_each: coverage_groups"],
  ["from · cap · batch", "a parallel step: one agent per item of a list, at most cap", "from: hypotheses"],
  ["with", "a plugin block's settings", "with: { sql: \"SELECT 1\", expect: none }"],
  ["soft", "a code step whose failure goes on (a branch reads RESULT)", "soft: true"],
  ["max_tokens · on_limit", "a step's token cap: pause, cheaper or stop", "max_tokens: 50000"],
  ["tools", "extra tools for the agent", "tools: [\"mcp:keel:*\"]"],
  ["instructions", "what this step wants that the agent's role does not say", "instructions: >-"],
];

export function WorkflowHelp() {
  const rows = (title: string, items: [string, string, string][]) => (
    <>
      <tr><th colSpan={3}>{title}</th></tr>
      {items.map(([field, allowed, example]) => (
        <tr key={`${title}-${field}`}><td><code>{field}</code></td><td>{allowed}</td><td><code>{example}</code></td></tr>
      ))}
    </>
  );
  return (
    <details className="rl-help wf-help">
      <summary>The fields of a workflow</summary>
      <table>
        <thead><tr><th>Field</th><th>Allowed</th><th>Example</th></tr></thead>
        <tbody>
          {rows("The workflow", HEAD)}
          {rows("Step kinds (kind:)", KINDS)}
          {rows("Step keys", KEYS)}
        </tbody>
      </table>
      <span className="row" style={{ gap: 12 }}>
        <a href={WORKFLOW_DOCS} target="_blank" rel="noreferrer">All the keys: docs/CONTRACT.md (Workflow keys)</a>
        <a href={WORKFLOW_EXAMPLES} target="_blank" rel="noreferrer">keel's own workflows: content/workflows</a>
      </span>
    </details>
  );
}
