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
  readonly claudeCodePrefix: string
  readonly skills: ReadonlyArray<string>
}

const listed = new Intl.ListFormat("en", { type: "conjunction" })

/** pi keeps the first skill of a name, and Local skills come first (`skillsOf` in the server). */
const sharedSkillNames = (engine: AgentEngine, sources: ReadonlyArray<ChosenSource>) => {
  const names = [...new Set(sources.flatMap(({ skills }) => skills))].toSorted()

  return names.flatMap((name) => {
    const having = sources.filter(({ skills }) => skills.includes(name))

    if (having.length < 2) return []

    const where = `${name} is in ${listed.format(having.map(({ label }) => label))}.`

    return engine === "pi"
      ? [`${where} The Agent uses the one in ${having[0]!.label}.`]
      : [
          `${where} The Agent has each, as ${listed.format(having.map(({ claudeCodePrefix }) => `/${claudeCodePrefix}${name}`))}.`,
        ]
  })
}

export const useSkillChoice = (place: AgentPlace, engine: AgentEngine) => {
  const listedPacks = useAtomValue(skillPacksAtom)
  const packs = Option.getOrElse(AsyncResult.value(listedPacks), () => [])
  const [lastChosen, setChosen] = useAtom(lastChosenAtom)
  const [lastLocalSkills, setLocalSkills] = useAtom(lastLocalSkillsAtom)
  const offersLocalSkills = Predicate.isTagged(place, "sandbox")
  const sendsLocalSkills = offersLocalSkills && lastLocalSkills
  const agentHasLocalSkills = !offersLocalSkills || lastLocalSkills
  const chosenPacks = packs.filter(({ name }) => lastChosen.includes(name))

  const localNamesListed = useAtomValue(
    agentHasLocalSkills && chosenPacks.length > 0 ? localSkillNamesAtom(engine) : noLocalSkills,
  )

  const localNames = Option.getOrElse(AsyncResult.value(localNamesListed), () => [])

  return {
    listed: listedPacks,
    localNamesListed,
    names: packs.map(({ name }) => name),
    chosen: chosenPacks.map(({ name }) => name),
    setChosen,
    offersLocalSkills,
    sendsLocalSkills,
    setLocalSkills,
    shared: sharedSkillNames(engine, [
      ...(agentHasLocalSkills
        ? [
            {
              label: LOCAL_SKILLS_LABEL,
              claudeCodePrefix: sendsLocalSkills ? `${LOCAL_SKILLS_NAMESPACE}:` : "",
              skills: localNames,
            },
          ]
        : []),
      ...chosenPacks.map(({ name, skills }) => ({
        label: name,
        claudeCodePrefix: `${name}:`,
        skills: skills.map((skill) => skill.name),
      })),
    ]),
  }
}
