import type { Revision } from "@glass/contracts"
import { TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { warningTone } from "./PullRequestRow"
import { ShortSha } from "./shortSha"

export function OutdatedNote(props: {
  revision: Revision
  consequence: string
  action?: ReactNode
}) {
  return (
    <Alert role="note">
      <TriangleAlert aria-hidden className={warningTone} />
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-48 break-words">
          Written for an older Revision (head <ShortSha sha={props.revision.head} />
          ), so {props.consequence}.
        </span>
        {props.action}
      </AlertDescription>
    </Alert>
  )
}
