# bb-plugin-browser

A real browser for bb's agents. One installed browser on a profile of its own,
**one tab per thread**, headless by default — and on screen the moment a human
is needed.

```
Your browser (real app, agents' profile, one process)
├── tab → thread A     agent A drives it
├── tab → thread B     agent B drives it, cannot touch A's
└── tab → yours        never closed by the plugin
```

Threads share the browser's cookies and logins, so a site logged into once is
logged in for every thread. What they do not share is a tab.

## Install

Requires bb ≥ 0.36 and a Chromium-family browser you already have.

```sh
npm install          # playwright-core is loaded at runtime, not bundled
bb plugin install .
```

## Which browser it drives

Anything Chromium-family: **Brave, Chrome, Chromium, Edge, Vivaldi, Opera**.
Everything here is the DevTools Protocol, so the vendor does not matter. The
first one installed is detected automatically, in that order.

To pin a different one, set the plugin's **Browser binary** setting to its
executable — for example `/Applications/Google Chrome.app/Contents/MacOS/Google
Chrome`. `bb browser status` prints which browser is in use and whether it was
detected or configured. A change takes effect at the next launch, so
`bb browser quit` to apply it now.

**Firefox and Safari cannot be used.** They do not speak CDP; pointing the
setting at either produces a browser that starts and then never answers.

## For agents

Eight page tools — `browser_open`, `browser_read`, `browser_snapshot`,
`browser_click`, `browser_type`, `browser_eval`, `browser_screenshot`,
`browser_close` — plus `browser_show`, which is how an agent asks for a human:
a login wall, a CAPTCHA, a confirmation it should not click, or anything you
should look at.

Page-controlled output is capped before it reaches a model context, and only
`http`/`https` urls open — `file://` would otherwise turn open+read into a
reader for anything the bb server can read.

## For you

```sh
bb browser show     # bring it on screen
bb browser hide     # back to headless
bb browser status   # mode, and how many tabs
bb browser tabs     # every tab, and whose it is
bb browser quit     # close the shared browser
```

Plus the same eight page commands (`bb browser open <url>`, `read`, `click`…).

**Logging in:** the agents' profile starts empty. When a thread needs a site
you are signed into, it calls `browser_show`; you log in once in that window
and it persists for every thread, across reloads and restarts.

**Your tabs are yours.** The idle reaper only ever closes tabs the plugin
opened. A tab you open in that window is left alone however long it sits there.

## Headless and headed share one profile

A Chromium profile directory can be held by exactly **one process**, so the two
modes are the same browser relaunched, not two browsers. That is a constraint of
Chromium, and it has one visible cost: switching modes reopens each thread's
page where it was, but **anything typed and not submitted is lost**. Log in
after the switch, not during it.

Parallelism is unaffected — it lives *inside* the one process, where each
thread has its own tab and its own CDP session.

## Testing

```sh
npm test         # fast, no browser, runs anywhere
npm run test:live   # starts a real browser; the tests that matter
```

The live suite is separate on purpose. It covers the four things a unit test
cannot: a tab surviving **time**, surviving a **plugin reload**, surviving a
**second thread**, and a **human's tab** never being closed. Each one
corresponds to a failure that actually happened.

Chromium needs to create a ProcessSingleton socket under `/tmp`, so under a
restrictive sandbox the browser aborts at startup and the failure reads like a
plugin bug. `BB_BROWSER_TEST_PROFILE_ROOT` moves the throwaway profiles, but
the socket path is Chromium's own — run the live suite outside the sandbox.

## Credits

Architecture and code are original. Two ideas come from
[jssblck/bb-plugins](https://github.com/jssblck/bb-plugins): the ancestry-walked
session key, so a fleet's subagents and their coordinator share one browser
while a fork gets its own; and the tab-etiquette and untrusted-content framing
in its agent skill. That repository carries no LICENSE, so nothing was copied
from it.
