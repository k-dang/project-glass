import { SuggestedDraft } from "@glass/contracts"
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

const SUGGEST_DRAFT_PLACED = "Glass shows this Suggested draft to the reviewer."

const refusal = ({ path, side, line }: SuggestedDraft) =>
  `${path} line ${line} on the ${side} side is not a line of the diff, so it can't be a Suggested draft. Place it on a line inside the diff's hunks, or put the comment in your answer.`

export const placeSuggestedDraft = (
  diffLines: ReviewBrief["diffLines"],
  draft: SuggestedDraft,
): ToolReply =>
  diffLines[draft.side][draft.path]?.includes(draft.line) === true
    ? { accepted: true, text: SUGGEST_DRAFT_PLACED }
    : { accepted: false, text: refusal(draft) }

export const suggestDraft = (diffLines: ReviewBrief["diffLines"]) =>
  replyTo(SuggestedDraft, (draft) => placeSuggestedDraft(diffLines, draft))
