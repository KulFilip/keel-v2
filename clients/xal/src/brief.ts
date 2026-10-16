// Which keel project xal works in, and the short brief a new xal session starts with. One read of /api/projects
// (the flow, phase, criteria, what waits and runs: the same source as keel2's planned status line and brief).

export type Project = {
  id: string;
  name: string;
  root: string;
  branch: string;
  flow: string | null;
  phase: string;
  acs: [number, number];
  waiting: number;
  running: number;
  flows?: number;
};

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/");

/**
 * The project for xal's working directory: the configured id or name; else the project whose folder holds `cwd`
 * (added folders and Docker-access mode keep the computer's paths); else the only project; else keel's main project
 * (`/workspace` inside keel's container). Undefined: let keel choose.
 */
export function pickProject(projects: Project[], cwd: string, configured?: string): Project | undefined {
  if (configured) {
    const p = projects.find((x) => x.id === configured) ?? projects.find((x) => x.name === configured);
    if (!p) throw new Error(`keel has no project "${configured}" (it has: ${projects.map((x) => x.id).join(", ") || "none"})`);
    return p;
  }
  const holding = projects.filter((p) => p.root && under(cwd, p.root)).sort((a, b) => b.root.length - a.root.length);
  if (holding[0]) return holding[0];
  if (projects.length === 1) return projects[0];
  return projects.find((p) => p.root === "/workspace");
}

/** At most six lines for the system prompt. Session state, not instructions: what keel is doing on this project. */
export function briefText(p: Project, url: string, inbox: number): string {
  const lines = [`keel v2 (${url}) runs this project's flows: project ${p.name} (${p.id}), branch ${p.branch || "?"}.`];
  if (p.flow) {
    const [done, total] = p.acs ?? [0, 0];
    const parts = [`flow "${p.flow}"`, p.phase ? `phase ${p.phase}` : "", total ? `AC ${done}/${total}` : ""].filter(Boolean);
    lines.push(`Now: ${parts.join(" · ")}.`);
  } else {
    lines.push("Now: no flow runs.");
  }
  const busy = [p.waiting ? `${p.waiting} waiting for the person` : "", p.running ? `${p.running} agent call(s) running` : ""].filter(Boolean);
  if (busy.length) lines.push(`keel: ${busy.join(", ")}.`);
  if (inbox) lines.push(`keel's Inbox has ${inbox} item(s) across projects.`);
  lines.push("keel's agents may change this folder while a flow runs; the person steers keel with /keel:* commands.");
  return ["<keel-brief>", ...lines, "</keel-brief>"].join("\n");
}
