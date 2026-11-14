import type { RiskKind, TourCodeTarget } from "@glass/contracts"
import { cn } from "cn"
import { ArrowUpRight, EyeOff, Flame, Route } from "lucide-react"
import { type ReactNode, useLayoutEffect, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { pathLineName } from "./Discussions"
import { plural } from "./plural"
import type { RankedHotspot } from "./rankedHotspots"
import { twoDigits } from "./tourProgress"
import type { ChapterHotspot, TourChapter, TourHotspot } from "./tourReading"
import { TourText } from "./TourText"

type ShowPlace = (place: TourCodeTarget) => void

export interface HotspotFocus {
  readonly rank: number
}

export interface HotspotLinks {
  readonly onShowPlace: ShowPlace
  readonly chapterOf: (rank: number) => number | null
  readonly onShowInTour: ShowPlace
  readonly focus: HotspotFocus | null
}

const kindLabels: Record<RiskKind, string> = {
  "data-access": "Data access",
  migration: "Migration",
  auth: "Auth & trust",
  concurrency: "Concurrency",
  "public-contract": "Public contract",
}

const placeName = (place: TourCodeTarget) =>
  place.startLine === place.endLine
    ? pathLineName(place.path, place.side, place.startLine)
    : `${pathLineName(place.path, place.side, place.startLine)} to ${place.endLine}`

function HotspotRank(props: { rank: number; className?: string }) {
  return (
    <span
      aria-label={`Hotspot ${props.rank}`}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background tabular-nums",
        props.className,
      )}
    >
      {props.rank}
    </span>
  )
}

function RiskKindBadge(props: { kind: RiskKind }) {
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      {kindLabels[props.kind]}
    </Badge>
  )
}

function PlaceLink(props: { place: TourCodeTarget; onShow: ShowPlace | null }) {
  const { place, onShow } = props

  if (onShow === null)
    return <span className="font-mono text-muted-foreground">{placeName(place)}</span>

  return (
    <button
      type="button"
      title={place.path}
      onClick={() => onShow(place)}
      className="font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {placeName(place)}
    </button>
  )
}

const useFocusedPoint = (focus: HotspotFocus | null) => {
  const points = useRef(new Map<number, HTMLElement>())

  useLayoutEffect(() => {
    const point = focus === null ? undefined : points.current.get(focus.rank)

    if (point === undefined) return

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    point.scrollIntoView({ block: "start", behavior: reduced ? "instant" : "smooth" })

    if (!reduced)
      point.animate([{ backgroundColor: "var(--muted)" }, { backgroundColor: "transparent" }], {
        duration: 1200,
        easing: "ease-out",
      })
  }, [focus])

  return (rank: number) => (element: HTMLElement | null) => {
    if (element === null) points.current.delete(rank)
    else points.current.set(rank, element)
  }
}

export function HotspotPoints(props: {
  hotspots: ReadonlyArray<RankedHotspot>
  links: HotspotLinks
  outdated: boolean
}) {
  const { links } = props
  const pointRef = useFocusedPoint(links.focus)

  if (props.hotspots.length === 0) return null

  return (
    <ol aria-label="Hotspots" className="my-5 space-y-5">
      {props.hotspots.map(({ rank, hotspot }) => {
        const chapter = links.chapterOf(rank)
        const { place } = hotspot

        return (
          <li
            key={rank}
            ref={pointRef(rank)}
            className="-mx-2 scroll-mt-4 space-y-2 rounded-md px-2 text-sm leading-relaxed"
          >
            <h2 className="flex items-start gap-2 font-semibold">
              <HotspotRank rank={rank} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <TourText text={hotspot.title} />
              </span>
            </h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-7 text-xs">
              <RiskKindBadge kind={hotspot.kind} />
              {place !== null && (
                <PlaceLink place={place} onShow={props.outdated ? null : links.onShowPlace} />
              )}
              {place !== null && chapter !== null && (
                <button
                  type="button"
                  onClick={() => links.onShowInTour(place)}
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <Route aria-hidden className="size-3" />
                  Tour Chapter {twoDigits(chapter + 1)}
                </button>
              )}
            </div>
            <div className="space-y-2 pl-7">
              <p>
                <TourText text={hotspot.why} />
              </p>
              <pre className="overflow-x-auto rounded-md border bg-muted/50 px-2 py-1 font-mono text-xs whitespace-pre-wrap">
                {hotspot.evidence}
              </pre>
              <p>
                <span className="font-medium">Check: </span>
                <TourText text={hotspot.check} />
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export function HotspotSummary(props: {
  hotspots: ReadonlyArray<RankedHotspot>
  onSelect: (rank: number) => void
}) {
  if (props.hotspots.length === 0) return null

  return (
    <ol aria-label="Hotspots" className="space-y-0.5">
      {props.hotspots.map(({ rank, hotspot }) => (
        <li key={rank}>
          <button
            type="button"
            onClick={() => props.onSelect(rank)}
            className="flex w-full items-center gap-2 rounded-md p-1 text-left text-sm hover:bg-muted"
          >
            <HotspotRank rank={rank} />
            <span className="min-w-0 flex-1 truncate">
              <TourText text={hotspot.title} />
            </span>
            <RiskKindBadge kind={hotspot.kind} />
          </button>
        </li>
      ))}
    </ol>
  )
}

function TourHotspotsHeading(props: { children: ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-normal tracking-wider text-muted-foreground uppercase">
      <Flame aria-hidden className="size-3" />
      {props.children}
    </h3>
  )
}

export function TourHotspots(props: {
  hotspots: ReadonlyArray<TourHotspot>
  onShowPlace: ShowPlace
  onShowInReview: (rank: number) => void
}) {
  return (
    <nav className="mt-6 max-w-[80ch] border-t pt-4" aria-label="Where to look first">
      <TourHotspotsHeading>Where to look first</TourHotspotsHeading>
      {props.hotspots.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          The Agent review found nothing that stands out. Read the Chapters in order.
        </p>
      ) : (
        <ol className="divide-y border-y">
          {props.hotspots.map((entry) => (
            <li key={entry.rank}>
              <button
                type="button"
                onClick={() =>
                  entry.chapter === null
                    ? props.onShowInReview(entry.rank)
                    : props.onShowPlace(entry.hotspot.place)
                }
                className="group flex w-full items-start gap-2.5 px-1 py-2 text-left text-[12.5px] leading-5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <HotspotRank rank={entry.rank} className="mt-px" />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block text-foreground">
                    <TourText text={entry.hotspot.title} />
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <RiskKindBadge kind={entry.hotspot.kind} />
                    {entry.chapter !== null && <span>Chapter {twoDigits(entry.chapter + 1)}</span>}
                  </span>
                </span>
                <ArrowUpRight aria-hidden className="mt-0.5 size-3 shrink-0 opacity-60" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  )
}

export function ChapterHotspots(props: {
  hotspots: ReadonlyArray<ChapterHotspot>
  title: string
  onShowPlace: ShowPlace
}) {
  if (props.hotspots.length === 0) return null

  return (
    <nav className="mt-5 max-w-[80ch]" aria-label={`Hotspots in ${props.title}`}>
      <TourHotspotsHeading>Hotspots</TourHotspotsHeading>
      <ol className="space-y-2">
        {props.hotspots.map(({ rank, hotspot }) => (
          <li key={rank} className="rounded-md border bg-background p-2.5 text-[12.5px] leading-5">
            <button
              type="button"
              onClick={() => props.onShowPlace(hotspot.place)}
              className="group flex w-full items-start gap-2 text-left"
            >
              <HotspotRank rank={rank} className="mt-px" />
              <span className="min-w-0 flex-1 font-medium group-hover:underline">
                <TourText text={hotspot.title} />
              </span>
              <RiskKindBadge kind={hotspot.kind} />
            </button>
            <p className="mt-1.5 pl-7 text-muted-foreground">
              <span className="font-medium text-foreground">Check: </span>
              <TourText text={hotspot.check} />
            </p>
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function LowAttentionMark(props: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-1 text-muted-foreground", props.className)}>
      <EyeOff aria-hidden className="size-3" />
      Low attention
    </span>
  )
}

export function AttentionMark(props: { chapter: TourChapter }) {
  const { hotspots, lowAttention } = props.chapter

  if (hotspots.length > 0)
    return (
      <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
        <Flame aria-hidden className="size-3" />
        {plural(hotspots.length, "hotspot")}
      </span>
    )

  return lowAttention ? <LowAttentionMark className="font-mono text-[11px]" /> : null
}
