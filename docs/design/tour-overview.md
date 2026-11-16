# Tour overview studies

Open [tour-overview.html](tour-overview.html) directly. It is self-contained and uses no network, model, backend, or saved Tour data.

The standalone study captures the visual direction using hand-authored examples. The in-app implementation and generation checks are described below.

## Examples

- **Branching · OpenCode:** the existing Claude Code and pi paths beside an added OpenCode service and event translation path. Based on Kevin's supplied screenshot, not on OpenCode source in this checkout. Chapter boundaries and code outlines are illustrative. The 59-file count comes from that screenshot; only three preview Chapters are represented.
- **Linear · Validation:** a synthetic submission flow. The old direct connection to storage is removed; validation is inserted before the existing save. Shows the successful path, without adding an unrelated error-handling flow.
- **Outline · Settings:** a synthetic change grouping configuration keys. Uses the burst of 20 and refill of five from the existing server demo, with an invented previous flat configuration. An outline expresses nesting more clearly than a graph.

## Interactions to assess

- Select an example to replace the overview and Chapter preview together.
- Select a map node or outline line to open its Chapter and highlight its corresponding illustrative outline line.
- Use the reading order or Start reading to enter a Chapter, then return with Tour overview.
- Read a branching map at normal text size. At narrow widths the map scrolls within its region; it does not shrink labels or overflow the page.
- Use the keyboard to reach every control. Connections also have an expandable text description.

## Design choices

The overview carries one map, with old and new paths visible together. Change color belongs to the nodes and connections that changed. The study places its nodes and connectors by hand; the app draws Mermaid with Pele.

The standalone Chapter preview uses clearly labeled illustrative outlines, not fabricated source diffs or line numbers.

## In-app examples

The fake backend also includes three PRs named **Tour example: add OpenCode for ordinary Conversations**, **Tour example: validate before saving**, and **Tour example: group rate-limit settings**. Run `pnpm dev:fake`, open one in Reviews, select Tour, and choose Write Tour, then Start reading.

These examples use small synthetic source files and real patches. They exercise saved Tour decoding, Mermaid diagrams drawn by Pele, code-target validation for outlines, and navigation to selected lines on either side of the diff. The OpenCode example is still an illustration of Kevin's supplied screenshot, not the actual OpenCode implementation.

When writing a Tour, the Tour engine chooses one overview map: a diagram for flows, branches, and changed routes, or a plain-language outline for nesting and hierarchy. Overview targets can cross files and Chapters; Chapter visuals stay local and add detail beyond that map. Trivial changes can omit the map. A diagram is a Mermaid flowchart whose nodes carry the `added` or `removed` class; Glass colors them and draws removed connections dotted. Labels describe behavior and relationships.

Diagrams Pele cannot draw are omitted, retaining a valid outline when supplied. Outdated Tours hide their visuals.
