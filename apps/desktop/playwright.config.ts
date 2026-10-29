import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "e2e",
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
})
