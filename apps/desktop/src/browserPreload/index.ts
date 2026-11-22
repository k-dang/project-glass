import type { PageState } from "@glass/contracts"
import { PAGE_EVENT_CHANNEL, PAGE_STATE_CHANNEL } from "@glass/contracts/desktop"
import { ipcRenderer } from "electron"
import { pageNotes } from "./pageNotes"

window.addEventListener("DOMContentLoaded", () =>
  pageNotes(window, {
    post: (event) => ipcRenderer.sendToHost(PAGE_EVENT_CHANNEL, event),
    onState: (receive) =>
      // SAFETY: Only Glass's window, the pane's host, sends on this channel, always a PageState.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A preload can't bundle Schema to decode it.
      ipcRenderer.on(PAGE_STATE_CHANNEL, (_event, state) => receive(state as PageState)),
  }),
)
