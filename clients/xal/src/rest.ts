// keel's REST api for what the MCP server has no tool for yet: the brief (one read of /api/projects), the live
// event stream (/api/events), the shared ASCII diagram renderer (/api/diagrams/ascii) and KeelBot.
// Every request says who it is (X-Keel-Via: xal, X-Keel-Client), like the keel TUI's "X-Keel-Via: tui".
// TODO(feat/keel-tui): when web/src/api.ts gets its transport (setTransport), use that typed client here instead.

export class KeelHttpError extends Error {
  readonly status: number;
  readonly hint: string | undefined;

  constructor(message: string, status: number, hint?: string) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class KeelRest {
  readonly base: string;
  private readonly client: string;
  private readonly timeoutMs: number;
  private readonly fetcher: Fetch;

  constructor(base: string, client: string, timeoutMs = 15_000, fetcher: Fetch = (u, i) => fetch(u, i)) {
    this.base = base;
    this.client = client;
    this.timeoutMs = timeoutMs;
    this.fetcher = fetcher;
  }

  headers(tool?: string): Record<string, string> {
    return { "X-Keel-Via": "xal", "X-Keel-Client": this.client, ...(tool ? { "X-Keel-Tool": tool } : {}) };
  }

  get<T>(path: string, tool?: string): Promise<T> {
    return this.request<T>("GET", path, undefined, tool);
  }

  post<T>(path: string, body: unknown = {}, tool?: string): Promise<T> {
    return this.request<T>("POST", path, body, tool);
  }

  /** The open stream for /api/events (the caller reads its body). */
  async stream(path: string, signal: AbortSignal): Promise<Response> {
    const res = await this.fetcher(this.base + "/api" + path, { headers: { ...this.headers(), accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new KeelHttpError(`${res.status} ${res.statusText}`.trim(), res.status);
    return res;
  }

  private async request<T>(method: string, path: string, body: unknown, tool?: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(this.base + "/api" + path, {
        method,
        headers: { ...this.headers(tool), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new KeelHttpError(`Cannot reach keel at ${this.base}.`, 0, "Is keel running? keel2 status shows its URL; set pluginConfig.keel.url to it.");
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      let err: { error?: string; hint?: string } = {};
      if (type.includes("json")) err = ((await res.json().catch(() => ({}))) ?? {}) as typeof err;
      throw new KeelHttpError(err.error || `${res.status} ${res.statusText}`.trim(), res.status, err.hint);
    }
    if (res.status === 204) return undefined as T;
    if (!type.includes("json")) throw new KeelHttpError("Unexpected answer from keel (not JSON).", res.status, "Is the URL keel's, not another app's?");
    return (await res.json()) as T;
  }
}
