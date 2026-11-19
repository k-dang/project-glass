import { useEffect, useState } from "react"
import type { Shot } from "../shot.ts"
import { alt, schemesShown, src, type Framing, type Scheme, type SchemeChoice } from "./model.ts"

// A new <img> paints blank until its PNG decodes, which flashes on every step. Decode the next shot
// off-screen and keep showing the old one until it's ready. Holding the decoded images keeps the
// neighbors ready too.
const decoded = new Map<string, Promise<HTMLImageElement>>()

const decode = (url: string) => {
  const cached = decoded.get(url)

  if (cached !== undefined) return cached

  const img = new Image()
  img.src = url

  const ready = img.decode().then(
    () => img,
    () => img,
  )

  decoded.set(url, ready)

  return ready
}

interface Displayed {
  readonly shot: Shot
  readonly schemes: ReadonlyArray<Scheme>
  readonly framing: Framing
}

interface SingleStageProps {
  readonly shot: Shot
  readonly previous: Shot | undefined
  readonly next: Shot | undefined
  readonly scheme: SchemeChoice
  readonly framing: Framing
}

export const SingleStage = ({ shot, previous, next, scheme, framing }: SingleStageProps) => {
  const [displayed, setDisplayed] = useState<Displayed | null>(null)

  useEffect(() => {
    const schemes = schemesShown(scheme)
    let live = true

    void Promise.all(schemes.map((shown) => decode(src(shot, shown, framing)))).then(() => {
      if (live) setDisplayed({ shot, schemes, framing })
    })

    const kept = [shot, next, previous].flatMap((near) =>
      near === undefined ? [] : schemes.map((shown) => src(near, shown, framing)),
    )

    for (const url of decoded.keys()) if (!kept.includes(url)) decoded.delete(url)

    for (const url of kept) void decode(url)

    return () => {
      live = false
    }
  }, [shot, previous, next, scheme, framing])

  if (displayed === null) return <div className="stage" />

  const pair = displayed.schemes.length > 1
  const urls = displayed.schemes.map((shown) => src(displayed.shot, shown, displayed.framing))

  // A new key gives each shot a fresh stage, scrolled to the top.
  return (
    <div className={pair ? "stage both" : "stage"} key={urls.join()}>
      {displayed.schemes.map((shown, index) => (
        <figure key={shown}>
          <img src={urls[index]} alt={alt(displayed.shot, shown)} />
          {pair && <figcaption>{shown === "light" ? "Light" : "Dark"}</figcaption>}
        </figure>
      ))}
    </div>
  )
}
