import { SUGGEST_DRAFT_TOOL, type SuggestedDraft } from "@glass/contracts"
import type { ReviewBrief } from "./protocol"

export const suggestDraftDescription =
  "Propose a comment for the PR's author on one line of the diff, for the reviewer to edit and add as a Draft. Glass refuses a line outside the diff's hunks."

export const suggestDraftFields = {
  path: "The file's path relative to the checkout root.",
  side: 'Either "new", for a line of the PR\'s head, or "old", for a line only in its base.',
  line: "The line's number on that side.",
  body: "The comment in GitHub Markdown, written to the PR's author in the reviewer's voice.",
} as const

export const SUGGEST_DRAFT_PLACED = "Glass shows this Suggested draft to the reviewer."

const refusal = (path: string, side: string, line: number) =>
  `${path} line ${line} on the ${side} side is not a line of the diff, so it can't be a Suggested draft. Place it on a line inside the diff's hunks, or put the comment in your answer.`

/** Glass's answer to a call of its Suggested-draft tool: a refusal unless the line is on the diff. */
export const placeSuggestedDraft = (brief: ReviewBrief, draft: SuggestedDraft) =>
  brief.diffLines[draft.side][draft.path]?.includes(draft.line) === true
    ? { placed: true, text: SUGGEST_DRAFT_PLACED }
    : { placed: false, text: refusal(draft.path, draft.side, draft.line) }

/**
 * A pi extension adding the Suggested-draft tool, with the diff's lines written into it: pi loads
 * it in its own process, out of the host's reach. It checks a line as `placeSuggestedDraft` does.
 */
export const piSuggestDraftExtension = (brief: ReviewBrief) => `
const diffLines = ${JSON.stringify(brief.diffLines)}
const refusal = ${refusal.toString()}

export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(SUGGEST_DRAFT_TOOL)},
    label: "Suggest draft",
    description: ${JSON.stringify(suggestDraftDescription)},
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: ${JSON.stringify(suggestDraftFields.path)} },
        side: { type: "string", enum: ["new", "old"], description: ${JSON.stringify(suggestDraftFields.side)} },
        line: { type: "integer", minimum: 1, description: ${JSON.stringify(suggestDraftFields.line)} },
        body: { type: "string", description: ${JSON.stringify(suggestDraftFields.body)} },
      },
      required: ["path", "side", "line", "body"],
      additionalProperties: false,
    },
    async execute(_toolCallId, { path, side, line, body }) {
      if (typeof body !== "string" || body.trim() === "") throw new Error("The comment is empty.")
      if (!(diffLines[side]?.[path] ?? []).includes(line)) throw new Error(refusal(path, side, line))
      return { content: [{ type: "text", text: ${JSON.stringify(SUGGEST_DRAFT_PLACED)} }], details: undefined }
    },
  })
}
`
