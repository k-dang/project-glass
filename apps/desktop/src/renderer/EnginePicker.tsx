import { AgentHarness, type EngineSettings, type PiModel } from "@glass/contracts"
import { cn } from "cn"
import { useId } from "react"
import { Input } from "@/components/ui/input"
import { harnessNames } from "./harnesses"

const hasModel = (harness: AgentHarness, models: EngineSettings["models"]) =>
  harness === "claude-code"
    ? models["claude-code"] !== ""
    : models[harness].provider !== "" && models[harness].modelId !== ""

export const missingModel = (settings: EngineSettings) =>
  AgentHarness.literals.find((harness) => !hasModel(harness, settings.models))

export function EnginePicker(props: {
  legend: string
  description: string
  value: EngineSettings
  onChange: (value: EngineSettings) => void
  onCommit: (value: EngineSettings) => void
}) {
  const id = useId()
  const { harness, models } = props.value

  const setModels = (changed: Partial<EngineSettings["models"]>) =>
    props.onChange({ ...props.value, models: { ...models, ...changed } })

  return (
    <fieldset aria-describedby={`${id}-description`} className="flex flex-col gap-3">
      <legend className="mb-1.5 text-sm font-medium">{props.legend}</legend>
      <p id={`${id}-description`} className="text-sm text-muted-foreground">
        {props.description}
      </p>
      <div className="flex w-fit flex-wrap gap-0.5 rounded-lg border bg-muted p-0.5">
        {AgentHarness.literals.map((option) => (
          <label key={option} className="relative">
            <input
              type="radio"
              name={id}
              value={option}
              checked={harness === option}
              onChange={() => {
                const next = { ...props.value, harness: option }
                props.onChange(next)
                props.onCommit(next)
              }}
              className="peer sr-only"
            />
            <span className="block cursor-pointer rounded-md px-3.5 py-1 text-sm font-medium text-muted-foreground peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm peer-checked:ring-1 peer-checked:ring-border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-ring">
              {harnessNames[option]}
              {!hasModel(option, models) && (
                <>
                  <span aria-hidden className="ml-1 text-destructive">
                    •
                  </span>
                  <span className="sr-only"> (needs a model)</span>
                </>
              )}
            </span>
          </label>
        ))}
      </div>
      <div
        onBlur={() => props.onCommit(props.value)}
        className={cn(
          "grid gap-2.5 rounded-lg border bg-card p-3",
          harness !== "claude-code" && "grid-cols-[minmax(6rem,10rem)_1fr] max-sm:grid-cols-1",
        )}
      >
        {harness === "claude-code" ? (
          <ModelInput
            label="Model"
            name="Claude Code model"
            value={models["claude-code"]}
            onChange={(model) => setModels({ "claude-code": model })}
          />
        ) : (
          <PiModelInputs value={models.pi} onChange={(model) => setModels({ pi: model })} />
        )}
      </div>
    </fieldset>
  )
}

function PiModelInputs(props: { value: PiModel; onChange: (value: PiModel) => void }) {
  const label = harnessNames.pi

  return (
    <>
      <ModelInput
        label="Provider"
        name={`${label} provider`}
        value={props.value.provider}
        onChange={(provider) => props.onChange({ ...props.value, provider })}
      />
      <ModelInput
        label="Model"
        name={`${label} model`}
        value={props.value.modelId}
        onChange={(modelId) => props.onChange({ ...props.value, modelId })}
      />
    </>
  )
}

function ModelInput(props: {
  label: string
  name: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <Input
        aria-label={props.name}
        value={props.value}
        aria-invalid={props.value === "" || undefined}
        onChange={(event) => props.onChange(event.target.value.trim())}
        spellCheck={false}
        className="h-7 font-mono text-xs md:text-xs"
      />
    </label>
  )
}
