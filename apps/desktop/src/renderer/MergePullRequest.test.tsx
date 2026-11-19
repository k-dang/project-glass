// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import {
  AddToMergeQueue,
  CanAddToMergeQueue,
  CanMerge,
  Merge,
  MergeRejected,
  type MergeOffer,
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

const mount = (mergeOffer: MergeOffer | null, merge: Handlers["MergePullRequest"]) => {
  const registry = testRegistry({ MergePullRequest: merge })
  registries.push(registry)
  const onReload = vi.fn<() => void>()

  render(
    <RegistryContext.Provider value={registry}>
      <Toaster>
        <MergePullRequest
          pullRequest={new PullRequest({ ...pullRequestFields, mergeOffer })}
          revision={revision}
          onReload={onReload}
        />
      </Toaster>
    </RegistryContext.Provider>,
  )

  return { onReload, user: userEvent.setup() }
}

it("merges with the method picked, then reloads the PR", async () => {
  const merge = vi.fn<Handlers["MergePullRequest"]>(() => Effect.void)
  const { onReload, user } = mount(CanMerge.make({ methods: ["squash", "merge"] }), merge)

  await user.click(screen.getByRole("button", { name: "Merge" }))
  await screen.findByRole("dialog", { name: "Merge pull request" })
  await user.click(screen.getByRole("radio", { name: "Create a merge commit" }))
  await user.click(screen.getByRole("button", { name: "Create a merge commit" }))

  await screen.findByText("Merged")
  expect(merge).toHaveBeenCalledWith(
    {
      pullRequestId: pullRequestFields.id,
      revision,
      request: Merge.make({ method: "merge" }),
    },
    expect.anything(),
  )
  expect(onReload).toHaveBeenCalledOnce()
})

it("adds the PR to its merge queue without asking for a method", async () => {
  const merge = vi.fn<Handlers["MergePullRequest"]>(() => Effect.void)
  const { user } = mount(CanAddToMergeQueue.make({}), merge)

  await user.click(screen.getByRole("button", { name: "Merge" }))
  await screen.findByRole("dialog", { name: "Add to merge queue" })
  expect(screen.queryByRole("radiogroup")).toBeNull()
  await user.click(screen.getByRole("button", { name: "Add to merge queue" }))

  await screen.findByText("Added to merge queue")
  expect(merge.mock.calls[0]?.[0].request).toEqual(AddToMergeQueue.make({}))
})

it("shows GitHub's reason when it won't merge, leaving the PR as it was", async () => {
  const { onReload, user } = mount(CanMerge.make({ methods: ["squash"] }), () =>
    Effect.fail(new MergeRejected({ message: "Required status check is failing." })),
  )

  await user.click(screen.getByRole("button", { name: "Merge" }))
  await user.click(await screen.findByRole("button", { name: "Squash and merge" }))

  expect(await screen.findByText("Required status check is failing.")).toBeDefined()
  expect(screen.getByRole("dialog", { name: "Merge pull request" })).toBeDefined()
  expect(onReload).not.toHaveBeenCalled()
})

it("offers no Merge when GitHub wouldn't take one", () => {
  mount(null, () => Effect.void)
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull()
})
