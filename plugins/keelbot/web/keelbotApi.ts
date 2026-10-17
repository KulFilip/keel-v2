// KeelBot's api calls, through keel's own transport (@keel/web-sdk get, post, patch, del: /api + path, errors as
// ApiError): its sessions (keel.api.helper.HelperController, /api/projects/{pid}/helper/*, the plugin's api), and the
// core pages' calls its panel and buttons use (the flow that waits, the files and symbols for @, an answer's steps,
// workflows, the start of a flow) plus the CI/CD plugin's runs for its CI button. The types are keel's (the api's
// contract), from @keel/web-sdk. keel's launcher (⌘K, core) asks KeelBot through keel's own api.ts.

import {
  del,
  get,
  patch,
  post,
  put,
  type CiRun,
  type FlowView,
  type GraphHit,
  type HelperChange,
  type HelperCommand,
  type HelperDone,
  type HelperHandover,
  type HelperMention,
  type HelperMode,
  type HelperQuestion,
  type HelperSelection,
  type HelperSession,
  type HelperTurnStarted,
  type JobStep,
  type Model,
  type RunMode,
  type ThreadState,
  type Workflow,
  type WorkflowCheck,
} from "@keel/web-sdk";

const q = (params: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  });
  const str = s.toString();
  return str ? "?" + str : "";
};
const e = encodeURIComponent;

/** v0.15.2 a folder for KeelBot's chats, in one project (the engine keeps them; every browser sees the same). */
export type HelperFolder = {
  id: string;
  project: string;
  name: string;
  chats: number;
  created_at: string;
  updated_at: string;
};

export const kb = {
  // KeelBot's own sessions
  sessions: (pid: string) =>
    get<HelperSession[]>(`/projects/${e(pid)}/helper/sessions`),
  create: (
    pid: string,
    body: { mode?: HelperMode; model?: Model; title?: string } = {},
  ) => post<HelperSession>(`/projects/${e(pid)}/helper/sessions`, body),
  session: (pid: string, sid: string) =>
    get<HelperSession>(`/projects/${e(pid)}/helper/sessions/${e(sid)}`),
  patch: (
    pid: string,
    sid: string,
    body: { title?: string; model?: Model; folder?: string },
  ) =>
    patch<HelperSession>(`/projects/${e(pid)}/helper/sessions/${e(sid)}`, body),
  remove: (pid: string, sid: string) =>
    del<{ ok: boolean }>(`/projects/${e(pid)}/helper/sessions/${e(sid)}`),
  // v0.15.2 folders for the chats (a chat moves with patch {folder}; "" takes it out)
  folders: (pid: string) =>
    get<HelperFolder[]>(`/projects/${e(pid)}/helper/folders`),
  folderCreate: (pid: string, name: string) =>
    post<HelperFolder>(`/projects/${e(pid)}/helper/folders`, { name }),
  folderRename: (pid: string, fid: string, name: string) =>
    patch<HelperFolder>(`/projects/${e(pid)}/helper/folders/${e(fid)}`, {
      name,
    }),
  folderDelete: (pid: string, fid: string) =>
    del<{ ok: boolean; moved: number }>(
      `/projects/${e(pid)}/helper/folders/${e(fid)}`,
    ),
  turn: (
    pid: string,
    sid: string,
    body: {
      text: string;
      model?: Model;
      mentions?: HelperMention[];
      selection?: HelperSelection;
      open_file?: string;
    },
  ) =>
    post<HelperTurnStarted>(
      `/projects/${e(pid)}/helper/sessions/${e(sid)}/turn`,
      body,
    ),
  stop: (pid: string, sid: string) =>
    post<HelperSession>(`/projects/${e(pid)}/helper/sessions/${e(sid)}/stop`),
  commands: (pid: string) =>
    get<HelperCommand[]>(`/projects/${e(pid)}/helper/commands`),
  changes: (pid: string, sid: string) =>
    get<HelperChange[]>(
      `/projects/${e(pid)}/helper/sessions/${e(sid)}/changes`,
    ),
  undo: (pid: string, sid: string, path?: string) =>
    post<HelperChange[]>(
      `/projects/${e(pid)}/helper/sessions/${e(sid)}/undo`,
      path ? { path } : {},
    ),
  done: (pid: string, sid: string, message = "") =>
    post<HelperDone>(
      `/projects/${e(pid)}/helper/sessions/${e(sid)}/done`,
      message.trim() ? { message: message.trim() } : {},
    ),
  handover: (pid: string, sid: string) =>
    get<HelperHandover>(
      `/projects/${e(pid)}/helper/sessions/${e(sid)}/handover`,
    ),
  toTask: (
    pid: string,
    sid: string,
    body: { title?: string; type?: string } = {},
  ) =>
    post<{ id: string; title: string }>(
      `/projects/${e(pid)}/helper/sessions/${e(sid)}/task`,
      body,
    ),
  toFlow: (
    pid: string,
    sid: string,
    body: { title?: string; workflow_id?: string } = {},
  ) =>
    post<ThreadState>(
      `/projects/${e(pid)}/helper/sessions/${e(sid)}/flow`,
      body,
    ),
  permissions: (pid: string) =>
    get<HelperQuestion[]>(`/projects/${e(pid)}/helper/permissions`),
  answer: (
    pid: string,
    qid: string,
    decision: "once" | "always" | "deny",
    why = "",
  ) =>
    post<{ id: string; decision: string }>(
      `/projects/${e(pid)}/helper/permissions/${e(qid)}`,
      { decision, why },
    ),

  // keel's core: the flow that runs or waits, the files and symbols for @, an answer's stored steps
  flow: (pid: string) => get<FlowView>(`/projects/${e(pid)}/flow`),
  repoFiles: (pid: string) =>
    get<{ files: string[]; truncated: boolean }>(
      `/projects/${e(pid)}/repo/files`,
    ),
  graphSearch: (pid: string, text: string) =>
    get<{ available: boolean; reason?: string; results: GraphHit[] }>(
      `/projects/${e(pid)}/graph/search?q=${e(text)}`,
    ),
  jobSteps: (id: string, after = 0) =>
    get<{ steps: JobStep[]; running: boolean }>(
      `/jobs/${e(id)}/steps${q({ after })}`,
    ),

  // keel's core: its buttons start a flow, check and save a workflow
  workflows: (pid: string) => get<Workflow[]>(`/projects/${e(pid)}/workflows`),
  checkWorkflow: (pid: string, yaml: string) =>
    post<WorkflowCheck>(`/projects/${e(pid)}/workflows/check`, { yaml }),
  importWorkflow: (pid: string, body: { yaml: string; folder?: string }) =>
    post<{ workflow: Workflow }>(`/projects/${e(pid)}/workflows/import`, body),
  startFlow: (
    pid: string,
    body: {
      workflow_id: string;
      title: string;
      request?: string;
      allow_dirty?: boolean;
    },
  ) => post<ThreadState>(`/projects/${e(pid)}/flows`, body),

  // 0.18.6 the chat keel TUI or another tab has open (the shared focus, api ui/UiFocus.kt)
  focus: () => get<{ project: string | null; chats: Record<string, string> }>("/ui/focus"),

  // 0.18.5 a new rule pack or agent KeelBot wrote
  // 0.18.9 a stack KeelBot wrote: keel's check (saves nothing), then save (.keel/stacks/<name>.yml)
  checkStack: (pid: string, yaml: string) =>
    post<{ ok: boolean; errors: string[]; warnings: string[]; replaces?: string | null; review?: { lane?: string } | null }>(
      `/projects/${e(pid)}/stacks/check`, { yaml }),
  saveStack: (pid: string, yaml: string) => post<{ path: string; replaced: boolean }>(`/projects/${e(pid)}/stacks/save`, { yaml }),
  checkRule: (pid: string, yaml: string) =>
    post<{ ok: boolean; errors?: string[]; dry_run?: { checked?: number; blocked?: { kind?: string; target?: string }[] } }>(
      `/projects/${e(pid)}/rules/check`, { yaml }),
  saveRule: (pid: string, yaml: string) => post<{ pack?: { id?: string } }>(`/projects/${e(pid)}/rules/packs`, { yaml }),
  saveAgent: (pid: string, body: { name: string; about: string; prompt: string; tools: string[]; phases: string[] }) =>
    post<{ id: string }>(`/projects/${e(pid)}/agents`, body),
  // 0.18.6 a skill KeelBot wrote: save it (its SKILL.md, the api's import), then the agents that load it
  agentIds: (pid: string) => get<{ id: string; label?: string }[]>(`/projects/${e(pid)}/agents`),
  saveSkill: (pid: string, body: string) => post<{ id: string; tokens: number; agents: string[] }>(`/projects/${e(pid)}/skills/import`, { body }),
  skillAgents: (pid: string, sid: string, agents: string[]) =>
    put<{ id: string; agents: string[] }>(`/projects/${e(pid)}/skills/${e(sid)}`, { agents }),

  // 0.18.4 its flow buttons (keel-flow): decide the gate a flow waits at, stop a flow, a flow's run mode
  decideGate: (tid: string, body: { decision: "approve" | "reject"; why?: string }) =>
    post<ThreadState>(`/inbox/${e(tid)}/act`, body),
  stopFlow: (tid: string) => post<ThreadState>(`/threads/${e(tid)}/stop`),
  setRunMode: (tid: string, mode: RunMode) => post<ThreadState>(`/threads/${e(tid)}/mode`, { mode }),
  flowOf: (pid: string, tid: string) => get<FlowView>(`/projects/${e(pid)}/flows/${e(tid)}`),

  // the CI/CD plugin's runs (its CI button: fix it, run the failed jobs again)
  ciRuns: (pid: string, branch?: string) =>
    get<CiRun[]>(`/projects/${e(pid)}/ci/runs${q({ branch })}`),
  ciRerun: (pid: string, id: number) =>
    post<{ id: number; rerun: boolean }>(
      `/projects/${e(pid)}/ci/runs/${id}/rerun`,
    ),
  ciFix: (pid: string, run?: number) =>
    post<ThreadState>(`/projects/${e(pid)}/ci/fix`, run ? { run } : {}),
};
