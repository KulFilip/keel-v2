// React's Scheduler (a dependency of Ink's react-reconciler): the two names test/stub.ts uses to wait until React is idle
declare module "scheduler" {
  export const unstable_IdlePriority: number;
  export function unstable_scheduleCallback(priority: number, callback: () => void): unknown;
}
