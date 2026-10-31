import { type AgentEngine, engineCapabilities, type PermissionMode } from "@glass/contracts"
import { ShieldCheck } from "lucide-react"
import { permissionModeNames } from "./agentsArea"
import { ChipSelect, selectorSlot } from "./chips"

/** Shown only for an agent program that takes Permission modes. */
export function PermissionModePicker(props: {
  engine: AgentEngine
  permissionMode: PermissionMode | null
  onChange: (permissionMode: PermissionMode) => void
}) {
  const modes = engineCapabilities[props.engine].permissionModes

  return (
    <div className={selectorSlot}>
      {modes.length > 0 && (
        <ChipSelect
          className="w-full min-w-0"
          label="Permission mode"
          icon={<ShieldCheck aria-hidden />}
          value={props.permissionMode}
          items={modes.map((mode) => ({ value: mode, label: permissionModeNames[mode] }))}
          onValueChange={props.onChange}
        />
      )}
    </div>
  )
}
