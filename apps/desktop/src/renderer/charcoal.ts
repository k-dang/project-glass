import type { ThemeRegistration } from "@pierre/diffs"

export const charcoal = {
  name: "glass-charcoal",
  displayName: "Glass Charcoal",
  type: "dark",
  colors: {
    "editor.background": "#1b1b1b",
    "editor.foreground": "#cecece",
    "gitDecoration.addedResourceForeground": "#63cd7b",
    "gitDecoration.deletedResourceForeground": "#ef8586",
    "gitDecoration.modifiedResourceForeground": "#a6a8ff",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#999999" } },
    { scope: ["keyword", "storage"], settings: { foreground: "#d995ca" } },
    {
      scope: ["entity.name.function", "support.function"],
      settings: { foreground: "#78cbd0" },
    },
    {
      scope: ["entity.name.type", "support.type", "support.class", "storage.type"],
      settings: { foreground: "#7ac8e9" },
    },
    { scope: ["string", "constant.other.symbol"], settings: { foreground: "#e8c778" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#e5a36e" } },
    { scope: "entity.name.tag", settings: { foreground: "#d995ca" } },
    { scope: "entity.other.attribute-name", settings: { foreground: "#78cbd0" } },
    { scope: "keyword.operator", settings: { foreground: "#cecece" } },
    { scope: "markup.heading", settings: { foreground: "#7ac8e9", fontStyle: "bold" } },
    { scope: "markup.bold", settings: { fontStyle: "bold" } },
    { scope: "markup.italic", settings: { fontStyle: "italic" } },
    { scope: "markup.inserted", settings: { foreground: "#63cd7b" } },
    { scope: "markup.deleted", settings: { foreground: "#ef8586" } },
  ],
} satisfies ThemeRegistration
