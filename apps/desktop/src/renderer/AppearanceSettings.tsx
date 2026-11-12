import { type ColorScheme, ColorSchemePreference, Theme } from "@glass/contracts"
import { Moon, Sun } from "lucide-react"
import { type ReactNode, useId } from "react"
import { SettingsSection } from "./SettingsSection"
import { useAppearance } from "./theme"

const colorSchemeLabels = {
  system: "System",
  light: "Light",
  dark: "Dark",
} satisfies Record<ColorSchemePreference, string>

const themeDetails = {
  glass: { label: "Glass", description: "Neutral and familiar." },
  charcoal: { label: "Charcoal", description: "Softer surfaces. Colorful code." },
  catppuccin: { label: "Catppuccin", description: "Latte and Mocha pastels." },
  linear: { label: "Linear", description: "Quiet surfaces. Lavender accent." },
  vercel: { label: "Vercel", description: "Ink and hairlines. Geist throughout." },
} satisfies Record<Theme, { label: string; description: string }>

const optionCard =
  "flex cursor-pointer flex-col gap-3 rounded-lg border bg-card p-3 has-checked:border-ring has-checked:ring-1 has-checked:ring-ring has-focus-visible:outline-2 has-focus-visible:outline-offset-4 has-focus-visible:outline-ring"

function Option(props: {
  name: string
  label: string
  checked: boolean
  onSelect: () => void
  description?: string
  children: ReactNode
}) {
  const descriptionId = useId()

  return (
    <label className={optionCard}>
      {props.children}
      <span className="flex items-center gap-2 text-sm font-medium">
        <input
          type="radio"
          name={props.name}
          checked={props.checked}
          onChange={props.onSelect}
          aria-label={props.label}
          aria-describedby={props.description === undefined ? undefined : descriptionId}
          className="size-3.5 accent-(--ring)"
        />
        {props.label}
      </span>
      {props.description !== undefined && (
        <span id={descriptionId} className="text-xs text-muted-foreground">
          {props.description}
        </span>
      )}
    </label>
  )
}

function Swatch(props: { theme: Theme; scheme: ColorScheme }) {
  const Icon = props.scheme === "light" ? Sun : Moon

  return (
    <span className="relative">
      <span className="theme-swatch" data-theme={props.theme} data-scheme={props.scheme} />
      <Icon className="absolute -right-1 -bottom-1 size-4 rounded-full border bg-popover p-0.5 text-popover-foreground" />
    </span>
  )
}

export function AppearanceSettings() {
  const { theme, colorScheme, setTheme, setColorScheme } = useAppearance()

  return (
    <SettingsSection
      title="Appearance"
      description="Choose how Glass looks, including code and diffs."
    >
      <fieldset className="grid grid-cols-3 gap-3">
        <legend className="mb-3 text-sm font-medium">Color scheme</legend>
        {ColorSchemePreference.literals.map((value) => (
          <Option
            key={value}
            name="color-scheme"
            label={colorSchemeLabels[value]}
            checked={colorScheme === value}
            onSelect={() => setColorScheme(value)}
          >
            <span className="theme-preview" data-preview={value} aria-hidden>
              <span className="theme-preview-rail" />
              <span className="theme-preview-files">
                <i />
                <i />
                <i />
              </span>
              <span className="theme-preview-code">
                <i />
                <i />
                <i />
                <i />
              </span>
            </span>
          </Option>
        ))}
      </fieldset>
      <fieldset className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <legend className="mb-3 text-sm font-medium">Theme</legend>
        {Theme.literals.map((value) => (
          <Option
            key={value}
            name="theme"
            label={themeDetails[value].label}
            checked={theme === value}
            onSelect={() => setTheme(value)}
            description={themeDetails[value].description}
          >
            <span className="flex justify-center gap-4 py-2" aria-hidden>
              <Swatch theme={value} scheme="light" />
              <Swatch theme={value} scheme="dark" />
            </span>
          </Option>
        ))}
      </fieldset>
    </SettingsSection>
  )
}
