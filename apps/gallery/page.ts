import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { GalleryData } from "./shot.ts"

const built = (name: string) => readFileSync(join(import.meta.dirname, "dist", name), "utf8")

const style = built("viewer.css")

const script = built("viewer.js")

if (script.includes("</script"))
  throw new Error("The viewer bundle contains </script, which would end its inline <script> early")

// WARNING: A page opened from disk can't load module scripts from other files, so everything is inlined.
export const galleryPage = (data: GalleryData) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glass App States</title>
<style>${style}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="gallery">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>
<script type="module">${script}</script>
</body>
</html>
`
