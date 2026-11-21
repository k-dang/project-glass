import { type Diagram, DRAW_DIAGRAM_TOOL } from "@glass/contracts"
import { readFileSync } from "node:fs"
import { MAX_FILE_BYTES } from "../src/agentHost/FolderFiles"
import { bash, lines, scriptedThread, type Tool, write } from "./demoScript"

// WARNING: Climbs to test/ so it resolves both from this source and from the bundled dist-fake/fakeBackend.mjs.
const sketch = new URL("../test/demoSketch.png", import.meta.url)

const page = [
  "<!doctype html><html><body>",
  "<h1>Rate-limit the poller</h1>",
  '<section id="limits"><h2>Limits</h2>',
  "<p>Each Connection gets a burst of 20 requests and a refill of five per minute.</p></section>",
  "<table><thead><tr><th>Option</th><th>Refill / min</th></tr></thead>",
  "<tbody><tr><td>Token bucket</td><td>5</td></tr></tbody></table>",
  "</body></html>",
].join("")

const chart = lines(
  '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="220" viewBox="0 0 420 220" font-family="system-ui, sans-serif">',
  '  <rect width="420" height="220" fill="#ffffff"/>',
  '  <text x="20" y="28" font-size="15" font-weight="600" fill="#18181b">Requests per minute</text>',
  '  <line x1="40" y1="190" x2="400" y2="190" stroke="#a1a1aa"/>',
  '  <rect x="70" y="50" width="70" height="140" fill="#f87171"/>',
  '  <text x="105" y="44" font-size="13" text-anchor="middle" fill="#18181b">140</text>',
  '  <text x="105" y="208" font-size="12" text-anchor="middle" fill="#52525b">Before</text>',
  '  <rect x="260" y="165" width="70" height="25" fill="#4ade80"/>',
  '  <text x="295" y="159" font-size="13" text-anchor="middle" fill="#18181b">25</text>',
  '  <text x="295" y="208" font-size="12" text-anchor="middle" fill="#52525b">After</text>',
  "</svg>",
  "",
)

const notes = lines(
  "# Rate-limit the poller",
  "",
  "The poller asks GitHub for every Connection at once, so a busy minute trips the secondary rate limit.",
  "",
  "## Plan",
  "",
  "1. Give each Connection a token bucket.",
  "2. Refill five tokens a minute, with a burst of 20.",
  "3. Skip a poll when the bucket is empty, and try again on the next tick.",
  "",
  "| Option | Refill / min | Burst |",
  "| --- | --- | --- |",
  "| Token bucket | 5 | 20 |",
  "| Fixed window | 5 | 5 |",
  "",
  "```ts",
  "const allowed = bucket.take(1)",
  "```",
  "",
)

const messageFlow = [
  "flowchart LR",
  "  A[Message box] --> B[Backend]",
  "  B --> C[Thread]",
  "  C -->|streams reply| A",
]

const drawFlow = (kind: Diagram["kind"], mermaid: string): Tool => ({
  name: DRAW_DIAGRAM_TOOL,
  arguments: { title: "Message flow", kind, mermaid },
})

export const artifactsThread = scriptedThread({
  name: "demo/artifacts",
  images: () => [{ mediaType: "image/png", data: readFileSync(sketch).toString("base64") }],
  turns: [
    [
      "Here's a sketch of the poller's requests per Connection. Write the rate-limit plan up as a page, notes and a chart, and diagram the message flow.",
      [
        {
          thinking: "I'll write each file, then draw the flow beside the Thread.",
          tools: [
            write("plan.html", page),
            write("notes.md", notes),
            write("chart.svg", chart),
            write(
              "bucket.ts",
              lines(
                "export const refillBucket = (tokens: number, minutes: number) =>",
                "  Math.min(20, tokens + 5 * minutes)",
                "",
              ),
            ),
            bash(
              `printf '\\0\\1\\2\\3' > limits.bin && dd if=/dev/zero of=poller.log bs=1 count=0 seek=${MAX_FILE_BYTES + 1} 2>/dev/null`,
            ),
          ],
        },
        { tools: [drawFlow("existing", messageFlow.join("\n"))] },
        {
          text: lines(
            "Start with [the plan](plan.html): open it to leave Feedback notes on any part of the page.",
            "",
            "- `notes.md` has the same plan as Markdown.",
            "- `bucket.ts` refills each Connection's tokens.",
            "- `limits.bin` is the raw bucket state, and `poller.log` is the full capture.",
            "- `chart.svg` shows requests per minute before and after:",
            "",
            "![Requests per minute](chart.svg)",
            "",
            "The message flow is beside the Thread, and here it is inline:",
            "",
            "```mermaid",
            ...messageFlow,
            "```",
          ),
        },
      ],
    ],
    [
      "Add a queue to it.",
      [
        {
          tools: [
            drawFlow("proposed", [...messageFlow, "  B --> Q[[Queue]]", "  Q --> C"].join("\n")),
          ],
        },
        { text: "The proposed flow, with the queue, is beside the Thread." },
      ],
    ],
    [
      "Show the retry path too.",
      [
        {
          tools: [drawFlow("existing", "flowchart LR\n  A -->> [[")],
        },
        { text: "That version didn't draw, so the proposed one stays." },
      ],
    ],
  ],
})
