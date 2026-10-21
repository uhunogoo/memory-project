# Issue tracker: Local Markdown

Issues and specs live in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- Specification: `.scratch/<feature-slug>/spec.md`.
- One implementation ticket per file:
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`.
- Record triage state in a `Status:` line near the top.
  Use the roles in `triage-labels.md`.
- Append comments and conversation history under `## Comments`.

## Publishing and fetching

When a skill says “publish to the issue tracker”, create the appropriate
Markdown file using these conventions.

When fetching a ticket, read its referenced path. Resolve a ticket number
within its feature directory; ask for the feature if the number is ambiguous.
