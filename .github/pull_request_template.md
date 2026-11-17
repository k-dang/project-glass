<!--
Open with the problem in plain words, then the fix in a sentence or two.
Not an inventory of what changed. Use the words in GLOSSARY.md.
Name the Linear issue (PER-123) or the earlier PR this builds on.

Then the smallest picture of the change that a reviewer would otherwise
have to rebuild from the diff: pseudocode, a call tree, a component tree,
a shallow file tree, a Mermaid diagram, or a `diff` block of a changed
type or contract. Skip it when the opener already says everything.
-->

## Evidence

<!--
Show that it works, before and after. A screenshot or recording for UI
changes, or the test or command output that failed before and passes now.
Leave out what CI already shows: passing suites, lint, typecheck.
If something couldn't be checked, say what and why.
-->

## Merge risk

**Door:** two-way | one-way
<!--
two-way: reverting the code restores the old behavior.
one-way: hard to undo, such as stored data shapes, deleted user data, or
a contract other code depends on. Say what reverting would leave behind
and any rollout or recovery steps.
-->

**Blast radius:**
<!-- Who or what besides the changed code could notice. -->
