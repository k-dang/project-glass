import { type ConversationPlace, type ConversationSkillPack, shortSha } from "@glass/contracts"
import { cn } from "cn"
import { FolderGit2, GitBranch, Package, PanelTop } from "lucide-react"
import { createContext, type ReactNode, use, useState } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ConversationsPanelToggle } from "./Conversations"
import { placeIcons, placeNames } from "./conversationsArea"
import { LOCAL_SKILLS_LABEL } from "./skillChoice"

const fact =
  "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"

// An action takes you to another view, so the popover leaves at once instead of
// fading out over the view it opened.
const CloseInstantly = createContext<() => void>(() => {})

export function ConversationHeader(props: {
  heading: ReactNode
  place: ConversationPlace | null
  repository?: string | undefined
  branch?: string | undefined
  baseBranch: string | null
  skillPacks?: ReadonlyArray<ConversationSkillPack> | undefined
  localSkills?: boolean | undefined
  children?: ReactNode
}) {
  const [instant, setInstant] = useState(false)
  const PlaceIcon = props.place === null ? null : placeIcons[props.place._tag]

  const skillSources = [
    ...(props.skillPacks ?? []).map(({ name, commit }) => `${name} @ ${shortSha(commit)}`),
    ...(props.localSkills === true ? [LOCAL_SKILLS_LABEL] : []),
  ]

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-sm">
      <ConversationsPanelToggle />
      <div className="flex min-w-0 flex-1 items-center gap-2">{props.heading}</div>
      {PlaceIcon !== null && props.place !== null && (
        <Popover onOpenChange={(open) => open && setInstant(false)}>
          <PopoverTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Details" />}>
            <PanelTop aria-hidden />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className={cn("w-64 gap-0 p-1", instant && "data-ending-style:transition-none")}
          >
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
            {skillSources.length > 0 && (
              <div className={fact}>
                <Package aria-hidden />
                <span className="truncate">{skillSources.join(" · ")}</span>
              </div>
            )}
            <CloseInstantly value={() => setInstant(true)}>{props.children}</CloseInstantly>
          </PopoverContent>
        </Popover>
      )}
    </header>
  )
}

export function ConversationHeaderAction(props: { onSelect: () => void; children: ReactNode }) {
  const closeInstantly = use(CloseInstantly)

  return (
    <PopoverClose
      onClick={() => {
        closeInstantly()
        props.onSelect()
      }}
      className={cn(fact, "text-left outline-none hover:bg-accent focus-visible:bg-accent")}
    >
      {props.children}
    </PopoverClose>
  )
}
