import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AgentEngine, type AgentModels, type ModelChoice } from "@glass/contracts"
import { AsyncResult } from "effect/reactivity"
import { ChevronDown, Gauge, LoaderCircle } from "lucide-react"
import { memo, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { agentModelsAtom, engineGlyphs, engineNames } from "./agentsArea"
import { chip, ChipSelect } from "./chips"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"

const DEFAULT_KEY = ""

const toKey = (choice: string | null) => choice ?? DEFAULT_KEY

const fromKey = (key: string) => (key === DEFAULT_KEY ? null : key)

const effortName = (level: string) => level.charAt(0).toUpperCase() + level.slice(1)

const find = (listed: AgentModels, id: string | null) =>
  id === null ? listed.defaultModel : listed.models.find((m) => m.id === id)

export const ModelPicker = memo(function ModelPicker(props: {
  engine: AgentEngine
  placeKey: string
  model: string | null
  effort: string | null
  onChange: (choice: ModelChoice) => void
  onEngineChange?: (engine: AgentEngine) => void
}) {
  const offered = agentModelsAtom(props.engine, props.placeKey)

  const listed = useAtomValue(offered)
  const retry = useAtomRefresh(offered)
  const [open, setOpen] = useState(false)
  const { model, effort, onEngineChange } = props

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
          />
        ),
      }
    })
    .render()

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={chip}
              aria-label={`${engineNames[props.engine]}: ${summary}`}
            />
          }
        >
          <span aria-hidden className="w-3.5 text-center">
            {engineGlyphs[props.engine]}
          </span>
          <span className="truncate">{summary}</span>
          <ChevronDown aria-hidden className="opacity-60" />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-auto max-w-80 min-w-64 gap-1 p-1">
          {onEngineChange !== undefined && (
            <RequiredChoice
              label="Agent program"
              value={props.engine}
              onChange={onEngineChange}
              items={AgentEngine.literals.map((engine) => ({
                value: engine,
                label: (
                  <>
                    <span aria-hidden>{engineGlyphs[engine]}</span>
                    {engineNames[engine]}
                  </>
                ),
              }))}
            />
          )}
          {body}
        </PopoverContent>
      </Popover>
      {efforts.length > 0 && (
        <ChipSelect
          label="Effort"
          icon={<Gauge aria-hidden />}
          value={toKey(effort)}
          items={[
            { value: DEFAULT_KEY, label: "Default effort" },
            ...efforts.map((level) => ({ value: level, label: effortName(level) })),
          ]}
          onValueChange={(chosen) => props.onChange({ model, effort: fromKey(chosen) })}
        />
      )}
    </>
  )
})

function Models(props: {
  models: AgentModels
  model: string | null
  effort: string | null
  onChange: (choice: ModelChoice) => void
  onPick: () => void
}) {
  const { defaultModel, models } = props.models
  const { model, effort } = props
  const current = find(props.models, model)

  const modelItems: Array<{ value: string; label: ReactNode }> = []

  if (defaultModel !== null)
    modelItems.push({
      value: DEFAULT_KEY,
      label: (
        <>
          Default
          <span className="ml-auto text-muted-foreground">{defaultModel.name}</span>
        </>
      ),
    })

  for (const { id, name } of models) modelItems.push({ value: id, label: name })

  const unlisted = model !== null && current === undefined

  if (unlisted) modelItems.push({ value: model, label: model })

  return (
    <RequiredChoice
      label="Model"
      heading
      orientation="vertical"
      value={toKey(model)}
      items={modelItems}
      onPick={props.onPick}
      onChange={(chosen) => {
        const next = fromKey(chosen)
        const kept = effort !== null && (find(props.models, next)?.efforts ?? []).includes(effort)
        props.onChange({ model: next, effort: kept ? effort : null })
      }}
    />
  )
}

function RequiredChoice<Value extends string>(props: {
  label: string
  heading?: boolean
  value: Value
  items: ReadonlyArray<{ value: Value; label: ReactNode }>
  onChange: (value: Value) => void
  onPick?: () => void
  orientation?: "horizontal" | "vertical"
}) {
  const stacked = props.orientation === "vertical"

  return (
    <>
      {props.heading === true && (
        <p aria-hidden className="px-2 pt-1.5 text-xs font-medium text-muted-foreground">
          {props.label}
        </p>
      )}
      <ToggleGroup
        aria-label={props.label}
        orientation={stacked ? "vertical" : "horizontal"}
        variant={stacked ? "default" : "outline"}
        size="sm"
        spacing={stacked ? 1 : 0}
        value={[props.value]}
        onValueChange={([pressed]) => {
          const chosen = props.items.find((item) => item.value === (pressed ?? props.value))

          if (chosen === undefined) return

          if (chosen.value !== props.value) props.onChange(chosen.value)

          props.onPick?.()
        }}
        className={stacked ? "w-auto gap-0 *:justify-start" : "m-1 w-auto *:flex-1"}
      >
        {props.items.map((item) => (
          <ToggleGroupItem
            key={item.value}
            value={item.value}
            className="gap-1.5 text-xs font-normal"
          >
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </>
  )
}
