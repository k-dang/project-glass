import type { CapturedContext } from "./agent"
import type { AgentReview } from "./agentReview"
import type { Tour } from "./tour"

export interface BackendEndpoint {
  readonly url: string
  readonly token: string
}

export interface BackendFailure {
  readonly kind: "start" | "crash"
  readonly message: string
  readonly logFile: string
}

export type Theme = "light" | "dark" | "system" | "charcoal" | "catppuccin-mocha"

export type ColorScheme = "light" | "dark"

export type ResourceProcess = "Main" | "Renderer" | "Backend" | "GPU / other"

export interface ResourceMeasurement {
  readonly cpuPercent: number
  readonly memoryBytes: number | null
}

export interface ResourceUsage extends ResourceMeasurement {
  readonly processes: ReadonlyArray<ResourceMeasurement & { readonly name: ResourceProcess }>
}

export interface DesktopBridge {
  readonly backendEndpoint: () => Promise<BackendEndpoint>
  readonly backendFailure: () => Promise<BackendFailure>
  readonly relaunch: () => Promise<void>
  readonly setTheme: (theme: Theme) => Promise<ColorScheme>
  readonly resourceUsage: () => Promise<ResourceUsage>
  readonly chooseFolder: () => Promise<string | null>
  /** Present in development builds only, which record Dogfood reports. */
  readonly dogfoodReports?: DogfoodReportsBridge
}

export interface DogfoodReportsBridge {
  /** Saves a screenshot of the window as it is now, with the logs and settings. */
  readonly record: () => Promise<DogfoodReportRecorded>
  /** Adds the note and what the screen was about, and returns the report's final folder. */
  readonly finish: (details: DogfoodReportDetails) => Promise<string>
}

/** Main passes this to development builds' renderers, whose preload then offers Dogfood reports. */
export const DOGFOOD_REPORTS_ARGUMENT = "--glass-dogfood-reports"

/** The screenshot and diagnostics are on disk; the note and what the screen showed come next. */
export interface DogfoodReportRecorded {
  readonly folder: string
  readonly screenshot: string
}

export interface DogfoodReportSubject {
  readonly route: string
  readonly context: typeof CapturedContext.Encoded | null
  readonly tour: typeof Tour.Encoded | null
  readonly agentReview: typeof AgentReview.Encoded | null
}

export interface DogfoodReportDetails {
  readonly folder: string
  readonly note: string
  readonly subject: DogfoodReportSubject
}

export const BACKEND_ENDPOINT_CHANNEL = "glass:backend-endpoint"

export const BACKEND_FAILURE_CHANNEL = "glass:backend-failure"

export const RELAUNCH_CHANNEL = "glass:relaunch"

export const SET_THEME_CHANNEL = "glass:set-theme"

export const RESOURCE_USAGE_CHANNEL = "glass:resource-usage"

export const CHOOSE_FOLDER_CHANNEL = "glass:choose-folder"

export const RECORD_DOGFOOD_REPORT_CHANNEL = "glass:record-dogfood-report"

export const FINISH_DOGFOOD_REPORT_CHANNEL = "glass:finish-dogfood-report"
