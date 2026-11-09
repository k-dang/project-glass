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
  readonly record: () => Promise<DogfoodReportRecorded>
  readonly finish: (details: DogfoodReportDetails) => Promise<string>
  readonly discard: (id: string) => Promise<void>
}

/** Main passes this to development builds' renderers, whose preload then offers Dogfood reports. */
export const DOGFOOD_REPORTS_ARGUMENT = "--glass-dogfood-reports"

export interface DogfoodReportRecorded {
  readonly id: string
  readonly screenshot: string
}

export interface DogfoodReportSubject {
  readonly route: string
  readonly context: typeof CapturedContext.Encoded | null
  readonly tour: typeof Tour.Encoded | null
  readonly agentReview: typeof AgentReview.Encoded | null
}

export interface DogfoodReportDetails {
  readonly id: string
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

export const DISCARD_DOGFOOD_REPORT_CHANNEL = "glass:discard-dogfood-report"
