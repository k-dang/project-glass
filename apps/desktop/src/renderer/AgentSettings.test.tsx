// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  defaultReviewPrompt,
  type EngineFeature,
  type EngineSettings,
  SettingsError,
} from "@glass/contracts"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { Toaster } from "@/components/ui/toast"
import { AgentSettings } from "./AgentSettings"
import { backendLayerAtom } from "./backend"
import { type Handlers, type Held, hold, next, testLayer } from "../../test/testBackend"

afterEach(cleanup)

type EngineSettingsSave = Held<
  { feature: EngineFeature; engineSettings: EngineSettings },
  EngineSettings,
  SettingsError
>

const tourSettings: EngineSettings = {
  engine: "claude-code",
  models: {
    "claude-code": "claude-sonnet-5-5",
    "pi-cli": { provider: "anthropic", modelId: "claude-sonnet-5-5" },
  },
}

const mount = (handlers: Partial<Handlers> = {}) => {
  const setPrompt = vi.fn<Handlers["SetReviewPrompt"]>(({ prompt }) => Effect.succeed(prompt))

  const backend = testLayer({
    GetEngineSettings: ({ feature }) =>
      Effect.succeed(feature === "tours" ? tourSettings : { ...tourSettings, engine: "pi-cli" }),
    GetReviewPrompt: () => Effect.succeed(defaultReviewPrompt),
    SetReviewPrompt: setPrompt,
    ...handlers,
  })

  render(
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      <Toaster>
        <AgentSettings />
      </Toaster>
    </RegistryProvider>,
  )

  return { setPrompt, user: userEvent.setup() }
}

const saveButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" })

const promptBox = () => screen.findByRole("textbox", { name: "Review prompt" })

it("shows only the chosen engine's model, and saves the Tour engine and models", async () => {
  const saves: Array<EngineSettingsSave> = []
  const { user } = mount({ SetEngineSettings: hold(saves) })
  const tours = within(await screen.findByRole("region", { name: "Tours" }))
  expect(saveButton().disabled).toBe(true)
  expect(tours.queryByRole("textbox", { name: "pi model" })).toBeNull()

  await user.click(tours.getByRole("radio", { name: "pi" }))
  expect(tours.queryByRole("textbox", { name: "Claude Code model" })).toBeNull()
  const model = tours.getByRole("textbox", { name: "pi model" })
  await user.clear(model)
  await user.click(tours.getByRole("radio", { name: "Claude Code" }))
  expect(screen.getByRole("status").textContent).toBe("The pi Tour engine needs a model.")
  expect(saveButton().disabled).toBe(true)
  await user.click(tours.getByRole("radio", { name: "pi (needs a model)" }))
  await user.type(tours.getByRole("textbox", { name: "pi model" }), " gpt-test ")
  await user.click(saveButton())

  const saving = await next(saves)
  expect(saving.payload).toEqual({
    feature: "tours",
    engineSettings: {
      engine: "pi-cli",
      models: { ...tourSettings.models, "pi-cli": { provider: "anthropic", modelId: "gpt-test" } },
    },
  })
  saving.answer(Effect.succeed(saving.payload.engineSettings))
  expect(await screen.findByText("Settings saved.")).toBeDefined()
  expect(saveButton().disabled).toBe(true)

  await user.type(tours.getByRole("textbox", { name: "pi model" }), "-updated")
  expect(saveButton().disabled).toBe(false)
  expect(screen.getByRole("status").textContent).toBe("Unsaved changes.")
})

it("saves only what changed in the Agent review settings", async () => {
  const saves: Array<EngineSettingsSave> = []
  const { setPrompt, user } = mount({ SetEngineSettings: hold(saves) })
  const reviews = within(await screen.findByRole("region", { name: "Agent reviews" }))
  const radio = (name: string) => reviews.getByRole<HTMLInputElement>("radio", { name })

  expect(radio("pi").checked).toBe(true)

  const model = reviews.getByRole("textbox", { name: "pi model" })
  await user.clear(model)
  await user.type(model, "deepseek-test")
  await user.click(saveButton())

  const saving = await next(saves)
  expect(saving.payload).toEqual({
    feature: "agentReviews",
    engineSettings: {
      engine: "pi-cli",
      models: {
        ...tourSettings.models,
        "pi-cli": { provider: "anthropic", modelId: "deepseek-test" },
      },
    },
  })
  saving.answer(Effect.succeed(saving.payload.engineSettings))
  expect(await screen.findByText("Settings saved.")).toBeDefined()
  expect(saves).toHaveLength(0)
  expect(setPrompt).not.toHaveBeenCalled()
})

it("refuses an empty prompt, saves it trimmed, and restores the default", async () => {
  const { setPrompt, user } = mount()
  const box = await promptBox()
  const restore = screen.getByRole<HTMLButtonElement>("button", { name: "Restore default" })
  expect(restore.disabled).toBe(true)
  expect(screen.getByText("Default")).toBeDefined()

  await user.clear(box)
  expect(saveButton().disabled).toBe(true)
  expect(screen.getByRole("status").textContent).toBe(
    "Write a review prompt. Agent reviews need it to know how you review.",
  )

  await user.type(box, "  Look only at naming.\n")
  expect(screen.getByText("Custom")).toBeDefined()
  await user.click(saveButton())
  expect(setPrompt).toHaveBeenCalledWith({ prompt: "Look only at naming." }, expect.anything())
  expect(await screen.findByText("Settings saved.")).toBeDefined()

  await user.click(restore)
  expect(box).toHaveProperty("value", defaultReviewPrompt)
  await user.click(saveButton())
  expect(setPrompt).toHaveBeenLastCalledWith({ prompt: defaultReviewPrompt }, expect.anything())
})

it("discards unsaved changes back to the saved settings", async () => {
  const { user } = mount()
  const box = await promptBox()
  const tours = within(screen.getByRole("region", { name: "Tours" }))

  await user.type(box, " Skip tests.")
  await user.click(tours.getByRole("radio", { name: "pi" }))
  expect(screen.getByRole("status").textContent).toBe("Unsaved changes.")
  await user.click(screen.getByRole("button", { name: "Discard" }))

  expect(box).toHaveProperty("value", defaultReviewPrompt)
  expect(tours.getByRole<HTMLInputElement>("radio", { name: "Claude Code" }).checked).toBe(true)
  expect(saveButton().disabled).toBe(true)
})

type EngineSettingsLoad = Held<{ feature: EngineFeature }, EngineSettings, SettingsError>

const mountWithFailingPrompt = () => {
  const reloads: Array<EngineSettingsLoad> = []
  let loaded = false

  const mounted = mount({
    GetEngineSettings: (payload) => {
      if (payload.feature === "agentReviews") {
        return Effect.succeed({ ...tourSettings, engine: "pi-cli" })
      }

      if (loaded) {
        return hold(reloads)(payload)
      }

      loaded = true

      return Effect.succeed(tourSettings)
    },
    SetEngineSettings: ({ engineSettings }) => Effect.succeed(engineSettings),
    SetReviewPrompt: () => Effect.fail(new SettingsError({ message: "Disk full." })),
  })

  return { ...mounted, reloads }
}

const saveEngineAndPrompt = async (user: ReturnType<typeof userEvent.setup>) => {
  const box = await promptBox()
  const tours = within(screen.getByRole("region", { name: "Tours" }))
  await user.click(tours.getByRole("radio", { name: "pi" }))
  await user.type(box, " Skip tests.")
  await user.click(saveButton())

  return { box, tours }
}

it("reloads what a partly failed save stored before Discard can use it", async () => {
  const { reloads, user } = mountWithFailingPrompt()
  const { box, tours } = await saveEngineAndPrompt(user)

  const reload = await next(reloads)
  expect(screen.getByRole("status").textContent).toBe("Saving…")
  reload.answer(Effect.succeed({ ...tourSettings, engine: "pi-cli" }))
  expect((await screen.findByRole("alert")).textContent).toContain("Disk full.")

  await user.click(screen.getByRole("button", { name: "Discard" }))
  expect(box).toHaveProperty("value", defaultReviewPrompt)
  expect(tours.getByRole<HTMLInputElement>("radio", { name: "pi" }).checked).toBe(true)
  expect(saveButton().disabled).toBe(true)
})

it("keeps the draft when reloading after a failed save also fails", async () => {
  const { reloads, user } = mountWithFailingPrompt()
  const { box } = await saveEngineAndPrompt(user)

  const reload = await next(reloads)
  reload.answer(Effect.fail(new SettingsError({ message: "Unreadable." })))
  expect((await screen.findByRole("alert")).textContent).toContain("Disk full.")
  expect(box).toHaveProperty("value", `${defaultReviewPrompt} Skip tests.`)
})
