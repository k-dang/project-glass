import { SUGGEST_DRAFT_TOOL, SuggestedDraft } from "@glass/contracts"
import { replyTo, type ToolReply, toolParameters } from "./hostTool"
import type { ReviewBrief } from "./protocol"

export const suggestDraftDescription =
  "Propose a comment for the PR's author on one line of the diff, for the reviewer to edit and add as a Draft. Glass refuses a line outside the diff's hunks."

export const suggestDraftParameters = toolParameters({
  path: [SuggestedDraft.fields.path, "The file's path relative to the checkout root."],
  side: [
    SuggestedDraft.fields.side,
    'Either "new", for a line of the PR\'s head, or "old", for a line only in its base.',
  ],
  line: [SuggestedDraft.fields.line, "The line's number on that side."],
  body: [
    SuggestedDraft.fields.body,
    "The comment in GitHub Markdown, written to the PR's author in the reviewer's voice.",
  ],
})

export const SUGGEST_DRAFT_PLACED = "Glass shows this Suggested draft to the reviewer."

const refusal = (path: string, side: string, line: number) =>
  `${path} line ${line} on the ${side} side is not a line of the diff, so it can't be a Suggested draft. Place it on a line inside the diff's hunks, or put the comment in your answer.`

const onDiff = (
  diffLines: ReviewBrief["diffLines"],
  side: "old" | "new",
  path: string,
  line: number,
) => diffLines[side][path]?.includes(line) === true

export const placeSuggestedDraft = (brief: ReviewBrief, draft: SuggestedDraft): ToolReply =>
  onDiff(brief.diffLines, draft.side, draft.path, draft.line)
    ? { accepted: true, text: SUGGEST_DRAFT_PLACED }
    : { accepted: false, text: refusal(draft.path, draft.side, draft.line) }

export const suggestDraft = (brief: ReviewBrief) =>
  replyTo(SuggestedDraft, (draft) => placeSuggestedDraft(brief, draft))

/** pi loads an extension in its own process, out of the host's reach, so the check goes into the file. */
export const piSuggestDraftExtension = (brief: ReviewBrief) => `
const diffLines = ${JSON.stringify(brief.diffLines)}
const onDiff = ${onDiff.toString()}
const refusal = ${refusal.toString()}

export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(SUGGEST_DRAFT_TOOL)},
    label: "Suggest draft",
    description: ${JSON.stringify(suggestDraftDescription)},
    parameters: ${JSON.stringify(suggestDraftParameters)},
    async execute(_toolCallId, { path, side, line, body }) {
      if (typeof body !== "string" || body.trim() === "") throw new Error("The comment is empty.")
      if (!onDiff(diffLines, side, path, line)) throw new Error(refusal(path, side, line))
      return { content: [{ type: "text", text: ${JSON.stringify(SUGGEST_DRAFT_PLACED)} }], details: undefined }
    },
  })
}
`
