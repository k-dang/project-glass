import type { MergeAction, MergeMethod, PullRequest, Revision } from "@glass/contracts"
import { Exit, Match } from "effect"
import { GitMerge, LoaderCircle } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { TooltipHint } from "@/components/ui/tooltip"
import { Backend, useBackendRuntime } from "./backend"
import { problemOf } from "./problems"

const methodNames: Record<MergeMethod, string> = {
  squash: "Squashes",
  merge: "Creates a merge commit",
  rebase: "Rebases",
}

const copy = (action: MergeAction, baseBranch: string) =>
  Match.value(action).pipe(
    Match.tagsExhaustive({
      Merge: ({ method }) => ({
        label: "Merge",
        hint: `${methodNames[method]} into ${baseBranch} now.`,
        done: "Merged",
      }),
      MergeWhenReady: ({ method }) => ({
        label: "Merge when ready",
        hint: `${methodNames[method]} into ${baseBranch} once required checks and Reviews pass.`,
        done: "Auto-merge on",
      }),
      AddToMergeQueue: () => ({
        label: "Add to merge queue",
        hint: `The ${baseBranch} merge queue merges it after its checks pass.`,
        done: "Added to merge queue",
      }),
      AddToMergeQueueWhenReady: () => ({
        label: "Merge when ready",
        hint: `Joins the ${baseBranch} merge queue once required checks and Reviews pass.`,
        done: "Auto-merge on",
      }),
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

  const { label, hint, done } = copy(action, pullRequest.baseBranch)

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
    <TooltipHint content={hint}>
      <Button variant="outline" disabled={sending} onClick={() => void merge()}>
        {sending ? (
          <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden />
        ) : (
          <GitMerge data-icon="inline-start" aria-hidden />
        )}
        {label}
      </Button>
    </TooltipHint>
  )
}
