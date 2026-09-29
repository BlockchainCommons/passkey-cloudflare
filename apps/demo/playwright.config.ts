import { defineConfig } from "@playwright/test";

// Browser smoke tests against the real demo page, served by `wrangler dev`
// with the relying party set to localhost. `--local-upstream` stops wrangler
// rewriting each request's Origin to the custom-domain route, which the Worker
// would refuse.
const PORT = 8788;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { baseURL: `http://localhost:${PORT}`, browserName: "chromium" },
  webServer: {
    command: `wrangler dev --port ${PORT} --local-upstream localhost:${PORT} --var RP_ID:localhost --var ORIGIN:http://localhost:${PORT} --var REFUSAL_FLOOR_MS:0 --persist-to .wrangler/e2e-state`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
