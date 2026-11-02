import {
  type Image,
  ImageMediaType,
  isNothingUnsent,
  type MessageInput,
  nothingUnsent,
  type SentMessage,
} from "@glass/contracts"
import { useAtomValue } from "@effect/atom-react"
import { Option, Predicate, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { AsyncResult } from "effect/reactivity"
import { ArrowUp, Square, X } from "lucide-react"
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { mention, MentionChoices, mentionChoices, mentionTrigger } from "./Mentions"
import { type Problem } from "./problems"
import { ProblemAlert } from "./ProblemAlert"
import { openToDosAtom } from "./toDoList"

const isMediaType = Schema.is(ImageMediaType)

const readImages = async (files: Iterable<File>) => {
  const read = await Promise.all(
    Array.from(files, async (file): Promise<Image | null> => {
      const mediaType = file.type

      return isMediaType(mediaType)
        ? { mediaType, data: Base64.encode(new Uint8Array(await file.arrayBuffer())) }
        : null
    }),
  )

  return read.filter(Predicate.isNotNull)
}

export const Attachment = memo(function Attachment(props: {
  image: Image
  index: number
  className: string
}) {
  const { mediaType, data } = props.image

  return (
    <img
      src={`data:${mediaType};base64,${data}`}
      alt={`Attachment ${props.index + 1}`}
      className={props.className}
    />
  )
})

const holdsFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files")

export function MessageBox(props: {
  composed: SentMessage
  setComposed: (update: (current: SentMessage) => SentMessage) => void
  placeholder: string
  blocked: boolean
  problem: Problem | null
  /** Why sending is blocked, when the placeholder alone can't say it. */
  notice?: ReactNode
  send: (message: MessageInput) => Promise<boolean>
  steer: ((message: MessageInput) => Promise<boolean>) | null
  recall: SentMessage | null
  onStop: (() => void) | null
  pickers?: ReactNode
  children?: ReactNode
}) {
  const { composed, setComposed } = props
  const textarea = useRef<HTMLTextAreaElement>(null)
  const choicesId = useId()
  const [caret, setCaret] = useState(0)
  const [highlighted, setHighlighted] = useState(0)
  // Where the user closed the To-do choices with Escape, so they stay closed for that `@`.
  const [dismissed, setDismissed] = useState<number | null>(null)
  const nextCaret = useRef<number | null>(null)
  const openToDos = Option.getOrElse(AsyncResult.value(useAtomValue(openToDosAtom)), () => [])

  const trigger = mentionTrigger(composed.message, caret)

  const choices =
    trigger === null || trigger.start === dismissed ? [] : mentionChoices(openToDos, trigger.query)

  const chosen = choices[Math.min(highlighted, choices.length - 1)]

  useLayoutEffect(() => {
    if (nextCaret.current === null) return
    textarea.current?.setSelectionRange(nextCaret.current, nextCaret.current)
    nextCaret.current = null
  })

  const followCaret = (element: HTMLTextAreaElement) => {
    setCaret(element.selectionEnd)
    setHighlighted(0)

    if (mentionTrigger(element.value, element.selectionEnd) === null) setDismissed(null)
  }

  const choose = (toDo: (typeof choices)[number]) => {
    if (trigger === null) return
    const next = mention(composed.message, trigger, caret, toDo)
    nextCaret.current = next.caret
    setCaret(next.caret)
    setComposed((current) => ({ ...current, message: next.text }))
  }

  const submit = async (deliver: (message: MessageInput) => Promise<boolean>) => {
    const sent = composed
    const message = sent.message.trim()

    if (props.blocked || message === "") return

    setComposed(() => nothingUnsent)

    if (!(await deliver({ message, images: sent.images })))
      setComposed((current) => (isNothingUnsent(current) ? sent : current))
  }

  const addImages = (files: Iterable<File>) =>
    void readImages(files).then((images) => {
      if (images.length > 0)
        setComposed((current) => ({ ...current, images: [...current.images, ...images] }))
    })

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter can confirm an input method's candidates.
    if (event.nativeEvent.isComposing) return

    if (chosen !== undefined && trigger !== null) {
      const moves = { ArrowDown: 1, ArrowUp: choices.length - 1 }[event.key]

      if (moves !== undefined) {
        event.preventDefault()
        setHighlighted((choices.indexOf(chosen) + moves) % choices.length)

        return
      }

      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        choose(chosen)

        return
      }

      if (event.key === "Escape") {
        event.preventDefault()
        setDismissed(trigger.start)

        return
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      const steer = event.metaKey || event.ctrlKey ? props.steer : null
      void submit(steer ?? props.send)
    } else if (event.key === "ArrowUp" && isNothingUnsent(composed) && props.recall !== null) {
      event.preventDefault()
      const { recall } = props
      setComposed(() => recall)
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files)

    if (!files.some(({ type }) => isMediaType(type))) return

    event.preventDefault()
    addImages(files)
  }

  return (
    <form
      className="px-6 pt-2 pb-4"
      onSubmit={(event) => {
        event.preventDefault()
        void submit(props.send)
      }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {props.problem !== null && <ProblemAlert problem={props.problem} />}
        {props.notice}
        {chosen !== undefined && (
          <MentionChoices
            id={choicesId}
            choices={choices}
            highlighted={choices.indexOf(chosen)}
            onChoose={choose}
          />
        )}
        <InputGroup>
          {composed.images.length > 0 && (
            <InputGroupAddon align="block-start" className="flex-wrap gap-2">
              {composed.images.map((image, index) => (
                <span key={index} className="relative">
                  <Attachment
                    image={image}
                    index={index}
                    className="size-14 rounded-md border object-cover"
                  />
                  <InputGroupButton
                    size="icon-xs"
                    variant="secondary"
                    className="absolute -top-1.5 -right-1.5 rounded-full"
                    aria-label={`Remove attachment ${index + 1}`}
                    onClick={() =>
                      setComposed((current) => ({
                        ...current,
                        images: current.images.filter((_, at) => at !== index),
                      }))
                    }
                  >
                    <X />
                  </InputGroupButton>
                </span>
              ))}
            </InputGroupAddon>
          )}
          <InputGroupTextarea
            ref={textarea}
            aria-label="Message"
            aria-controls={chosen === undefined ? undefined : choicesId}
            aria-activedescendant={chosen === undefined ? undefined : `${choicesId}-${chosen.id}`}
            className="max-h-60 p-3"
            placeholder={props.placeholder}
            value={composed.message}
            onChange={(event) => {
              const message = event.target.value
              followCaret(event.target)
              setComposed((current) => ({ ...current, message }))
            }}
            onSelect={(event) => followCaret(event.currentTarget)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onDragOver={(event) => {
              if (holdsFiles(event)) event.preventDefault()
            }}
            onDrop={(event) => {
              if (!holdsFiles(event)) return

              event.preventDefault()
              addImages(event.dataTransfer.files)
            }}
          />
          <InputGroupAddon align="block-end" className="min-w-0 items-end gap-1">
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1 [&>button]:min-w-0">
              {props.pickers}
            </div>
            <div className="ml-auto flex shrink-0 gap-1">
              {props.onStop !== null && (
                <InputGroupButton
                  size="icon-sm"
                  variant="secondary"
                  className="rounded-full"
                  aria-label="Stop"
                  onClick={props.onStop}
                >
                  <Square className="fill-current" />
                </InputGroupButton>
              )}
              <InputGroupButton
                type="submit"
                size="icon-sm"
                variant="default"
                className="rounded-full"
                disabled={props.blocked || composed.message.trim() === ""}
                aria-label="Send"
              >
                <ArrowUp />
              </InputGroupButton>
            </div>
          </InputGroupAddon>
        </InputGroup>
        {props.children}
      </div>
    </form>
  )
}
