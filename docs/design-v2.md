# bb-plugin-browser v2 — one real browser, N agents, no view to stream

**Status:** implemented
**Date:** 2026-08-12
**Supersedes:** the streamed-panel architecture in `docs/design.md`

> **Amended 2026-08-12 — any Chromium, not only Brave.** This document says
> "Brave" throughout because Brave is what it was designed and measured
> against, and that record is left as it was written. The shipped plugin drives
> **any Chromium-family browser** — Brave, Chrome, Chromium, Edge, Vivaldi,
> Opera — because every mechanism below is CDP and none of it is vendor-
> specific. `src/browsers.ts` detects the first one installed; the plugin's
> `browserPath` setting pins a specific binary. Firefox and Safari remain
> impossible: no CDP. Read "Brave" below as "the detected browser".

One dedicated Brave profile on the host, driven over CDP. Every thread gets its
own tab. The window is real, so a human takes over by using it.

## What this replaces, and why

v1 gave agents a browser and tried to stream it into a bb panel. The agent half
worked. The panel half failed repeatedly in live use, and the failures were not
independent bugs:

| Symptom | Cause |
|---|---|
| Pages destroyed every ~30s, a login lost twice | A thread's tab was identified by an `agent-browser` **label held in a daemon's memory**. Anything that restarted the daemon lost every label; the next command rebound, and rebinding *replaces* the page |
| bb itself went sluggish, needed a restart | An `<img>` on a multipart response holds one of the browser's six connections to bb's origin; starve that pool and bb's own API calls queue behind it |
| "It froze" (three separate times) | Chrome emits a screencast frame at cast start and then only on repaint, so a reconnecting viewer waited for a repaint a settled page never makes |
| "I had to click before typing worked" | Keystrokes only reach a focused element |
| "Chrome for Testing is only for automated testing" | `agent-browser` downloads a stripped automation build |

Four of those five are properties of *streaming a browser into a web panel*.
Removing the panel removes them outright rather than patching them.

## The architecture

```
bb plugin ──Playwright connectOverCDP──> Brave (dedicated profile, own window)
                                          ├── tab: thread A   ← agent A drives
                                          ├── tab: thread B   ← agent B drives
                                          └── tab: whatever the user opens
```

- **One browser**, launched by the plugin: the real `/Applications/Brave Browser.app`
  binary, a dedicated profile directory, `--remote-debugging-port=0` (the actual
  port is read from the profile's `DevToolsActivePort`), and
  `--disable-blink-features=AutomationControlled`.
- **One tab per thread**, remembered by CDP **`targetId`**.
- **Playwright** for page actions; **raw CDP** for target lifecycle and anything
  Playwright does not expose.
- **No panel, no MJPEG, no screencast, no input forwarding.**

### Why a targetId fixes the thing labels broke

This is the whole reason for v2, so it is worth stating precisely. An
`agent-browser` label lives in that session's daemon process. A `targetId` lives
in **the browser**. Restart the plugin, the daemon, or bb itself and the
targetId is still valid and still names the same tab — so a thread finds its
page again instead of replacing it.

Measured (2026-08-12), three agents on one real Brave:

```
agent 1 opened example.com     reads example.com
agent 2 opened example.org     reads example.org
agent 3 opened www.iana.org    reads www.iana.org
isolated: true

after agent 2 navigates away:
  agent 1: https://example.com/          unchanged
  agent 2: https://example.com/?moved
  agent 3: https://www.iana.org/…        unchanged
```

There is no shared "current tab" to corrupt. Concurrency is a property of CDP
sessions, not something this plugin has to arrange.

### Why a real Brave

Verified: real Brave answers CDP as `Chrome/151.0.7922.108`, non-headless, no
"for testing" banner, and auto-updates like any other app. Playwright's
`connectOverCDP` attaches to it and gives a full `Page` per tab, including
`ariaSnapshot()` — a better structured view than v1 had:

```
- heading "Example Domain" [level=1]
- paragraph: This domain is for use in documentation examples…
- paragraph:
  - link "Learn more":
    - /url: https://iana.org/domains/example
```

A dedicated profile rather than the user's own: driving their everyday browser would
mean running it with remote debugging permanently, which hands every local
process control of all his browsing. The dedicated profile is the same real
Brave, its own window, logged in once.

## Human takeover

There is nothing to build. The agents' Brave window is on screen; switch to it
and use it. A verified consequence: a human tab opened in that window coexists
with agent tabs and does not disturb them.

Etiquette, enforced in code: **the plugin only ever closes tabs it opened.** A
tab the user opens is never reaped, however idle it looks.

## Lifecycle, and the rule v1 got wrong

**The browser is not shut down when the plugin reloads.** v1 tore it down on
dispose, which destroyed every page and every label, which caused the churn.
v2 leaves it running and *reattaches* — the targetIds are still valid.

- Launch on first use; reattach on every later load.
- An idle reaper closes tabs this plugin opened that no thread has used for
  `idleMinutes`, and never touches a tab it did not open.
- Thread archived or deleted → close that thread's tab.
- The browser is shut down only when the user asks for it (`bb browser quit`).

## What survives from v1

The parts that were never the problem: the tool surface
(`browser_open/read/snapshot/click/type/eval/screenshot/close`), the `bb browser`
CLI, the agent skill, the ancestry-walked session key (spawned threads share a
page, forks get their own), the http/https-only allowlist, and the output caps.

## What is deleted

`engine.ts` (agent-browser), the label/marker binding in `pages.ts`, the origin
and browser-identity machinery in `page-registry.ts`, `screencast.ts`,
`stream.ts`, `panel-rpc.ts`, the panel in `app.tsx`, the URL-restore path, and
the foreground keepalive. Roughly half the plugin, and the half that produced
every incident.

The `::browser{}` message directive goes too — with no panel to open, it has
nothing to do.

## The test that would have caught all of it

v1 had 335 tests and not one crossed a time boundary, which is why a bug that
destroyed a page every 30 seconds passed everything. v2 starts with these:

1. **Survives time.** Open a page, wait past a sweep interval, assert it is the
   same `targetId` and the same URL.
2. **Survives a plugin reload.** Open a page, drop the connection, reconnect,
   assert the thread finds the same tab rather than creating one.
3. **Survives a peer.** Two threads, interleaved commands, assert neither moves
   the other's tab — the v1 defect that hid for five tasks.
4. **Never closes a human's tab.** Open a tab outside the plugin, run the
   reaper, assert it is untouched.

These are integration tests against a real Brave on a throwaway profile, not
unit tests against a fake. The fakes are what let v1's defects through.

## Phases

1. **Launcher + connection + tools.** Brave starts, Playwright attaches, a
   thread gets a tab, the eight tools and the CLI work against it. This is the
   point where other threads can use it.
2. **Lifecycle.** Reattach-on-reload, idle reaper for our tabs only, thread
   teardown, `bb browser quit`.
3. **Removal.** Delete the panel, stream, screencast and binding machinery; cut
   `scripts/verify` over to the new surface.

## Open questions

- **Login maintenance.** The dedicated profile needs the user to log into the sites
  agents use, once, in that window. Worth doing deliberately rather than
  discovering per site.
- **Remote debugging exposure.** The port is localhost-only, but any local
  process can drive that browser. Acceptable for a dedicated profile; it would
  not be for his main one.
- **x.com.** Whether a login there succeeds from this profile is still unknown —
  it failed twice in v1 and it was never established whether that was the panel
  or X refusing an automated sign-in. Worth testing early, on a profile whose
  loss costs nothing.
