# Domain docs

## Layout and reading rules

This repository uses a single-context layout:

- `GLOSSARY.md` at the repository root defines domain terminology.
- `docs/adr/` contains architectural decision records.

Before exploring the codebase, read the glossary and ADRs relevant to the task.
If they do not exist, proceed silently. Create them through domain-modeling
when terminology or decisions are actually resolved.

## Terminology

Use glossary terms consistently in code, tests, issues, and proposals.
When a needed concept is missing, reconsider the wording or identify the gap
for domain-modeling.

## Architectural decisions

Explicitly identify any proposal that contradicts an existing ADR.
Name the ADR and explain why the decision should be reconsidered.
