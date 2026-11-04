const { app } = require("electron")

if (process.platform === "darwin") {
  const prohibit = () => app.setActivationPolicy("prohibited")

  prohibit()
  app.on("will-finish-launching", prohibit)
  app.on("ready", prohibit)
}

if (!process.env.CI) {
  // Hidden windows render at 1 frame per second, and each Playwright click waits on those frames.
  app.on("browser-window-created", (_event, window) => {
    window.show = () => {
      window.setOpacity(0)
      window.setIgnoreMouseEvents(true)
      window.showInactive()
    }
  })
}
