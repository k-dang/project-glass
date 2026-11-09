import { useAtom, useAtomValue } from "@effect/atom-react"
import { type AgentEngine, type AgentPlace, LOCAL_SKILLS_NAMESPACE } from "@glass/contracts"
import { Option, Predicate, Schema } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Backend, backendRuntime } from "./backend"
import { skillPacksAtom } from "./SkillPacks"

const storageKey = "glass.newAgent.skillPacks"

const localSkillsKey = "glass.newAgent.localSkills"

export const LOCAL_SKILLS_LABEL = "Local skills"

const decodeChosen = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

const lastChosenAtom = Atom.writable(
  (): ReadonlyArray<string> =>
    Option.getOrElse(decodeChosen(localStorage.getItem(storageKey)), () => []),
  (ctx, chosen: ReadonlyArray<string>) => {
    localStorage.setItem(storageKey, JSON.stringify(chosen))
    ctx.setSelf(chosen)
  },
).pipe(Atom.keepAlive)

const lastLocalSkillsAtom = Atom.writable(
  () => localStorage.getItem(localSkillsKey) === "true",
  (ctx, chosen: boolean) => {
    localStorage.setItem(localSkillsKey, String(chosen))
    ctx.setSelf(chosen)
  },
).pipe(Atom.keepAlive)

const localSkillNamesAtom = Atom.family((engine: AgentEngine) =>
  backendRuntime.atom(Backend.use((backend) => backend.ListLocalSkills({ engine }))),
)

const noLocalSkills = Atom.make(AsyncResult.success<ReadonlyArray<string>>([]))

interface ChosenSource {
  readonly label: string
  /** What Claude Code puts before the source's skill names in its commands, such as `team:`. */
  readonly prefix: string
  readonly skills: ReadonlyArray<string>
}

const listed = new Intl.ListFormat("en", { type: "conjunction" })

/**
 * One line per skill name that more than one chosen source has, saying which the Agent uses.
 * Local skills come first because pi keeps the first skill of a name: a local Agent's pi finds
 * them before any sent skill, and Glass sends a Sandbox Agent's first (`skillsOf` in the server's
 * Agents.ts).
 */
const sharedSkillNames = (engine: AgentEngine, sources: ReadonlyArray<ChosenSource>) => {
  const names = [...new Set(sources.flatMap(({ skills }) => skills))].toSorted()

  return names.flatMap((name) => {
    const having = sources.filter(({ skills }) => skills.includes(name))

    if (having.length < 2) return []

    const where = `${name} is in ${listed.format(having.map(({ label }) => label))}.`

    return engine === "pi"
      ? [`${where} The Agent uses the one in ${having[0]!.label}.`]
      : [
          `${where} The Agent has each, as ${listed.format(having.map(({ prefix }) => `/${prefix}${name}`))}.`,
        ]
  })
}

/**
 * The new-Agent flow's choice of Skill packs and, for a Sandbox Agent, Local skills. A local Agent
 * always has its Local skills, so they count towards the shared-name warning there too.
 */
export const useSkillChoice = (place: AgentPlace, engine: AgentEngine) => {
  const listedPacks = useAtomValue(skillPacksAtom)
  const packs = Option.getOrElse(AsyncResult.value(listedPacks), () => [])
  const [lastChosen, setChosen] = useAtom(lastChosenAtom)
  const [lastLocalSkills, setLocalSkills] = useAtom(lastLocalSkillsAtom)
  const offersLocalSkills = Predicate.isTagged(place, "sandbox")
  const localSkills = offersLocalSkills && lastLocalSkills
  const hasLocalSkills = !offersLocalSkills || lastLocalSkills
  const chosenPacks = packs.filter(({ name }) => lastChosen.includes(name))

  const localNamesListed = useAtomValue(
    hasLocalSkills && chosenPacks.length > 0 ? localSkillNamesAtom(engine) : noLocalSkills,
  )

  const localNames = Option.getOrElse(AsyncResult.value(localNamesListed), () => [])

  return {
    listed: listedPacks,
    localNamesListed,
    names: packs.map(({ name }) => name),
    chosen: chosenPacks.map(({ name }) => name),
    setChosen,
    offersLocalSkills,
    localSkills,
    setLocalSkills,
    shared: sharedSkillNames(engine, [
      ...(hasLocalSkills
        ? [
            {
              label: LOCAL_SKILLS_LABEL,
              prefix: localSkills ? `${LOCAL_SKILLS_NAMESPACE}:` : "",
              skills: localNames,
            },
          ]
        : []),
      ...chosenPacks.map(({ name, skills }) => ({
        label: name,
        prefix: `${name}:`,
        skills: skills.map((skill) => skill.name),
      })),
    ]),
  }
}
