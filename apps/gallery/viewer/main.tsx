import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import type { GalleryData } from "../shot.ts"
import { Gallery } from "./Gallery.tsx"
import "./viewer.css"

const data = document.getElementById("gallery")?.textContent

if (data === undefined) throw new Error("The gallery page has no #gallery data")

const root = document.getElementById("root")

if (root === null) throw new Error("The gallery page has no #root to render into")

const gallery: GalleryData = JSON.parse(data)

createRoot(root).render(
  <StrictMode>
    <Gallery {...gallery} />
  </StrictMode>,
)
