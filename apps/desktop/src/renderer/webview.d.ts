interface WebviewEventMap extends HTMLElementEventMap {
  "dom-ready": Event
  "did-navigate": Event & { readonly url: string }
  "did-navigate-in-page": Event & { readonly url: string; readonly isMainFrame: boolean }
  "page-title-updated": Event & { readonly title: string }
  "did-start-loading": Event
  "did-stop-loading": Event
  "ipc-message": Event & { readonly channel: string; readonly args: ReadonlyArray<unknown> }
}

interface HTMLWebViewElement {
  getWebContentsId(): number
  getURL(): string
  getTitle(): string
  loadURL(url: string): Promise<void>
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  openDevTools(): void
  send(channel: string, ...args: ReadonlyArray<unknown>): Promise<void>
  addEventListener<K extends keyof WebviewEventMap>(
    type: K,
    listener: (event: WebviewEventMap[K]) => void,
  ): void
  removeEventListener<K extends keyof WebviewEventMap>(
    type: K,
    listener: (event: WebviewEventMap[K]) => void,
  ): void
}
