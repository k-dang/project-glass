import {
  type AgentCommand,
  type Image,
  ImageMediaType,
  isNothingUnsent,
  type MessageInput,
  nothingUnsent,
  type SentMessage,
} from "@glass/contracts"
import { Document } from "@tiptap/extension-document"
import { Paragraph } from "@tiptap/extension-paragraph"
import { Text } from "@tiptap/extension-text"
import { Placeholder, UndoRedo } from "@tiptap/extensions"
import { Selection, TextSelection } from "@tiptap/pm/state"
import { type EditorView } from "@tiptap/pm/view"
import { EditorContent, useEditor } from "@tiptap/react"
import { Predicate, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { ArrowUp, LoaderCircle, Paperclip, Square, X } from "lucide-react"
import { memo, type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { InputGroup, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group"
import { Suggestion, Suggestions } from "@/components/ui/suggestion"
import { noCommands, noFiles } from "./agentsArea"
import { CommandHighlight, useCommandPicker } from "./Commands"
import { pastedSlice, toContent, Mention, toMessage } from "./composerDocument"
import { MarkdownStyling } from "./markdownStyling"
import { useMentionPicker } from "./Mentions"
import { type Problem } from "./problems"
import { ProblemAlert } from "./ProblemAlert"

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

const extensions = [
  Document,
  Paragraph,
  Text,
  Mention,
  MarkdownStyling,
  CommandHighlight,
  UndoRedo,
  Placeholder.configure({
    placeholder: ({ editor }) => {
      const { attributes } = editor.options.editorProps

      return Predicate.isFunction(attributes) ? "" : (attributes?.["aria-placeholder"] ?? "")
    },
  }),
]

export type ComposerSuggestion = { label: string; prompt: string }

const takeText = (view: EditorView, data: DataTransfer | null, from: number, to = from) => {
  const text = data?.getData("text/plain") ?? ""

  if (text === "") return false

  const { tr } = view.state
  tr.replaceRange(from, to, pastedSlice(view.state.schema, text))
  view.dispatch(
    tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(to, 1)), -1)).scrollIntoView(),
  )

  return true
}

export function MessageBox(props: {
  composed: SentMessage
  setComposed: (update: (current: SentMessage) => SentMessage) => void
  label: string
  placeholder: string
  textOnly?: boolean
  holdUntilAccepted?: boolean
  allowEmpty?: boolean
  attachment?: ReactNode
  blocked: boolean
  problem: Problem | null
  notice?: ReactNode
  send: (message: MessageInput) => Promise<boolean>
  steer: ((message: MessageInput) => Promise<boolean>) | null
  recall: SentMessage | null
  onStop: (() => void) | null
  commands?: ReadonlyArray<AgentCommand>
  files?: ReadonlyArray<string>
  pickers?: ReactNode
  suggestions?: ReadonlyArray<ComposerSuggestion>
  children?: ReactNode
}) {
  const { composed, setComposed } = props
  const sending = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [awaiting, setAwaiting] = useState(false)

  const [content] = useState(() => toContent(composed.message))

  const editor = useEditor({
    extensions,
    content,
    onUpdate: (event) => {
      const message = toMessage(event.editor.state.doc.content)
      setComposed((current) => ({ ...current, message }))
    },
  })

  const mentions = useMentionPicker(editor, !props.textOnly, props.files ?? noFiles)
  const commands = useCommandPicker(editor, props.commands ?? noCommands)
  const picker = mentions.activeDescendant === null ? commands : mentions

  useLayoutEffect(() => {
    if (composed.message === toMessage(editor.state.doc.content)) return
    editor
      .chain()
      .setContent(toContent(composed.message), { emitUpdate: false })
      .command(({ tr }) => {
        tr.setSelection(Selection.atEnd(tr.doc)).setMeta("addToHistory", false)

        return true
      })
      .run()
  }, [editor, composed.message])

  const written = (): SentMessage => ({ ...composed, message: toMessage(editor.state.doc.content) })

  const suggest = async (prompt: string) => {
    if (props.blocked || sending.current) return

    sending.current = true
    setAwaiting(true)

    try {
      await props.send({ message: prompt, images: [] })
    } finally {
      sending.current = false
      setAwaiting(false)
    }
  }

  const submit = async (deliver: (message: MessageInput) => Promise<boolean>) => {
    const sent = written()
    const message = sent.message.trim()

    if (props.blocked || sending.current || (message === "" && !props.allowEmpty)) return

    if (!props.holdUntilAccepted) {
      setComposed(() => nothingUnsent)

      if (!(await deliver({ message, images: sent.images })))
        setComposed((current) => (isNothingUnsent(current) ? sent : current))

      return
    }

    sending.current = true
    setAwaiting(true)

    try {
      if (await deliver({ message, images: sent.images })) setComposed(() => nothingUnsent)
    } finally {
      sending.current = false
      setAwaiting(false)
    }
  }

  const addImages = (files: Iterable<File>) =>
    void readImages(files).then((images) => {
      if (images.length > 0)
        setComposed((current) => ({ ...current, images: [...current.images, ...images] }))
    })

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return false

    if (picker.onKeyDown(event)) return true

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault()

      editor.commands.splitBlock()
    } else if (event.key === "Enter") {
      event.preventDefault()
      const steer = event.metaKey || event.ctrlKey ? props.steer : null
      void submit(steer ?? props.send)
    } else if (event.key === "ArrowUp" && isNothingUnsent(written()) && props.recall !== null) {
      event.preventDefault()
      const { recall } = props
      setComposed(() => recall)
    } else return false

    return true
  }

  const takeImages = (data: DataTransfer | null) => {
    const files = Array.from(data?.files ?? [])

    if (props.textOnly || !files.some(({ type }) => isMediaType(type))) return false
    addImages(files)

    return true
  }

  const onPaste = (view: EditorView, { clipboardData }: ClipboardEvent) => {
    const { from, to } = view.state.selection

    return takeImages(clipboardData) || takeText(view, clipboardData, from, to)
  }

  const onDrop = (view: EditorView, event: DragEvent, moved: boolean) => {
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos

    const taken =
      takeImages(event.dataTransfer) ||
      (!moved && at !== undefined && takeText(view, event.dataTransfer, at))

    if (taken) {
      event.preventDefault()
      view.focus()
    }

    return taken
  }

  const handlers = useRef({ onKeyDown, onPaste, onDrop })

  useLayoutEffect(() => {
    handlers.current = { onKeyDown, onPaste, onDrop }
  })

  const { label, placeholder } = props
  const { activeDescendant, listbox } = picker

  useLayoutEffect(() => {
    const combobox =
      activeDescendant === null
        ? {}
        : { "aria-controls": listbox, "aria-activedescendant": activeDescendant }

    editor.setOptions({
      editable: !awaiting,
      editorProps: {
        attributes: {
          ...combobox,
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": label,
          "aria-placeholder": placeholder,
          "aria-readonly": String(awaiting),
          "data-slot": "input-group-control",
          class: "max-h-60 w-full flex-1 overflow-y-auto p-3 text-base outline-none md:text-sm",
        },
        handleKeyDown: (_view, event) => handlers.current.onKeyDown(event),
        handlePaste: (view, event) => handlers.current.onPaste(view, event),
        handleDrop: (view, event, _slice, moved) => handlers.current.onDrop(view, event, moved),
        clipboardTextSerializer: (slice) => toMessage(slice.content),
      },
    })
  }, [editor, label, placeholder, awaiting, activeDescendant, listbox])

  return (
    <>
      {props.attachment !== undefined && (
        <div className="px-6 pt-2">
          <div className="mx-auto max-w-3xl rounded-lg border bg-muted/30 px-3 py-2">
            {props.attachment}
          </div>
        </div>
      )}
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
          {props.suggestions !== undefined && props.suggestions.length > 0 && (
            <Suggestions>
              {props.suggestions.map((suggestion) => (
                <Suggestion
                  key={suggestion.label}
                  disabled={props.blocked || awaiting}
                  onClick={() => void suggest(suggestion.prompt)}
                >
                  {suggestion.label}
                </Suggestion>
              ))}
            </Suggestions>
          )}
          <div className="relative">
            {picker.choices !== null && (
              <div className="absolute inset-x-0 bottom-full z-50 mb-2">{picker.choices}</div>
            )}
            <InputGroup className="has-[[data-slot=input-group-control]:focus-visible]:border-foreground/25 has-[[data-slot=input-group-control]:focus-visible]:ring-0">
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
              <EditorContent editor={editor} className="w-full min-w-0" />
              <InputGroupAddon align="block-end" className="min-w-0 items-end gap-1">
                {!props.textOnly && (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      accept={ImageMediaType.literals.join(",")}
                      multiple
                      hidden
                      onChange={(event) => {
                        addImages(event.currentTarget.files ?? [])
                        event.currentTarget.value = ""
                        editor.commands.focus()
                      }}
                    />
                    <InputGroupButton
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label="Attach images"
                      title="Attach images"
                      disabled={awaiting}
                      onClick={() => fileInput.current?.click()}
                    >
                      <Paperclip />
                    </InputGroupButton>
                  </>
                )}
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
                    disabled={
                      props.blocked ||
                      awaiting ||
                      (composed.message.trim() === "" && !props.allowEmpty)
                    }
                    aria-label="Send"
                    aria-busy={awaiting}
                  >
                    {awaiting ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
                  </InputGroupButton>
                </div>
              </InputGroupAddon>
            </InputGroup>
          </div>
          {props.children}
        </div>
      </form>
    </>
  )
}
