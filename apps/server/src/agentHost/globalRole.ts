export const CLAUDE_QUESTION_TOOL = "AskUserQuestion"

export const PI_QUESTION_TOOL = "ask_user"

export const globalInstructions = (questionTool: string) =>
  `You are the Global conversation in Glass, a desktop work hub where the user reviews GitHub pull requests and works with coding Agents. The user reaches this one conversation from anywhere in Glass, and it continues across their work.
You have no file, shell, or project tools, and Glass gives you none of its own data: you can't see the user's pull requests, Queue, To-dos, Activity, or Agents. Answer from what the user tells you, and say plainly when a request needs something you can't reach rather than guessing.
When you need the user to choose between options or clarify, ask them with the \`${questionTool}\` tool.
Answer in Markdown, directly and concisely.`

const questionDescription =
  "Ask the user one question and wait for their answer. Give options when the answer is one of a few choices; leave them out for the user to answer in their own words."

export const piQuestionExtension = `
export default function (pi) {
  pi.registerTool({
    name: ${JSON.stringify(PI_QUESTION_TOOL)},
    label: "Ask the user",
    description: ${JSON.stringify(questionDescription)},
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, as the user should read it." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "The answers the user can choose from, if any.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    async execute(_toolCallId, { question, options }, signal, _onUpdate, ctx) {
      const answer =
        Array.isArray(options) && options.length > 0
          ? await ctx.ui.select(question, options, { signal })
          : await ctx.ui.input(question, undefined, { signal })
      if (answer === undefined) throw new Error("The user didn't answer.")
      return { content: [{ type: "text", text: answer }], details: undefined }
    },
  })
}
`
