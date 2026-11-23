// Settings for the automatic checks of the Fluffy Pilots web build.
// Run them with:  cd qa && npm ci && npx playwright install chromium && npm test
const { defineConfig, devices } = require("@playwright/test");

const PORT = 4173;
// BASE_URL lets the same checks run against the live website instead of a local copy.
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/results.json" }],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: BASE_URL,
    // The game's offline helper (sw.js) would keep old files between checks.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // An upright phone: the game turns itself on its side here, which is its own code path.
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        // The repository is the website itself, so a plain file server is enough.
        command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory ..`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
});
