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

export const shortAgentNames = () => Array.from({ length: 10 }, shortName)

export const uniqueAgentName = () => `${shortName()}-${randomUUID().slice(0, 8)}`
