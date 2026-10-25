// keel Product's api (product/api ProductController): initiatives, their stages, questions, disagreements, follow-ups,
// the plan (its drafts, its Jira tickets) and its hand-off, the teams with their knowledge, projects, Jira and ticket
// keys, and the Jira plugin's keel-wide connection (/api/jira).

import { del, get, getText, patch, post, put } from "@keel/web-sdk";

export const STAGES = [
  "idea",
  "brief",
  "impact",
  "decision",
  "plan",
  "delivery",
  "outcome",
  "done",
] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABEL: Record<string, string> = {
  idea: "Idea",
  brief: "Brief",
  impact: "Impact",
  decision: "Decision",
  plan: "Plan",
  delivery: "Delivery",
  outcome: "Outcome",
  done: "Done",
};

export type Initiative = {
  id: string;
  n: number;
  title: string;
  idea: string;
  why_now?: string | null;
  outcome_hope?: string | null;
  owner?: string | null;
  stage: string;
  status: string;
  option?: string | null;
  repos: string[];
  metric?: string | null;
  revisit_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type Progress = { done: number; total: number };

export type BoardItem = {
  id: string;
  title: string;
  stage: string;
  status: string;
  waiting: boolean;
  teams: string[];
  option?: string | null;
  progress?: Progress | null;
  next: string;
  updated_at: string;
  revisit_at?: string | null;
};

export type GateQuestion = {
  id: string;
  question: string;
  why?: string;
  options: { label: string; description?: string; recommended?: boolean }[];
};
export type Waiting = {
  step?: string;
  kind?: string;
  title?: string;
  detail?: string;
  questions?: GateQuestion[];
  choices?: string[];
};

export type StageView = {
  stage: string;
  status: string;
  thread_id?: string | null;
  waiting?: Waiting | null;
  next: string;
};

export type DocView = {
  kind: string;
  version: number;
  versions: number[];
  path: string;
  text: string;
  data?: unknown;
  approved_at?: string | null;
  created_at: string;
};
export type ProductDoc = {
  initiative_id: string;
  kind: string;
  version: number;
  path: string;
  sha?: string | null;
  text: string;
  data?: unknown;
  thread_id?: string | null;
  created_at: string;
  approved_at?: string | null;
};

export type Question = {
  id: string;
  initiative_id: string;
  stage: string;
  role: string;
  asked_to?: string | null;
  about?: string | null;
  text: string;
  answer?: string | null;
  answered_by?: string | null;
  status: string;
  created_at: string;
  answered_at?: string | null;
};

export type Disagreement = {
  id: string;
  initiative_id: string;
  stage: string;
  author: string;
  reason: string;
  proposal?: string | null;
  decider: string;
  status: string;
  outcome?: string | null;
  decided_by?: string | null;
  created_at: string;
  decided_at?: string | null;
};

export type ProductEvent = {
  id: number;
  initiative_id: string;
  at: string;
  actor: string;
  kind: string;
  text: string;
  data?: unknown;
};

export type FollowUp = {
  id: string;
  initiative_id: string;
  kind: string;
  text: string;
  owner?: string | null;
  due_at: string;
  repeat_days?: number | null;
  ref?: string | null;
  done_at?: string | null;
  last_reminded_at?: string | null;
  created_at: string;
};

export type Run = {
  thread_id: string;
  initiative_id: string;
  stage: string;
  workflow_id: string;
  status: string;
  reason?: string | null;
  started_at: string;
  ended_at?: string | null;
};

export type Story = {
  id: string;
  epic: string;
  team?: string | null;
  repo?: string | null;
  project_id?: string | null;
  title: string;
  criteria: string[];
  tasks: string[];
  depends_on: string[];
  estimate_days: number[];
  task_id?: string | null;
  task_status?: string | null;
  jira_key?: string | null;
  /** The branches and commits whose names carry its Jira key. */
  work?: TicketWork | null;
};
export type Epic = {
  id: string;
  team?: string | null;
  title: string;
  stories: Story[];
  jira_key?: string | null;
};
export type PlanView = {
  version: number;
  ok: boolean;
  problems: string[];
  critical_path: string[];
  critical_days?: number | null;
  teams?: Record<string, number[]> | null;
  total_days?: number[] | null;
  epics: Epic[];
  progress?: Progress | null;
  /** The initiative's own Jira ticket, when it has one. */
  initiative_key?: string | null;
  /** Changed by hand after keel checked it (its critical path and totals may be old). */
  edited?: boolean;
};

/** A change to a story draft: a field left out stays as it is. */
export type StoryEdit = {
  epic?: string;
  title?: string;
  criteria?: string[];
  tasks?: string[];
  depends_on?: string[];
  estimate_days?: number[];
  team?: string;
  repo?: string;
};
export type EpicEdit = { id?: string; title?: string; team?: string };

/** One ticket of the Jira tree: what a send makes (create), what is there (exists), what cannot go (blocked). */
export type TicketRow = {
  level: "initiative" | "epic" | "story" | "subtask" | string;
  ref: string;
  title: string;
  team?: string | null;
  project?: string | null;
  site?: string | null;
  type?: string | null;
  parent?: string | null;
  key?: string | null;
  action: "create" | "exists" | "blocked" | string;
  problem?: string | null;
};
export type TicketPreview = {
  rows: TicketRow[];
  problems: string[];
  notes: string[];
  creates?: number;
  ok?: boolean;
};
export type SendResult = {
  created: TicketRow[];
  jira: string[];
  notes: string[];
  preview: TicketPreview;
};
/** Where an initiative's own Jira ticket goes; no project = no initiative ticket. */
export type InitiativeJira = {
  connection?: string | null;
  project?: string | null;
  type?: string | null;
};

/** B5: a Jira connection a team or the initiatives can use (GET /api/product/jira/connections); no token. */
export type JiraConnectionInfo = {
  /** the keel project whose own connection it is; null = the keel-wide one */
  project_id: string | null;
  name: string;
  connected: boolean;
  kind?: string | null;
  base_url?: string | null;
  project_key?: string | null;
};

export type JiraConnections = {
  keel_wide: JiraConnectionInfo;
  projects: JiraConnectionInfo[];
  /** null = keel-wide (connected, or no project is); else the project whose connection keel uses instead */
  suggested: string | null;
};

export type RepoOwner = {
  project_id: string;
  name: string;
  root: string;
  teams: string[];
};

export type Detail = {
  initiative: Initiative;
  stage: StageView;
  docs: Record<string, DocView>;
  questions: Question[];
  disagreements: Disagreement[];
  runs: Run[];
  history: ProductEvent[];
  follow_ups: FollowUp[];
  plan?: PlanView | null;
  repos: RepoOwner[];
  teams: string[];
};

export type TeamPath = {
  team_id: string;
  project_id: string;
  glob: string;
  source: string;
};
/** A team's own Jira. Blank issue types are found in Jira; connection null = the keel-wide one. */
export type TeamJira = {
  connection?: string | null;
  initiative_type?: string | null;
  epic_type?: string | null;
  story_type?: string | null;
  subtask_type?: string | null;
  epic_link_field?: string | null;
  labels: string[];
  component?: string | null;
};
export type Team = {
  id: string;
  name: string;
  lead?: string | null;
  jira_project?: string | null;
  capacity_days?: number | null;
  members: string[];
  source: string;
  owns: TeamPath[];
  created_at: string;
  updated_at: string;
  jira?: TeamJira;
  /** The ticket-key pattern as the team saved it (null: the Jira project key's). */
  key_pattern?: string | null;
  /** The pattern keel matches branches and commits with. */
  keys?: string | null;
  projects?: string[];
};
export type TeamPage = { name: string; title: string; text: string };
export type Suggestion = {
  id: string;
  team_id: string;
  page: string;
  text: string;
  source?: string | null;
  status: string;
  created_at: string;
};
export type TeamKnowledge = {
  team: Team;
  pages: TeamPage[];
  suggestions: Suggestion[];
};
export type TeamBody = {
  name?: string;
  lead?: string | null;
  jira_project?: string | null;
  capacity_days?: number | null;
  members?: string[];
  owns?: { project_id: string; glob: string }[];
  jira?: TeamJira;
  /** "" goes back to the Jira project key's pattern. */
  key_pattern?: string;
};
export type KeyTest = { pattern?: string | null; keys: string[] };

/** A branch or a commit keel read in a team's git. */
export type TicketLink = {
  project_id: string;
  kind: "branch" | "commit" | string;
  ref: string;
  key: string;
  team_id?: string | null;
  title?: string | null;
  author?: string | null;
  at?: string | null;
  files?: string[];
};
export type TicketWork = {
  key: string;
  team?: string | null;
  branches: TicketLink[];
  commits: TicketLink[];
  last_at?: string | null;
};
export type ProjectScan = {
  project_id: string;
  at: string;
  branches: number;
  commits: number;
  linked: number;
  error?: string | null;
};
export type TeamTickets = {
  team?: string | null;
  tickets: TicketWork[];
  unlinked: TicketLink[];
  scans: ProjectScan[];
};
export type ScanResult = { projects: ProjectScan[] };

/** The Jira plugin's keel-wide connection (GET/PUT/DELETE /api/jira): one site and token for every project. */
export type JiraKind = "cloud" | "server";
export type JiraUser = { name: string; email?: string | null };
export type JiraView = {
  connected: boolean;
  settings: {
    kind: JiraKind;
    base_url: string;
    email?: string | null;
    project_key?: string | null;
  };
  token_set: boolean;
  token_hint?: string | null;
  me?: JiraUser | null;
};
export type JiraSave = {
  kind?: JiraKind;
  base_url?: string;
  email?: string;
  token?: string;
  project_key?: string;
};
export type JiraTest = {
  ok: boolean;
  user?: JiraUser | null;
  error?: string | null;
  hint?: string | null;
};
/** One step of a business flow; cite is path:line in the repo (null: keel found no file for it). */
export type FlowStep = { text: string; cite?: string | null; repo?: string | null };
export type FlowView = {
  project_id: string;
  id: string;
  name: string;
  summary?: string | null;
  team?: string | null;
  steps?: FlowStep[] | null;
  endpoints?: string[] | null;
  tables?: string[] | null;
  edited: boolean;
  hidden: boolean;
  updated_at: string;
  /** The ticket keys whose commits changed a file this flow cites. */
  tickets: string[];
};
export type MapTeam = {
  id: string;
  name: string;
  lead?: string | null;
  projects: string[];
  jira_project?: string | null;
  keys?: string | null;
};
export type FlowRun = {
  thread_id: string;
  projects: string[];
  status: "running" | "done" | "failed" | "stopped" | string;
  error?: string | null;
  started_at: string;
  ended_at?: string | null;
};
export type ProductMap = {
  teams: MapTeam[];
  flows: FlowView[];
  tickets: TeamTickets;
  runs: FlowRun[];
  /** The team projects with no flows yet. */
  not_analysed: string[];
};
export type FlowEdit = { name?: string; summary?: string; hidden?: boolean };

export type ImportResult = {
  teams: string[];
  paths: number;
  read: string[];
  skipped: string[];
};

export type NewInitiative = {
  title: string;
  idea: string;
  why_now?: string;
  outcome_hope?: string;
  owner?: string;
  repos: string[];
  start?: boolean;
};
export type Handoff = {
  tasks: string[];
  jira: string[];
  skipped: string[];
  notes: string[];
};

const e = encodeURIComponent;
const I = (id: string) => `/initiatives/${e(id)}`;

export const productApi = {
  info: () =>
    get<{ version: string; project_id: string; root: string }>("/product"),
  board: () => get<BoardItem[]>("/initiatives"),
  repos: () => get<RepoOwner[]>("/initiatives/repos"),
  create: (b: NewInitiative) => post<Detail>("/initiatives", b),
  get: (id: string) => get<Detail>(I(id)),
  patch: (id: string, b: Partial<NewInitiative>) => patch<Detail>(I(id), b),
  start: (id: string, stage?: string) =>
    post<Detail>(`${I(id)}/start`, stage ? { stage } : {}),
  approve: (
    id: string,
    b: { why?: string; answers?: Record<string, string | string[]> } = {},
  ) => post<Detail>(`${I(id)}/approve`, b),
  sendBack: (id: string, note: string) =>
    post<Detail>(`${I(id)}/send-back`, { note }),
  decide: (
    id: string,
    b: {
      choice: "go" | "not_now";
      option?: string;
      why?: string;
      revisit?: string;
    },
  ) => post<Detail>(`${I(id)}/decide`, b),
  rerun: (id: string, b: { stage?: string; note?: string } = {}) =>
    post<Detail>(`${I(id)}/rerun`, b),
  stop: (id: string) => post<Detail>(`${I(id)}/stop`),
  ask: (id: string, b: { text: string; to: string; about?: string }) =>
    post<Question>(`${I(id)}/questions`, b),
  answer: (id: string, qid: string, answer: string) =>
    post<Question>(`${I(id)}/questions/${e(qid)}/answer`, { answer }),
  disagree: (
    id: string,
    b: { stage?: string; reason: string; proposal?: string; author?: string },
  ) => post<Disagreement>(`${I(id)}/disagreements`, b),
  settle: (id: string, did: string, b: { outcome: string; note?: string }) =>
    post<Disagreement>(`${I(id)}/disagreements/${e(did)}/settle`, b),
  rerunWithObjection: (id: string, did: string) =>
    post<Detail>(`${I(id)}/disagreements/${e(did)}/rerun`),
  addFollowUp: (
    id: string,
    b: { text: string; due_at: string; owner?: string },
  ) => post<FollowUp>(`${I(id)}/follow-ups`, b),
  doneFollowUp: (id: string, fid: string) =>
    post<FollowUp>(`${I(id)}/follow-ups/${e(fid)}/done`),
  park: (id: string, b: { revisit?: string; why?: string } = {}) =>
    post<Detail>(`${I(id)}/park`, b),
  unpark: (id: string) => post<Detail>(`${I(id)}/unpark`),
  released: (id: string) => post<Detail>(`${I(id)}/released`),
  outcome: (id: string, metric: string) =>
    post<Detail>(`${I(id)}/outcome`, { metric }),
  handoff: (id: string, target: "tasks" | "jira" | "both") =>
    post<Handoff>(`${I(id)}/handoff`, { target }),
  editStory: (id: string, sid: string, b: StoryEdit) =>
    patch<Detail>(`${I(id)}/plan/stories/${e(sid)}`, b),
  addStory: (id: string, b: StoryEdit) =>
    post<Detail>(`${I(id)}/plan/stories`, b),
  deleteStory: (id: string, sid: string) =>
    del<Detail>(`${I(id)}/plan/stories/${e(sid)}`),
  editEpic: (id: string, eid: string, b: EpicEdit) =>
    patch<Detail>(`${I(id)}/plan/epics/${e(eid)}`, b),
  addEpic: (id: string, b: EpicEdit) => post<Detail>(`${I(id)}/plan/epics`, b),
  deleteEpic: (id: string, eid: string) =>
    del<Detail>(`${I(id)}/plan/epics/${e(eid)}`),
  ticketPreview: (id: string) =>
    get<TicketPreview>(`${I(id)}/tickets/preview`),
  ticketSend: (id: string, stories: string[] = []) =>
    post<SendResult>(`${I(id)}/tickets/send`, { stories }),
  initiativeJira: () => get<InitiativeJira>("/product/jira"),
  jiraConnections: () => get<JiraConnections>("/product/jira/connections"),
  saveInitiativeJira: (b: InitiativeJira) =>
    put<InitiativeJira>("/product/jira", b),
  doc: (id: string, kind: string, version: number) =>
    get<ProductDoc>(`${I(id)}/docs/${e(kind)}/${version}`),
  deckUrl: (id: string, version?: number) =>
    `/api${I(id)}/deck${version ? `?version=${version}` : ""}`,
  deck: (id: string) => getText(`${I(id)}/deck`),
  rebuildDeck: (id: string) => post<ProductDoc>(`${I(id)}/deck`),
  teams: () => get<Team[]>("/teams"),
  team: (id: string) => get<TeamKnowledge>(`/teams/${e(id)}`),
  createTeam: (b: TeamBody) => post<Team>("/teams", b),
  updateTeam: (id: string, b: TeamBody) => patch<Team>(`/teams/${e(id)}`, b),
  deleteTeam: (id: string) => del<{ ok: boolean }>(`/teams/${e(id)}`),
  importCodeowners: () => post<ImportResult>("/teams/import-codeowners"),
  savePage: (id: string, page: string, text: string) =>
    put<TeamPage>(`/teams/${e(id)}/pages/${e(page)}`, { text }),
  decideSuggestion: (id: string, sid: string, accept: boolean) =>
    post<TeamKnowledge>(`/teams/${e(id)}/suggestions/${e(sid)}`, { accept }),
  addProject: (id: string, pid: string) =>
    put<Team>(`/teams/${e(id)}/projects/${e(pid)}`, {}),
  removeProject: (id: string, pid: string) =>
    del<Team>(`/teams/${e(id)}/projects/${e(pid)}`),
  testKeyPattern: (pattern: string | null, text: string) =>
    post<KeyTest>("/teams/key-pattern/test", { pattern, text }),
  tickets: (team?: string) =>
    get<TeamTickets>(`/product/tickets${team ? `?team=${e(team)}` : ""}`),
  scanTickets: () => post<ScanResult>("/product/tickets/scan"),
  map: (team?: string) =>
    get<ProductMap>(`/product/map${team ? `?team=${e(team)}` : ""}`),
  findFlows: (projects: string[] = []) =>
    post<FlowRun>("/product/flows/run", { projects }),
  editFlow: (pid: string, fid: string, b: FlowEdit) =>
    patch<FlowView>(`/product/flows/${e(pid)}/${e(fid)}`, b),
  keelJira: () => get<JiraView>("/jira"),
  saveKeelJira: (b: JiraSave) => put<JiraView>("/jira", b),
  removeKeelJira: () => del<{ ok: boolean }>("/jira"),
  testKeelJira: (b: JiraSave) => post<JiraTest>("/jira/test", b),
};
