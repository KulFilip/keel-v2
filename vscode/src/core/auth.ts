import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { KeelApi, KeelError, normalizeBase, say } from "../api/client";
import { deviceName } from "../logic/format";

const DEFAULT_URL = "http://localhost:8088";

/** How this window signs in to keel: a stored key or device token, or keel2's key read on this computer. */
export type AuthKind = "key" | "device" | "local";

/**
 * keel's address and sign-in. A pasted API key and a paired device's token live in VS Code's SecretStorage (the OS
 * keychain), one per keel address, never in settings; keel2's own key is read with `keel2 auth key` and kept in
 * memory only. No secret is ever written to a log or shown.
 */
export class Auth {
  private localKey: string | undefined;
  private localTried = false;
  private readonly changed = new vscode.EventEmitter<void>();
  /** The address or the sign-in changed: connect again. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /** keel's address from the setting keel.url (normalized; the default when it is not an address). */
  baseUrl(): string {
    const raw =
      vscode.workspace.getConfiguration("keel").get<string>("url") ||
      DEFAULT_URL;
    return normalizeBase(raw) ?? normalizeBase(DEFAULT_URL)!;
  }

  private secretKey(base = this.baseUrl()): string {
    return `keel.token:${base}`;
  }

  private kindKey(base = this.baseUrl()): string {
    return `keel.authKind:${base}`;
  }

  kind(): AuthKind | undefined {
    return this.ctx.globalState.get<AuthKind>(this.kindKey());
  }

  /** The sign-in for the current address: the stored secret, else keel2's key (when allowed), else undefined. */
  async token(): Promise<string | undefined> {
    // tests and demos (and CI): a sign-in from the environment, never stored
    const fromEnv = process.env.KEEL_VSCODE_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    const stored = await this.ctx.secrets.get(this.secretKey());
    if (stored) return stored;
    if (this.localKey) return this.localKey;
    const allowed = vscode.workspace
      .getConfiguration("keel")
      .get<boolean>("useLocalKeel2", true);
    if (allowed && !this.localTried && isLocal(this.baseUrl())) {
      this.localTried = true;
      try {
        this.localKey = await readLocalKey();
      } catch {
        this.localKey = undefined; // keel2 missing or keel down: the Connect command says why
      }
    }
    return this.localKey;
  }

  /** keel refused the sign-in: forget it (a removed device, or keel2 auth reset made a new key). */
  async removed(): Promise<void> {
    this.localKey = undefined;
    this.localTried = false;
    const k = this.kind();
    if (k === "key" || k === "device") {
      await this.ctx.secrets.delete(this.secretKey());
      await this.ctx.globalState.update(this.kindKey(), undefined);
    }
  }

  async signOut(): Promise<void> {
    await this.ctx.secrets.delete(this.secretKey());
    await this.ctx.globalState.update(this.kindKey(), undefined);
    this.localKey = undefined;
    this.localTried = true; // not again on its own: Connect turns it back on
    this.changed.fire();
  }

  /** A client for the current address with the current sign-in. */
  api(token: string | undefined, onRemoved?: () => void): KeelApi {
    return new KeelApi({
      baseUrl: this.baseUrl(),
      token: () => token,
      onRemoved,
    });
  }

  /** keel: Connect — the address, then keel2 on this computer, an API key, or a pairing code. */
  async connect(): Promise<boolean> {
    const current = this.baseUrl();
    const url = await vscode.window.showInputBox({
      title: "keel: Connect (1/2)",
      prompt: "keel's address",
      value: current.replace(/\/$/, ""),
      ignoreFocusOut: true,
      validateInput: (v) =>
        normalizeBase(v)
          ? undefined
          : "An address like http://localhost:8088 or https://keel.example.ts.net",
    });
    if (url === undefined) return false;
    const base = normalizeBase(url)!;
    if (base !== current)
      await vscode.workspace
        .getConfiguration("keel")
        .update(
          "url",
          base.replace(/\/$/, ""),
          vscode.ConfigurationTarget.Global,
        );

    type Pick = vscode.QuickPickItem & { id: "local" | "key" | "pair" };
    const items: Pick[] = [
      {
        id: "local",
        label: "$(terminal) Use keel2 on this computer",
        detail: "Runs keel2 auth key; the key stays in memory.",
      },
      {
        id: "key",
        label: "$(key) Paste an API key",
        detail:
          "The key from keel2 auth key; kept in VS Code's secret storage.",
      },
      {
        id: "pair",
        label: "$(device-mobile) Pair with a code",
        detail: "keel › Settings › Devices › Pair shows a one-time code.",
      },
    ];
    const how = await vscode.window.showQuickPick(items, {
      title: "keel: Connect (2/2)",
      placeHolder: "How should VS Code sign in?",
      ignoreFocusOut: true,
    });
    if (!how) return false;
    try {
      if (how.id === "local") {
        const key = await readLocalKey();
        await this.check(base, key);
        await this.ctx.secrets.delete(this.secretKey(base));
        await this.ctx.globalState.update(this.kindKey(base), "local");
        this.localKey = key;
        this.localTried = true;
      } else if (how.id === "key") {
        const key = await vscode.window.showInputBox({
          title: "keel: API key",
          prompt: "Paste keel's sign-in key (keel2 auth key prints it)",
          password: true,
          ignoreFocusOut: true,
          validateInput: (v) =>
            v.trim() && !/\s/.test(v.trim())
              ? undefined
              : "One piece, no spaces",
        });
        if (!key) return false;
        await this.check(base, key.trim());
        await this.store(base, key.trim(), "key");
      } else {
        const code = await vscode.window.showInputBox({
          title: "keel: Pair",
          prompt: "The code keel shows in Settings › Devices › Pair",
          ignoreFocusOut: true,
        });
        if (!code?.trim()) return false;
        const name = deviceName(os.hostname());
        const res = await new KeelApi({
          baseUrl: base,
          token: () => undefined,
        }).pair(code, name);
        await this.store(base, res.token, "device");
        vscode.window.showInformationMessage(
          `keel: paired as "${res.device.name ?? name}"${res.keel?.version ? ` with keel ${res.keel.version}` : ""}.`,
        );
      }
    } catch (e) {
      vscode.window.showErrorMessage(`keel: could not connect. ${say(e)}`);
      return false;
    }
    this.changed.fire();
    return true;
  }

  private async store(
    base: string,
    token: string,
    kind: AuthKind,
  ): Promise<void> {
    await this.ctx.secrets.store(this.secretKey(base), token);
    await this.ctx.globalState.update(this.kindKey(base), kind);
    this.localKey = undefined;
  }

  /** A read that needs the sign-in: a wrong key fails here, before it is kept. */
  private async check(base: string, token: string): Promise<void> {
    await new KeelApi({ baseUrl: base, token: () => token }).projects();
  }
}

/** Whether keel2 on this computer can know this keel's key (it only knows the keel it runs). */
export function isLocal(base: string): boolean {
  try {
    const h = new URL(base).hostname;
    return (
      h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1"
    );
  } catch {
    return false;
  }
}

/** Where keel2 usually is: the PATH, then the install script's places (an editor started from the Dock has a short PATH). */
export function keel2Candidates(
  home = os.homedir(),
  envPath = process.env.PATH ?? "",
): string[] {
  const dirs = [
    ...envPath.split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  return [...new Set(dirs)].map((d) =>
    path.join(d, process.platform === "win32" ? "keel2.exe" : "keel2"),
  );
}

/** keel's sign-in key from `keel2 auth key`, or an error with keel2's own words (never the key itself). */
export function readLocalKey(timeoutMs = 30_000): Promise<string> {
  const exe = keel2Candidates().find((p) => existsSync(p));
  if (!exe)
    return Promise.reject(
      new KeelError(
        401,
        "keel2 was not found.",
        "Install keel (install.sh), or connect with an API key or a pairing code.",
      ),
    );
  const home = os.homedir();
  const env = {
    ...process.env,
    PATH: [
      process.env.PATH ?? "",
      "/usr/local/bin",
      "/opt/homebrew/bin",
      path.join(home, ".local", "bin"),
      "/usr/bin",
      "/bin",
    ]
      .filter(Boolean)
      .join(path.delimiter),
  };
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ["auth", "key"],
      { env, timeout: timeoutMs, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const key = String(stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        if (err || !key || /\s/.test(key)) {
          const why = String(stderr || "")
            .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
          reject(
            new KeelError(
              401,
              why[0] ?? "keel2 auth key printed no key.",
              why[1] ?? "Is keel running? keel2 status",
            ),
          );
          return;
        }
        resolve(key);
      },
    );
  });
}
