// The review store: the newest load wins, and each action is busy on its own (a button waits for its own action only).

import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewApi, type ReviewView } from "../reviewApi";
import { addDraft, load, resetReviews, review, submit } from "../store";

const view = (title: string) => ({ key: "pr:1", title, drafts: [] }) as unknown as ReviewView;
const later = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

afterEach(() => {
  vi.restoreAllMocks();
  resetReviews();
});

describe("review store", () => {
  it("keeps the newest load when an older one answers late", async () => {
    const slow = later<ReviewView>();
    const spy = vi.spyOn(reviewApi, "view");
    spy.mockReturnValueOnce(slow.promise);          // the refresh: slow
    spy.mockResolvedValueOnce(view("fresh"));       // the reload after it: quick
    const first = load("p", "pr:1", true);
    const second = load("p", "pr:1", false);
    await second;
    expect(review("p", "pr:1").view?.title).toBe("fresh");
    slow.resolve(view("stale"));
    await first;
    expect(review("p", "pr:1").view?.title).toBe("fresh");
  });

  it("is busy per action: one ending does not free the other", async () => {
    const draft = later<never>();
    const sending = later<never>();
    vi.spyOn(reviewApi, "addDraft").mockReturnValue(draft.promise);
    vi.spyOn(reviewApi, "submit").mockReturnValue(sending.promise);
    const a = addDraft("p", "pr:1", "text", null);
    const b = submit("p", "pr:1", "COMMENT", "");
    expect(review("p", "pr:1").running).toEqual(["draft", "submit"]);
    draft.resolve(undefined as never);
    await a;
    expect(review("p", "pr:1").running).toEqual(["submit"]);         // submit is still running
    expect(review("p", "pr:1").busy).toBe("submit");
    sending.resolve(undefined as never);
    await b;
    expect(review("p", "pr:1").running).toEqual([]);
    expect(review("p", "pr:1").busy).toBeNull();
  });
});
