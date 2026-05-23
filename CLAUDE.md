# OlegAuto — Claude Instructions

## Caveman Hard Rules

- Caveman compresses **agent conversational output only** — never file content written for humans
- Default mode: `full`. Never use `ultra`. Never use `wenyan`/Classical Chinese mode
- If anything fails, stop and report verbatim — do not silently skip

## Caveman Output Scope

Caveman style applies to: conversational responses, internal plans, commit messages, PR comments.

Caveman style MUST NOT apply to: `README.md`, any `*.md` under `docs/`, user-facing UI copy,
error messages shown to end users, admin panel labels, deployment guides.

When writing a file in the "MUST NOT" list, switch to normal full English regardless of caveman mode.

## Commit Rules

- Commit after every complex or multi-file change — do not batch unrelated changes into one commit
- Simple one-liner fixes may be grouped if clearly related
- Commit message: imperative, ≤50 chars subject, explain *why* in body if non-obvious
- Always push after committing unless told otherwise

## Obsidian — Conversation Context

- **Before starting work**: check `/Users/ruslanhlopeckij/Desktop/Obsidian_memory/Game/Changes/` for recent daily logs to understand what changed last session
- **During work**: key decisions, blockers, and session summaries go to Obsidian (the hook auto-logs file changes; manually note important architectural decisions)
- Use Obsidian as the source of truth for cross-session context — not conversation history

## GitNexus — Code Context

- At session start, `.gitnexus/` index is built automatically (hook already wired)
- Use GitNexus summaries for code context — read index/summary files, not full source trees
- Limit GitNexus reads to 1–2 targeted lookups per task to avoid token waste
- Never read the full codebase when a GitNexus summary answers the question
