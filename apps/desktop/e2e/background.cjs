const { app } = require("electron")

if (process.platform === "darwin") {
  // WARNING: Electron still activates on macOS unless the activation policy is set at every launch stage.
  const prohibit = () => app.setActivationPolicy("prohibited")

  prohibit()
  app.on("will-finish-launching", prohibit)
  app.on("ready", prohibit)
}

if (!process.env.CI) {
  // WARNING: Chromium draws hidden windows at 1 fps and each Playwright click waits on frames, so windows show transparent instead.
  app.on("browser-window-created", (_event, window) => {
    window.show = () => {
      if (process.platform === "linux") return

      window.setOpacity(0)
      window.setIgnoreMouseEvents(true)
      window.showInactive()
    }
  })
}
