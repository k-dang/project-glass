import { useAtomValue } from "@effect/atom-react"
import type { AtomRegistry } from "effect/reactivity"
import { Backend } from "./backend"
import { createKeyedWrites, type WriteView } from "./keyedWrites"

export type ResolutionView = WriteView<boolean, boolean>

export const createResolutions = (registry: AtomRegistry.AtomRegistry) =>
  createKeyedWrites(registry, (discussionId, resolved: boolean) =>
    Backend.use((backend) => backend.SetDiscussionResolved({ discussionId, resolved })),
  )

export type Resolutions = ReturnType<typeof createResolutions>

export const useResolution = (resolutions: Resolutions, discussionId: string) =>
  useAtomValue(resolutions.viewAtom(discussionId))
