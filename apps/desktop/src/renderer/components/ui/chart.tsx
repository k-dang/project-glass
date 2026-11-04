import * as React from "react"
import { cn } from "cn"
import * as RechartsPrimitive from "recharts"

function ChartContainer({
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"]
}) {
  return (
    <div
      data-slot="chart"
      className={cn(
        "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-surface]:outline-hidden",
        className,
      )}
      {...props}
    >
      <RechartsPrimitive.ResponsiveContainer initialDimension={{ width: 320, height: 200 }}>
        {children}
      </RechartsPrimitive.ResponsiveContainer>
    </div>
  )
}

function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
}: Partial<
  Pick<
    RechartsPrimitive.TooltipContentProps<RechartsPrimitive.TooltipValueType, string>,
    "active" | "payload" | "label" | "labelFormatter"
  >
>) {
  if (!active || payload === undefined || payload.length === 0) {
    return null
  }

  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{labelFormatter ? labelFormatter(label, payload) : label}</div>
      <div className="grid gap-1.5">
        {payload.map((item) => (
          <div key={item.name} className="flex w-full items-center gap-2">
            <div
              className="size-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: item.color }}
            />
            <div className="flex flex-1 items-center justify-between gap-4 leading-none">
              <span className="text-muted-foreground">{item.name}</span>
              <span className="font-mono font-medium text-foreground tabular-nums">
                {String(item.value)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export { ChartContainer, ChartTooltipContent }
