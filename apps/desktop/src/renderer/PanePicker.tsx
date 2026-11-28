import { cn } from "cn"
import type { LucideIcon } from "lucide-react"
import { Kbd } from "@/components/ui/kbd"
import { SidePanel, threadPaneWidthAtom } from "./SidePanel"
import { actionRow } from "./ThreadFrame"
import { useShortcuts } from "./useShortcuts"

export interface PaneChoice {
  readonly id: string
  readonly label: string
  readonly icon: LucideIcon
  readonly key?: string
  readonly open: () => void
}

const focusOnMount = (element: HTMLButtonElement | null) => element?.focus()

export function PanePicker(props: { choices: ReadonlyArray<PaneChoice>; onClose: () => void }) {
  useShortcuts(
    props.choices.flatMap(({ key, open }) => (key === undefined ? [] : [{ key, run: open }])),
  )

  return (
    <SidePanel
      name="Pane picker"
      heading="Open a pane"
      width={threadPaneWidthAtom}
      onClose={props.onClose}
    >
      <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-3">
        {props.choices.map(({ id, label, icon: Icon, key, open }, index) => (
          <li key={id}>
            <button
              ref={index === 0 ? focusOnMount : undefined}
              type="button"
              onClick={open}
              aria-keyshortcuts={key?.toUpperCase()}
              className={cn(
                actionRow,
                "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm",
              )}
            >
              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {key !== undefined && <Kbd>{key.toUpperCase()}</Kbd>}
            </button>
          </li>
        ))}
      </ul>
    </SidePanel>
  )
}
