import { tester } from "./rule-tester.ts"
import { noManualEffectErrorTagRule } from "../effect/rules/no-manual-effect-error-tag.ts"
import { noManualTagComparisonRule } from "../effect/rules/no-manual-tag-comparison.ts"
import { noManualTaggedConstructionRule } from "../effect/rules/no-manual-tagged-construction.ts"

tester.run("no-manual-effect-error-tag", noManualEffectErrorTagRule, {
  valid: [
    "import { Effect } from 'effect'; task.pipe(Effect.catchTag('Missing', () => Effect.succeed(null)));",
    "import { Effect } from 'effect'; task.pipe(Effect.catchTags({ Missing: () => Effect.succeed(null) }));",
    "import { Effect } from 'effect'; task.pipe(Effect.catchReason('RequestError', 'Missing', () => Effect.succeed(null)));",
    "import { Effect } from 'effect'; task.pipe(Effect.catch(error => Effect.succeed(error.message)));",
    "const missing = error._tag === 'Missing';",
  ],
  invalid: [
    {
      code: "import { Effect } from 'effect'; task.pipe(Effect.catch(error => error._tag === 'Missing' ? recover : fail));",
      errors: [{ messageId: "tag" }],
      output: null,
    },
    {
      code: "import * as Effect from 'effect/Effect'; Effect.catch(task, function(error) { return 'Missing' !== error['_tag'] ? fail : recover; });",
      errors: [{ messageId: "tag" }],
      output: null,
    },
    {
      code: "import { Effect } from 'effect'; task.pipe(Effect.catchIf(shouldRecover, error => error.reason._tag === 'Missing' ? recover : fail));",
      errors: [{ messageId: "reason" }],
      output: null,
    },
    {
      code: "Effect.catch(error => { switch (error['reason']['_tag']) { case 'Missing': return recover; default: return fail; } });",
      errors: [{ messageId: "reason" }],
      output: null,
    },
    {
      code: "Effect.catch(error => { switch (error._tag) { case 'Missing': return recover; default: return fail; } });",
      errors: [{ messageId: "tag" }],
      output: null,
    },
  ],
})

tester.run("no-manual-tag-comparison", noManualTagComparisonRule, {
  valid: [
    "import { Predicate } from 'effect'; const isMissing = Predicate.isTagged('Missing');",
    "import { Match } from 'effect'; Match.value(value).pipe(Match.tag('Missing', handle), Match.orElse(other));",
    "const message = error._tag;",
    "const same = error.code === 'Missing';",
    "Effect.catch(error => error._tag === 'Missing' ? recover : fail);",
    "Effect.catchIf(shouldRecover, error => error.reason['_tag'] === 'Missing' ? recover : fail);",
  ],
  invalid: [
    ...[
      "const missing = error._tag === 'Missing';",
      "const missing = 'Missing' != error['_tag'];",
      "const missing = error.reason._tag == 'Missing';",
      // The nested callback has its own branching responsibility.
      "Effect.catch(error => values.map(value => value._tag === 'Missing'));",
      // Aliases are not recognized as broad Effect handlers; the general rule still rejects branching.
      "import { Effect as Fx } from 'effect'; Fx.catch(error => error._tag === 'Missing' ? recover : fail);",
    ].map((code) => ({ code, errors: [{ messageId: "manualComparison" }], output: null })),
    {
      code: "switch (value['_tag']) { case 'Missing': handle(); break; default: other(); }",
      errors: [{ messageId: "manualSwitch" }],
      output: null,
    },
  ],
})

tester.run("no-manual-tagged-construction", noManualTaggedConstructionRule, {
  valid: [
    "import { Schema } from 'effect'; class Missing extends Schema.TaggedError<Missing>()('Missing', { path: Schema.String }) {} new Missing({ path: '/' });",
    "import { Data } from 'effect'; class Missing extends Data.TaggedError('Missing')<{ path: string }> {} new Missing({ path: '/' });",
    "Payload.make({ id: 1 });",
    "const { Ready } = Data.taggedEnum<State>(); Ready({ id: 1 });",
    "import { Match } from 'effect'; Match.when({ _tag: 'Missing' }, handle);",
    "import * as Match from 'effect/Match'; Match.not({ _tag: 'Missing' }, handle);",
    "const value = { tag: 'Missing' };",
  ],
  invalid: [
    "const value = { _tag: 'Missing', path: '/' };",
    "Effect.fail({ '_tag': 'Missing', path: '/' });",
    "const value = { ['_tag']: 'Missing' };",
    "const value = { ...fields, _tag: 'Missing' };",
    "Match.when(predicate, () => ({ _tag: 'Missing' }));",
  ].map((code) => ({ code, errors: [{ messageId: "manualConstruction" }], output: null })),
})
