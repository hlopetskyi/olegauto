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
