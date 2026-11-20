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
  const action = props.pullRequest.mergeAction

  if (action === null) return null

  return <MergeButton key={JSON.stringify(action)} {...props} action={action} />
}

function MergeButton(props: {
  pullRequest: PullRequest
  revision: Revision
  action: MergeAction
  onReload: () => void
}) {
  const { pullRequest, action } = props
  const runtime = useBackendRuntime()
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle")

  if (state === "sent") return null

  const { label, hint, done } = copy(action, pullRequest.baseBranch)

  const merge = async () => {
    setState("sending")

    const exit = await runtime.runPromiseExit(
      Backend.use((backend) =>
        backend.MergePullRequest({
          pullRequestId: pullRequest.id,
          revision: props.revision,
          action,
        }),
      ),
    )

    if (Exit.isFailure(exit)) {
      setState("idle")
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

    setState("sent")
    toast.add({ type: "success", title: done, description: pullRequest.title })
    props.onReload()
  }

  return (
    <TooltipHint content={hint}>
      <Button variant="outline" disabled={state === "sending"} onClick={() => void merge()}>
        {state === "sending" ? (
          <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden />
        ) : (
          <GitMerge data-icon="inline-start" aria-hidden />
        )}
        {label}
      </Button>
    </TooltipHint>
  )
}
