import { expect, it } from "vite-plus/test"
import { electronKeysOf, electronTextOf } from "./cdpKeys"

it("turns Playwright's key events into Electron's, typing a key's text and renaming arrows", () => {
  expect(electronKeysOf({ type: "keyDown", key: "a", text: "a", modifiers: 0 })).toEqual([
    { type: "keyDown", keyCode: "a", modifiers: [] },
    { type: "char", keyCode: "a", modifiers: [] },
  ])
  expect(electronKeysOf({ type: "rawKeyDown", key: "ArrowDown", modifiers: 10 })).toEqual([
    { type: "keyDown", keyCode: "Down", modifiers: ["control", "shift"] },
  ])
  expect(electronKeysOf({ type: "keyUp", key: "F5" })).toEqual([
    { type: "keyUp", keyCode: "F5", modifiers: [] },
  ])
  expect(() => electronKeysOf({ type: "keyDown", key: "AudioVolumeUp" })).toThrow(
    "A Browser pane can't press AudioVolumeUp",
  )
})

it("types text one character at a time, keeping a character outside the basic plane whole", () => {
  expect(electronTextOf({ text: "é😀" })).toEqual([
    { type: "char", keyCode: "é", modifiers: [] },
    { type: "char", keyCode: "😀", modifiers: [] },
  ])
})
