import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import type { FollowedRepository } from "@glass/contracts"
import { Effect, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Backend, type BackendError, backendRuntime } from "./backend"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, settledProblem } from "./problems"

interface RepositoryChange {
  readonly target: string
  readonly save: Effect.Effect<ReadonlyArray<FollowedRepository>, BackendError, Backend>
}

const followedRepositoriesAtom = backendRuntime
  .atom(Backend.use((backend) => backend.ListFollowedRepositories()))
  .pipe(Atom.keepAlive)

const repositoryInputAtom = Atom.make("").pipe(Atom.keepAlive)

const changeTargetAtom = Atom.make("").pipe(Atom.keepAlive)

export const followedRepositoriesRevisionAtom = Atom.make(0).pipe(Atom.keepAlive)

const changeAtom = backendRuntime
  .fn((change: RepositoryChange, get) =>
    Effect.sync(() => get.set(changeTargetAtom, change.target)).pipe(
      Effect.andThen(change.save),
      Effect.tap(() =>
        Effect.sync(() => {
          get.registry.update(followedRepositoriesRevisionAtom, (revision) => revision + 1)

          if (change.target === "follow") get.set(repositoryInputAtom, "")
        }),
      ),
    ),
  )
  .pipe(Atom.keepAlive)

export const repositoriesAtom = Atom.make((get) =>
  Option.match(AsyncResult.value(get(changeAtom)), {
    onSome: (saved) => AsyncResult.success(saved),
    onNone: () => get(followedRepositoriesAtom),
  }),
)

function useFollowedRepositories() {
  const [input, setInput] = useAtom(repositoryInputAtom)
  const change = useAtomValue(changeAtom)
  const target = useAtomValue(changeTargetAtom)
  const save = useAtomSet(changeAtom)

  const run = (next: RepositoryChange) => {
    if (!change.waiting) save(next)
  }

  return {
    input,
    setInput,
    pending: change.waiting ? target : null,
    problem: settledProblem(change),
    status: change.waiting
      ? "Saving followed repositories…"
      : AsyncResult.isSuccess(change)
        ? "Followed repositories saved."
        : "",
    follow: () =>
      run({
        target: "follow",
        save: Backend.use((backend) => backend.FollowRepository({ input })),
      }),
    unfollow: (repository: FollowedRepository) =>
      run({
        target: `${repository.owner}/${repository.repo}`,
        save: Backend.use((backend) => backend.UnfollowRepository({ repository })),
      }),
  }
}

type RepositoryConfiguration = ReturnType<typeof useFollowedRepositories>

export function FollowedRepositoriesSettings() {
  const repositories = useAtomValue(repositoriesAtom)
  const retry = useAtomRefresh(followedRepositoriesAtom)
  const configuration = useFollowedRepositories()

  return (
    <section
      aria-labelledby="repositories-heading"
      aria-busy={configuration.pending !== null}
      className="flex flex-col gap-4"
    >
      <div>
        <h2 id="repositories-heading" className="text-lg font-semibold">
          Followed repositories
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose the repositories for your PR lists. You can still open any PR directly.
        </p>
      </div>
      {AsyncResult.builder(repositories)
        .onInitialOrWaiting(() => <output>Loading followed repositories…</output>)
        .onFailure((cause) => (
          <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: retry }} />
        ))
        .onSuccess((value) => (
          <RepositoryEditor repositories={value} configuration={configuration} />
        ))
        .render()}
    </section>
  )
}

function RepositoryEditor(props: {
  repositories: ReadonlyArray<FollowedRepository>
  configuration: RepositoryConfiguration
}) {
  const { input, setInput, pending, problem, status, follow, unfollow } = props.configuration

  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          follow()
        }}
      >
        <fieldset disabled={pending !== null} className="flex flex-col gap-2">
          <Label htmlFor="repository-input">Repository</Label>
          <div className="flex items-center gap-2">
            <Input
              id="repository-input"
              aria-describedby="repository-hint"
              placeholder="owner/repo or https://github.com/owner/repo"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              spellCheck={false}
            />
            <Button type="submit" disabled={pending !== null || input.trim() === ""}>
              {pending === "follow" ? "Following…" : "Follow"}
            </Button>
          </div>
          <p id="repository-hint" className="text-xs text-muted-foreground">
            Enter a GitHub repository name or URL.
          </p>
        </fieldset>
      </form>
      {props.repositories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No followed repositories yet.</p>
      ) : (
        <ul aria-label="Followed repositories" className="divide-y rounded-md border px-3">
          {props.repositories.map((repository) => {
            const name = `${repository.owner}/${repository.repo}`

            return (
              <li key={name} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 break-all text-sm">{name}</span>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Unfollow ${name}`}
                  disabled={pending !== null}
                  onClick={() => unfollow(repository)}
                >
                  {pending === name ? "Unfollowing…" : "Unfollow"}
                </Button>
              </li>
            )
          })}
        </ul>
      )}

      {problem !== null && <ProblemAlert problem={problem} />}
      <output aria-live="polite" className="text-sm text-muted-foreground">
        {status}
      </output>
    </>
  )
}
