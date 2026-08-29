---
name: no-comments
description: The comment policy for this repo, load it before writing or reviewing code here. Also invoke for a cleanup pass on "clean comments", "comment pass", "trim comments", "too many comments".
---

# no-comments

Comments in this repo are banned by default. A comment earns its place only by
being load-bearing: delete it, and a competent reader loses something the code
cannot tell them. That deletion test is the whole policy; everything below is
elaboration.

Prose about what the code does belongs in `docs/` (see "Where prose goes"), not
above the function.

## The five comment types that may stay

1. **Why, not what.** A decision, trade-off, or constraint the code cannot
   express: `// bytes, not chars: the cursor is a byte offset`.
2. **Landmine warnings.** A change that looks safe but is not:
   `// checked before full on purpose: only affects a --full dry run`.
3. **Deliberate omissions.** Intentionally absent code a reader would mistake
   for a bug: `// no retry here: the threads view already excludes these`.
4. **External pointers, durable only.** Issue numbers (`#141`), stable doc
   paths (`docs/architecture.md`), RFCs. The comment must still stand on its
   own with the link removed; never point at moving targets (chat threads,
   section numbers, "the design doc").
5. **Toolchain annotations.** Pragmas, type directives, codegen markers.

Keep each one to a line or two. Apply Occam's razor to every comment you keep:
shortest wording that preserves the substance.

## Always delete

- **Narration**: restating what the next line does (`// loop over files`,
  `// return the result`). The bulk of AI-generated noise.
- **Signature restatement**: doc blocks that repeat the function name,
  parameter names, or return type. Rename the function instead.
- **Section banners and block-end markers** (`// ---- helpers ----`).
- **Change narration**: `// fixed X`, `// now uses Y`. That is the commit
  message's job.
- **Reviewer-directed justification**: comments arguing that the change is
  correct. That is the PR description's job.
- **Module essays**: multi-paragraph overviews of what a module owns and how
  it fits the system. Move the substance to `docs/architecture.md` and leave at
  most a one-line pointer.

## Where prose goes

- What a command does, flags, output: `README.md` (user guide) and
  `skills/cerebro/SKILL.md`.
- How modules fit together, design rationale, flows: `docs/architecture.md`.
- Operational details (hooks, scheduling, model tiering, source adapters): the
  other `docs/` pages.
- Load-bearing invariants: `CLAUDE.md`.

Do not reflexively document either: docs are only written for things a reader
cannot get from the code in reasonable time, because every documented detail is
a detail that can drift. Prefer clearer names and smaller functions over both
comments and docs.

## Cleanup pass (when invoked on existing code)

Comment-only edits, never behavior. For each comment, in order:

1. Narration or signature restatement -> delete.
2. Change narration -> delete.
3. Points at a moving target -> delete, or rewrite against a durable source.
4. Bloated why -> trim to the local invariant; move system-level narrative to
   `docs/architecture.md`.
5. Stale or wrong -> correct or delete.
6. None of the above and it passes the deletion test -> keep.

A comment that compensates for unclear code is a flag, not a keeper: report it
as a rename/refactor candidate instead of preserving the comment. Finish with
delete/rewrite/keep counts per file, then run `bun run check` and `bun test`.
