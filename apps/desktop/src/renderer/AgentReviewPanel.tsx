import type { AgentReview } from "@glass/contracts"
import { cn } from "cn"
import { Streamdown } from "streamdown"

export function AgentReviewMarkdown(props: { markdown: string; className?: string }) {
  return (
    <Streamdown
      className={cn(
        "text-sm leading-relaxed break-words [&_h2]:mt-5 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold",
        // Long inline code such as paths wraps often here, so its chip is slim and wraps cleanly.
        "[&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0 [&_:not(pre)>code]:text-[0.8125rem] [&_:not(pre)>code]:[box-decoration-break:clone]",
        props.className,
      )}
    >
      {props.markdown}
    </Streamdown>
  )
}

/** The whole Agent review in the file panel, so it reads beside the diff. */
export function AgentReviewPanel(props: { review: AgentReview }) {
  return (
    <section aria-label="Agent review" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      <AgentReviewMarkdown markdown={props.review.markdown} />
    </section>
  )
}
