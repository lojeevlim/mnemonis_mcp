import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts", "test/**/*.test.ts", "adapter/test/**/*.test.ts"], globalSetup: ["test/globalSetup.ts"] },
});
