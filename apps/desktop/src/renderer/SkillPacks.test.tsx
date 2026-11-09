// @vitest-environment happy-dom
import { RegistryProvider } from "@effect/atom-react"
import {
  Skill,
  SkillPack,
  SkillPackNameTaken,
  SkillPackPreview,
  SkillPackSource,
  SkillPackUpdate,
  SkippedSkill,
} from "@glass/contracts"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { backendLayerAtom } from "./backend"
import { SkillPacksSettings } from "./SkillPacks"
import { type Handlers, testLayer } from "../../test/testBackend"

afterEach(cleanup)

const source = new SkillPackSource({
  owner: "acme",
  repo: "skills",
  ref: "main",
  path: "skills/team",
})

const architect = new Skill({ name: "architect", description: "Shape a design." })

const first = "ae5650f0000000000000000000000000000000000"

const second = "b17c0de0000000000000000000000000000000000"

const pack = (name: string, commit: string, skills: ReadonlyArray<Skill>) =>
  new SkillPack({ name, source, commit, updatable: true, skills })

const mount = (handlers: Partial<Handlers>) => {
  render(
    <RegistryProvider initialValues={[[backendLayerAtom, testLayer(handlers)]]}>
      <SkillPacksSettings />
    </RegistryProvider>,
  )

  return userEvent.setup()
}

it("previews a pack, refuses a taken name, and adds it under the chosen name", async () => {
  const added = vi.fn<Handlers["AddSkillPack"]>(({ name, commit }) =>
    Effect.succeed([pack("team", first, [architect]), pack(name, commit, [architect])]),
  )

  const user = mount({
    ListSkillPacks: () => Effect.succeed([pack("team", first, [architect])]),
    PreviewSkillPack: () =>
      Effect.succeed(
        new SkillPackPreview({
          source,
          commit: first,
          suggestedName: "team",
          skills: [architect],
          skipped: [
            new SkippedSkill({ directory: "silent", reason: "SKILL.md has no description." }),
          ],
        }),
      ),
    AddSkillPack: added,
  })

  await user.type(
    await screen.findByRole("textbox", { name: "GitHub URL" }),
    "https://github.com/acme/skills/tree/main/skills/team",
  )
  await user.click(screen.getByRole("button", { name: "Preview" }))

  const preview = within(await screen.findByRole("form", { name: "Skill pack preview" }))

  expect(preview.getByRole("list", { name: "Skills" }).textContent).toBe(
    "architect · Shape a design.",
  )
  expect(preview.getByRole("list", { name: "Skipped" }).textContent).toBe(
    "silent · SKILL.md has no description.",
  )
  expect(preview.getByText("You already have a pack named team.")).toBeDefined()
  expect(preview.getByRole("button", { name: "Add pack" })).toHaveProperty("disabled", true)

  const name = preview.getByRole("textbox", { name: "Name" })

  await user.clear(name)
  await user.type(name, "team-two")
  await user.click(preview.getByRole("button", { name: "Add pack" }))

  expect(added).toHaveBeenCalledWith({ source, commit: first, name: "team-two" }, expect.anything())
  expect(await screen.findByText("team-two")).toBeDefined()
  expect(screen.queryByRole("form", { name: "Skill pack preview" })).toBeNull()
  expect(screen.getByRole("textbox", { name: "GitHub URL" })).toHaveProperty("value", "")
})

it("keeps the preview open with the problem when adding fails", async () => {
  const user = mount({
    ListSkillPacks: () => Effect.succeed([]),
    PreviewSkillPack: () =>
      Effect.succeed(
        new SkillPackPreview({
          source,
          commit: first,
          suggestedName: "team",
          skills: [architect],
          skipped: [],
        }),
      ),
    AddSkillPack: ({ name }) => Effect.fail(new SkillPackNameTaken({ name })),
  })

  await user.type(await screen.findByRole("textbox", { name: "GitHub URL" }), "acme/skills")
  await user.click(screen.getByRole("button", { name: "Preview" }))
  await user.click(await screen.findByRole("button", { name: "Add pack" }))

  expect(await screen.findByText("That name is taken")).toBeDefined()
  expect(screen.getByRole("form", { name: "Skill pack preview" })).toBeDefined()
})

it("shows what an update changes and moves the pin only when confirmed", async () => {
  const critic = new Skill({ name: "critic", description: "Find the flaws." })

  const updated = vi.fn<Handlers["UpdateSkillPack"]>(({ commit }) =>
    Effect.succeed([pack("team", commit, [architect, critic])]),
  )

  const user = mount({
    ListSkillPacks: () => Effect.succeed([pack("team", first, [architect])]),
    PreviewSkillPackUpdate: ({ name }) =>
      Effect.succeed(
        new SkillPackUpdate({
          name,
          from: first,
          to: second,
          added: [critic],
          removed: [],
          changed: [architect],
          skipped: [],
        }),
      ),
    UpdateSkillPack: updated,
  })

  await user.click(await screen.findByRole("button", { name: "Update team" }))

  const update = within(await screen.findByLabelText("Update team", { selector: "div" }))

  expect(update.getByText("ae5650f → b17c0de")).toBeDefined()
  expect(update.getByRole("list", { name: "Added" }).textContent).toBe("critic · Find the flaws.")
  expect(update.getByRole("list", { name: "Changed" }).textContent).toBe(
    "architect · Shape a design.",
  )
  expect(updated).not.toHaveBeenCalled()

  await user.click(update.getByRole("button", { name: "Update to b17c0de" }))

  expect(updated).toHaveBeenCalledWith({ name: "team", commit: second }, expect.anything())
  expect(await screen.findByText("b17c0de")).toBeDefined()
  expect(screen.queryByLabelText("Update team", { selector: "div" })).toBeNull()
})
