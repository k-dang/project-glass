import { useId } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

export function SwitchSetting(props: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}) {
  const id = useId()

  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
        aria-describedby={`${id}-description`}
        className="-mt-0.5"
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{props.label}</Label>
        <p id={`${id}-description`} className="text-sm text-muted-foreground">
          {props.description}
        </p>
      </div>
    </div>
  )
}
