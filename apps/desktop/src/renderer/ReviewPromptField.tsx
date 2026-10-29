import { defaultReviewPrompt } from "@glass/contracts"
import { useId } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

export function ReviewPromptField(props: { value: string; onChange: (value: string) => void }) {
  const id = useId()
  const prompt = props.value.trim()
  const isDefault = prompt === defaultReviewPrompt

  return (
    <div className="flex flex-col gap-2.5 border-t border-dashed pt-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 id={`${id}-heading`} className="font-semibold">
            Review prompt
          </h3>
          <p id={`${id}-description`} className="text-sm text-muted-foreground">
            How you review: what to look for and what to skip.
          </p>
        </div>
        <Badge variant={isDefault ? "outline" : "secondary"}>
          {isDefault ? "Default" : "Custom"}
        </Badge>
      </div>
      <Textarea
        value={props.value}
        rows={7}
        aria-labelledby={`${id}-heading`}
        aria-describedby={`${id}-description ${id}-wrapping`}
        aria-invalid={prompt === "" || undefined}
        onChange={(event) => props.onChange(event.target.value)}
        className="font-mono text-xs leading-relaxed md:text-xs"
      />
      <div className="flex items-start justify-between gap-3">
        <p id={`${id}-wrapping`} className="text-sm text-muted-foreground">
          Glass wraps it in its own instructions, which fix the answer format and keep the agent
          from suggesting a Review decision.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isDefault}
          onClick={() => props.onChange(defaultReviewPrompt)}
        >
          Restore default
        </Button>
      </div>
    </div>
  )
}
