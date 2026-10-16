import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@keel/web-sdk": fileURLToPath(new URL("./src/core/sdk.ts", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: { environment: "node", include: ["test/**/*.test.{ts,tsx}"], testTimeout: 20000 },
});
