import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { isolatedGitEnv } from "./gitEnv"

export class GitFailed extends Schema.TaggedError<GitFailed>()("GitFailed", {
  args: Schema.Array(Schema.String),
  code: Schema.NullOr(Schema.Int),
  stderr: Schema.String,
}) {}

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => ""),
  )

export class Git extends Context.Service<
  Git,
  {
    readonly run: (
      cwd: string,
      args: ReadonlyArray<string>,
      env?: Record<string, string>,
    ) => Effect.Effect<string, GitFailed>
    readonly runUntrimmed: (
      cwd: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<string, GitFailed>
    readonly isolated: (
      args: ReadonlyArray<string>,
      env: Record<string, string>,
    ) => Effect.Effect<string, GitFailed>
  }
>()("@glass/server/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const git = Effect.fnUntraced(function* (
        args: ReadonlyArray<string>,
        options: ChildProcess.CommandOptions,
      ) {
        const { stdout, stderr, code } = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* spawner.spawn(
              ChildProcess.make("git", args, { ...options, stdin: "ignore" }),
            )

            const [out, err, exit] = yield* Effect.all(
              [collect(child.stdout), collect(child.stderr), child.exitCode],
              { concurrency: "unbounded" },
            )

            return { stdout: out, stderr: err, code: Number(exit) }
          }),
        ).pipe(Effect.mapError(() => new GitFailed({ args: [...args], code: null, stderr: "" })))

        if (code !== 0) return yield* new GitFailed({ args: [...args], code, stderr })

        return stdout
      })

      const userGit = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string>) =>
        git(args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, extendEnv: true })

      return Git.of({
        run: (cwd, args, env = {}) => userGit(cwd, args, env).pipe(Effect.map((out) => out.trim())),
        runUntrimmed: (cwd, args) => userGit(cwd, args, {}),
        isolated: (args, env) =>
          git(args, { env: { ...isolatedGitEnv(), ...env }, extendEnv: false }).pipe(
            Effect.map((out) => out.trim()),
          ),
      })
    }),
  )
}
