import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { AgentHarness, AgentModels, ModelChoice } from "@glass/contracts"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandItemText,
  CommandList,
  type ListFilter,
} from "@ui-sdk/react/command"
import { AsyncResult } from "effect/reactivity"
import { cn } from "cn"
import { Check, LoaderCircle, Search } from "lucide-react"
import { memo, useRef, useState, type RefObject } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { agentModelsAtom } from "./threadsArea"
import { AgentHarnessIcon } from "./AgentHarnessIcon"
import { harnessNames } from "./harnesses"
import { chip, ChipSelect } from "./chips"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"

const DEFAULT_KEY = "\0default"

const toKey = (choice: string | null) => choice ?? DEFAULT_KEY

const fromKey = (key: string) => (key === DEFAULT_KEY ? null : key)

const effortName = (level: string) => level.charAt(0).toUpperCase() + level.slice(1)

const find = (listed: AgentModels, id: string | null) =>
  id === null ? listed.defaultModel : listed.models.find((m) => m.id === id)

export const ModelPicker = memo(function ModelPicker(props: {
  harness: AgentHarness
  placeKey: string
  model: string | null
  effort: string | null
  onChange: (choice: ModelChoice) => void
  harnessChoice?: {
    readonly options: ReadonlyArray<AgentHarness>
    readonly onChange: (harness: AgentHarness) => void
  }
}) {
  const offered = agentModelsAtom(props.harness, props.placeKey)

  const listed = useAtomValue(offered)
  const retry = useAtomRefresh(offered)
  const [open, setOpen] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const { model, effort, harnessChoice } = props

  const { summary, body, efforts } = AsyncResult.builder(listed)
    .onInitial(() => ({
      summary: "Loading models…",
      efforts: [],
      body: (
        <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          Loading models…
        </p>
      ),
    }))
    .onFailure((cause) => ({
      summary: "Couldn't list models",
      efforts: [],
      body: <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: retry }} />,
    }))
    .onSuccess((models) => {
      const current = find(models, model)

      return {
        summary: current?.name ?? model ?? "Default model",
        efforts: current?.efforts ?? [],
        body: (
          <Models
            models={models}
            model={model}
            effort={effort}
            onChange={props.onChange}
            onPick={() => setOpen(false)}
            inputRef={search}
          />
        ),
      }
    })
    .render()

  return (
    <>
      {harnessChoice?.options
        .filter((harness) => harness !== props.harness)
        .map((harness) => (
          <PrefetchModels key={harness} harness={harness} placeKey={props.placeKey} />
        ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn(chip, "text-foreground")}
              aria-label={`${harnessNames[props.harness]}: ${summary}`}
              title={summary}
            />
          }
        >
          <AgentHarnessIcon harness={props.harness} />
          <span className="min-w-0 truncate font-semibold">{summary}</span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          initialFocus={search}
          className="h-96 max-h-(--available-height) w-80 max-w-(--available-width) gap-1 overflow-hidden p-1"
        >
          {harnessChoice !== undefined && (
            <HarnessChoice
              harness={props.harness}
              options={harnessChoice.options}
              onChange={harnessChoice.onChange}
            />
          )}
          <div key={props.harness} className="min-h-0 flex-1 overflow-y-auto">
            {body}
          </div>
        </PopoverContent>
      </Popover>
      {efforts.length > 0 && (
        <ChipSelect
          className="-ml-1"
          label="Effort"
          align="end"
          indicator={false}
          value={toKey(effort)}
          items={[
            { value: DEFAULT_KEY, label: "Default" },
            ...efforts.map((level) => ({ value: level, label: effortName(level) })),
          ]}
          onValueChange={(chosen) => props.onChange({ model, effort: fromKey(chosen) })}
        />
      )}
    </>
  )
})

function PrefetchModels(props: { harness: AgentHarness; placeKey: string }) {
  useAtomValue(agentModelsAtom(props.harness, props.placeKey))

  return null
}

function Models({
  inputRef,
  ...props
}: {
  models: AgentModels
  model: string | null
  effort: string | null
  onChange: (choice: ModelChoice) => void
  onPick: () => void
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const { defaultModel, models } = props.models
  const { model, effort } = props
  const current = find(props.models, model)
  const currentKey = toKey(model)

  const rows: Array<ModelRow> = []

  if (defaultModel !== null)
    rows.push({
      value: DEFAULT_KEY,
      label: "Default",
      detail: defaultModel.name,
      keywords: [defaultModel.name],
    })

  for (const { id, name } of models) rows.push({ value: id, label: name, keywords: [id] })

  if (model !== null && current === undefined)
    rows.push({ value: model, label: model, keywords: [] })

  const choose = (chosen: string) => {
    if (chosen !== currentKey) {
      const next = fromKey(chosen)
      const kept = effort !== null && (find(props.models, next)?.efforts ?? []).includes(effort)
      props.onChange({ model: next, effort: kept ? effort : null })
    }

    props.onPick()
  }

  return (
    <Command
      defaultValue={currentKey}
      onAction={choose}
      filter={everyWord}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center gap-2 border-b px-2">
        <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <CommandInput
          ref={inputRef}
          aria-label="Search models"
          placeholder="Search models"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      <CommandEmpty className="px-2 py-1.5 text-xs text-muted-foreground">
        No models match.
      </CommandEmpty>
      <CommandList className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1 [scrollbar-gutter:stable]">
        {rows.map((row) => {
          const isCurrent = row.value === currentKey

          return (
            <CommandItem
              key={row.value}
              value={row.value}
              label={row.label}
              keywords={row.keywords}
              aria-current={isCurrent || undefined}
              className="flex cursor-default items-center gap-1.5 rounded-md px-2 py-1.5 text-xs outline-none aria-current:font-medium data-highlighted:bg-accent data-highlighted:text-accent-foreground"
            >
              <CommandItemText className="min-w-0 flex-1 truncate" />
              {row.detail !== undefined && (
                <span className="shrink-0 text-muted-foreground">{row.detail}</span>
              )}
              {isCurrent && <Check aria-hidden className="size-3.5 shrink-0" />}
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}

interface ModelRow {
  readonly value: string
  readonly label: string
  readonly detail?: string
  readonly keywords: Array<string>
}

const everyWord: ListFilter = (item, query) => {
  const text = [item.label, ...(item.keywords ?? [])].join(" ").toLowerCase()

  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word))
}

function HarnessChoice(props: {
  harness: AgentHarness
  options: ReadonlyArray<AgentHarness>
  onChange: (harness: AgentHarness) => void
}) {
  return (
    <ToggleGroup
      aria-label="Agent harness"
      variant="outline"
      size="sm"
      spacing={0}
      value={[props.harness]}
      onValueChange={([pressed]) => {
        const chosen = props.options.find((harness) => harness === pressed)

        if (chosen !== undefined && chosen !== props.harness) props.onChange(chosen)
      }}
      className="m-1 w-auto shrink-0 *:flex-1"
    >
      {props.options.map((harness) => (
        <ToggleGroupItem
          key={harness}
          value={harness}
          className="gap-1.5 text-xs font-normal hover:bg-accent hover:text-accent-foreground aria-pressed:bg-accent"
        >
          <AgentHarnessIcon harness={harness} />
          {harnessNames[harness]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
