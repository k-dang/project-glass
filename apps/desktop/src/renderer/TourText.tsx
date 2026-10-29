export function TourText(props: { text: string }) {
  return props.text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      <code key={index} className="rounded bg-muted px-1 font-mono text-xs text-foreground">
        {part.slice(1, -1)}
      </code>
    ) : part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={index} className="font-medium text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  )
}
