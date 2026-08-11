const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "test/ui",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: "npm run preview",
    url: "http://localhost:4173/readyz",
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
