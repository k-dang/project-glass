// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import {
  AddToMergeQueue,
  Merge,
  type MergeAction,
  MergeRejected,
  MergeWhenReady,
  PullRequest,
} from "@glass/contracts"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { Toaster } from "@/components/ui/toast"
import { MergePullRequest } from "./MergePullRequest"
import { type Handlers, testRegistry } from "../../test/testBackend"
import { pullRequestFields, revision } from "../../test/workspace"

const registries: Array<ReturnType<typeof testRegistry>> = []

afterEach(() => {
  cleanup()

  for (const registry of registries.splice(0)) registry.dispose()
})

const mount = (mergeAction: MergeAction | null, merge: Handlers["MergePullRequest"]) => {
  const registry = testRegistry({ MergePullRequest: merge })
  registries.push(registry)
  const onReload = vi.fn<() => void>()

  const view = (action: MergeAction | null) => (
    <RegistryContext.Provider value={registry}>
      <Toaster>
        <MergePullRequest
          pullRequest={new PullRequest({ ...pullRequestFields, mergeAction: action })}
          revision={revision}
          onReload={onReload}
        />
      </Toaster>
    </RegistryContext.Provider>
  )

  const { rerender } = render(view(mergeAction))

  return {
    onReload,
    user: userEvent.setup(),
    changeAction: (action: MergeAction | null) => rerender(view(action)),
  }
}

it("merges in one click, then hides Merge and reloads the PR", async () => {
  const merge = vi.fn<Handlers["MergePullRequest"]>(() => Effect.void)
  const action = Merge.make({ method: "squash" })
  const { onReload, user } = mount(action, merge)

  await user.click(screen.getByRole("button", { name: "Merge" }))

  await screen.findByText("Merged")
  expect(merge).toHaveBeenCalledWith(
    { pullRequestId: pullRequestFields.id, revision, action },
    expect.anything(),
  )
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
  expect(onReload).toHaveBeenCalledOnce()
})

it("keeps Merge disabled while sending, even when GitHub's merge action changes", async () => {
  const { user, changeAction } = mount(
    MergeWhenReady.make({ method: "squash" }),
    () => Effect.never,
  )

  await user.click(screen.getByRole("button", { name: "Merge when ready" }))
  changeAction(Merge.make({ method: "squash" }))

  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Merge" }).disabled).toBe(true)
})

it("offers Merge again once GitHub drops the merge it took", async () => {
  const action = MergeWhenReady.make({ method: "squash" })
  const { user, changeAction } = mount(action, () => Effect.void)

  await user.click(screen.getByRole("button", { name: "Merge when ready" }))
  await screen.findByText("Auto-merge on")
  changeAction(null)
  changeAction(action)

  expect(screen.getByRole("button", { name: "Merge when ready" })).toBeDefined()
})

it("names what GitHub would do on the button", async () => {
  const merge = vi.fn<Handlers["MergePullRequest"]>(() => Effect.void)
  const { user } = mount(AddToMergeQueue.make({}), merge)

  await user.click(screen.getByRole("button", { name: "Add to merge queue" }))

  await screen.findByText("Added to merge queue")
  expect(merge.mock.calls[0]?.[0].action).toEqual(AddToMergeQueue.make({}))
})

it("shows GitHub's reason when it won't merge, leaving Merge in place", async () => {
  const { onReload, user } = mount(Merge.make({ method: "squash" }), () =>
    Effect.fail(new MergeRejected({ message: "Required status check is failing." })),
  )

  await user.click(screen.getByRole("button", { name: "Merge" }))

  expect(await screen.findByText("Required status check is failing.")).toBeDefined()
  expect(screen.getByRole("button", { name: "Merge" })).toBeDefined()
  expect(onReload).not.toHaveBeenCalled()
})

it("offers no Merge when GitHub wouldn't take one", () => {
  mount(null, () => Effect.void)
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
})
