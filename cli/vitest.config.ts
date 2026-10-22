import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@keel/web-sdk": fileURLToPath(new URL("./src/core/sdk.ts", import.meta.url)) } },
  oxc: { jsx: { runtime: "automatic" } },
  test: { environment: "node", env: { KEEL_TUI_CLIPBOARD: "terminal" }, include: ["test/**/*.test.{ts,tsx}"], testTimeout: 20000 },
});
