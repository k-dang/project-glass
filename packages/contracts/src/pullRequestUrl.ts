import { Option, Schema } from "effect"
import { PullRequestRef, referenceKey } from "./pullRequest"

const PULL_REQUEST_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/

const decodeReference = Schema.decodeUnknownOption(PullRequestRef)

export const parsePullRequestReference = (input: string): PullRequestRef | null => {
  const text = input.trim()
  const match = PULL_REQUEST_URL.exec(text) ?? /^([A-Za-z0-9-]+)\/([\w.-]+)#(\d+)$/.exec(text)

  if (match === null) return null

  return Option.getOrNull(
    decodeReference({ owner: match[1], repo: match[2], number: Number(match[3]) }),
  )
}

const PULL_REQUEST_MENTION =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9-]+\/[\w.-]+\/pull\/\d+|[A-Za-z0-9-]+\/[\w.-]+#\d+/g

export const findPullRequestReferences = (text: string): ReadonlyArray<PullRequestRef> => {
  const found = new Map<string, PullRequestRef>()

  for (const [mention] of text.matchAll(PULL_REQUEST_MENTION)) {
    const ref = parsePullRequestReference(mention)

    if (ref !== null && !found.has(referenceKey(ref))) found.set(referenceKey(ref), ref)
  }

  return [...found.values()]
}
