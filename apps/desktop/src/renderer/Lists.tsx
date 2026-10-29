import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"

export function Empty(props: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
      <h2 className="text-base font-semibold text-foreground">{props.title}</h2>
      {props.children}
    </div>
  )
}

export function LoadMore(props: {
  label: string
  loading: boolean
  disabled: boolean
  onMore: () => void
}) {
  return (
    <div className="pt-4">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.disabled}
        onClick={props.onMore}
      >
        {props.loading ? "Loading more…" : props.label}
      </Button>
    </div>
  )
}
