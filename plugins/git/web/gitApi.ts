// The Git plugin's api calls (keel.api.plugins.GitPluginController, /api/projects/{pid}/git/*), through keel's own
// transport (@keel/web-sdk get and post: /api + path, errors as ApiError). The Code page's branch tab (the Code plugin's,
// plugins/code) reads /git/branch and switches with /git/switch through its own calls (plugins/code/web/codeApi.ts).

import { get, post } from "@keel/web-sdk";

/** The branch against its remote and its base, and the uncommitted files. */
export type GitStatus = {
  branch: string | null;
  base: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  base_ahead: number;
  base_behind: number;
  pushed: boolean;
  /** `added` / `deleted`: the lines of a tracked file against HEAD (0.18.38; not for an untracked or binary file) */
  changes: { path: string; status: string; added?: number; deleted?: number }[];
};

/** A local branch against the base. */
export type GitBranch = {
  name: string;
  current: boolean;
  ahead: number;
  behind: number;
  date: string;
  subject: string;
  /** the last commit's author (0.18.38) */
  author?: string;
  /** the last commit is the repository's git user's; missing when git has no user.email */
  mine?: boolean;
};

/** The branch's pull request on GitHub: its checks and review comments. */
export type PullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  draft?: boolean;
  review?: string | null;
  base?: string;
  branch?: string;
  checks: { name: string; state: string; url: string }[];
  checks_done: number;
  checks_failed: number;
  comments: {
    author: string;
    body: string;
    path?: string | null;
    line?: number | null;
  }[];
  /** 0.18.38 every comment (the list keeps the last 50), who is asked to review, and when it last changed */
  comments_total?: number;
  review_requests?: string[];
  updated_at?: string | null;
};

/** GET /git/pr: the pull request, none, or (0.18.38) why it could not be read when GitHub did not answer in time
 *  (`transient`: keel tried twice; the branch and its commits are fine). Any other failure is an error answer. */
export type PrAnswer = {
  pr: PullRequest | null;
  error?: { message: string; hint?: string; transient?: boolean } | null;
};

const base = (pid: string) => `/projects/${encodeURIComponent(pid)}/git`;

export const gitApi = {
  status: (pid: string) => get<GitStatus>(`${base(pid)}/status`),
  branches: (pid: string) => get<GitBranch[]>(`${base(pid)}/branches`),
  pr: (pid: string) => get<PrAnswer>(`${base(pid)}/pr`),
  switch: (pid: string, branch: string, create = false, stash = false) =>
    post<{ branch: string; stashed?: { from: string; message: string } | null }>(`${base(pid)}/switch`, { branch, create, ...(stash ? { stash } : {}) }),
  commit: (pid: string, message: string) =>
    post<{ sha: string; subject: string; files: string[] }>(
      `${base(pid)}/commit`,
      { message },
    ),
  sync: (pid: string) =>
    post<{ merged: boolean; from: string; branch: string }>(
      `${base(pid)}/sync`,
    ),
  push: (pid: string) =>
    post<{ branch: string; sha: string }>(`${base(pid)}/push`),
  openPr: (
    pid: string,
    body: { title: string; body: string; draft?: boolean },
  ) =>
    post<{ url?: string; number?: number; updated: boolean }>(
      `${base(pid)}/pr`,
      body,
    ),
};
