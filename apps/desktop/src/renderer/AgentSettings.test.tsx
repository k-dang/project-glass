// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  defaultReviewPrompt,
  type EngineFeature,
  type EngineSettings,
  SettingsError,
} from "@glass/contracts"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { AgentSettings } from "./AgentSettings"
import { backendLayerAtom } from "./backend"
import { type Handlers, type Held, hold, next, testLayer } from "../../test/testBackend"

afterEach(cleanup)

type EngineSettingsSave = Held<
  { feature: EngineFeature; engineSettings: EngineSettings },
  EngineSettings,
  SettingsError
>

type PromptSave = Held<{ prompt: string }, string, SettingsError>

const tourSettings: EngineSettings = {
  engine: "claude-code",
  models: {
    "claude-code": "claude-sonnet-5-5",
    pi: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
  },
}

const settled = (field: HTMLElement) =>
  waitFor(() => expect(field.closest("[aria-busy]")?.getAttribute("aria-busy")).toBe("false"))

const mount = (handlers: Partial<Handlers> = {}) => {
  const setEngine = vi.fn<Handlers["SetEngineSettings"]>(({ engineSettings }) =>
    Effect.succeed(engineSettings),
  )

  const setPrompt = vi.fn<Handlers["SetReviewPrompt"]>(({ prompt }) => Effect.succeed(prompt))

  const backend = testLayer({
    GetEngineSettings: ({ feature }) =>
      Effect.succeed(feature === "tours" ? tourSettings : { ...tourSettings, engine: "pi" }),
    SetEngineSettings: setEngine,
    GetReviewPrompt: () => Effect.succeed(defaultReviewPrompt),
    SetReviewPrompt: setPrompt,
    ...handlers,
  })

  const tree = (show: boolean) => (
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      {show && <AgentSettings />}
    </RegistryProvider>
  )

  const view = render(tree(true))

  return {
    setEngine,
    setPrompt,
    user: userEvent.setup(),
    show: (show: boolean) => view.rerender(tree(show)),
  }
}

it("saves engine choices immediately and model edits on blur, without saving other settings", async () => {
  const saves: Array<EngineSettingsSave> = []
  const { setPrompt, user } = mount({ SetEngineSettings: hold(saves) })
  const tours = within(await screen.findByRole("region", { name: "Tours" }))
  await tours.findByRole("textbox", { name: "Claude Code model" })

  await user.click(tours.getByRole("radio", { name: "pi" }))
  const saving = await next(saves)
  expect(saving.payload).toEqual({
    feature: "tours",
    engineSettings: { ...tourSettings, engine: "pi" },
  })
  const model = tours.getByRole("textbox", { name: "pi model" })
  expect(model.closest("[aria-busy]")?.getAttribute("aria-busy")).toBe("true")
  saving.answer(Effect.succeed(saving.payload.engineSettings))
  await settled(model)

  await user.clear(model)
  await user.type(model, " gpt-test ")
  expect(saves).toHaveLength(0)
  await user.tab()
  const edit = await next(saves)
  expect(edit.payload.engineSettings.models.pi).toEqual({
    provider: "anthropic",
    modelId: "gpt-test",
  })
  edit.answer(Effect.succeed(edit.payload.engineSettings))
  await settled(model)
  expect(setPrompt).not.toHaveBeenCalled()
})

it("keeps incomplete model edits local while other settings can save", async () => {
  const { setEngine, user } = mount()
  const tours = within(await screen.findByRole("region", { name: "Tours" }))
  const model = await tours.findByRole("textbox", { name: "Claude Code model" })
  await user.clear(model)
  await user.tab()
  expect(setEngine).not.toHaveBeenCalled()
  expect(tours.getByText("The Claude Code Tour engine needs a model.")).toBeDefined()

  const reviews = within(screen.getByRole("region", { name: "Agent reviews" }))
  await user.click(reviews.getByRole("radio", { name: "Claude Code" }))
  await waitFor(() => expect(setEngine).toHaveBeenCalledTimes(1))
  expect(setEngine).toHaveBeenCalledWith(
    expect.objectContaining({ feature: "agentReviews" }),
    expect.anything(),
  )
})

it("refuses an empty prompt, saves edits trimmed on blur, and restores the default immediately", async () => {
  const { setPrompt, user } = mount()
  const box = await screen.findByRole("textbox", { name: "Review prompt" })
  await user.clear(box)
  await user.click(screen.getByRole("heading", { name: "Agent reviews" }))
  expect(setPrompt).not.toHaveBeenCalled()
  expect(
    screen.getByText("Write a review prompt. Agent reviews need it to know how you review."),
  ).toBeDefined()

  await user.type(box, "  Look only at naming.\n")
  expect(setPrompt).not.toHaveBeenCalled()
  await user.click(screen.getByRole("heading", { name: "Agent reviews" }))
  await waitFor(() => expect(box).toHaveProperty("value", "Look only at naming."))
  expect(setPrompt).toHaveBeenCalledWith({ prompt: "Look only at naming." }, expect.anything())
  await user.click(screen.getByRole("button", { name: "Restore default" }))
  await waitFor(() =>
    expect(setPrompt).toHaveBeenLastCalledWith({ prompt: defaultReviewPrompt }, expect.anything()),
  )
})

it("keeps failed edits visible and retries them without repeating another setting's save", async () => {
  const saves: Array<EngineSettingsSave> = []
  const { setPrompt, user } = mount({ SetEngineSettings: hold(saves) })
  const tours = within(await screen.findByRole("region", { name: "Tours" }))
  await tours.findByRole("textbox", { name: "Claude Code model" })
  await user.click(tours.getByRole("radio", { name: "pi" }))
  const saving = await next(saves)
  saving.answer(Effect.fail(new SettingsError({ message: "Disk full." })))
  expect((await tours.findByRole("alert")).textContent).toContain("Disk full.")
  expect(tours.getByRole<HTMLInputElement>("radio", { name: "pi" }).checked).toBe(true)
  await user.click(tours.getByRole("button", { name: "Retry" }))
  const retry = await next(saves)
  expect(retry.payload).toEqual(saving.payload)
  retry.answer(Effect.succeed(retry.payload.engineSettings))
  await waitFor(() => expect(tours.queryByRole("alert")).toBeNull())
  expect(setPrompt).not.toHaveBeenCalled()
})

it("keeps an unfinished edit when leaving Settings and returning", async () => {
  const { show, user } = mount()
  const box = await screen.findByRole("textbox", { name: "Review prompt" })
  await user.clear(box)
  show(false)
  show(true)
  expect(await screen.findByRole("textbox", { name: "Review prompt" })).toHaveProperty("value", "")
})

it("keeps a visible engine selection made while the previous model saves", async () => {
  const saves: Array<EngineSettingsSave> = []
  const { user } = mount({ SetEngineSettings: hold(saves) })
  const tours = within(await screen.findByRole("region", { name: "Tours" }))
  const model = await tours.findByRole("textbox", { name: "Claude Code model" })
  await user.type(model, "-updated")
  await user.click(tours.getByText("pi", { selector: "span" }))
  expect(tours.getByRole<HTMLInputElement>("radio", { name: "pi" }).checked).toBe(true)

  const previous = await next(saves)
  expect(previous.payload.engineSettings.engine).toBe("claude-code")
  expect(saves).toHaveLength(0)
  previous.answer(Effect.succeed(previous.payload.engineSettings))

  const latest = await next(saves)
  expect(latest.payload.engineSettings).toEqual({
    ...tourSettings,
    engine: "pi",
    models: { ...tourSettings.models, "claude-code": "claude-sonnet-5-5-updated" },
  })
  latest.answer(Effect.succeed(latest.payload.engineSettings))
  await settled(tours.getByRole("radio", { name: "pi" }))
})

it("keeps typing in the next model field while a provider save is pending", async () => {
  const saves: Array<EngineSettingsSave> = []
  const { user } = mount({ SetEngineSettings: hold(saves) })
  const reviews = within(await screen.findByRole("region", { name: "Agent reviews" }))
  const provider = await reviews.findByRole("textbox", { name: "pi provider" })
  const model = reviews.getByRole("textbox", { name: "pi model" })
  await user.type(provider, "-updated")
  await user.click(model)
  const saving = await next(saves)
  await user.type(model, "-new")
  expect(model).toHaveProperty("value", "claude-sonnet-5-5-new")

  saving.answer(Effect.succeed(saving.payload.engineSettings))
  await settled(model)
  expect(model).toHaveProperty("value", "claude-sonnet-5-5-new")
  expect(saves).toHaveLength(0)
  await user.tab()
  const latest = await next(saves)
  expect(latest.payload.engineSettings.models.pi).toEqual({
    provider: "anthropic-updated",
    modelId: "claude-sonnet-5-5-new",
  })
  latest.answer(Effect.succeed(latest.payload.engineSettings))
  await settled(model)
})

it("normalizes whitespace-only prompt edits without writing or leaving a dirty draft", async () => {
  const { setPrompt, user } = mount()
  const box = await screen.findByRole("textbox", { name: "Review prompt" })
  await user.type(box, "  ")
  await user.click(screen.getByRole("heading", { name: "Agent reviews" }))
  expect(box).toHaveProperty("value", defaultReviewPrompt)
  expect(setPrompt).not.toHaveBeenCalled()
})

it("saves the latest committed prompt after an earlier write fails, even after leaving Settings", async () => {
  const saves: Array<PromptSave> = []
  const { show, user } = mount({ SetReviewPrompt: hold(saves) })
  const box = await screen.findByRole("textbox", { name: "Review prompt" })
  const leaveField = () => user.click(screen.getByRole("heading", { name: "Agent reviews" }))
  await user.type(box, " First edit.")
  await leaveField()
  const first = await next(saves)

  await user.type(box, " Second edit.")
  await leaveField()
  await user.type(box, " Latest edit.")
  await leaveField()
  expect(saves).toHaveLength(0)
  show(false)
  first.answer(Effect.fail(new SettingsError({ message: "First write failed." })))

  const latest = await next(saves)
  expect(latest.payload.prompt).toBe(`${defaultReviewPrompt} First edit. Second edit. Latest edit.`)
  latest.answer(Effect.succeed(latest.payload.prompt))
  show(true)
  const reviews = within(await screen.findByRole("region", { name: "Agent reviews" }))
  const returned = await screen.findByRole("textbox", { name: "Review prompt" })
  await settled(returned)
  expect(returned).toHaveProperty("value", latest.payload.prompt)
  expect(reviews.queryByRole("alert")).toBeNull()
})

it("retains the last successful value when a later queued write fails", async () => {
  const saves: Array<PromptSave> = []
  const { user } = mount({ SetReviewPrompt: hold(saves) })
  const box = await screen.findByRole("textbox", { name: "Review prompt" })
  const leaveField = () => user.click(screen.getByRole("heading", { name: "Agent reviews" }))
  await user.type(box, " First edit.")
  await leaveField()
  const first = await next(saves)
  await user.type(box, " Second edit.")
  await leaveField()
  first.answer(Effect.succeed(first.payload.prompt))
  const second = await next(saves)
  second.answer(Effect.fail(new SettingsError({ message: "Second write failed." })))
  expect((await screen.findByRole("alert")).textContent).toContain("Second write failed.")

  await user.clear(box)
  await user.type(box, first.payload.prompt)
  await leaveField()
  expect(saves).toHaveLength(0)
  expect(screen.queryByRole("alert")).toBeNull()
  expect(box).toHaveProperty("value", first.payload.prompt)
})
