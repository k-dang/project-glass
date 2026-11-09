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
import { chip } from "./chips"
import { LOCAL_SKILLS_LABEL } from "./skillChoice"

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
