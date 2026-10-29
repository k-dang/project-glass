import { TooltipHint } from "@/components/ui/tooltip"

export const shortSha = (sha: string) => sha.slice(0, 7)

export function ShortSha(props: { sha: string }) {
  return (
    <TooltipHint content={props.sha}>
      <code className="font-mono text-foreground">{shortSha(props.sha)}</code>
    </TooltipHint>
  )
}
