import type { AgentPlace } from "@glass/contracts"
import { cn } from "cn"
import { FolderGit2, GitBranch, PanelTop } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { placeIcons, placeNames } from "./agentsArea"

const fact =
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"

export function AgentHeader(props: {
  heading: ReactNode
  place: AgentPlace
  repository?: string | undefined
  branch?: string | undefined
  baseBranch: string | null
  children?: ReactNode
}) {
  const PlaceIcon = placeIcons[props.place._tag]

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-6 text-sm">
      {props.heading}
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Details" className="ml-auto" />
          }
        >
          <PanelTop aria-hidden />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 gap-0 p-1">
          <div className={fact}>
            <PlaceIcon aria-hidden />
            {placeNames[props.place._tag]}
          </div>
          <div className={fact}>
            <FolderGit2 aria-hidden />
            <span className="truncate">{props.repository ?? "No repository"}</span>
          </div>
          {props.baseBranch !== null && (
            <>
              <div className="-mx-1 my-1 border-t" />
              <div className={fact}>
                <GitBranch aria-hidden />
                {props.branch !== undefined && <span className="truncate">{props.branch}</span>}
                <span className="ml-auto shrink-0 text-muted-foreground">
                  from {props.baseBranch}
                </span>
              </div>
            </>
          )}
          {props.children}
        </PopoverContent>
      </Popover>
    </header>
  )
}

export function AgentHeaderAction(props: { onSelect: () => void; children: ReactNode }) {
  return (
    <PopoverClose
      onClick={props.onSelect}
      className={cn(fact, "text-left outline-none hover:bg-accent focus-visible:bg-accent")}
    >
      {props.children}
    </PopoverClose>
  )
}
