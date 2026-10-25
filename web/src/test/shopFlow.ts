// keel 0.18.54 a neutral demo flow for the Flow page's readability tests: project "shop", ticket SHOPS-1234, people
// ana / bo / alex. openShopFlow() makes it the project and the flow the page opens on.

import type { EngineEvent, Project, ThreadState, Workflow } from "../api";
import { db } from "./setup";

export const SHOP_TID = "th_shop1";
export const SHOP_BRANCH = "feat/SHOPS-1234-cart-totals-keep-the-discount-when-the-cart-changes";

export const shopWorkflow: Workflow = {
  id: "feature", name: "feature (keel)", keel_rules: true, version: 2, yaml: "name: feature (keel)\nsteps: []\n",
  steps: [
    { id: "interview", kind: "agent", name: "interview", agent: "explorer", model: "default", phase: "spec" },
    { id: "interview_gate", kind: "gate", name: "your answers", phase: "spec" },
    { id: "spec", kind: "agent", name: "spec", agent: "explorer", model: "default", phase: "spec" },
    { id: "spec_gate", kind: "gate", name: "spec approval", lock: true, back: "spec", phase: "spec" },
    { id: "red", kind: "agent", name: "red", agent: "test-author", model: "default", per_ac: true, phase: "red" },
  ],
} as Workflow;

export const shopThread = (over: Partial<ThreadState> = {}): ThreadState => ({
  thread_id: SHOP_TID, project_id: "shop", workflow_id: "feature", title: "SHOPS-1234 cart totals keep the discount", status: "running",
  current: "spec", phase: "spec", ac: null, acs: [],
  usage: { tokens_in: 42000, tokens_out: 9000, cost_usd: 0.61, premium_requests: 0, cap_tokens: 600000 },
  checkpoints: 6, updated_at: new Date().toISOString(), run_mode: "manual",
  ...over,
});

export const shopProject: Project = {
  id: "shop", name: "shop", root: "/workspace/shop", branch: SHOP_BRANCH, flow: "feature", phase: "spec", acs: [0, 0], waiting: 0, running: 1,
} as Project;

/** The shop project and its flow are what the page opens on. */
export function openShopFlow(over: Partial<ThreadState> = {}) {
  db.projects = [shopProject, ...db.projects];
  db.flows.shop = { thread: shopThread(over), workflow: structuredClone(shopWorkflow) };
  localStorage.setItem("keel2.project", "shop");
}

let n = 0;
/** An engine event of the shop flow, `sec` seconds after 10:00. */
export const shopEvent = (type: string, step: string | undefined, data: Record<string, unknown>, sec = n++): EngineEvent => ({
  type, thread_id: SHOP_TID, project_id: "shop", step, at: new Date(Date.UTC(2026, 9, 17, 10, 0, sec)).toISOString(), data,
});

export const ANSWERS = "Answers to your questions:\n1. Which carts keep the discount?\n   → Only open carts\n"
  + "2. Who may change a discount?\n   → ana and bo (the shop owners)\nAlso, in the user's words: alex reviews the copy.\n"
  + "Now write the spec. Put each answer into the spec as a sentence under Decisions.";
