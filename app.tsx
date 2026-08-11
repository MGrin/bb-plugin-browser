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
import { definePluginApp, useRpc } from "@bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@bb/plugin-sdk/app";
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

  const streamSrc = view?.page
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
});
