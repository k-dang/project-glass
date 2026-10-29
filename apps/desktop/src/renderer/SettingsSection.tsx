import { type ReactNode, useId } from "react"

export function SettingsSection(props: {
  title: string
  description: string
  children: ReactNode
}) {
  const id = useId()

  return (
    <section aria-labelledby={id} className="flex flex-col gap-6 border-t pt-8">
      <div>
        <h2 id={id} className="text-lg font-semibold">
          {props.title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{props.description}</p>
      </div>
      {props.children}
    </section>
  )
}
