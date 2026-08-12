# bb-plugin-browser

A real browser for bb's agents. One [Brave](https://brave.com) on a profile of
its own, **one tab per thread**, headless by default — and on screen the moment
a human is needed.

```
Brave (real app, agents' profile, one process)
├── tab → thread A     agent A drives it
├── tab → thread B     agent B drives it, cannot touch A's
└── tab → yours        never closed by the plugin
```

Threads share the browser's cookies and logins, so a site logged into once is
logged in for every thread. What they do not share is a tab.

## Install

Requires Brave at `/Applications/Brave Browser.app` and bb ≥ 0.36.

```sh
npm install          # playwright-core is loaded at runtime, not bundled
bb plugin install .
```

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
you are signed into, it calls `browser_show`; you log in once in that Brave
window and it persists for every thread, across reloads and restarts.

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
npm run test:live   # starts a real Brave; the tests that matter
```

The live suite is separate on purpose. It covers the four things v1's 335 unit
tests could not: a tab surviving **time**, surviving a **plugin reload**,
surviving a **second thread**, and a **human's tab** never being closed. Each
one corresponds to a failure that actually happened — see `docs/design-v2.md`.

## History

`docs/design.md` describes v1, which streamed the browser into a bb panel. It
is kept for the reasoning, not as a description of this plugin.
`docs/design-v2.md` is what exists now, including why the panel is gone.

## Credits

Architecture and code are original. Two ideas come from
[jssblck/bb-plugins](https://github.com/jssblck/bb-plugins): the ancestry-walked
session key, so a fleet's subagents and their coordinator share one browser
while a fork gets its own; and the tab-etiquette and untrusted-content framing
in its agent skill. That repository carries no LICENSE, so nothing was copied
from it.
