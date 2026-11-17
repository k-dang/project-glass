import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { BinaryFile, ImageFile, TextFile } from "@glass/contracts"
import { Effect, Layer } from "effect"
import { symlinkSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { FolderFiles } from "./FolderFiles"
import { HostConversationError } from "./protocol"

it.effect("finds and reads a folder's files by kind, refusing paths that leave it", () =>
  Effect.gen(function* () {
    const outside = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "glass-outside-")))
    const folder = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "glass-read-")))
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0)

    writeFileSync(join(outside, "secret.txt"), "secret\n")
    writeFileSync(join(folder, "artifact.html"), "<h1>Hi</h1>\n")
    writeFileSync(join(folder, "chart.png"), png)
    writeFileSync(join(folder, "data.bin"), Uint8Array.of(1, 0, 2))
    symlinkSync(join(outside, "secret.txt"), join(folder, "linked.txt"))

    const files = yield* FolderFiles
    const read = (path: string) => files.read(folder, path)

    assert.deepStrictEqual(yield* read("artifact.html"), TextFile.make({ text: "<h1>Hi</h1>\n" }))
    assert.deepStrictEqual(
      yield* read("chart.png"),
      ImageFile.make({ mediaType: "image/png", data: Buffer.from(png).toString("base64") }),
    )
    assert.deepStrictEqual(yield* read("data.bin"), BinaryFile.make({}))

    assert.deepStrictEqual(
      yield* files.existing(folder, ["chart.png", "missing.md", "linked.txt", "artifact.html"]),
      ["chart.png", "artifact.html"],
    )

    for (const path of ["../" + basename(outside) + "/secret.txt", "linked.txt", "."])
      assert.instanceOf(yield* Effect.flip(read(path)), HostConversationError)
  }).pipe(Effect.provide(FolderFiles.layer.pipe(Layer.provide(NodeServices.layer)))),
)
