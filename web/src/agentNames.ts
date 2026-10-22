// Agent names that changed (engine/keel_engine/agent_names.py, api keel.api.agents.AgentNames): an old name still
// means the new agent. The api answers with the new names only; this is for names a person types (keel2 /skill attach)
// or a KeelBot block writes.

/** old name -> new name */
export const RENAMED_AGENTS: Readonly<Record<string, string>> = {
  "ac-reviewer": "criterion-reviewer",
  "code-reviewer": "branch-reviewer",
  "reviewer": "lens-reviewer",
  "ticket-reviewer": "pr-reviewer",
};

/** The agent's current name: an old name gives its new one, any other name stays as it is. */
export function agentName(name: string): string {
  return Object.prototype.hasOwnProperty.call(RENAMED_AGENTS, name) ? RENAMED_AGENTS[name] : name;
}
