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

- After every meaningful change: commit AND push to GitHub automatically — do not wait for user to ask
- Simple one-liner fixes may be grouped if clearly related
- Commit message: imperative, ≤50 chars subject, explain *why* in body if non-obvious
- Always push immediately after committing

## Obsidian — Conversation Context

- **Before starting work**: check `/Users/ruslanhlopeckij/Desktop/Obsidian_memory/Game/Changes/` for recent daily logs to understand what changed last session
- **During work**: key decisions, blockers, and session summaries go to Obsidian (the hook auto-logs file changes; manually note important architectural decisions)
- Use Obsidian as the source of truth for cross-session context — not conversation history

## GitNexus — Code Context

- At session start, `.gitnexus/` index is built automatically (hook already wired)
- Use GitNexus summaries for code context — read index/summary files, not full source trees
- Limit GitNexus reads to 1–2 targeted lookups per task to avoid token waste
- Never read the full codebase when a GitNexus summary answers the question

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **olegauto** (136 symbols, 139 relationships, 0 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/olegauto/context` | Codebase overview, check index freshness |
| `gitnexus://repo/olegauto/clusters` | All functional areas |
| `gitnexus://repo/olegauto/processes` | All execution flows |
| `gitnexus://repo/olegauto/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
