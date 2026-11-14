import type { DogfoodReportDetails, DogfoodReportSubject } from "@glass/contracts/desktop"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

interface Capture {
  readonly screenshot: Buffer
  readonly backendLogPath: string
  readonly settingsPath: string
  readonly glassCommit: string
  readonly now: Date
}

interface Recorded {
  readonly recordedAt: string
  readonly glassCommit: string
}

const pad = (value: number) => String(value).padStart(2, "0")

const stampOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-` +
  `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`

const readIfPresent = (path: string) =>
  readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error

    return null
  })

const SLUG_LENGTH = 48

export const slugOf = (note: string) => {
  const words = (note.split("\n")[0] ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")

  let slug = ""

  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`

    if (next.length > SLUG_LENGTH) break

    slug = next
  }

  return slug
}

type AgentReview = NonNullable<DogfoodReportSubject["agentReview"]>

interface SubjectFile extends Recorded {
  readonly route?: string
  readonly context?: DogfoodReportSubject["context"]
  readonly agentReview?: Omit<AgentReview, "markdown">
}

const subjectFileOf = (recorded: Recorded, subject: DogfoodReportSubject): SubjectFile => {
  const { route, context, agentReview } = subject

  if (agentReview === null) return { ...recorded, route, context }

  const { markdown: _markdown, ...review } = agentReview

  return { ...recorded, route, context, agentReview: review }
}

const json = (value: SubjectFile | NonNullable<DogfoodReportSubject["tour"]>) =>
  `${JSON.stringify(value, null, 2)}\n`

interface Held {
  readonly id: string
  readonly stamp: string
  readonly recorded: Recorded
  readonly files: ReadonlyArray<readonly [string, Buffer | null]>
}

export const dogfoodReportWriter = (reports: string) => {
  let held: Held | null = null

  return {
    record: async (capture: Capture): Promise<string> => {
      const [backendLog, settings] = await Promise.all([
        readIfPresent(capture.backendLogPath),
        readIfPresent(capture.settingsPath),
      ])

      const id = randomUUID()

      held = {
        id,
        stamp: stampOf(capture.now),
        recorded: { recordedAt: capture.now.toISOString(), glassCommit: capture.glassCommit },
        files: [
          ["screenshot.png", capture.screenshot],
          ["backend.log", backendLog],
          ["settings.json", settings],
        ],
      }

      return id
    },

    finish: async ({ id, note, subject }: DogfoodReportDetails): Promise<string> => {
      if (held?.id !== id) throw new Error(`No unfinished Dogfood report ${id}`)

      const { stamp, recorded, files } = held
      held = null

      const text = note.trim()
      const slug = slugOf(text)
      const folder = join(reports, slug === "" ? stamp : `${stamp}-${slug}`)

      await mkdir(reports, { recursive: true })
      await mkdir(folder)
      await Promise.all([
        ...files.map(([name, data]) => data !== null && writeFile(join(folder, name), data)),
        writeFile(join(folder, "subject.json"), json(subjectFileOf(recorded, subject))),
        text !== "" && writeFile(join(folder, "note.md"), `${text}\n`),
        subject.tour !== null && writeFile(join(folder, "tour.json"), json(subject.tour)),
        subject.agentReview !== null &&
          writeFile(join(folder, "agent-review.md"), subject.agentReview.markdown),
      ])

      return folder
    },

    discard: (id: string) => {
      if (held?.id === id) held = null
    },
  }
}
