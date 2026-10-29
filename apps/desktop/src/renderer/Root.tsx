import type { BackendFailure } from "@glass/contracts"
import { LoaderCircle, ServerCrash } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { App } from "./App"

export function Root() {
  const [failure, setFailure] = useState<BackendFailure | null>(null)

  useEffect(() => {
    void window.glass.backendFailure().then(setFailure)
  }, [])

  return failure === null ? <App /> : <BackendFailed failure={failure} />
}

function BackendFailed(props: { failure: BackendFailure }) {
  const [relaunching, setRelaunching] = useState(false)
  const { kind, message, logFile } = props.failure

  const relaunch = () => {
    setRelaunching(true)
    void window.glass.relaunch()
  }

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="title-strip absolute inset-x-0 top-0" aria-hidden />
      <ServerCrash className="size-8 text-destructive" aria-hidden />
      <h1 className="text-lg font-semibold">
        {kind === "start" ? "Glass's backend didn't start" : "Glass's backend keeps stopping"}
      </h1>
      <p className="max-w-md text-sm text-balance text-muted-foreground">
        {message}. Relaunch Glass to continue.
      </p>
      <p className="max-w-xl text-xs break-all text-muted-foreground">
        Details are in <code className="font-mono">{logFile}</code>
      </p>
      <Button className="mt-2" onClick={relaunch} disabled={relaunching}>
        {relaunching && <LoaderCircle className="animate-spin" aria-hidden />}
        Relaunch Glass
      </Button>
    </main>
  )
}
