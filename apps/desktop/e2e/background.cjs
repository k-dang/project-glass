const { app } = require("electron")

if (process.platform === "darwin") {
  // Setting this policy at only one launch stage still let Electron activate.
  const prohibit = () => app.setActivationPolicy("prohibited")

  prohibit()
  app.on("will-finish-launching", prohibit)
  app.on("ready", prohibit)
}

// CI shows windows inside Xvfb: hidden Linux windows slow Playwright's frame waits.
if (!process.env.CI) {
  app.on("browser-window-created", (_event, window) => {
    window.show = () => {}
  })
}
