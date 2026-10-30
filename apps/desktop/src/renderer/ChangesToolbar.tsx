import type { DiffIndicators } from "@pierre/diffs"
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  FolderTree,
  Maximize2,
  Minimize2,
  Route,
  Rows2,
  Settings2,
} from "lucide-react"
import { type ReactNode, useId } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { Display } from "./ChangedFilesView"
import type { CollapseChoices } from "./changesView"
import { plural } from "./plural"
import type { ChangesOrder } from "./reviewsArea"

const indicatorStyles: ReadonlyArray<{ readonly value: DiffIndicators; readonly label: string }> = [
  { value: "bars", label: "Bars" },
  { value: "classic", label: "+ / −" },
  { value: "none", label: "None" },
]

function DisplaySwitch(props: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const id = useId()

  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <Label htmlFor={id} className="font-normal">
        {props.label}
      </Label>
      <Checkbox id={id} checked={props.checked} onCheckedChange={props.onCheckedChange} />
    </div>
  )
}

export function ChangesToolbar(props: {
  filePanelToggle: ReactNode
  fileCount: number
  viewedCount: number | null
  display: Display
  onDisplayChange: (display: Display) => void
  all: CollapseChoices["all"]
  onAllChange: (all: CollapseChoices["all"]) => void
  tourOrder: {
    readonly current: ChangesOrder
    readonly onChange: (order: ChangesOrder) => void
  } | null
  fullScreen: {
    readonly on: boolean
    readonly onChange: (on: boolean) => void
  } | null
  agentReview: ReactNode
}) {
  const { display, onDisplayChange, tourOrder, fullScreen } = props
  const set = (change: Partial<Display>) => onDisplayChange({ ...display, ...change })
  const collapsing = props.all !== "collapsed"
  const allLabel = collapsing ? "Collapse all files" : "Expand all files"
  const split = display.diffStyle === "split"
  const styleLabel = split ? "Show unified diffs" : "Show split diffs"

  return (
    <div className="flex items-center gap-1 px-6 py-2 text-sm text-muted-foreground">
      {props.filePanelToggle}
      <span>{plural(props.fileCount, "file")} changed</span>
      {tourOrder !== null && (
        <ToggleGroup
          aria-label="File order"
          variant="outline"
          size="sm"
          spacing={0}
          className="ml-3"
          value={[tourOrder.current]}
          onValueChange={([chosen]) => {
            if (chosen === "path" || chosen === "tour") tourOrder.onChange(chosen)
          }}
        >
          <ToggleGroupItem value="path">
            <FolderTree aria-hidden />
            Path
          </ToggleGroupItem>
          <ToggleGroupItem value="tour">
            <Route aria-hidden />
            Tour
          </ToggleGroupItem>
        </ToggleGroup>
      )}
      <span className="flex-1" />
      {props.agentReview}
      {props.viewedCount !== null && (
        <span className="mr-2 tabular-nums" aria-live="polite">
          {props.viewedCount}/{props.fileCount} viewed
        </span>
      )}
      {fullScreen !== null && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Full screen"
          aria-pressed={fullScreen.on}
          aria-keyshortcuts="F"
          title={fullScreen.on ? "Exit full screen (F or Esc)" : "Full screen (F)"}
          onClick={() => fullScreen.onChange(!fullScreen.on)}
        >
          {fullScreen.on ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={allLabel}
        title={allLabel}
        onClick={() => props.onAllChange(collapsing ? "collapsed" : "expanded")}
      >
        {collapsing ? <ChevronsDownUp aria-hidden /> : <ChevronsUpDown aria-hidden />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={styleLabel}
        title={styleLabel}
        onClick={() => set({ diffStyle: split ? "unified" : "split" })}
      >
        {split ? <Rows2 aria-hidden /> : <Columns2 aria-hidden />}
      </Button>
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Display settings" title="Display" />
          }
        >
          <Settings2 aria-hidden />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 text-sm">
          <DisplaySwitch
            label="Word wrap"
            checked={display.wrap}
            onCheckedChange={(wrap) => set({ wrap })}
          />
          <DisplaySwitch
            label="Line numbers"
            checked={display.lineNumbers}
            onCheckedChange={(lineNumbers) => set({ lineNumbers })}
          />
          <DisplaySwitch
            label="Backgrounds"
            checked={display.backgrounds}
            onCheckedChange={(backgrounds) => set({ backgrounds })}
          />
          <div className="flex flex-col gap-1.5 pt-2">
            <span>Change markers</span>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[display.indicators]}
              onValueChange={([indicators]) => {
                const style = indicatorStyles.find(({ value }) => value === indicators)

                if (style !== undefined) set({ indicators: style.value })
              }}
              aria-label="Change markers"
            >
              {indicatorStyles.map(({ value, label }) => (
                <ToggleGroupItem key={value} value={value} className="flex-1">
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
