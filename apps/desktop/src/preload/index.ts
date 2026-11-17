import {
  BACKEND_ENDPOINT_CHANNEL,
  BACKEND_FAILURE_CHANNEL,
  CHOOSE_FOLDER_CHANNEL,
  CLOSE_HTML_PAGE_CHANNEL,
  type DesktopBridge,
  DISCARD_DOGFOOD_REPORT_CHANNEL,
  FINISH_DOGFOOD_REPORT_CHANNEL,
  OPEN_HTML_PAGE_CHANNEL,
  RECORD_DOGFOOD_REPORT_CHANNEL,
  RELAUNCH_CHANNEL,
  RESOURCE_USAGE_CHANNEL,
  SET_APPEARANCE_CHANNEL,
} from "@glass/contracts/desktop"
import { contextBridge, ipcRenderer } from "electron"

const bridge: DesktopBridge = {
  backendEndpoint: () => ipcRenderer.invoke(BACKEND_ENDPOINT_CHANNEL),
  backendFailure: () => ipcRenderer.invoke(BACKEND_FAILURE_CHANNEL),
  relaunch: () => ipcRenderer.invoke(RELAUNCH_CHANNEL),
  setAppearance: (appearance) => ipcRenderer.invoke(SET_APPEARANCE_CHANNEL, appearance),
  resourceUsage: () => ipcRenderer.invoke(RESOURCE_USAGE_CHANNEL),
  chooseFolder: () => ipcRenderer.invoke(CHOOSE_FOLDER_CHANNEL),
  dogfoodReports: {
    record: () => ipcRenderer.invoke(RECORD_DOGFOOD_REPORT_CHANNEL),
    finish: (details) => ipcRenderer.invoke(FINISH_DOGFOOD_REPORT_CHANNEL, details),
    discard: (id) => ipcRenderer.invoke(DISCARD_DOGFOOD_REPORT_CHANNEL, id),
  },
  htmlPages: {
    open: (html) => ipcRenderer.invoke(OPEN_HTML_PAGE_CHANNEL, html),
    close: (url) => ipcRenderer.invoke(CLOSE_HTML_PAGE_CHANNEL, url),
  },
}

contextBridge.exposeInMainWorld("glass", bridge)
