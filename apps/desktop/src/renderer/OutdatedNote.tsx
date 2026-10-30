import type { Revision } from "@glass/contracts"
import { cn } from "cn"
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
      {/* The icon rides with the text, so it stays level with it when the action makes the row taller. */}
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-1 basis-48 items-start gap-2">
          <TriangleAlert aria-hidden className={cn("size-4 shrink-0 translate-y-0.5", warningTone)} />
          <span className="min-w-0 break-words">
            Written for an older Revision (head <ShortSha sha={props.revision.head} />
            ), so {props.consequence}.
          </span>
        </span>
        {props.action}
      </AlertDescription>
    </Alert>
  )
}
