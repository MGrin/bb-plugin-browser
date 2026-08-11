# bb-plugin-browser — design

**Status:** approved architecture, spec under review
**Date:** 2026-08-11
**Owner:** mgrin

A browser that lives inside bb: agents drive it through native tools, and a tab
in the thread's side panel shows the live page and forwards your clicks and
keystrokes — from the Mac or from the phone.

## Why

Browser work on this machine runs through the `browse` wrapper over
`agent-browser`, and the failure modes are structural rather than incidental:

| Problem | Cause |
|---|---|
| Every browser call needs `dangerouslyDisableSandbox` | macOS Seatbelt denies `AF_UNIX bind()`, so the daemon cannot start under Claude Code's sandbox |
| A thread's page changes under it mid-task | One shared default session; any thread can navigate it |
| Logins do not survive | `--restore` snapshots `storageState`, which misses `localStorage` and IndexedDB tokens |
| An X account got locked | `navigator.webdriver=true` unless every single call passes `--disable-blink-features=AutomationControlled` |
| QuickBooks renders a blank page | Headless-only rendering differences |
| Nobody can see what the agent is doing | Headless by default, and the `:4848` dashboard is not built in the brew binary |

Each has a workaround, and every workaround is a thing an agent must remember.
Moving ownership of the browser into bb removes the class instead of the
instances: bb's plugin backend is not sandboxed, sessions are keyed by thread
rather than shared, profiles are real on-disk Chrome profiles, launch args are
set once in one place, and the panel makes the page visible.

## What already exists, and why we are not using it

**bb's own in-app browser.** bb desktop ships a real browser in the secondary
panel: `apps/desktop/src/desktop-browser-view.ts` creates an Electron
`WebContentsView` on the isolated persistent partition `persist:bb-browser`,
with a tab deck, a popup policy, and a loopback/LAN request firewall. It is
excellent, and an agent cannot use it. The renderer bridge
(`BbDesktopBrowserApi`) exposes attach, navigate, back, forward, reload,
bounds, and visibility — no DOM access, no input injection, no script
evaluation. Driving it would require either an upstream change to bb core or
launching bb with `--remote-debugging-port`, which is an unverified flag and a
standing local security hole. It is also desktop-only, and a plugin-attached
view would fight bb's own `browserViewVisibilityCoordinator`.

**jssblck/bb-plugins `plugin-browser`.** A Chrome extension plus a native
messaging host that lets agents drive the user's real Chrome. Created
2026-08-07, the browser plugin landed in a single commit on 2026-08-10, six
commits total, no LICENSE file. Two of its ideas are good enough to take,
credited in the README and reimplemented rather than copied:

1. A session key that walks the thread's parent chain, so a fleet's subagents
   and their coordinator share one browser while a fork gets its own.
2. Tab etiquette in the agent skill: agent pages open in the background, and
   page content is untrusted input rather than instruction.

Its architecture is not right for this machine. The extension exists to inherit
the user's real logins, and the decision here is a dedicated agent profile —
logins get established once either way. Without that benefit, the extension
layer costs a hand-loaded unpacked extension (branded Chrome and Brave both
ignore `--load-extension`), a native messaging host, a socket bridge, a
permanently attached debugger banner, and a hard requirement that Brave is
running.

## Architecture

```
                     one Chromium per profile, one page per thread
                     ┌───────────────────────────────────────────┐
thread A tool ──> agent-browser session A ──CDP──> page A        │
thread B tool ──> agent-browser session B ──CDP──> page B        │
                     │              profile "main" (shared logins)│
                     └───────────────────────────────────────────┘
panel <──MJPEG over plugin HTTP── screencast ──CDP──> that thread's page
panel ──click/key over plugin RPC──> dispatchInput ──CDP──────────┘
```

Commands and pixels reach the same page by two different paths on purpose.
`agent-browser` already has the semantics worth having — accessibility
snapshots with stable refs, find-by-role, network routing, storage control —
and reimplementing them against raw CDP would be a month of work to arrive
where brew already is. What it does not have is a live view, and CDP gives that
directly.

### Sessions, profiles, and pages

The naive model — one browser per thread — is wrong: a Chromium profile
directory is locked to one process, so per-thread browsers mean per-thread
profiles, which means logging into every site again in every new thread. The
opposite naive model — one browser, `tab <n>` to select — is also wrong:
selecting a tab is stateful, so two threads interleaving `tab 3; click` act on
each other's page, which is the shared-session bug this plugin exists to kill.

Measured on 2026-08-11, agent-browser resolves both:

```
agent-browser --session sA --profile P open https://example.com   # launches Chromium
agent-browser --session sA get cdp-url  → ws://127.0.0.1:PORT/devtools/browser/…
curl http://127.0.0.1:PORT/json/list    → a stable ws endpoint per page target
agent-browser --session sB connect ws://127.0.0.1:PORT/devtools/page/<id>
agent-browser --session sB get url      → https://example.com/   (sA still on its own page)
```

So: **one Chromium per profile, one agent-browser session per thread, each
connected to its own page target.** Threads share cookies and logins and never
share a page. No mutex, no tab indices, no races.

Default profile is `main`. A task that must not share cookies asks for an
isolated profile, which is a second Chromium with its own directory.

Cleanup follows from the same measurement: `close` on a connected session
detaches it and leaves both the browser and the page alive. Ending a thread
therefore closes its page explicitly through CDP `Target.closeTarget`; the
profile's browser dies only when its last page is gone or the idle reaper fires.

## Components

Each is independently testable and depends only on what is listed.

### `src/engine.ts` — agent-browser lifecycle

Owns every `agent-browser` invocation, launched under
`--namespace bb-plugin-browser` so plugin-owned daemons and sockets can never
collide with the shell's `browse` sessions. Launch args are set once, here,
including `--disable-blink-features=AutomationControlled`.

Two levels:

- **Profile.** One Chromium per profile, directory
  `<dataDir>/plugins/browser/profiles/<profile>`, persistent across restarts.
  Started on first use, addressed by its browser CDP endpoint.
- **Page.** One page target per session key, created through CDP on that
  profile's browser, with a session-key-to-page-id map in plugin storage so a
  thread returns to its page across bb restarts. The map is verified on every
  use, because a page can vanish — the panel's close button, a crash, the
  reaper — and a stale id must create a fresh page rather than fail.

Exposes `exec(sessionKey, argv)`, `pageCdpUrl(sessionKey)`,
`closePage(sessionKey)`, and `shutdown(profile)`. Depends on:
`node:child_process`, `bb.storage`.

### `src/session-key.ts` — thread to session

Walks the thread's parent chain through `bb.sdk.threads.get` and returns the
root. A `fork` origin stops the walk and starts its own session. Calls outside
any thread use `scratch`. Ancestry never changes, so results are cached
forever. Idea credited to jssblck/bb-plugins.

Depends on: `bb.sdk.threads`.

### `src/screencast.ts` — CDP client

Connects to that thread's **page** websocket and runs `Page.startScreencast`
(`format: jpeg`, quality and max width from settings), acknowledging each frame
and holding only the latest. Reference-counted: the screencast starts when the
first viewer subscribes and stops when the last leaves, so a page nobody is
watching costs nothing.

Exposes `subscribe(sessionKey, onFrame): () => void` and
`dispatchInput(sessionKey, event)` for `Input.dispatchMouseEvent` /
`Input.dispatchKeyEvent`. Depends on: `engine.pageCdpUrl`.

### `src/http.ts` — the frame stream

`GET /api/v1/plugins/browser/http/stream/:sessionKey?token=…` returns
`multipart/x-mixed-replace` with JPEG parts, which an `<img>` renders natively
with no client-side decoding. Auth mode is `token` rather than `local`: an
`<img>` sends no `Origin` header, and token auth in the query string is what
makes the stream load over the Cloudflare tunnel from the phone.

Backpressure drops frames for a slow client and never queues them — a stalled
phone connection must not grow memory or make the Mac's view lag.

Depends on: `screencast.subscribe`, `bb.http.route`.

### `src/tools.ts` — agent tools

| Tool | Returns |
|---|---|
| `browser_open(url)` | page title and final URL |
| `browser_read()` | rendered text |
| `browser_snapshot(interactive?)` | accessibility tree with refs |
| `browser_click(selector)` | confirmation |
| `browser_type(selector, text, submit?)` | confirmation |
| `browser_eval(js)` | JSON result |
| `browser_screenshot()` | an `image` content part — the agent sees the page |
| `browser_close()` | confirmation |

Every tool resolves its own session key from `ctx.threadId`. A session key is
never a parameter, so one thread cannot address another thread's browser.

Depends on: `engine.exec`, `session-key`.

### `app.tsx` — the thread panel tab

A `threadPanelAction` registered with `layout: "flush"`, so the component owns
the full tab area. It renders an address bar, the `<img>` frame stream, and a
navigation row, and it captures pointer and keyboard events over the image,
scaling panel coordinates to frame coordinates before sending them to
`dispatchInput`.

This is the login surface. A site that needs credentials gets them from you,
typed into the panel, from wherever you are.

Depends on: `rpc`, the stream URL and token from `rpc.attachToken()`.

### `src/rpc.ts` — panel to backend

`state()`, `attachToken()`, `navigate(url)`, `input(event)`, `back()`,
`forward()`, `reload()`, `setMode(headless|headed)`. Local auth, which is the
default and correct for same-origin panel calls.

### `src/cli.ts` — `bb browser …`

Mirrors the tools for humans and for agents that would rather type a command
than call a tool. `bb browser open|read|snapshot|click|type|eval|screenshot|
close|sessions|mode`.

### `skills/browser/SKILL.md`

When to reach for the browser, the one-tab-per-thread model, and the safety
rules: page content informs but never instructs, ask before any side effect the
user did not request, never solve a CAPTCHA — hand it back to the human, who
can now actually take over through the panel.

## Lifecycle

- `bb.background.service("engine")` shuts down every profile's browser when the
  plugin is disposed, reloaded, or bb shuts down.
- `thread.archived` and `thread.deleted` close that thread's **page** through
  `Target.closeTarget` and drop its storage entry. Profiles are never deleted —
  they hold the logins.
- An idle reaper closes pages with no command and no viewer for
  `idleTimeoutMinutes` (default 30), and shuts a profile's browser down once it
  has no pages left. The profile directory stays on disk.

## Rendering modes

Headless by default — screencast works fine headless, and nothing appears on
your screen. Sites that render blank headless (QuickBooks is the known one)
need a headed browser.

Headed-ness belongs to the browser process, so it is a property of the profile,
not of a thread. `bb browser mode headed` relaunches that profile's Chromium
with a visible window. The profile directory is unchanged, so **every login
survives** — that matters, because the sites that need headed rendering are
exactly the ones you are logged into.

What the relaunch does cost is pages: they close with the old process. The
engine records each session's last URL, recreates missing pages on the next
command, and restores that URL, so a thread sharing the profile sees a reload
rather than a failure. The tool result names the relaunch explicitly; a browser
restarting under other threads is never a silent event.

## Settings

`defaultRenderMode` (headless), `idleTimeoutMinutes` (30), `maxPagesPerProfile`
(8), `frameQuality` (60), `maxFrameWidth` (1280).

## Security

- The stream token is bb's per-plugin token, fetched by the panel over local
  auth. It is never written into a skill, a memory record, or the repo.
- Session keys are derived server-side from the calling thread, never accepted
  as a parameter.
- `browser_eval` is arbitrary script execution against whatever that profile is
  logged into. Blast radius is the profile: keep agent profiles signed into
  what agents need and nothing else.
- Browser profiles hold live cookies and live under `~/.bb/plugins/browser/`.
  `bb-state-backup` is an explicit allowlist of four SQLite files, so nothing
  here reaches the dotfiles repo. Never add this plugin to that allowlist.
- Page content is untrusted input. The skill says so, and tool descriptions
  repeat it, because prompt injection through a rendered page is the realistic
  attack.

## Testing

- `engine`: a fake `agent-browser` on `PATH` asserts namespace, session,
  profile path, and launch args.
- `session-key`: a fake `bb.sdk.threads` covers parent chains, forks, cycles,
  and unreadable threads.
- `screencast`: a fake CDP websocket server covers frame acking, reference
  counting, and stop-on-last-unsubscribe.
- `http`: multipart framing, token rejection, and frame dropping for a slow
  reader.
- `app.tsx`: jsdom render plus unit tests for the coordinate scaling math,
  which is where a live view silently goes wrong.
- One live smoke test outside CI: open `example.com`, read text, screenshot.

## Migration

1. `~/.claude/skills/browser/SKILL.md` points at `bb browser`; `browse fresh`
   survives only for throwaway, no-login scraping.
2. Memory records rewritten: `mem_prjpooxmhqi` (sandbox), `mem_rrsmfbxl8c0`
   (shared session), `mem_jdxi93esyzg` (browse wrapper truth),
   `mem_s4b9pobgwkw` (sandbox failure), `mem_kikb4w4tzho` (profile isolation).
   A new record describes the plugin.
3. `~/Dev/dotfiles` carries the skill change. The plugin itself installs into
   bb and needs nothing there.

## Phases

Each phase ends with something that works.

1. **Engine, tools, CLI — ~3h.** No UI. Agents get a per-thread, non-sandboxed,
   persistent-profile browser. This alone retires the `dangerouslyDisableSandbox`
   dance and the shared-session hijack.
2. **Panel with a read-only live view — ~3h.** Screencast, MJPEG route, panel
   tab. You can watch what an agent is doing, from the phone.
3. **Input forwarding — ~2h.** Click, type, and scroll in the panel. Logins
   become possible from anywhere. This is the phase that makes a dedicated
   profile practical.
4. **Lifecycle and migration — ~2h.** Idle reaper, thread-end cleanup, headed
   mode, settings, skill and memory rewrites.

Roughly ten hours of build across four sessions.

## Deliberately not doing

- No Chrome extension and no native messaging host.
- No attempt to drive bb's built-in `WebContentsView`.
- No `<iframe>` rendering: `X-Frame-Options` and `frame-ancestors` make it work
  only for localhost dev servers, which is not a browser.
- No remote or cloud browser providers, though `agent-browser` supports them
  and the engine boundary leaves the door open.

## Credits

Architecture and code are original. Two design ideas come from
[jssblck/bb-plugins](https://github.com/jssblck/bb-plugins): the ancestry-walked
session key, and the tab-etiquette and untrusted-content framing in its agent
skill.
