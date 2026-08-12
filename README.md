# bb-plugin-browser

A browser that lives inside [bb](https://github.com/get-bb/bb). Agents drive
pages through native tools; a **Browser** tab in the thread's side panel shows
the live page and forwards your clicks and keystrokes — from the Mac or from
the phone.

It exists because driving a browser from an agent on this machine used to mean
remembering a list of workarounds: disabling the Bash sandbox on every call,
hoping no other thread navigated the one shared session out from under you,
re-establishing logins that `--restore` never really saved, and passing an
anti-detection flag on every single invocation or getting an account locked.
bb's plugin backend is not sandboxed, sessions are keyed by thread, profiles
are real on-disk Chrome profiles, launch args are set once in one place, and
the panel makes the page visible.

`docs/design.md` is the full design, including a **Known gaps** section listing
what is deliberately or accidentally not built.

## Install

Requires [`agent-browser`](https://github.com/vercel-labs/agent-browser) on
`PATH` (`brew install agent-browser`) and bb ≥ 0.36.

```sh
bb plugin install .          # from a clone of this repo
bb plugin build . && bb plugin reload browser   # after editing sources
```

Configure:

```sh
bb plugin config browser                        # show settings
bb plugin config browser set headed true        # show the browser window
bb plugin config browser set idleMinutes 30     # close unused pages after N minutes
```

Those two are the whole settings surface.

## Agent tools

Registered for every session, alongside the `browser` skill:

| Tool | Returns |
|---|---|
| `browser_open(url)` | page title and final URL (http/https only) |
| `browser_read()` | rendered text — prefer this over HTML |
| `browser_snapshot(interactive?)` | accessibility tree with `@refs` you can click by |
| `browser_click(selector)` | confirmation; takes a CSS selector or an `@ref` |
| `browser_type(selector, text, submit?)` | fills a field, optionally pressing Enter |
| `browser_eval(expression)` | the expression's JSON result |
| `browser_screenshot()` | a PNG as image content — the agent sees the page |
| `browser_close()` | closes this thread's page |

Every tool derives its session key from the calling thread; a session key is
never a parameter. Page-controlled output is capped before it reaches a model
context, and `file://`, `javascript:` and `data:` URLs are refused.

## CLI

Same operations, for humans and for agents that would rather type a command:

```sh
bb browser open <url>
bb browser read
bb browser snapshot [--full]        # interactive-only by default
bb browser click <selector>
bb browser type <selector> <text> [--submit]
bb browser eval <expression>
bb browser screenshot [path]        # defaults to ./screenshot.png
bb browser close
```

Run inside a bb thread it drives that thread's page; run outside one it drives
the shared `scratch` page.

## The Browser panel

Every thread gets a **Browser** tab in its side panel. It shows the thread's
page as an MJPEG stream and forwards clicks, scrolling and keystrokes back to
it over CDP, so **this is where you log in** — including from a phone, since
the stream is a plain token-authed HTTP route and works over a Cloudflare
tunnel.

The address bar navigates (a missing scheme becomes `https`). **Reload**
reloads the *view* — it reconnects the stream — not the page. When the thread
has no page open, the panel says so and waits; input is refused rather than
opening a page nobody asked for.

## The profile/page model

One Chromium per **profile** (`main`, under
`<bb dataDir>/plugins/browser/profiles/`), because a Chrome profile directory
is locked to a single process — so sharing logins means sharing a browser.
Inside it, each thread drives its **own labelled tab**, selected fresh inside
every command, so threads share cookies and never share a page. A thread you
spawn shares your page (a coordinator and its subagents are one worker); a fork
gets its own.

Pages are remembered across bb restarts and verified on every use. A background
reaper closes pages nothing has used for `idleMinutes` and tabs no thread is
bound to — which is load-bearing rather than tidy, because Chromium restores
its tabs on relaunch and nothing else would ever prune them. A page you are
watching in the panel is never reaped.

## Headed mode

Headless by default. Some sites (QuickBooks is the known one) render blank
headless, and sometimes you simply want to drive the thing yourself:

```sh
bb plugin config browser set headed true
```

That closes the browser; the next command starts it again with a visible
window. The profile directory is untouched, so **every login survives** the
switch in both directions. There is no `--headed` flag on any command — headed
is a property of the browser process, and therefore of the profile.

While headed, the reaper only closes tabs *this plugin* opened, so the tabs you
open yourself are never closed out from under you mid-login — however long they
sit there. The plugin's own orphans are still collected in both modes, so
nothing accumulates waiting for a mode change.

## Verifying it works

```sh
scripts/verify           # eleven checks against the bb you are running
scripts/verify --clean   # …and close the page afterwards
```

It drives the installed plugin through the same `bb browser` surface an agent
uses, against a real Chromium — nothing is mocked. Each check prints what it
proves. Exit code is the number of failures, so `scripts/verify && echo ok`
means something.

What it covers: the plugin is loaded with all eight tools and its skill and no
errors; a real page opens, reads, evaluates and snapshots **inside the default
sandbox**, with no `dangerouslyDisableSandbox` and no `browse` wrapper; the page
persists across commands; a screenshot round-trips as real PNG bytes; `file://`
is refused; and the panel's MJPEG route serves frames.

Three things a script cannot check, in order of what is most worth your time:

1. **The panel.** Open a thread, click **+** in the side panel, choose
   **Browser**. The live page appears, and clicking a link inside it navigates.
2. **Per-thread isolation.** In two different bb threads, `bb browser open` a
   different URL in each, then `bb browser read` in both. Each must still report
   its own page — that is the property the whole binding mechanism exists for.
3. **Headed mode.** `bb plugin config browser set headed true`, reload the
   plugin, run any command: a real Chrome window appears and your logins survive
   the switch, because the profile directory does not change.

## Development

```sh
npm test          # 323 tests, no live browser touched
npm run typecheck
bb plugin types   # refresh types/ from the running bb
```

`types/bb-plugin-sdk.d.ts` and `types/bb-plugin-sdk-app.d.ts` are the bundled
bb plugin API; `tsconfig.json` maps `@bb/plugin-sdk` to them.

## Credits

Architecture and code are original, and the design records the measurements
behind the parts that are unobvious. Two **ideas** come from
[jssblck/bb-plugins](https://github.com/jssblck/bb-plugins):

1. **The ancestry-walked session key** — walking a thread's parent chain so a
   fleet's subagents and their coordinator share one browser, while a fork gets
   its own.
2. **The tab-etiquette and untrusted-content framing** in its agent skill —
   agent pages stay out of the human's way, and page content informs but never
   instructs.

That repository carries no LICENSE file, so nothing was copied from it: this is
an **independent implementation of shared ideas**, not derived code. Its own
architecture (a Chrome extension plus a native messaging host, driving the
user's real Chrome) is deliberately not the one here — see
`docs/design.md` for why.
