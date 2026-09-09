<!-- agents-md ceiling: 63 lines -->
# AGENTS.md — bb-plugin-browser

A bb plugin giving every agent one real Chromium-family browser: a tab per thread,
headless by default, logins shared. [`README.md`](README.md) is the user-facing document
and `skills/browser/SKILL.md` is what agents are taught — change behaviour and you owe an
edit to the skill, not just to the code.

## Commands, all run 2026-09-09

```sh
npm install                 # rc=0
npm test                    # vitest — 10 files, 167 tests, 0 fail, 388ms
npm run typecheck           # tsc --noEmit, rc=0
npm run test:live           # NOT RUN in this pass: starts a real Brave, tens of seconds
sh scripts/verify [--clean] # drives the INSTALLED plugin; exit code = failures
```

**There is no CI in this repo** — `.github/` does not exist, so `git push` runs nothing
and a red suite reaches nobody. The three commands above are the entire gate and they are
yours to run.

## Two live readings you should not mistake for your own breakage

Both measured 2026-09-09 against the installed plugin, sandboxed and unsandboxed alike:

- **`scripts/verify` reads 6 pass / 6 fail on this machine.** Five failures are
  `net::ERR_NAME_NOT_RESOLVED` reaching `example.com` — the machine's egress, not the
  plugin — and disabling the Bash sandbox does not change it, so it is not a sandbox
  denial either. Do not "fix" the plugin for this.
- **`all 8 agent tools are registered` FAILS because the plugin now registers 10**
  (`browser_click|close|eval|open|read|screenshot|show|snapshot|type|upload`). The
  assertion in `scripts/verify` is stale, not the plugin.

## Layout

| path | what it is |
|---|---|
| `src/*.ts` | the logic — launch, profile, tabs, holder, mode, reaper, tools |
| `src/*.test.ts` | the fast suite, colocated |
| `src/*.integration.test.ts` | the live suite, run only by `npm run test:live` |
| `src/test-support/` | fakes (`memory-kv.ts`); no test reaches a real store |
| `server.ts` | the plugin entry the manifest points at — its test sits at the root too |
| `skills/browser/SKILL.md` | what agents read; ships with the plugin |

## Conventions that differ from the defaults

- **Two vitest configs, deliberately.** `vitest.config.ts` excludes
  `**/*.integration.test.ts` so the fast suite runs anywhere including the Bash sandbox,
  which cannot launch a browser at all; `vitest.live.config.ts` runs only those, with
  `fileParallelism: false` because they share one browser profile. Do not merge them —
  the separation is what stops the live checks being weakened for speed.
- **`playwright-core` and `zod` are the only runtime dependencies** and belong in
  `dependencies`. bb's managed git install resolves `--omit=dev`, so a runtime import
  parked in `devDependencies` builds in your clone and fails for every real user.
- **`file://` is refused before anything spawns.** That check closed a real local-file
  read; keep the refusal at the entry point, not behind a launch.

**Nothing about who may merge, how agents are spawned, or how the maintainer's
machine handles secrets belongs in this file, and none of it is stated here.**
Those are properties of a working environment, not of this project; if you are
contributing, your own conventions apply and nothing in this repo depends on
the maintainer's.
