// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import { OutsideAgent } from "@glass/contracts"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect, SubscriptionRef } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { backendLayerAtom } from "./backend"
import { OutsideAgentsSettings } from "./OutsideAgentsSettings"
import { testLayer } from "../../test/testBackend"

afterEach(cleanup)

const claudeCode = new OutsideAgent({
  id: "agent-1",
  name: "Claude Code",
  issuedAt: DateTime.makeUnsafe("2026-11-12T00:00:00Z"),
  expiresAt: DateTime.makeUnsafe("2026-12-12T00:00:00Z"),
})

it("lists an agent that connects while Settings is open, and disconnects it", async () => {
  const connected = Effect.runSync(SubscriptionRef.make<ReadonlyArray<OutsideAgent>>([]))
  const user = userEvent.setup()

  render(
    <RegistryProvider
      initialValues={[
        [
          backendLayerAtom,
          testLayer({
            WatchOutsideAgents: () => SubscriptionRef.changes(connected),
            RevokeOutsideAgent: () => SubscriptionRef.set(connected, []),
          }),
        ],
      ]}
    >
      <OutsideAgentsSettings />
    </RegistryProvider>,
  )

  expect(await screen.findByText("No outside agents are connected.")).toBeTruthy()

  Effect.runSync(SubscriptionRef.set(connected, [claudeCode]))

  expect(await screen.findByText("Claude Code")).toBeTruthy()
  expect(screen.getByText("Connected until 2026-12-12")).toBeTruthy()

  await user.click(screen.getByRole("button", { name: "Disconnect Claude Code" }))

  expect(await screen.findByText("No outside agents are connected.")).toBeTruthy()
})
