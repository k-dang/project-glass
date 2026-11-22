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
  readonly browserRelay: (webContentsId: number) => Promise<string>
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

export const BROWSER_PARTITION = "persist:glass-browser"

export const SANDBOX_BROWSER_PARTITION = "persist:glass-browser-sandbox"

export const BROWSER_RELAY_CHANNEL = "glass:browser-relay"

export const PAGE_EVENT_CHANNEL = "glass:page-event"

export const PAGE_STATE_CHANNEL = "glass:page-state"

export const THREAD_FILE_SCHEME = "glass-file"

const LOOPBACK_HOST =
  /^(?:localhost|.+\.localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\])$/i

export const isLoopbackHost = (host: string) => LOOPBACK_HOST.test(host.replace(/\.$/, ""))
