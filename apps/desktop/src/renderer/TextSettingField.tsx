import { cn } from "cn"
import { useId } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export interface TextSettingCopy {
  readonly title: string
  readonly description: string
  readonly footnote: string
  readonly defaultValue: string
}

export function TextSettingField(props: {
  copy: TextSettingCopy
  value: string
  separated?: boolean | undefined
  onChange: (value: string) => void
  onCommit: (value: string) => void
}) {
  const id = useId()
  const { title, description, footnote, defaultValue } = props.copy
  const text = props.value.trim()
  const isDefault = text === defaultValue

  return (
    <div
      className={cn("flex flex-col gap-2.5", props.separated && "border-t border-dashed pt-5")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) props.onCommit(props.value)
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 id={`${id}-heading`} className="font-semibold">
            {title}
          </h3>
          <p id={`${id}-description`} className="text-sm text-muted-foreground">
            {description}
          </p>
        </div>
        <Badge variant={isDefault ? "outline" : "secondary"}>
          {isDefault ? "Default" : "Custom"}
        </Badge>
      </div>
      <Textarea
        value={props.value}
        rows={7}
        aria-labelledby={`${id}-heading`}
        aria-describedby={`${id}-description ${id}-footnote`}
        aria-invalid={text === "" || undefined}
        onChange={(event) => props.onChange(event.target.value)}
        className="font-mono text-xs leading-relaxed md:text-xs"
      />
      <div className="flex items-start justify-between gap-3">
        <p id={`${id}-footnote`} className="text-sm text-muted-foreground">
          {footnote}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isDefault}
          onClick={() => {
            props.onChange(defaultValue)
            props.onCommit(defaultValue)
          }}
        >
          Restore default
        </Button>
      </div>
    </div>
  )
}
