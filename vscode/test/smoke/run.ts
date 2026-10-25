// The smoke test: starts the demo keel, then VS Code with the extension and the demo "shop" folder, and runs suite.ts
// inside it. Uses the installed VS Code when VSCODE_EXECUTABLE is set, else downloads one (@vscode/test-electron).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../../../..");
  const port = 18_000 + Math.floor(Math.random() * 1000);
  const demo = spawn(process.execPath, [path.join(root, "scripts", "demo-keel.mjs"), String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    demo.stdout.on("data", (d: Buffer) => d.toString().includes("demo keel on") && resolve());
    demo.on("exit", (c) => reject(new Error(`the demo keel exited (${c})`)));
  });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "keel-smoke-"));
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(
    path.join(userData, "User", "settings.json"),
    JSON.stringify({ "keel.url": `http://127.0.0.1:${port}`, "keel.useLocalKeel2": false, "keel.notifications": false, "workbench.startupEditor": "none", "security.workspace.trust.enabled": false }),
  );
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite"),
      extensionTestsEnv: { KEEL_VSCODE_TOKEN: "demo-token", KEEL_SMOKE_PORT: String(port) },
      launchArgs: [path.join(root, "test", "smoke", "fixture", "shop"), `--user-data-dir=${userData}`, `--extensions-dir=${path.join(userData, "extensions")}`, "--disable-extensions"],
    });
  } finally {
    demo.kill();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
