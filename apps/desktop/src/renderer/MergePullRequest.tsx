import type { MergeAction, PullRequest, Revision } from "@glass/contracts"
import { Exit, Match } from "effect"
import { GitMerge, LoaderCircle } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { Backend, useBackendRuntime } from "./backend"
import { problemOf } from "./problems"

const copy = (action: MergeAction) =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      Merge: () => ({ label: "Merge", done: "Merged" }),
      MergeWhenReady: () => ({ label: "Merge when ready", done: "Auto-merge on" }),
      AddToMergeQueue: () => ({ label: "Add to merge queue", done: "Added to merge queue" }),
      AddToMergeQueueWhenReady: () => ({ label: "Merge when ready", done: "Auto-merge on" }),
    }),
  )

export function MergePullRequest(props: {
  pullRequest: PullRequest
  revision: Revision
  onReload: () => void
}) {
  const { pullRequest } = props
  const action = pullRequest.mergeAction
  const runtime = useBackendRuntime()
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)

  const actionKey = action === null ? null : JSON.stringify(action)

  if (sent !== null && sent !== actionKey) setSent(null)

  if (action === null || sent === actionKey) return null

  const { label, done } = copy(action)

  const merge = async () => {
    setSending(true)

    const exit = await runtime.runPromiseExit(
      Backend.use((backend) =>
        backend.MergePullRequest({
          pullRequestId: pullRequest.id,
          revision: props.revision,
          action,
        }),
      ),
    )

    setSending(false)

    if (Exit.isFailure(exit)) {
      const problem = problemOf(exit.cause)

      const id = toast.add({
        type: "error",
        title: problem.title,
        description: problem.detail,
        ...(problem.fixedByReload && {
          actionProps: {
            children: "Reload",
            onClick: () => {
              toast.close(id)
              props.onReload()
            },
          },
        }),
      })

      return
    }

    setSent(JSON.stringify(action))
    toast.add({ type: "success", title: `${done} #${pullRequest.ref.number}` })
    props.onReload()
  }

  return (
    <Button variant="outline" disabled={sending} onClick={() => void merge()}>
      {sending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden />
      ) : (
        <GitMerge data-icon="inline-start" aria-hidden />
      )}
      {label}
    </Button>
  )
}
