# Finance Tracker — take-home task

A personal finance tracker built with TanStack Start, Drizzle (Postgres via
embedded PGlite), TanStack Query, Tailwind/shadcn UI and Paraglide i18n.

**Your task is in [TASK.md](TASK.md).**

## Getting started

Requirements: Node.js 22 and pnpm 10 (`corepack enable` will pick up the
pinned version). Use `pnpm`, not `npm`. The exact Node version is pinned in
`.nvmrc` (`nvm use`) and in `devEngines.runtime`, so `pnpm install`
downloads it and every `pnpm run` script uses it, whatever your global Node
version is.

```bash
pnpm install
pnpm exec playwright install chromium   # for E2E tests
pnpm run dev                            # http://127.0.0.1:3000
```

No `.env` is needed for local development: the database is an embedded
PGlite instance under `./data/pg`. See `.env.example` for optional settings
(set `AI_FAKE=1` if you don't want to configure an AI provider).

`pnpm run check` runs typecheck, lint, unit tests and E2E tests together.
Project conventions are documented in [CLAUDE.md](CLAUDE.md) (identical to
[AGENTS.md](AGENTS.md)).

## How we'd like you to work

You're welcome — encouraged — to use AI coding agents. Treat the task as
you would a real feature in an unfamiliar codebase.

In the interview we'll ask you to:

- walk us through your workflow and your conversations with the agent(s);
- explain the design of your solution and how it fits the existing code;
- demo the feature running locally.

Please keep your agent session history and any agent configuration you
used so you can show them. Note that `.gitignore` excludes `.claude/`,
`.agents/`, `.mcp.json` etc. — remove those entries if you'd like to commit
your setup.
