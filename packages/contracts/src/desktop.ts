export interface BackendEndpoint {
  readonly url: string
  readonly token: string
}

export interface BackendFailure {
  readonly kind: "start" | "crash"
  readonly message: string
  readonly logFile: string
}

export type Theme = "light" | "dark" | "system" | "charcoal"

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
}

export const BACKEND_ENDPOINT_CHANNEL = "glass:backend-endpoint"

export const BACKEND_FAILURE_CHANNEL = "glass:backend-failure"

export const RELAUNCH_CHANNEL = "glass:relaunch"

export const SET_THEME_CHANNEL = "glass:set-theme"

export const RESOURCE_USAGE_CHANNEL = "glass:resource-usage"

export const CHOOSE_FOLDER_CHANNEL = "glass:choose-folder"
