// The Supervisor plugin's web part (plugins/supervisor): `npm run build:plugin -- supervisor` (in web/) builds this file
// on its own into plugins/supervisor/web/dist/index.js. It puts the Supervisor in Jobs as the tab Supervisor
// (#/jobs/supervisor): the flow that waits now with its on/off switch and mode, and the audit log of every look,
// answer and escalation with its reason. It imports only @keel/web-sdk and react.

import { definePlugin, SLOTS, type JobsTabItem, type KeelSdk } from "@keel/web-sdk";
import { SupervisorView } from "./Supervisor";

export function setup(sdk: KeelSdk) {
  sdk.registerSlot<JobsTabItem>(SLOTS.jobsTab, {
    id: "supervisor",
    title: "Supervisor",
    sub: "What the Supervisor looked at, answered and asked you about, and why.",
    plugin: "supervisor",
    order: 30,
    component: SupervisorView,
  });
}

export default definePlugin({ name: "supervisor", setup });
