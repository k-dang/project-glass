import type { FileContents, PullRequestRef, Revision, RevisionSide } from "@glass/contracts"
import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs"
import { Cause, Data, Effect, Exit, Match, Option } from "effect"
import { useCallback, useState } from "react"
import { Backend, useBackendRuntime } from "./backend"
import { describeError, type Problem, unexpectedProblem } from "./problems"

class Unreadable extends Data.TaggedError("Unreadable")<{ readonly detail: string }> {}

interface Load {
  readonly revision: Revision
  readonly problem: Problem | null
}

export function useFullFiles(pullRequest: PullRequestRef, revision: Revision) {
  const backendRuntime = useBackendRuntime()
  const [last, setLast] = useState<Load | null>(null)

  const loadDiffFiles = useCallback(
    async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const read = (side: RevisionSide, path: string) =>
        Backend.use((backend) =>
          backend.GetFileContents({ pullRequest, revision, side, path }),
        ).pipe(
          Effect.mapError((error) => new Unreadable({ detail: describeError(error).detail })),
          Effect.flatMap(
            Match.type<FileContents>().pipe(
              Match.tagsExhaustive({
                TextFile: ({ text }) => Effect.succeed({ name: path, contents: text }),
                BinaryFile: () =>
                  Effect.fail(new Unreadable({ detail: "GitHub reports it as a binary file." })),
                FileTooLarge: () =>
                  Effect.fail(new Unreadable({ detail: "It's too large to show in full." })),
              }),
            ),
          ),
        )

      const load: Load = { revision, problem: null }
      setLast(load)

      const exit = await backendRuntime.runPromiseExit(
        Effect.all(
          {
            oldFile: read("base", fileDiff.prevName ?? fileDiff.name),
            newFile: read("head", fileDiff.name),
          },
          { concurrency: "unbounded" },
        ),
      )

      if (Exit.isSuccess(exit)) return exit.value

      const detail = Option.match(Cause.findErrorOption(exit.cause), {
        onSome: (error) => error.detail,
        onNone: () => unexpectedProblem.detail,
      })

      const problem = { title: `Couldn't expand ${fileDiff.name}`, detail }
      setLast((current) => (current === load ? { revision, problem } : current))

      // Diffs leaves the partial diff intact after a load failure and retries on expansion.
      throw Cause.squash(exit.cause)
    },
    [pullRequest, revision, backendRuntime],
  )

  return {
    loadDiffFiles,
    problem: last?.revision === revision ? last.problem : null,
  }
}
