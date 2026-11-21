import { Menu } from "@base-ui/react/menu"
import { Keyboard } from "lucide-react"
import { useRef, useState } from "react"
import { Kbd } from "@/components/ui/kbd"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { IdentityAvatar, useIdentity } from "./ConnectionAvatar"
import { ResourceReadings, ResourceUsagePanel, useResourceUsage } from "./ResourceUsage"
import { shortcutsDialog } from "./ShortcutsDialog"

const menuItem =
  "flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"

export function ConnectionMenu() {
  const identity = useIdentity()
  const trigger = useRef<HTMLButtonElement>(null)
  const [showingUsage, setShowingUsage] = useState(false)
  const returnToAvatar = useRef(true)

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          ref={trigger}
          aria-label={identity.label}
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <IdentityAvatar identity={identity} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="right" align="end" sideOffset={10} className="isolate z-50">
            <Menu.Popup className="w-64 origin-(--transform-origin) rounded-lg bg-popover p-1.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden popup-motion">
              <div className="flex items-center gap-2.5 px-2 py-2">
                <IdentityAvatar identity={identity} className="size-8" />
                <p className="min-w-0 text-xs text-muted-foreground">{identity.label}</p>
              </div>
              <Menu.Separator className="-mx-1.5 my-1 h-px bg-border" />
              <Menu.Item className={menuItem} onClick={() => shortcutsDialog.open(null)}>
                <Keyboard className="size-4 text-muted-foreground" aria-hidden />
                Keyboard shortcuts
                <Kbd className="ml-auto">?</Kbd>
              </Menu.Item>
              <ResourceUsageItem onClick={() => setShowingUsage(true)} />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Popover
        open={showingUsage}
        onOpenChange={(open, details) => {
          returnToAvatar.current = details.reason !== "outside-press"
          setShowingUsage(open)
        }}
      >
        <PopoverContent
          anchor={trigger}
          finalFocus={() => (returnToAvatar.current ? trigger.current : false)}
          side="right"
          align="end"
          sideOffset={10}
          className="w-72 gap-3 p-4"
        >
          <ResourceUsageDetails />
        </PopoverContent>
      </Popover>
    </>
  )
}

function ResourceUsageItem(props: { onClick: () => void }) {
  const usage = useResourceUsage()

  return (
    <Menu.Item className={`${menuItem} text-xs text-muted-foreground`} onClick={props.onClick}>
      <ResourceReadings usage={usage} />
    </Menu.Item>
  )
}

function ResourceUsageDetails() {
  return <ResourceUsagePanel usage={useResourceUsage()} />
}
