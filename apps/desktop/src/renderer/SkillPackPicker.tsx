import { useAtom, useAtomValue } from "@effect/atom-react"
import { type AgentEngine, type AgentPlace, LOCAL_SKILLS_NAMESPACE } from "@glass/contracts"
import { Option, Predicate, Schema } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Package, TriangleAlert } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "cn"
import { Backend, backendRuntime } from "./backend"
import { chip } from "./chips"
import { skillPacksAtom } from "./SkillPacks"

const storageKey = "glass.newAgent.skillPacks"

const localSkillsKey = "glass.newAgent.localSkills"

const LOCAL_SKILLS_LABEL = "Local skills"

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

const unread = Atom.make(AsyncResult.success<ReadonlyArray<string>>([]))

interface ChosenSource {
  readonly label: string
  readonly namespace: string
  readonly skills: ReadonlyArray<string>
}

const listed = new Intl.ListFormat("en", { type: "conjunction" })

/**
 * One line per skill name that more than one chosen source has, saying which the Agent uses.
 * Local skills come first because Glass sends them first, so pi keeps their skill of a name.
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
          `${where} The Agent has each, as ${listed.format(having.map(({ namespace }) => `/${namespace}:${name}`))}.`,
        ]
  })
}

/** The new-Agent flow's choice of Skill packs and, for a Sandbox Agent, Local skills. */
export const useSkillPackChoice = (place: AgentPlace, engine: AgentEngine) => {
  const listedPacks = useAtomValue(skillPacksAtom)
  const packs = Option.getOrElse(AsyncResult.value(listedPacks), () => [])
  const [lastChosen, setChosen] = useAtom(lastChosenAtom)
  const [lastLocalSkills, setLocalSkills] = useAtom(lastLocalSkillsAtom)
  const offersLocalSkills = Predicate.isTagged(place, "sandbox")
  const localSkills = offersLocalSkills && lastLocalSkills
  const chosenPacks = packs.filter(({ name }) => lastChosen.includes(name))

  const localNames = Option.getOrElse(
    AsyncResult.value(useAtomValue(localSkills ? localSkillNamesAtom(engine) : unread)),
    () => [],
  )

  return {
    listed: listedPacks,
    names: packs.map(({ name }) => name),
    chosen: chosenPacks.map(({ name }) => name),
    setChosen,
    offersLocalSkills,
    localSkills,
    setLocalSkills,
    shared: sharedSkillNames(engine, [
      ...(localSkills
        ? [{ label: LOCAL_SKILLS_LABEL, namespace: LOCAL_SKILLS_NAMESPACE, skills: localNames }]
        : []),
      ...chosenPacks.map(({ name, skills }) => ({
        label: name,
        namespace: name,
        skills: skills.map((skill) => skill.name),
      })),
    ]),
  }
}

export function SkillPackPicker(props: {
  names: ReadonlyArray<string>
  chosen: ReadonlyArray<string>
  onChange: (chosen: ReadonlyArray<string>) => void
}) {
  if (props.names.length === 0) return null

  const label = props.chosen.length === 0 ? "No Skill packs" : props.chosen.join(", ")

  return (
    <Select
      multiple
      value={[...props.chosen]}
      onValueChange={(chosen) =>
        props.onChange(props.names.filter((name) => chosen.includes(name)))
      }
    >
      <SelectTrigger aria-label="Skill packs" title={label} size="sm" className={chip}>
        <Package aria-hidden />
        <SelectValue className="min-w-0">
          <span className="truncate">{label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        side="top"
        align="start"
        alignItemWithTrigger={false}
        className="w-auto max-w-80 min-w-48 p-1"
      >
        {props.names.map((name) => (
          <SelectItem key={name} value={name} className="py-1.5 text-xs">
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function LocalSkillsToggle(props: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className={cn(chip, "flex cursor-pointer items-center rounded-md")}>
      <Checkbox checked={props.checked} onCheckedChange={props.onCheckedChange} />
      {LOCAL_SKILLS_LABEL}
    </label>
  )
}

export function SharedSkillNames(props: { shared: ReadonlyArray<string> }) {
  if (props.shared.length === 0) return null

  return (
    <ul
      aria-label="Shared skill names"
      className="flex basis-full flex-col gap-0.5 px-2 text-xs text-muted-foreground"
    >
      {props.shared.map((line) => (
        <li key={line} className="flex items-start gap-1.5">
          <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0 text-amber-500" />
          {line}
        </li>
      ))}
    </ul>
  )
}
