import { useAtom, useAtomValue } from "@effect/atom-react"
import { Option, Schema } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Package } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { chip } from "./chips"
import { skillPacksAtom } from "./SkillPacks"

const storageKey = "glass.newAgent.skillPacks"

const decodeChosen = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

const lastChosenAtom = Atom.writable(
  (): ReadonlyArray<string> =>
    Option.getOrElse(decodeChosen(localStorage.getItem(storageKey)), () => []),
  (ctx, chosen: ReadonlyArray<string>) => {
    localStorage.setItem(storageKey, JSON.stringify(chosen))
    ctx.setSelf(chosen)
  },
).pipe(Atom.keepAlive)

export const useSkillPackChoice = () => {
  const listed = useAtomValue(skillPacksAtom)
  const packs = Option.getOrElse(AsyncResult.value(listed), () => [])
  const [lastChosen, setChosen] = useAtom(lastChosenAtom)
  const names = packs.map(({ name }) => name)

  return {
    listed,
    names,
    chosen: names.filter((name) => lastChosen.includes(name)),
    setChosen,
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
