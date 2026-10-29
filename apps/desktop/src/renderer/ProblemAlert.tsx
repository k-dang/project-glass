import type { ReactNode } from "react"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { Problem } from "./problems"

export const withCode = (text: string) =>
  text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="font-mono">
        {part}
      </code>
    ) : (
      part
    ),
  )

export function ProblemAlert(props: {
  problem: Problem
  action?: { readonly label: string; readonly run: () => void } | undefined
}) {
  const { action } = props

  return (
    <Alert variant="destructive">
      <AlertTitle>{props.problem.title}</AlertTitle>
      <AlertDescription>{withCode(props.problem.detail)}</AlertDescription>
      {action !== undefined && (
        <AlertAction>
          <Button variant="outline" size="sm" onClick={action.run}>
            {action.label}
          </Button>
        </AlertAction>
      )}
    </Alert>
  )
}

export function Problems(props: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 border-b px-6 py-4">{props.children}</div>
}
