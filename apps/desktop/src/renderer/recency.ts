export const recency = ["Today", "Yesterday", "Past week", "Older"] as const

export type Recency = (typeof recency)[number]

const DAY = 24 * 60 * 60 * 1000

const dayNumber = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY

export const daysBetween = (from: Date, to: Date) => dayNumber(to) - dayNumber(from)

export const daysAgo = (days: number, now: Date) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - days)

export const recencyOf = (date: Date, now: Date): Recency => {
  const days = daysBetween(date, now)

  if (days <= 0) return "Today"

  if (days === 1) return "Yesterday"

  return days < 7 ? "Past week" : "Older"
}

export const dayOf = (date: Date, now: Date) => {
  const recent = recencyOf(date, now)

  if (recent === "Today" || recent === "Yesterday") return recent

  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  })
}
