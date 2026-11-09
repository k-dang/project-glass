import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"

export function FilePanelTabsList(props: { children: ReactNode }) {
  return (
    <TabsList
      aria-label="File panel"
      className="w-full justify-start gap-1 rounded-none border-b bg-transparent px-2 py-1 group-data-horizontal/tabs:h-9"
    >
      {props.children}
    </TabsList>
  )
}

export function FilePanelTabTrigger(props: {
  value: string
  icon: LucideIcon
  children: ReactNode
}) {
  return (
    <TabsTrigger
      value={props.value}
      className="h-6 flex-none rounded-md px-2 text-xs font-normal transition-none data-active:bg-muted dark:data-active:border-transparent dark:data-active:bg-muted group-data-[variant=default]/tabs-list:data-active:shadow-none"
    >
      <props.icon aria-hidden className="size-3" />
      {props.children}
    </TabsTrigger>
  )
}
