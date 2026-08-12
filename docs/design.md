# bb-plugin-browser — design

**Status:** built. This document describes the plugin as it exists on
`feat/browser-plugin`, not as it was originally specified — where the two
differ, the difference is stated rather than edited away, because the reasons
are the useful part.
**Date:** written 2026-08-11, reconciled with the implementation 2026-08-11
**Owner:** mgrin

A browser that lives inside bb: agents drive it through native tools, and a tab
in the thread's side panel shows the live page and forwards your clicks and
keystrokes — from the Mac or from the phone.

## Why

Browser work on this machine ran through the `browse` wrapper over
`agent-browser`, and the failure modes were structural rather than incidental:

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

Re-checked mid-build, when the resemblance between bb's "Open browser" launcher
and this plugin's panel came up: bb's browser and this one are two different
browsers (Electron `persist:bb-browser` versus agent-browser's Chromium under
`<dataDir>/plugins/browser/profiles/main`), so bb's panel can never show the
agent's page. bb's only built-in agent tool is `update_environment_directory`;
there is no built-in browser tool, so nothing here duplicates bb core.

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
                     one Chromium per profile, one labelled tab per thread
                     ┌───────────────────────────────────────────┐
thread A tool ──> agent-browser session A ──> tab "bbpage" (A's) │
thread B tool ──> agent-browser session B ──> tab "bbpage" (B's) │
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
profiles, which means logging into every site again in every new thread. So the
profile is shared, and the isolation has to happen one level down, at the tab.

**The mechanism changed after this document was first written, and the original
one does not work.** The design originally specified binding a session to a
page by its CDP websocket:

```
agent-browser --session sB connect ws://127.0.0.1:PORT/devtools/page/<id>
agent-browser --session sB get url      # → the page you named, supposedly
```

Measured against agent-browser 0.33.2: `connect` attaches the session to the
**browser** and ignores the `/devtools/page/<id>` path entirely. The session
lands on some other tab, and which one varies. The original spike looked like a
success only because the page it named also happened to be the first page in
the browser — a one-tab browser hides this completely. A discriminating probe
(four tabs; name the second, active the first) returns the wrong page every
time. Tasks 4 through 8 were built on the false version, and the panel would
have streamed a blank tab while the agent worked in another one.

**Write this down so nobody re-derives it: `connect <page-websocket>` is not a
bind.**

What replaced it is a **session-local tab label**, re-selected inside every
command. Each command is one `agent-browser batch --bail` invocation, with the
step list as JSON on stdin:

```json
[["connect", "ws://127.0.0.1:PORT/devtools/browser/…"],
 ["tab", "bbpage"],
 ["eval", "\"bbready-<uuid>\""],
 ["read"]]
```

Four measured facts force exactly that shape:

- **`connect` every time.** It is per-invocation. A session whose daemon has
  been restarted and does not reconnect launches a Chromium of its own on a
  throwaway profile — a stray, logged-out browser that nothing ever closes.
- **Tab ids (`t1`, `t2`, …) and labels are session-local.** Two sessions
  disagree about which tab is `t3`, and one session cannot select a label
  another assigned. That is why a single constant label (`bbpage`) suffices,
  and why a page must be created *by* the session that will drive it —
  `tab new --label` is the only command that assigns one.
- **A session's selected tab is silently stolen** whenever any new page appears
  in the browser, including a background tab another thread just opened. So
  selecting once and remembering it is not a binding either; selection is
  re-done inside every command, and `--bail` stops the batch before the real
  command runs if the select fails. A session that has lost its tab therefore
  never acts on somebody else's page, which is what makes the retry below safe.
- **The uuid marker** is both how the real command's output is located in the
  batch's combined stdout and how "the session lost its tab" is told apart from
  "the command failed", without parsing an error message. A missing marker
  triggers exactly one rebind (a fresh, freshly labelled page) and one retry; a
  second failure is reported.

Isolation was verified against `Target.getTargets` rather than session
self-reports, using a scene where "bound", "oldest", "newest" and "foreground"
each predict a different tab: only "bound" survives, and the same probe fails
against the pre-fix commit. 25 rounds of racing concurrent page creation
produced zero wrong-tab navigations.

One more measured rule, load-bearing everywhere: a thread's session passes
`--namespace` and `--session` and **never `--profile`**. Passing `--profile` on
an attaching session asks agent-browser to launch a second Chromium against a
profile directory the first already holds; Chromium aborts with *"Failed to
create a ProcessSingleton for your profile directory"* and that session is dead
for every later command. Only a profile's control session launches, and the
engine guarantees the browser is up before any attach (one idempotent
`get cdp-url` per profile per process lifetime).

So: **one Chromium per profile, one agent-browser session per thread, each
selecting its own labelled tab inside every command.** Threads share cookies
and logins and never share a page.

Default profile is `main`, and it is the only one today: `profileFor` is a
constant in `server.ts`. Per-project or isolated profiles are a later
decision — the seam exists, the setting does not.

Cleanup follows from the same measurements: `close` on a connected session
detaches it and leaves both the browser and the page alive, so ending a thread
closes its page explicitly through CDP `Target.closeTarget`.

## Components

Each is independently testable and depends only on what is listed.

### `src/identity.ts` — the constants that must not drift

Plugin id, the `bb-plugin-browser` agent-browser namespace, the Chromium launch
args (`--disable-blink-features=AutomationControlled`), and the default profile
name. Four lines, in one place, because every one of them is a thing that broke
once when it was written twice.

### `src/engine.ts` — agent-browser lifecycle

Owns every `agent-browser` invocation — nothing else in the plugin spawns a
process — launched under `--namespace bb-plugin-browser` so plugin-owned
daemons and sockets can never collide with the shell's `browse` sessions.

Two modes:

- **Launch.** Passes `--profile <dataDir>/plugins/browser/profiles/<profile>`,
  `--args` (the anti-detection launch args) and, when the `headed` setting is
  on, `--headed`. Used only by the profile's control session
  (`<profile>-control`).
- **Attach** (`attach: true`). Passes `--namespace` and `--session` only. Every
  thread session runs this way, on both the bind and the command — proven live:
  the bind succeeds either way, and only the *following* command dies with the
  ProcessSingleton abort, which would have shipped a plugin that looked fine
  until it acted.

Before the first attach for a profile, the engine makes one idempotent
launch-mode `get cdp-url` call so a browser is guaranteed to exist. This is
deliberately *not* gated on in-memory "is it live" state: that state resets on
a plugin reload while the daemon and browser keep running, which is the most
ordinary case there is.

Exposes `run(args)`, `browserCdpUrl(profile)`, `shutdown(profile)`,
`shutdownAll()`. Depends on: `node:child_process`, `identity`.

`RunArgs` also carries `stdin` (the `batch` step list, as JSON — its argument
form splits on whitespace and would tear a selector apart) and `maxOutput`
(agent-browser's `--max-output`, which is a global flag and is rejected inside
a batch step).

### `src/cdp.ts` — a minimal CDP client

One websocket, request/response by id, plus event listeners. It has a connect
timeout (10s, injectable) because a socket that accepts TCP and never upgrades
otherwise produces a promise that never settles — which poisons a coalescing
map for the life of the process and silently kills the reaper, since a hang is
not a throw. Non-object frames (`null`, `42`, a bare string) are dropped rather
than dereferenced: reading `.id` off `JSON.parse("null")` throws *inside* the
listener, which is an uncaught exception in the plugin host.

### `src/browser-endpoint.ts` — talking to the browser, not the page

`listPageTargets`, `closeTarget`, `pageUrl`, `httpOriginOf`, `browserIdOf`, and
the `/json/version` reachability probe. Every listing closes its socket — a
leak here is one socket a minute forever, and invisible to every functional
assertion.

### `src/page-registry.ts` and `src/pages.ts` — the trust seam

These were one module and are now two, because the invariant *"watching must
never create a page or launch a browser"* was enforced by a comment and a
pre-check that guarded a different call than the one it protected.

- **`src/page-registry.ts` is read-only.** Lookups (`existingPageUrl`,
  `existingPageInfo`), the reaper surface (`listOpenPages`, `closeUnboundPage`),
  `closePage`, `forget`, and the storage schema. It does not import
  `engine.ts` and cannot reach it transitively.
- **`src/pages.ts` is launch-capable.** `bindingFor`, `rebind`, `pageUrlFor`,
  `shutdownBrowser`, `shutdownAllBrowsers`. It holds `engine`, and
  `Pages extends PageRegistry` by spreading the one shared registry instance,
  so a lookup through `pages` and the same lookup through the registry cannot
  diverge.

The stream route, the panel's read path, the screencast and the reaper take the
registry. Only `pages.ts` and `operations.ts` take the engine, and
`src/trust-seam.test.ts` walks the real import graph (type-only imports
included) to pin it.

A session-key-to-binding map lives in plugin storage — target id, profile, tab
label, and the browser's HTTP origin — so a thread returns to its page across bb
restarts. It is verified on every use, because a page can vanish (the panel, a
crash, the reaper) and a stale id must produce a fresh page rather than an
error. The remembered origin is probed over `/json/version` with a short
timeout and **checked against the browser's uuid** before anything is closed
through it: an ephemeral CDP port is freed when a browser exits, and adopting
whatever answers there next means closing a stranger's tabs once a minute,
unattended. That hazard was reproduced live in both directions.

Concurrent resolutions for one session key coalesce (a coordinator and its
subagents share a key by design, so this is the normal fleet case, and without
it every concurrent call orphans a tab). Rebinds coalesce in their own map, so
a rebind never joins the resolve it exists to replace.

### `src/session-key.ts` — thread to session

Walks the thread's parent chain through `bb.sdk.threads.get` and returns the
root. A `fork` origin stops the walk and starts its own session; an unreadable
ancestor stops it at the last node that could be read. Calls outside any thread
use `scratch`. Ancestry never changes, so results are cached forever — but a
*failed* fetch is never cached, since it may be transient. Idea credited to
jssblck/bb-plugins.

Depends on: `bb.sdk.threads`.

### `src/operations.ts` — what a browser can be asked to do

The plugin's own vocabulary (`open`, `read`, `snapshot`, `click`, `type`,
`evaluate`, `screenshot`, `close`), and the single funnel every caller passes
through — tools, CLI and panel alike. It builds the connect/select/marker/act
batch described above, does the one rebind-and-retry, and enforces two rules
the callers therefore cannot forget:

- **http and https only.** `z.url()` accepts `file://`, `javascript:` and
  `data:`; `open` + `read` on a `file://` URL is a local-file exfiltration path
  reachable by injection from any page the agent is already reading. Enforced
  here as well as in the tool schema, so the CLI inherits it. Probed with 42
  hostile strings (case variants, control-character prefixes, `view-source:`,
  `filesystem:`, `blob:`, protocol-relative, UNC) — all rejected at both layers
  with zero engine spawns.
- **Output caps.** `MAX_OUTPUT_CHARS` (40k) on every command whose output the
  *page* writes: `read`, `snapshot`, `eval` **and `open`**, because what `open`
  returns is the page's own `<title>`, which is as attacker-controlled as a
  body and is the first thing a hostile page gets to answer. Screenshots are
  refused above 3.5MB (base64 inflates by 4/3, and model APIs cap images at
  5MB).

It also holds the page for the duration of a command (`watch`/`touch`/
`unwatch` on the reaper), so a command slower than the idle timeout cannot have
its page closed half way through.

Depends on: `engine.run`, `pages`.

### `src/screencast.ts` — CDP screencast

Connects to a page websocket **the caller supplies** and runs
`Page.startScreencast` (`format: jpeg`, quality 60, max width 1280),
acknowledging each frame and holding only the latest. Reference-counted: the
cast starts when the first viewer subscribes and stops when the last leaves, so
a page nobody is watching costs nothing. Concurrent starts for one session are
gated by per-entry promise identity, so a stale start cannot orphan a newer
socket.

Exposes `subscribe(sessionKey, cdpUrl, onFrame): Promise<() => void>`,
`dispatchInput(sessionKey, event)`, `viewportOf(sessionKey)` and `stopAll()`.
Depends on: `cdp.ts`, and nothing else — deliberately. It has no way to resolve
a page, so it cannot be the reason one exists. `dispatchInput` **rejects when
nothing is casting** rather than resolving a page for the keystroke, which is
how a click aimed at a page that had just closed used to mint a blank one.

### `src/stream.ts` — the frame stream

`GET /api/v1/plugins/browser/http/stream?threadId=…&token=…` returns
`multipart/x-mixed-replace` with JPEG parts, which an `<img>` renders natively
with no client-side decoding.

Two corrections to the original design worth keeping visible:

- The file is `stream.ts`, not `http.ts`.
- The route takes **`?threadId=`**, not a `/stream/:sessionKey` path parameter.
  bb's plugin HTTP dispatcher matches registered routes by exact string
  equality, so a path-param route can never match a real request. The
  first-party `tasks` plugin hits the same constraint and solves it the same
  way (`/attachments/download?attachmentId=…`). The session key is derived
  server-side from the thread id; a `?sessionKey=` in the query is ignored.

Auth mode is `token` rather than `local`: an `<img>` sends no `Origin` header,
and token auth in the query string is what makes the stream load over the
Cloudflare tunnel from the phone.

A thread with no page open gets a **404**, not a freshly minted `about:blank`
tab: watching must never be the reason a page exists. A `subscribe` that
rejects produces a real **502** with a readable body rather than a 200 whose
multipart body errors out silently. Backpressure drops frames for a slow client
and never queues them (measured: 500 × 100KB frames at a non-reading reader
retained three chunks) — a stalled phone must not grow memory, lag the Mac's
view, or lag other viewers sharing the same cast.

Depends on: `screencast.subscribe`, `page-registry.existingPageUrl`,
`bb.http.route`.

### `src/tools.ts` — agent tools

| Tool | Returns |
|---|---|
| `browser_open(url)` | page title and final URL |
| `browser_read()` | rendered text |
| `browser_snapshot(interactive?)` | accessibility tree with refs (default: interactive only) |
| `browser_click(selector)` | confirmation |
| `browser_type(selector, text, submit?)` | confirmation (`submit` presses Enter after filling) |
| `browser_eval(expression)` | JSON result |
| `browser_screenshot()` | an `image` content part — the agent sees the page |
| `browser_close()` | confirmation |

Every tool resolves its own session key from `ctx.threadId`, and every
description carries the untrusted-content warning. A session key is never a
parameter — see Security for what that does and does not buy.

Depends on: `operations`, `session-key`.

### `app.tsx` — the thread panel tab

A `threadPanelAction` registered with `layout: "flush"`, so the component owns
the full tab area. It renders an address bar with **Go** and **Reload**, the
`<img>` frame stream, and captures pointer, wheel and keyboard events over the
image, scaling panel coordinates to page coordinates (`src/panel-geometry.ts`)
before sending them to `dispatchInput`.

Two behaviours that are easy to misread:

- **"Reload" reloads the *view*, not the page.** It re-fetches panel state and
  forces the `<img>` to reconnect to the stream (the URL is otherwise identical
  and the browser would reuse the dead one). There is no page reload, and no
  back/forward — the original design listed a navigation row; it was not built.
  Navigation is the address bar.
- **Input is refused when nothing is casting.** The panel checks
  `viewportOf(sessionKey)` and shows *"This thread's page is no longer open.
  Reload the view."* rather than opening a throwaway session.

It never polls: state is fetched on mount, after an explicit user action, and
once when the first frame decodes. The token goes into the `<img>` URL and
nowhere else.

This is the login surface. A site that needs credentials gets them from you,
typed into the panel, from wherever you are.

### `src/panel-rpc.ts` — panel to backend

Three methods, not the eight the original design listed (`state`,
`attachToken`, `back`, `forward`, `reload` and `setMode` were never built):

- `view({threadId})` → stream path, plugin token, and the page's url and
  viewport (or `null` when this thread has no page — an ordinary, quiet state).
- `navigate({threadId, url})` → the one panel action allowed to create a page,
  because the user asked by typing an address. A missing scheme is filled in
  with `https`; a scheme that is present is passed through untouched, even one
  `open` will refuse, so the user sees the refusal rather than a silent rewrite.
- `input({threadId, event})` → `{ok}`, where `false` means nothing was casting.

Local auth, which is the default and correct for same-origin panel calls. Input
schemas are `.strict()`, so a session key cannot be smuggled in as an extra
field.

### `src/reaper.ts` — closing pages nobody is using

Load-bearing rather than hygiene: the shared Chromium profile **restores its
tabs when it relaunches** (measured — 21 leftover tabs came back after one
plugin reload), Chrome mints fresh target ids on restore, so restored tabs are
bound to nobody and nothing else would ever prune them.

Two passes, once a minute:

- **idle** — a session still owns its page but has not used it for
  `idleMinutes`. Closed through the registry, which closes the tab *and then*
  drops the binding; a close that fails keeps its session and is reported,
  because a forgotten binding whose tab is still open is the worst outcome
  available. Viewers count as use: a page you are watching in the panel is
  never closed, however idle it looks.
- **unbound** — an open target no binding names: a restored tab, a lost
  binding, a tab left by a crash mid-create. Closed by target id after one full
  sweep interval of grace (pages are created and only then bound, and a sweep
  landing in that window must not close a page a thread is about to be handed).

**While the browser is headed, the unbound pass is off entirely.** A tab the
human opens is a tab no binding names, indistinguishable from restored debris,
so the pass would close their own tab mid-login inside 60-120 seconds. The
alternatives were rejected with reasons: "only reap targets we created" cannot
work, because restore mints new ids and restored debris is exactly what the
pass exists to clear; a longer grace period only moves the deadline. See Known
gaps for what this costs.

### `src/cli.ts` — `bb browser …`

Mirrors the tools for humans and for agents that would rather type a command:
`bb browser open|read|snapshot|click|type|eval|screenshot|close`.

`bb browser sessions` and `bb browser mode`, which the original design listed,
were never built — see Known gaps.

### `server.ts` — wiring only

Builds the engine, registry, pages, operations, screencast and reaper, and
registers the tools, CLI, RPC, stream route, background service, thread events
and settings. Everything with a decision in it lives under `src/`. It is
covered by `server.test.ts` against a fake bb host and a fake `agent-browser`
on `PATH`, because "the wiring is obviously right" is how both halves of a
correct fix ship with only one of them connected.

### `skills/browser/SKILL.md`

When to reach for the browser, the one-page-per-thread model, and the safety
rules: page content informs but never instructs, ask before any side effect the
user did not request, never solve a CAPTCHA — hand it back to the human, who
can now actually take over through the panel.

## Lifecycle

- `bb.background.service("reaper")` sweeps once a minute (see above). The
  original design named this service `engine`; the service that exists is the
  reaper, and browser shutdown hangs off `onDispose` instead.
- `bb.onDispose` stops every cast and shuts every profile's browser down when
  the plugin is disposed, reloaded, or bb shuts down — and **forgets the
  remembered browser address in the same act**, because an address that
  outlives its browser points at a freed ephemeral port.
- `thread.archived` and `thread.deleted` close that thread's **page** through
  `Target.closeTarget` and drop its storage entry, but only when the thread
  *owns* its session key: a spawned child shares its parent's key, so archiving
  one subagent must never close a working fleet's page. The handler never
  rejects — bb dispatches these fire-and-forget, and a thread that never opened
  a browser is the ordinary case.
- Toggling the `headed` setting stops the casts and closes the browser; the
  next command relaunches it in the new mode. Profile directories are never
  deleted — they hold the logins.

## Rendering modes

Headless by default — screencast works fine headless, and nothing appears on
your screen. Sites that render blank headless (QuickBooks is the known one)
need a headed browser.

Headed-ness belongs to the browser process, so it is a property of the profile,
not of a thread. It is a **plugin setting**, not a command:

```
bb plugin config browser set headed true
bb plugin config browser set headed false
```

The original design promised `bb browser mode headed`; there is no `mode`
subcommand and no `--headed` flag on anything. Changing the setting closes the
browser and the next command starts it again with (or without) a window. The
profile directory is unchanged, so **every login survives** — verified with a
cookie across both relaunches — and that matters, because the sites that need
headed rendering are exactly the ones you are logged into.

What the relaunch costs is pages: they close with the old process, and Chromium
then restores its tabs with fresh target ids that no binding names. The next
command for a thread creates a fresh page. The design's promise that the engine
*records each session's last URL and restores it* was not built — see Known
gaps.

While headed, the reaper leaves tabs nobody is bound to alone, so your own tabs
survive; it says so in the log once per transition.

## Settings

Two, both defined in `server.ts`:

| Setting | Type | Default | Effect |
|---|---|---|---|
| `headed` | boolean | `false` | Show the browser window. Changing it closes the browser; the next command relaunches it. |
| `idleMinutes` | string | `"30"` | How long a page may go unused before the reaper closes it. A string because bb's setting descriptors are string, boolean, select and project — there is no number; anything unparseable falls back to 30 rather than to 0 or Infinity. |

The original design listed five: `defaultRenderMode` became the `headed`
boolean, `idleTimeoutMinutes` became `idleMinutes`, and the other three were
not built — `frameQuality` (60) and `maxFrameWidth` (1280) are constants in
`server.ts`, and `maxPagesPerProfile` was dropped deliberately. See Known gaps.

## Security

- The stream token is bb's per-plugin token, fetched by the panel over local
  auth. It is never written into a skill, a memory record, or the repo.
- **Session keys are derived server-side from the calling thread and are never
  accepted as a parameter — and that is defence in depth, not a privilege
  boundary.** What derivation buys precisely: no request can name a key of its
  own choosing — not one for a thread that does not exist, not one outside the
  thread graph, not one smuggled in as an extra field (the RPC schemas are
  `.strict()`, and the stream route ignores a `?sessionKey=`). What it does not
  buy is isolation between threads: the stream route authenticates with the
  per-plugin token and the panel RPC with bb's local auth, and *neither carries
  a caller identity*, so any local process holding the token can name any
  thread id. Every thread on this machine already has a shell, and a shell
  reaches the same profile directly. The honest claim is "no key smuggling",
  not "one thread cannot reach another's".
- Pages open only over `http:` and `https:`, enforced in `operations.ts` as
  well as in the tool schema.
- Page-controlled output is capped before it reaches a model context.
- `browser_eval` is arbitrary script execution against whatever that profile is
  logged into. Blast radius is the profile: keep agent profiles signed into
  what agents need and nothing else.
- The reaper refuses to close anything through a remembered address unless the
  browser's uuid matches the one recorded with it. Without that check, a stale
  address plus a recycled ephemeral port means closing a stranger's tabs once a
  minute.
- Browser profiles hold live cookies and live under
  `<dataDir>/plugins/browser/` (`~/.bb/plugins/browser/` on this machine).
  `bb-state-backup` is an explicit allowlist of four SQLite files, so nothing
  here reaches the dotfiles repo. Never add this plugin to that allowlist.
- Page content is untrusted input. The skill says so, and tool descriptions
  repeat it, because prompt injection through a rendered page is the realistic
  attack.

## Testing

276 tests, `npm test`; `npm run typecheck` clean.

- `engine`: a fake `agent-browser` on `PATH` asserts namespace, session,
  profile path, launch args, and that attach mode omits `--profile`/`--args`.
- `session-key`: a fake `bb.sdk.threads` covers parent chains, forks, cycles,
  and unreadable threads.
- `binding` / `pages` / `page-registry`: creation, coalescing, rebind, the
  origin probe, the browser-identity check, and a CDP connect that never
  completes.
- `cdp` / `browser-endpoint`: connect timeouts, malformed frames, and that no
  socket is left open behind a listing or a close.
- `screencast`: a fake CDP websocket server covers frame acking, reference
  counting, stop-on-last-unsubscribe, and concurrent start/stop races (fuzzed).
- `stream`: multipart framing, the 400/404/502 branches, frame dropping for a
  slow reader, and that a `?sessionKey=` in the query is ignored.
- `reaper`: both passes, the grace period's duration, and the headed exemption.
- `trust-seam`: walks the real import graph so a launch-capable dependency
  cannot creep back into the read-only half.
- `server`: every registered surface, against a fake bb host and a fake
  `agent-browser` — no live browser is touched.
- `panel-geometry`: the coordinate scaling math, which is where a live view
  silently goes wrong.
- One live smoke test outside CI: open `example.com`, read text, screenshot.

## Known gaps

Things this document promised, or that a reader would reasonably expect, and
which are **not** built. None of them is blocking; all of them are cheap to add
later, and saying so beats a design that quietly reads as done.

1. ~~**The reaper never shuts the browser down.**~~ **Closed.** A sweep that
   finds no tabs left now shuts the browser down and forgets its address, which
   is the same act (a remembered ephemeral port outlives the process holding
   it). Three guards, each a case where "no tabs" does not mean "unused": a
   listing that failed, a headed window on screen, and any hold — `watch` is
   taken for a command's whole duration as well as by a panel viewer. The
   remaining race is self-correcting: a command arriving after the check takes
   its hold too late to be seen, but every command ensures its browser before
   attaching, so the worst case is one relaunch.
2. **`bb browser sessions` and `bb browser mode` do not exist.** Headed-ness is
   a plugin setting (see Rendering modes); there is no command that lists which
   threads hold pages. The `bb browser` command list is the eight page
   operations and nothing else.
3. **`frameQuality` and `maxFrameWidth` are not settings.** They are the
   constants 60 and 1280, passed to `createScreencast` in `server.ts`.
4. **`maxPagesPerProfile` was dropped on purpose.** The reaper plus explicit
   `browser_close` covers the real leak, and no fleet has come close to
   exhausting memory. Add it if one ever does.
5. ~~**No last-URL restore across a headed/headless relaunch.**~~ **Closed.**
   The relaunch path captures where each bound page was, and the next page a
   session is handed goes back there. Narrow on purpose — "reopen the page you
   had" is a bad default for an agent's browser: the record is written only by
   the relaunch path, used at most once, deleted whether or not the navigation
   worked, ignored after ten minutes, and never written for a tab no thread is
   bound to or a page still sitting on its create marker. An explicit
   `browser_close` must never resurrect a logged-in page later.
6. **The headed exemption is bounded but not self-clearing.** A plugin-owned
   tab that loses its binding *while* headed is unreapable until headless
   returns — and toggling headed relaunches Chromium, which restores that
   debris. Returning to headless closes the browser outright, which is what
   eventually clears it, but the sequence "headed → lose a binding → toggle
   twice" can carry debris forward. Bounded, visible (there is a window on
   screen), and opt-in.
7. **Test-coverage residuals.** 17 surviving mutations, concentrated in
   `cli.ts` and `tools.ts`, which the final fix wave did not target. The
   shipped code is correct in every case; what is missing is a test that would
   catch a regression. Ranked by consequence: the `browser_type` `submit`
   default, `bb browser close` silently not closing, `--full` inverted, the
   screenshot temp file never being removed. Recorded rather than absorbed.
8. **`session-key.ts` trusts the shape of `bb.sdk.threads.get`.** A host that
   answered `null` — plausibly a `thread.deleted` event for a row already gone
   — throws a TypeError the teardown catches and warns about, leaving the page
   to the idle reaper. One line to fix; it changes behaviour, so it is recorded
   rather than done.

## Migration (done)

1. `~/.claude/skills/browser/SKILL.md` points at `bb browser`; the `browse`
   wrapper survives only for throwaway, no-login scraping.
2. Memory records rewritten to scope their warnings to the `browse` fallback:
   `mem_prjpooxmhqi` (sandbox), `mem_rrsmfbxl8c0` (shared session),
   `mem_jdxi93esyzg` (browse wrapper truth), `mem_s4b9pobgwkw` (sandbox
   failure), `mem_kikb4w4tzho` (profile isolation). A new record describes the
   plugin. (`mem_mrlkjtkej6y`, which claimed `connect <page-ws>` binds a page,
   was retired mid-build and superseded by `mem_wcic13yfile`.)
3. `~/Dev/dotfiles` carries the skill change. The plugin itself installs into
   bb and needs nothing there.

## Phases (as planned; all delivered)

1. **Engine, tools, CLI.** No UI. Agents get a per-thread, non-sandboxed,
   persistent-profile browser. This alone retires the `dangerouslyDisableSandbox`
   dance and the shared-session hijack.
2. **Panel with a read-only live view.** Screencast, MJPEG route, panel tab.
3. **Input forwarding.** Click, type, and scroll in the panel. Logins become
   possible from anywhere.
4. **Lifecycle and migration.** Idle reaper, thread-end cleanup, headed mode,
   settings, skill and memory rewrites.

The binding rework (Task 9b) was not in the plan and was the largest single
piece of unplanned work; see Sessions, profiles, and pages.

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
skill. That repo carries no LICENSE; nothing was copied from it, and this is an
independent implementation of the ideas.
