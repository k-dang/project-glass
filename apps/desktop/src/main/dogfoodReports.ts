import type { DogfoodReportDetails, DogfoodReportSubject } from "@glass/contracts/desktop"
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises"
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

const copyIfPresent = (from: string, to: string) =>
  copyFile(from, to).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
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
  /** `agent-review.md` holds the Markdown; everything else about the review stays here. */
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

/** Writes Dogfood reports into `reports`, one folder each. */
export const dogfoodReportWriter = (reports: string) => {
  // Also limits `finish` to folders this writer recorded.
  const unfinished = new Map<string, Recorded>()

  return {
    record: async (capture: Capture): Promise<string> => {
      const folder = join(reports, stampOf(capture.now))
      const recorded = { recordedAt: capture.now.toISOString(), glassCommit: capture.glassCommit }

      await mkdir(reports, { recursive: true })
      // Not recursive, so a second report in the same second fails instead of overwriting.
      await mkdir(folder)
      await Promise.all([
        writeFile(join(folder, "screenshot.png"), capture.screenshot),
        copyIfPresent(capture.backendLogPath, join(folder, "backend.log")),
        copyIfPresent(capture.settingsPath, join(folder, "settings.json")),
        writeFile(join(folder, "subject.json"), json(recorded)),
      ])
      unfinished.set(folder, recorded)

      return folder
    },

    finish: async ({ folder, note, subject }: DogfoodReportDetails): Promise<string> => {
      const recorded = unfinished.get(folder)

      if (recorded === undefined) throw new Error(`No unfinished Dogfood report at ${folder}`)

      unfinished.delete(folder)

      const text = note.trim()

      await Promise.all([
        writeFile(join(folder, "subject.json"), json(subjectFileOf(recorded, subject))),
        text !== "" && writeFile(join(folder, "note.md"), `${text}\n`),
        subject.tour !== null && writeFile(join(folder, "tour.json"), json(subject.tour)),
        subject.agentReview !== null &&
          writeFile(join(folder, "agent-review.md"), subject.agentReview.markdown),
      ])

      const slug = slugOf(text)

      if (slug === "") return folder

      const named = `${folder}-${slug}`
      await rename(folder, named)

      return named
    },
  }
}
