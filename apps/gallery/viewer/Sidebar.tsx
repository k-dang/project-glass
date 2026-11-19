import { useEffect, useRef, type RefObject } from "react"
import type { Shot } from "../shot.ts"
import { openOnClick } from "./model.ts"

interface SidebarProps {
  readonly total: number
  readonly capturedAt: string
  readonly areas: ReadonlyMap<string, ReadonlyArray<Shot>>
  readonly current: Shot | undefined
  readonly filter: string
  readonly onFilter: (query: string) => void
  readonly filterRef: RefObject<HTMLInputElement | null>
  readonly onOpen: (id: string) => void
}

export const Sidebar = ({
  total,
  capturedAt,
  areas,
  current,
  filter,
  onFilter,
  filterRef,
  onOpen,
}: SidebarProps) => {
  const list = useRef<HTMLDivElement>(null)
  const currentId = current?.id

  useEffect(() => {
    if (currentId === undefined) return

    list.current
      ?.querySelector(`a[href="#${CSS.escape(currentId)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [currentId])

  return (
    <nav>
      <header>
        <h1>Glass app states</h1>
        <div className="meta">
          {total} states · captured {capturedAt}
        </div>
        <input
          ref={filterRef}
          type="search"
          placeholder="Filter  ( / )"
          aria-label="Filter states"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur()
          }}
        />
      </header>
      <div className="list" ref={list}>
        {[...areas].map(([area, shots]) => (
          <section key={area}>
            <h2>{area}</h2>
            {shots.map((shot) => (
              <a
                key={shot.id}
                href={`#${shot.id}`}
                onClick={openOnClick(onOpen, shot.id)}
                aria-current={shot === current ? "true" : undefined}
              >
                {shot.name}
              </a>
            ))}
          </section>
        ))}
      </div>
    </nav>
  )
}
