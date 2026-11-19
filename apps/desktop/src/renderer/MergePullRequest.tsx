import {
  AddToMergeQueue,
  AddToMergeQueueWhenReady,
  Merge,
  type MergeMethod,
  type MergeOffer,
  type MergeRequest,
  MergeWhenReady,
  type PullRequest,
  type Revision,
} from "@glass/contracts"
import { type Array as Arr, Exit, Match } from "effect"
import { ChevronDown, LoaderCircle } from "lucide-react"
import { type FormEvent, type ReactNode, useState } from "react"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { toast } from "@/components/ui/toast"
import { ActionPopover } from "./ActionPopover"
import { Backend, useBackendRuntime } from "./backend"
import { ProblemAlert } from "./ProblemAlert"
import { type Problem, problemOf } from "./problems"

const methodLabels: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
}

const copy = (offer: MergeOffer, baseBranch: string) =>
  Match.value(offer).pipe(
    Match.tagsExhaustive({
      CanMerge: () => ({
        title: "Merge pull request",
        description: `Merges into ${baseBranch} now.`,
        done: "Merged",
      }),
      CanMergeWhenReady: () => ({
        title: "Merge when ready",
        description: `GitHub merges into ${baseBranch} once required checks and Reviews pass.`,
        done: "Auto-merge on",
      }),
      CanAddToMergeQueue: () => ({
        title: "Add to merge queue",
        description: `${baseBranch}'s merge queue merges it after its checks pass.`,
        done: "Added to merge queue",
      }),
      CanAddToMergeQueueWhenReady: () => ({
        title: "Add to merge queue when ready",
        description: `GitHub adds it to ${baseBranch}'s merge queue once required checks and Reviews pass.`,
        done: "Auto-merge on",
      }),
    }),
  )

export function MergePullRequest(props: {
  pullRequest: PullRequest
  revision: Revision
  onReload: () => void
}) {
  const { mergeOffer } = props.pullRequest

  if (mergeOffer === null) return null

  return <MergePopover key={JSON.stringify(mergeOffer)} {...props} offer={mergeOffer} />
}

function MergePopover(props: {
  pullRequest: PullRequest
  revision: Revision
  offer: MergeOffer
  onReload: () => void
}) {
  const { offer, pullRequest } = props
  const { title, description, done } = copy(offer, pullRequest.baseBranch)
  const runtime = useBackendRuntime()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  const send = async (request: MergeRequest) => {
    if (submitting) return

    setSubmitting(true)
    setProblem(null)

    const exit = await runtime.runPromiseExit(
      Backend.use((backend) =>
        backend.MergePullRequest({
          pullRequestId: pullRequest.id,
          revision: props.revision,
          request,
        }),
      ),
    )

    setSubmitting(false)

    if (Exit.isFailure(exit)) {
      setProblem(problemOf(exit.cause))

      return
    }

    setOpen(false)
    toast.add({ type: "success", title: done, description: pullRequest.title })
    props.onReload()
  }

  const form = { submitting, onSend: (request: MergeRequest) => void send(request) }

  return (
    <ActionPopover
      open={open}
      onOpenChange={setOpen}
      busy={submitting}
      trigger={
        <Button variant="outline">
          Merge
          <ChevronDown data-icon="inline-end" aria-hidden />
        </Button>
      }
      title={title}
      className="w-[22rem]"
    >
      <p className="text-sm text-muted-foreground">{description}</p>
      {mergeForm(offer, title, form)}
      {problem !== null && (
        <ProblemAlert
          problem={problem}
          action={problem.fixedByReload ? { label: "Reload", run: props.onReload } : undefined}
        />
      )}
    </ActionPopover>
  )
}

const mergeForm = (offer: MergeOffer, title: string, form: FormProps): ReactNode =>
  Match.value(offer).pipe(
    Match.tagsExhaustive({
      CanMerge: ({ methods }) => (
        <MethodForm
          {...form}
          methods={methods}
          label={(method) => methodLabels[method]}
          request={(method) => Merge.make({ method })}
        />
      ),
      CanMergeWhenReady: ({ methods }) => (
        <MethodForm
          {...form}
          methods={methods}
          label={() => title}
          request={(method) => MergeWhenReady.make({ method })}
        />
      ),
      CanAddToMergeQueue: () => (
        <SubmitForm {...form} label={title} request={AddToMergeQueue.make({})} />
      ),
      CanAddToMergeQueueWhenReady: () => (
        <SubmitForm {...form} label={title} request={AddToMergeQueueWhenReady.make({})} />
      ),
    }),
  )

interface FormProps {
  readonly submitting: boolean
  readonly onSend: (request: MergeRequest) => void
}

function MethodForm(
  props: FormProps & {
    methods: Arr.NonEmptyReadonlyArray<MergeMethod>
    label: (method: MergeMethod) => string
    request: (method: MergeMethod) => MergeRequest
  },
) {
  const [method, setMethod] = useState<MergeMethod>(props.methods[0])

  return (
    <SubmitForm {...props} label={props.label(method)} request={props.request(method)}>
      {props.methods.length > 1 && (
        <RadioGroup
          value={method}
          onValueChange={setMethod}
          disabled={props.submitting}
          aria-label="Merge method"
          className="gap-1"
        >
          {props.methods.map((value) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium hover:bg-muted has-data-disabled:cursor-default has-data-disabled:opacity-60"
            >
              <RadioGroupItem value={value} />
              {methodLabels[value]}
            </label>
          ))}
        </RadioGroup>
      )}
    </SubmitForm>
  )
}

function SubmitForm(
  props: FormProps & { label: string; request: MergeRequest; children?: ReactNode },
) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    props.onSend(props.request)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {props.children}
      <Button type="submit" disabled={props.submitting} className="self-end">
        {props.submitting && (
          <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden />
        )}
        {props.label}
      </Button>
    </form>
  )
}
