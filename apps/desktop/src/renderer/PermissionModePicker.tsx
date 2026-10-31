import { type AgentEngine, engineCapabilities, type PermissionMode } from "@glass/contracts"
import { cn } from "cn"
import { Lock, type LucideIcon, PencilLine, ShieldOff, Sparkles } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { permissionModeNames } from "./agentsArea"
import { chip } from "./chips"

const icons: Record<PermissionMode, LucideIcon> = {
  default: Lock,
  acceptEdits: PencilLine,
  auto: Sparkles,
  bypassPermissions: ShieldOff,
}

const descriptions: Record<PermissionMode, string> = {
  default: "Asks before edits and commands.",
  acceptEdits: "Edits files without asking; still asks before commands.",
  auto: "Approves routine actions; still asks for risky ones.",
  bypassPermissions: "Never asks. Only for a sandbox you can throw away.",
}

/** Shown only for an agent program that takes Permission modes. */
export function PermissionModePicker(props: {
  engine: AgentEngine
  permissionMode: PermissionMode | null
  onChange: (permissionMode: PermissionMode) => void
}) {
  const modes = engineCapabilities[props.engine].permissionModes

  if (modes.length === 0) return null

  const { permissionMode } = props
  const Icon = permissionMode === null ? null : icons[permissionMode]
  const name = permissionMode === null ? undefined : permissionModeNames[permissionMode]

  return (
    <Select
      value={permissionMode}
      onValueChange={(chosen) => {
        if (chosen !== null) props.onChange(chosen)
      }}
    >
      <SelectTrigger
        aria-label="Permission mode"
        title={name}
        size="sm"
        indicator={false}
        className={cn(chip, permissionMode === "bypassPermissions" && "text-destructive")}
      >
        <SelectValue>
          {Icon !== null && <Icon aria-hidden />}
          <span className="sr-only">{name}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent side="top" align="end" alignItemWithTrigger={false} className="w-72 p-1">
        {modes.map((mode) => {
          const ModeIcon = icons[mode]

          return (
            <SelectItem
              key={mode}
              value={mode}
              aria-label={permissionModeNames[mode]}
              aria-description={descriptions[mode]}
              className="items-start py-1.5 text-xs *:first:whitespace-normal"
            >
              <ModeIcon aria-hidden className="mt-0.5 size-3.5" />
              <span className="flex flex-col">
                {permissionModeNames[mode]}
                <span className="text-muted-foreground">{descriptions[mode]}</span>
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
