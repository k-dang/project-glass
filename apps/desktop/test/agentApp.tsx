import { RegistryProvider } from "@effect/atom-react"
import { type AgentEngine, AgentModels, GitHubConnection } from "@glass/contracts"
import { cleanup, render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Effect, Stream } from "effect"
import { afterEach } from "vite-plus/test"
import { App } from "../src/renderer/App"
import { backendLayerAtom } from "../src/renderer/backend"
import { agent } from "./agent"
import { testLayer } from "./testBackend"

export const piModels = new AgentModels({
  defaultModel: { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] },
  models: [
    { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] },
    { id: "glass-test/thinker", name: "Thinker", efforts: ["off", "low", "high"] },
  ],
})

export const claudeModels = new AgentModels({
  defaultModel: { id: "default", name: "Opus 5.5", efforts: ["low", "medium", "high"] },
  models: [{ id: "sonnet", name: "Sonnet 5.5", efforts: ["low", "high"] }],
})

export const listModels = ({ engine }: { engine: AgentEngine }) =>
  Effect.succeed(engine === "pi" ? piModels : claudeModels)

export const mount = (handlers: Parameters<typeof testLayer>[0], path = `/agents/${agent.id}`) => {
  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    WatchAgents: () => Stream.make([agent]),
    ListAgentModels: listModels,
    ...handlers,
  })

  window.history.replaceState(null, "", `#${path}`)

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      <App />
    </RegistryProvider>,
  )

  return userEvent.setup()
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  window.history.replaceState(null, "", "#/")
})

export const choice = (picker: HTMLElement, group: string, item: string) =>
  within(within(picker).getByRole("group", { name: group })).getByRole("button", { name: item })

export const pixel = {
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
} as const
