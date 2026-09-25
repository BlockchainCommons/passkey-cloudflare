import { defineConfig } from "@playwright/test";

// One browser smoke test against the real entry page, served by `wrangler dev`
// with the relying party set to localhost.
const PORT = 8788;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}`, browserName: "chromium" },
  webServer: {
    command: `wrangler dev --port ${PORT} --var RP_ID:localhost --var ORIGIN:http://localhost:${PORT} --var REFUSAL_FLOOR_MS:0 --persist-to .wrangler/e2e-state`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
