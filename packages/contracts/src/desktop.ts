import type { CapturedContext } from "./thread"
import type { AgentReview } from "./agentReview"
import type { Tour } from "./tour"
import type { ColorSchemePreference, Layout, Theme } from "./appearance"

export interface BackendEndpoint {
  readonly url: string
  readonly token: string
}

export interface BackendFailure {
  readonly kind: "start" | "crash"
  readonly message: string
  readonly logFile: string
}

export type ColorScheme = "light" | "dark"

export interface Appearance {
  readonly theme: Theme
  readonly colorScheme: ColorSchemePreference
  readonly layout: Layout
}

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
  readonly setAppearance: (appearance: Appearance) => Promise<ColorScheme>
  readonly resourceUsage: () => Promise<ResourceUsage>
  readonly chooseFolder: () => Promise<string | null>
  readonly bringToFront: () => Promise<void>
  readonly dogfoodReports: DogfoodReportsBridge
  readonly htmlPages: HtmlPagesBridge
}

export interface HtmlPagesBridge {
  readonly open: (html: string) => Promise<string>
  readonly close: (url: string) => Promise<void>
}

export interface DogfoodReportsBridge {
  readonly record: () => Promise<DogfoodReportRecorded>
  readonly finish: (details: DogfoodReportDetails) => Promise<string>
  readonly discard: (id: string) => Promise<void>
}

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

export const SET_APPEARANCE_CHANNEL = "glass:set-appearance"

export const RESOURCE_USAGE_CHANNEL = "glass:resource-usage"

export const CHOOSE_FOLDER_CHANNEL = "glass:choose-folder"

export const BRING_TO_FRONT_CHANNEL = "glass:bring-to-front"

export const RECORD_DOGFOOD_REPORT_CHANNEL = "glass:record-dogfood-report"

export const FINISH_DOGFOOD_REPORT_CHANNEL = "glass:finish-dogfood-report"

export const DISCARD_DOGFOOD_REPORT_CHANNEL = "glass:discard-dogfood-report"

export const OPEN_HTML_PAGE_CHANNEL = "glass:open-html-page"

export const CLOSE_HTML_PAGE_CHANNEL = "glass:close-html-page"

export const HTML_PAGE_SCHEME = "glass-page"

export const HTML_PAGE_SANDBOX = "allow-scripts allow-forms allow-popups"
