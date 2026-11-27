import { Schema } from "effect"
import type { KeyboardInputEvent } from "electron"

type Modifier = "alt" | "control" | "meta" | "shift"

const KeyEvent = Schema.Struct({
  type: Schema.Literals(["keyDown", "rawKeyDown", "keyUp", "char"]),
  key: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  modifiers: Schema.optional(Schema.Number),
})

const decodeKeyEvent = Schema.decodeUnknownSync(KeyEvent)

const decodeInsertText = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))

const RENAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  [" ", "Space"],
])

const NAMED_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "Shift",
  "Control",
  "Alt",
  "Meta",
])

const MODIFIER_BITS: ReadonlyArray<readonly [number, Modifier]> = [
  [1, "alt"],
  [2, "control"],
  [4, "meta"],
  [8, "shift"],
]

const keyCodeOf = (key: string) => {
  const renamed = RENAMED_KEYS.get(key)

  if (renamed !== undefined) return renamed

  if (NAMED_KEYS.has(key) || key.length === 1 || /^F\d{1,2}$/.test(key)) return key

  throw new Error(`A Browser pane can't press ${key}`)
}

export const electronKeysOf = (params: Schema.JsonObject): ReadonlyArray<KeyboardInputEvent> => {
  const event = decodeKeyEvent(params)
  const bits = event.modifiers ?? 0
  const modifiers = MODIFIER_BITS.flatMap(([bit, name]) => ((bits & bit) !== 0 ? [name] : []))
  const text = event.text ?? ""

  if (event.type === "char") return [{ type: "char", keyCode: text, modifiers }]

  const pressed: KeyboardInputEvent = {
    type: event.type === "keyUp" ? "keyUp" : "keyDown",
    keyCode: keyCodeOf(event.key ?? text),
    modifiers,
  }

  return event.type === "keyDown" && text !== ""
    ? [pressed, { type: "char", keyCode: text, modifiers }]
    : [pressed]
}

export const electronTextOf = (params: Schema.JsonObject): ReadonlyArray<KeyboardInputEvent> =>
  Array.from(decodeInsertText(params).text, (character) => ({
    type: "char",
    keyCode: character,
    modifiers: [],
  }))
