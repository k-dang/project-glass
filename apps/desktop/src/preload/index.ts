import {
  BACKEND_ENDPOINT_CHANNEL,
  BACKEND_FAILURE_CHANNEL,
  CHOOSE_FOLDER_CHANNEL,
  type DesktopBridge,
  DOGFOOD_REPORTS_ARGUMENT,
  FINISH_DOGFOOD_REPORT_CHANNEL,
  RECORD_DOGFOOD_REPORT_CHANNEL,
  RELAUNCH_CHANNEL,
  RESOURCE_USAGE_CHANNEL,
  SET_THEME_CHANNEL,
} from "@glass/contracts/desktop"
import { contextBridge, ipcRenderer } from "electron"

const bridge: DesktopBridge = {
  backendEndpoint: () => ipcRenderer.invoke(BACKEND_ENDPOINT_CHANNEL),
  backendFailure: () => ipcRenderer.invoke(BACKEND_FAILURE_CHANNEL),
  relaunch: () => ipcRenderer.invoke(RELAUNCH_CHANNEL),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  resourceUsage: () => ipcRenderer.invoke(RESOURCE_USAGE_CHANNEL),
  chooseFolder: () => ipcRenderer.invoke(CHOOSE_FOLDER_CHANNEL),
  ...(process.argv.includes(DOGFOOD_REPORTS_ARGUMENT) && {
    dogfoodReports: {
      record: () => ipcRenderer.invoke(RECORD_DOGFOOD_REPORT_CHANNEL),
      finish: (details) => ipcRenderer.invoke(FINISH_DOGFOOD_REPORT_CHANNEL, details),
    },
  }),
}

contextBridge.exposeInMainWorld("glass", bridge)
