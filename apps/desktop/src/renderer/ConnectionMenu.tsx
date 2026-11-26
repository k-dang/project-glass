import { Menu } from "@base-ui/react/menu"
import { Keyboard } from "lucide-react"
import { Kbd } from "@/components/ui/kbd"
import { IdentityAvatar, useIdentity } from "./Identity"
import { shortcutsDialog } from "./ShortcutsDialog"

export function ConnectionMenu() {
  const identity = useIdentity()

  return (
    <Menu.Root>
      <Menu.Trigger
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
            <Menu.Item
              className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
              onClick={() => shortcutsDialog.open(null)}
            >
              <Keyboard className="size-4 text-muted-foreground" aria-hidden />
              Keyboard shortcuts
              <Kbd className="ml-auto">?</Kbd>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
