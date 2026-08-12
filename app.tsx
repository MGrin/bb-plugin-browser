// The Browser tab in a thread's side panel: the page as it is right now, and
// your clicks and keystrokes going back to it.
//
// Three things here are deliberate and easy to undo by accident:
//
//  - It never polls. View state is fetched on mount, after an explicit user
//    action, and once when the first frame decodes. A panel that refetched on
//    a timer would keep a browser encoding frames for a tab nobody is
//    looking at.
//  - The token goes into the <img> URL and nowhere else. An <img> sends no
//    Origin header, so a query-string token is the only auth that works over
//    the Cloudflare tunnel — but that also means it must never reach a log,
//    an error message, or the panel's persisted params.
//  - The panel names a thread, never a session key. The server derives the
//    key; see src/panel-rpc.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type {
  PluginMessageDirectiveProps,
  PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import { toPageCoordinates } from "./src/panel-geometry.js";
import type { PanelView, panelRpcContract } from "./src/panel-rpc.js";

/** Falls back to the decoded frame when no cast has reported a viewport yet. */
function frameSize(image: HTMLImageElement, view: PanelView | null) {
  const reported = view?.page?.viewport;
  if (reported) return reported;
  return { width: image.naturalWidth, height: image.naturalHeight };
}

function BrowserPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof panelRpcContract>();
  const [view, setView] = useState<PanelView | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  // Bumped to force the <img> to reconnect; the stream URL is otherwise
  // identical across reloads and the browser would reuse the dead one.
  const [attempt, setAttempt] = useState(0);
  const imageRef = useRef<HTMLImageElement | null>(null);

  // `useRpc` may hand back a fresh object each render; keeping it in a ref
  // stops that from re-running the mount effect (which would refetch on
  // every render — the polling this panel must not do).
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const mounted = useRef(true);
  // The <img> fires `load` for EVERY frame of a multipart stream, so the
  // one follow-up fetch that picks up the cast's viewport is guarded rather
  // than left to fire per frame.
  const viewportSynced = useRef(false);

  const load = useCallback(
    async (options: { syncAddress: boolean }) => {
      try {
        const next = await rpcRef.current.call("view", { threadId });
        if (!mounted.current) return;
        setView(next);
        setStatus("ready");
        if (options.syncAddress) setAddress(next.page?.url ?? "");
      } catch (error) {
        if (!mounted.current) return;
        setStatus("error");
        setNotice(error instanceof Error ? error.message : "Could not read the browser state.");
      }
    },
    [threadId],
  );

  useEffect(() => {
    mounted.current = true;
    viewportSynced.current = false;
    void load({ syncAddress: true });
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // The panel does not poll, so without a push it believes whatever was true
  // when it mounted — which is how it kept insisting "no page open" while the
  // thread had one, three separate times in live testing. The backend
  // broadcasts on every create and close; this is the panel finally listening.
  useRealtime("page-changed", () => {
    viewportSynced.current = false;
    setAttempt((previous) => previous + 1);
    void load({ syncAddress: true });
  });

  const reload = useCallback(() => {
    setNotice(null);
    viewportSynced.current = false;
    setAttempt((previous) => previous + 1);
    void load({ syncAddress: true });
  }, [load]);

  const send = useCallback(
    async (event: Parameters<typeof rpc.call<"input">>[1]["event"]) => {
      try {
        const result = await rpcRef.current.call("input", { threadId, event });
        if (!result.ok && mounted.current) {
          setNotice("This thread's page is no longer open. Reload the view.");
        }
      } catch {
        // A dropped click is not worth a dialog; the stream itself failing
        // is what the user will notice, and it has its own message.
      }
    },
    [threadId],
  );

  const sendMouse = useCallback(
    (type: "mousePressed" | "mouseReleased", event: React.MouseEvent<HTMLImageElement>) => {
      const image = imageRef.current;
      if (!image) return;
      const point = toPageCoordinates({
        clientX: event.clientX,
        clientY: event.clientY,
        rect: image.getBoundingClientRect(),
        frame: frameSize(image, view),
      });
      void send({ kind: "mouse", type, x: point.x, y: point.y, button: "left", clickCount: 1 });
    },
    [send, view],
  );

  const sendWheel = useCallback(
    (event: React.WheelEvent<HTMLImageElement>) => {
      const image = imageRef.current;
      if (!image) return;
      const point = toPageCoordinates({
        clientX: event.clientX,
        clientY: event.clientY,
        rect: image.getBoundingClientRect(),
        frame: frameSize(image, view),
      });
      void send({ kind: "scroll", x: point.x, y: point.y, deltaY: event.deltaY });
    },
    [send, view],
  );

  const sendKey = useCallback(
    (event: React.KeyboardEvent<HTMLImageElement>) => {
      // Let the app's own shortcuts through rather than swallowing them into
      // a page that cannot act on them.
      if (event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      const printable = event.key.length === 1;
      void send(
        printable
          ? { kind: "key", type: "char", text: event.key }
          : { kind: "key", type: "keyDown", key: event.key },
      );
    },
    [send],
  );

  // A stream held while nobody is looking is not just wasted frames: an <img>
  // on a multipart response holds one of the browser's SIX connections to
  // bb's own origin for as long as it is attached, and reconnects that have
  // not finished closing hold more. Starve that pool and bb's own API calls
  // queue behind it — the whole app goes sluggish, which is exactly what
  // happened in testing and needed a restart to clear. So the stream exists
  // only while this tab is actually on screen.
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const streamSrc = visible && view?.page
    ? `${view.streamPath}?threadId=${encodeURIComponent(threadId)}&token=${encodeURIComponent(
        view.token,
      )}&attempt=${attempt}`
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <form
        className="flex shrink-0 items-center gap-2 border-b border-border p-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!address.trim()) return;
          setStatus("loading");
          setNotice(null);
          void rpcRef.current
            .call("navigate", { threadId, url: address })
            .then(() => {
              viewportSynced.current = false;
              setAttempt((previous) => previous + 1);
              return load({ syncAddress: true });
            })
            .catch((error: unknown) => {
              if (!mounted.current) return;
              setStatus("ready");
              setNotice(error instanceof Error ? error.message : "Could not open that address.");
            });
        }}
      >
        <input
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="example.com"
          aria-label="Address"
          spellCheck={false}
        />
        <button type="submit" className="rounded-md border border-border px-3 py-1 text-sm">
          Go
        </button>
        <button
          type="button"
          onClick={reload}
          className="rounded-md border border-border px-3 py-1 text-sm"
        >
          Reload
        </button>
      </form>

      {notice ? (
        <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive">
          {notice}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
        {streamSrc ? (
          <img
            ref={imageRef}
            key={streamSrc}
            src={streamSrc}
            alt="Live page"
            tabIndex={0}
            // Focused as soon as it mounts. Keystrokes only reach a focused
            // element, and "click the picture once before typing works" is
            // not something anyone guesses — it read as broken input.
            autoFocus
            draggable={false}
            // Width-fit with a natural height, never object-contain: the
            // click mapping assumes the element's rect IS the drawn image,
            // and letterboxing would silently offset every coordinate.
            className="block w-full select-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onLoad={() => {
              if (viewportSynced.current) return;
              viewportSynced.current = true;
              void load({ syncAddress: false });
            }}
            onError={() =>
              setNotice("The live view stopped. Reload it, or reopen the page in this thread.")
            }
            onMouseDown={(event) => sendMouse("mousePressed", event)}
            onMouseUp={(event) => sendMouse("mouseReleased", event)}
            onWheel={sendWheel}
            onKeyDown={sendKey}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            {status === "loading"
              ? "Connecting…"
              : status === "error"
                ? "The browser plugin did not answer."
                : "No page open in this thread yet. Type an address above, or let the agent open one."}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * `::browser{}` on its own line in an agent's message: opens the Browser panel.
 *
 * The panel is where a human logs in, solves a CAPTCHA, or watches what an
 * agent is doing — and every one of those is a moment the agent knows about
 * and the human does not. Making them go and find a menu entry is the
 * difference between a feature that gets used and one that gets explained.
 *
 * Opened once per mounted directive, not once per render: a chat message
 * re-renders whenever it scrolls back into view, and a panel that reopened
 * itself every time the user scrolled would be indistinguishable from a bug.
 * If the surface has no side panel — a narrow window, a phone — `openThreadPanel`
 * returns false and the button below is the fallback rather than a dead end.
 */
function OpenBrowserPanel({ attributes }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const opened = useRef(false);
  const [failed, setFailed] = useState(false);

  const open = useCallback(() => {
    const accepted = navigate.openThreadPanel({ actionId: "browser" });
    setFailed(!accepted);
    return accepted;
  }, [navigate]);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    // `auto="false"` lets an agent offer the panel without taking over the
    // screen — a mention in passing, rather than "look at this now".
    if (attributes.auto === "false") return;
    open();
  }, [attributes.auto, open]);

  return (
    <button
      type="button"
      onClick={open}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden>🌐</span>
      {failed ? "Open the Browser panel" : "Browser panel"}
    </button>
  );
}


/**
 * EXPERIMENT — the panel talking CDP straight to Chromium.
 *
 * The shipped panel streams MJPEG from bb's own origin and sends each input as
 * its own HTTP request. Two structural problems came out of live use: an
 * `<img>` on a multipart response holds one of the browser's six connections
 * to bb's origin, so a forgotten panel can starve bb's own API calls and make
 * the whole app sluggish; and a round trip per keystroke makes typing feel
 * detached.
 *
 * This does neither. One WebSocket to the page's own CDP endpoint carries
 * frames down and input up, on a different origin from bb entirely — so it
 * cannot compete for bb's connections, and a keystroke is a socket write
 * rather than an HTTP request.
 *
 * It is NOT shippable as it stands: a CDP socket is total control of the
 * browser, and handing that to the renderer (let alone through a tunnel) is
 * not something to do casually. The point is to find out whether this class of
 * transport feels right before building the safe version of it, where the
 * plugin keeps CDP to itself and speaks its own protocol over its own port.
 */
function DirectBrowserPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof panelRpcContract>();
  const [frame, setFrame] = useState<string | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [stats, setStats] = useState({ frames: 0, lastMs: 0 });
  const socketRef = useRef<WebSocket | null>(null);
  const nextId = useRef(1);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewport = useRef<{ width: number; height: number } | null>(null);
  const sentAt = useRef<number | null>(null);

  const send = useCallback((method: string, params: Record<string, unknown> = {}) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ id: nextId.current++, method, params }));
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const view = await rpc.call("view", { threadId });
        if (cancelled) return;
        if (!view.page) {
          setStatus("no page open in this thread yet");
          return;
        }
        socket = new WebSocket(view.page.cdpUrl);
        socketRef.current = socket;
        socket.addEventListener("open", () => {
          setStatus("connected");
          send("Page.enable");
          send("Page.bringToFront");
          send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280 });
        });
        socket.addEventListener("close", () => setStatus("socket closed"));
        socket.addEventListener("error", () => setStatus("socket error"));
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data)) as {
            method?: string;
            params?: {
              data?: string;
              sessionId?: number;
              metadata?: { deviceWidth?: number; deviceHeight?: number };
            };
          };
          if (message.method !== "Page.screencastFrame" || !message.params?.data) return;
          const width = message.params.metadata?.deviceWidth;
          const height = message.params.metadata?.deviceHeight;
          if (width && height) viewport.current = { width, height };
          setFrame(message.params.data);
          setStats((previous) => ({
            frames: previous.frames + 1,
            lastMs: sentAt.current ? Math.round(performance.now() - sentAt.current) : previous.lastMs,
          }));
          sentAt.current = null;
          send("Page.screencastFrameAck", { sessionId: message.params.sessionId });
        });
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "failed");
      }
    })();
    return () => {
      cancelled = true;
      socket?.close();
      socketRef.current = null;
    };
  }, [rpc, threadId, send]);

  const pointOf = (event: React.MouseEvent<HTMLImageElement>) => {
    const image = imageRef.current;
    if (!image) return { x: 0, y: 0 };
    return toPageCoordinates({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: image.getBoundingClientRect(),
      frame: viewport.current ?? { width: image.naturalWidth, height: image.naturalHeight },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>direct CDP · {status}</span>
        <span>{stats.frames} frames</span>
        {stats.lastMs ? <span>last input → paint: {stats.lastMs}ms</span> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/20">
        {frame ? (
          <img
            ref={imageRef}
            src={`data:image/jpeg;base64,${frame}`}
            alt="Live page"
            tabIndex={0}
            autoFocus
            draggable={false}
            className="block w-full select-none outline-none"
            onMouseDown={(event) => {
              sentAt.current = performance.now();
              const p = pointOf(event);
              send("Input.dispatchMouseEvent", {
                type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1,
              });
            }}
            onMouseUp={(event) => {
              const p = pointOf(event);
              send("Input.dispatchMouseEvent", {
                type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1,
              });
            }}
            onWheel={(event) => {
              const p = pointOf(event);
              send("Input.dispatchMouseEvent", {
                type: "mouseWheel", x: p.x, y: p.y, deltaX: 0, deltaY: event.deltaY,
                button: "none", clickCount: 0,
              });
            }}
            onKeyDown={(event) => {
              if (event.metaKey || event.ctrlKey) return;
              event.preventDefault();
              sentAt.current = performance.now();
              if (event.key.length === 1) {
                send("Input.dispatchKeyEvent", { type: "char", text: event.key });
              } else {
                send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: event.key, windowsVirtualKeyCode: event.keyCode });
                send("Input.dispatchKeyEvent", { type: "keyUp", key: event.key, windowsVirtualKeyCode: event.keyCode });
              }
            }}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">{status}</p>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "browser",
    title: "Browser",
    icon: "Globe",
    // The panel owns its own layout: an address bar pinned above a view that
    // fills whatever is left.
    layout: "flush",
    component: BrowserPanel,
  });

  app.slots.threadPanelAction({
    id: "browser-direct",
    title: "Browser (direct CDP — experiment)",
    icon: "Zap",
    layout: "flush",
    component: DirectBrowserPanel,
  });

  app.slots.messageDirective({
    id: "browser",
    component: OpenBrowserPanel,
  });
});
