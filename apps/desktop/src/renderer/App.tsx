import { RegistryContext } from "@effect/atom-react"
import { RouterProvider } from "@tanstack/react-router"
import { useContext, useState } from "react"
import { Toaster } from "@/components/ui/toast"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createAppRouter } from "./routes"

export function App() {
  const registry = useContext(RegistryContext)
  const [router] = useState(() => createAppRouter(registry))

  return (
    <Toaster>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </Toaster>
  )
}
