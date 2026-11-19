import { SUGGEST_DRAFT_TOOL } from "@glass/contracts"
import { readFileSync } from "node:fs"
import { type PiExtensionApi, registerHostTool } from "./piHostTool"
import type { ReviewBrief } from "./protocol"
import { suggestDraft, suggestDraftDescription, suggestDraftParameters } from "./suggestDraftTool"

export const PI_DIFF_LINES = "diff-lines.json"

export default function piSuggestDraft(pi: PiExtensionApi) {
  const diffLines: ReviewBrief["diffLines"] = JSON.parse(
    readFileSync(new URL(PI_DIFF_LINES, import.meta.url), "utf8"),
  )

  registerHostTool(
    pi,
    {
      name: SUGGEST_DRAFT_TOOL,
      label: "Suggest draft",
      description: suggestDraftDescription,
      parameters: suggestDraftParameters,
    },
    suggestDraft(diffLines),
  )
}
