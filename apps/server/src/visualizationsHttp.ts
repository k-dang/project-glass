import { VISUALIZATIONS_PATH } from "@glass/contracts"
import { Effect, Option } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { PAGE_CONTENT_SECURITY_POLICY } from "./visualizationPage"
import { Visualizations } from "./Visualizations"

const missing = HttpServerResponse.text("No such Visualization.", { status: 404 })

export const VisualizationRoutes = HttpRouter.add(
  "GET",
  `${VISUALIZATIONS_PATH}/:id`,
  Effect.gen(function* () {
    const { id } = yield* HttpRouter.params
    const visualizations = yield* Visualizations

    if (id === undefined) return missing

    return yield* visualizations.page(id).pipe(
      Effect.map(
        Option.match({
          onNone: () => missing,
          onSome: (html) =>
            HttpServerResponse.text(html, {
              contentType: "text/html; charset=utf-8",
              headers: {
                "content-security-policy": PAGE_CONTENT_SECURITY_POLICY,
                "x-content-type-options": "nosniff",
              },
            }),
        }),
      ),
      Effect.catchTag("ThreadError", ({ message }) =>
        Effect.succeed(HttpServerResponse.text(message, { status: 500 })),
      ),
    )
  }),
)
