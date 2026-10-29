import { RegistryProvider } from "@effect/atom-react"
import { WorkerPoolContextProvider, type WorkerPoolOptions } from "@pierre/diffs/react"
// Vite builds `?worker` imports into a worker constructor the import plugin can't see.
// oxlint-disable-next-line import/default
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { codeThemeFor, CodeThemeSync } from "./codeTheme"
import { Root } from "./Root"
import { applyTheme, savedTheme } from "./theme"
import "./styles.css"

const poolOptions: WorkerPoolOptions = {
  workerFactory: () => new DiffsWorker(),
  poolSize: Math.min(3, Math.max(1, navigator.hardwareConcurrency - 1)),
}

const theme = savedTheme()

void applyTheme(theme)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={{ theme: codeThemeFor(theme) }}
    >
      <RegistryProvider>
        <CodeThemeSync />
        <Root />
      </RegistryProvider>
    </WorkerPoolContextProvider>
  </StrictMode>,
)
