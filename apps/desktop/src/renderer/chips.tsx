import type { ReactNode } from "react"
import { cn } from "cn"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const chip =
  "h-7 w-auto max-w-64 gap-1.5 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent"

/** Reserve label-independent slots; zero width lets narrow fieldsets shrink below their contents. */
export const selectorSlot = "flex w-0 min-w-0 shrink basis-36"

interface ChipItem<Value extends string> {
  readonly value: Value
  readonly label: string
  readonly title?: string | undefined
}

/** The key the action item has, which no listed value can take. */
const ACTION = "\0action"

export function ChipSelect<Value extends string>(props: {
  label: string
  icon: ReactNode
  value: Value | null
  items: ReadonlyArray<ChipItem<Value>>
  onValueChange: (value: Value) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  action?: { label: string; icon: ReactNode; onSelect: () => void; disabled: boolean } | undefined
}) {
  const selected = props.items.find((item) => item.value === props.value)

  return (
    <Select
      value={props.value}
      items={props.items}
      disabled={props.disabled}
      onValueChange={(chosen) => {
        if (chosen === ACTION) props.action?.onSelect()
        else if (chosen !== null) props.onValueChange(chosen)
      }}
    >
      <SelectTrigger
        aria-label={props.label}
        title={selected?.label ?? props.placeholder}
        size="sm"
        className={cn(chip, props.className)}
      >
        {props.icon}
        <SelectValue className="min-w-0" placeholder={props.placeholder}>
          <span className="truncate">{selected?.label ?? props.placeholder}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        side="top"
        align="start"
        alignItemWithTrigger={false}
        className="w-auto max-w-80 min-w-48 p-1"
      >
        {props.items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            title={item.title}
            className="py-1.5 text-xs"
          >
            {item.label}
          </SelectItem>
        ))}
        {props.action !== undefined && (
          <>
            {props.items.length > 0 && <SelectSeparator />}
            <SelectItem
              value={ACTION}
              disabled={props.action.disabled}
              className="py-1.5 text-xs text-muted-foreground"
            >
              {props.action.icon}
              {props.action.label}
            </SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  )
}
