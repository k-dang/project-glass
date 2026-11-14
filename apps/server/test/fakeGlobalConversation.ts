import { localPlace } from "@glass/contracts"
import { Predicate, type Schema } from "effect"
import { type FakeModelDelta, type FakeModelRequest, lastUserText } from "./fakeModelProvider.ts"

const textOf = ({ content }: FakeModelRequest["messages"][number]) =>
  Predicate.isString(content) ? content : (content ?? []).map(({ text }) => text ?? "").join("")

const toolNames = ({ tools = [] }: FakeModelRequest) =>
  tools.flatMap((tool) =>
    Predicate.hasProperty(tool, "function") &&
    Predicate.hasProperty(tool.function, "name") &&
    Predicate.isString(tool.function.name)
      ? [tool.function.name]
      : [],
  )

export const isGlobalConversation = (input: FakeModelRequest) =>
  toolNames(input).includes("ask_user")

export const globalConversationReply = (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> => {
  const last = input.messages.at(-1)

  if (last?.role === "tool") return [{ text: `The fake model saw: ${textOf(last).slice(0, 200)}` }]

  const words = lastUserText(input)

  if (words.startsWith("<glass_report>"))
    return [{ text: "The Agent you started is done. Want me to look at what it changed?" }]

  const call = (name: string, args: Schema.JsonObject): ReadonlyArray<FakeModelDelta> => [
    { toolCall: { id: `call-${input.messages.length}`, name, arguments: args } },
  ]

  const viewed = /viewing PR ([\w-]+)\/([\w.-]+)#(\d+) at Revision base (\w+), head (\w+)\./.exec(
    words,
  )

  if (viewed !== null && /\bthis PR\b/i.test(words)) {
    const [, owner = "", repo = "", number = "", base = "", head = ""] = viewed

    return call("mcp__glass__read_pull_request", {
      pullRequest: { owner, repo, number: Number(number) },
      revision: { base, head },
    })
  }

  const delegated = /^Start an Agent in ([\w-]+)\/([\w.-]+) from (\S+): (.+)$/m.exec(words)

  if (delegated !== null) {
    const [, owner = "", repo = "", baseBranch = "", message = ""] = delegated

    return call("mcp__glass__create_agent", {
      repository: { owner, repo },
      baseBranch,
      place: localPlace,
      engine: "claude-code",
      model: null,
      effort: null,
      message,
    })
  }

  if (/\bask\b/i.test(words))
    return call("ask_user", {
      question: "Which files should I look at?",
      options: ["Only the README", "Everything"],
    })

  return [{ text: `Fake reply to: ${words.split("\n")[0]}` }]
}
