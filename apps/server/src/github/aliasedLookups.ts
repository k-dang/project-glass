import { Result, Schema } from "effect"

const AliasedResponse = <A extends Schema.Top>(answer: A) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(answer)))),
    errors: Schema.optional(
      Schema.Array(
        Schema.Struct({
          type: Schema.optional(Schema.String),
          message: Schema.String,
          path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
        }),
      ),
    ),
  })

export interface AliasedLookup<I, S extends Schema.Top, A> {
  readonly name: string
  readonly batchSize: number
  readonly declarations: (index: number) => string
  readonly selection: (index: number) => string
  readonly fragment: string
  readonly variables: (item: I, index: number) => ReadonlyArray<readonly [string, string | number]>
  readonly response: ReturnType<typeof AliasedResponse<S>>
  readonly decode: (answer: S["Type"], item: I) => A | null
}

export const aliasedLookup = <I, S extends Schema.Top, A>(
  lookup: Omit<AliasedLookup<I, S, A>, "response"> & { readonly answer: S },
): AliasedLookup<I, S, A> => ({ ...lookup, response: AliasedResponse(lookup.answer) })

const aliasOf = (index: number) => `lookup${index}`

export const aliasedQuery = <I, S extends Schema.Top, A>(
  lookup: AliasedLookup<I, S, A>,
  count: number,
) => {
  const indexes = Array.from({ length: count }, (_, index) => index)

  return `query ${lookup.name}(${indexes.map(lookup.declarations).join(", ")}) {
  ${indexes.map((index) => `${aliasOf(index)}: ${lookup.selection(index)}`).join("\n  ")}
}

${lookup.fragment}`
}

export const aliasedVariables = <I, S extends Schema.Top, A>(
  lookup: AliasedLookup<I, S, A>,
  items: ReadonlyArray<I>,
) => Object.fromEntries(items.flatMap((item, index) => lookup.variables(item, index)))

const missingTypes = new Set(["NOT_FOUND", "FORBIDDEN"])

export const aliasedAnswers = <I, S extends Schema.Top, A>(
  lookup: AliasedLookup<I, S, A>,
  items: ReadonlyArray<I>,
  { data, errors }: AliasedLookup<I, S, A>["response"]["Type"],
): Result.Result<ReadonlyArray<A | null>, string> => {
  const aliases = items.map((_, index) => aliasOf(index))

  const unanswered = errors?.find(
    (error) => !aliases.includes(String(error.path?.[0])) || !missingTypes.has(error.type ?? ""),
  )

  if (unanswered !== undefined) return Result.fail(unanswered.message)

  if (data == null) return Result.fail(`GraphQL ${lookup.name} answered without data`)

  return Result.succeed(
    items.map((item, index) => {
      const answer = data[aliasOf(index)]

      return answer == null ? null : lookup.decode(answer, item)
    }),
  )
}
