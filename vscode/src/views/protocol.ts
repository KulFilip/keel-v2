// The messages between the extension and its two webviews (the flow panel and KeelBot). Types only: the webview
// scripts import them too, so nothing here may import `vscode`.

export type Why = "required" | "optional" | "none";

export interface GateButtonVm {
  name: string;
  label: string;
  description: string;
  why: Why;
  reasonLabel?: string;
}

export interface QuestionVm {
  id: string;
  question: string;
  why?: string;
  multiple: boolean;
  options: {
    label: string;
    description?: string;
    recommended: boolean;
    picked: boolean;
  }[];
}

export interface GateVm {
  id?: string;
  title: string;
  detailHtml: string;
  kind: string;
  buttons: GateButtonVm[];
  picked?: string;
  questions: QuestionVm[];
}

export interface AcVm {
  id: string;
  layer: string;
  title: string;
  /** green | red | doing | todo */
  state: string;
}

export interface FlowVm {
  threadId: string;
  title: string;
  status: string;
  waits: boolean;
  meta: string;
  steps: { name: string; state: "done" | "current" | "todo" }[];
  phase: string;
  current: string;
  error?: string;
  acs: AcVm[];
  gate?: GateVm;
  canStop: boolean;
  canResume: boolean;
  updated: string;
  branch?: string;
  spec?: string;
}

export interface AgentVm {
  callId: string;
  agent: string;
  model?: string;
  effort?: string;
  since?: number;
  tokens: string;
  cost: string;
}

export interface LineVm {
  key: string;
  clock: string;
  agent?: string;
  kind: string;
  title: string;
  path?: string;
  added?: number;
  removed?: number;
  exit?: number;
  ok?: boolean;
  failed?: number;
  /** the folded part as plain text (output, diff) */
  detail?: string;
  /** the folded part as rendered markdown (an agent's answer) */
  detailHtml?: string;
}

export type ToFlow =
  | { type: "flow"; flow: FlowVm }
  | { type: "now"; step: string; agents: AgentVm[] }
  | { type: "lines"; lines: LineVm[]; reset?: boolean }
  | { type: "note"; text: string; bad?: boolean }
  | { type: "focusGate" }
  | { type: "busy"; busy: boolean };

export type FromFlow =
  | { type: "ready" }
  | {
      type: "answer";
      picked?: string;
      why: string;
      qPicked: Record<string, string[]>;
      qTyped: Record<string, string>;
    }
  | { type: "stop" }
  | { type: "resume" }
  | { type: "open"; path: string; line?: number }
  | { type: "openSpec" }
  | { type: "copyLog"; text: string }
  | { type: "refresh" };

export interface ChatMessageVm {
  n: number;
  role: string;
  html: string;
  /** a user message, as typed */
  text?: string;
  tools?: string;
  toolLines?: string;
  files?: string[];
}

export interface ChatVm {
  title: string;
  mode: string;
  model: string;
  usage: string;
  busy: boolean;
  messages: ChatMessageVm[];
  liveHtml?: string;
  changes: { path: string; added: number; removed: number }[];
  note?: string;
  noProject?: string;
}

export type ToChat =
  | { type: "chat"; chat: ChatVm }
  | { type: "prefill"; text: string }
  | { type: "note"; text: string };

export type FromChat =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "mode"; mode: string }
  | { type: "new" }
  | { type: "pickChat" }
  | { type: "pickModel" }
  | { type: "open"; path: string; line?: number }
  | { type: "undoAll" }
  | { type: "keep" }
  | { type: "mention" };
