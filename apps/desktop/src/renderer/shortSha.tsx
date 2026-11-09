import { shortSha } from "@glass/contracts"
import { TooltipHint } from "@/components/ui/tooltip"

export function ShortSha(props: { sha: string }) {
  return (
    <TooltipHint content={props.sha}>
      <code className="font-mono text-foreground">{shortSha(props.sha)}</code>
    </TooltipHint>
  )
}
