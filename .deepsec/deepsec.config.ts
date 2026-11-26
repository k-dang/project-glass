import { defineConfig } from "deepsec/config";
import { generatedMatchersPlugin } from "./generated-matchers.js";

export default defineConfig({
  projects: [
    { id: "glass", root: ".." },
    // <deepsec:projects-insert-above>
  ],
  plugins: [generatedMatchersPlugin],
  defaultAgent: "claude",
  defaultModel: "claude-opus-5-5",
  defaultThinkingLevel: "high",
});
