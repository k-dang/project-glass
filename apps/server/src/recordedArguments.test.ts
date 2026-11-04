import { Option, Predicate } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vite-plus/test"
import { decodeJson, isJsonArray, isJsonObject, type Json } from "../test/replay"

const recordings = join(import.meta.dirname, "..", "test", "recordings")

const argumentsIn = (value: Json): ReadonlyArray<string> =>
  isJsonArray(value)
    ? value.flatMap(argumentsIn)
    : isJsonObject(value)
      ? Object.entries(value).flatMap(([name, inner]) =>
          name === "args" && isJsonArray(inner)
            ? inner.filter(Predicate.isString)
            : argumentsIn(inner),
        )
      : []

it("stays under the argument length endpoint security tools kill processes for (ADR 0004)", () => {
  const recorded = readdirSync(recordings, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".json"))
    .flatMap((path) =>
      argumentsIn(Option.getOrThrow(decodeJson(readFileSync(join(recordings, path), "utf8")))),
    )

  expect(recorded.length).toBeGreaterThan(0)
  expect(Math.max(...recorded.map(({ length }) => length))).toBeLessThan(1000)
})
