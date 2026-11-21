import { Context, Layer } from "effect"
import { randomUUID } from "node:crypto"

const adjectives = [
  "brisk",
  "calm",
  "clever",
  "eager",
  "keen",
  "lucid",
  "nimble",
  "quiet",
  "steady",
  "swift",
]

const nouns = [
  "badger",
  "falcon",
  "heron",
  "lynx",
  "marten",
  "otter",
  "owl",
  "puffin",
  "raven",
  "wren",
]

const pick = (words: ReadonlyArray<string>) => words[Math.floor(Math.random() * words.length)] ?? ""

const shortName = () => `agent/${pick(adjectives)}-${pick(nouns)}`

export const shortThreadNames = () => Array.from({ length: 10 }, shortName)

export class ThreadNames extends Context.Service<
  ThreadNames,
  { readonly candidates: () => ReadonlyArray<string> }
>()("@glass/server/ThreadNames") {
  static readonly layer = Layer.succeed(ThreadNames)({ candidates: shortThreadNames })
}

export const uniqueThreadName = () => `${shortName()}-${randomUUID().slice(0, 8)}`
