// The Browser tab's data plane: what to draw, and the two ways to act on it.
//
// Three methods, one rule between them: the panel names a THREAD, never a
// session key. Every handler resolves the key server-side through the same
// resolver the tools and the CLI use, and the input schemas are strict, so a
// caller cannot smuggle one in as an extra field (docs/design.md: "Session
// keys are derived server-side from the calling thread, never accepted as a
// parameter").
import type { BbPluginApi, PluginRpcContract, PluginRpcHandlers } from "@bb/plugin-sdk";
import { z } from "zod";
import type { Operations } from "./operations.js";
import type { Pages } from "./pages.js";
import type { InputEvent, Screencast } from "./screencast.js";
import type { SessionKeyResolver } from "./session-key.js";
import { STREAM_PATH } from "./stream.js";

// The wire form of screencast.ts's InputEvent. Declared here rather than
// accepted as `unknown` because these values become CDP commands: a NaN
// coordinate is a protocol error, and an unknown event type would reach
// Chrome as a malformed Input command.
const finite = z.number().finite();
const inputEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse"),
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved"]),
    x: finite,
    y: finite,
    button: z.enum(["left", "none"]),
    clickCount: z.number().int().min(0).max(3),
  }),
  z.object({
    kind: z.literal("key"),
    type: z.enum(["keyDown", "keyUp", "char"]),
    text: z.string().max(64).optional(),
    key: z.string().max(64).optional(),
  }),
  z.object({ kind: z.literal("scroll"), x: finite, y: finite, deltaY: finite }),
]);

// Compile-time proof the wire schema and the CDP-facing union stay in step:
// widening one without the other stops typechecking here rather than at a
// runtime cast in the handler.
const _wireMatchesCdp: (parsed: z.infer<typeof inputEventSchema>) => InputEvent = (parsed) =>
  parsed;
void _wireMatchesCdp;

const threadInput = z.object({ threadId: z.string().min(1) }).strict();

// A plain object checked with `satisfies` rather than wrapped in the SDK's
// `defineRpcContract`, which is an identity function at runtime but a real
// runtime import: `@bb/plugin-sdk` only exists inside the bb host, and these
// contracts are unit-tested in a plain node process where importing it fails.
// Every other module here imports the SDK type-only for the same reason.
export const panelRpcContract = {
  view: {
    input: threadInput,
    output: z.object({
      /** Path of the MJPEG route; the panel appends threadId and token. */
      streamPath: z.string(),
      /** This plugin's HTTP token. Belongs in an <img> URL and nowhere else. */
      token: z.string(),
      /** Null when this thread has no page open — an ordinary, quiet state. */
      page: z
        .object({
          url: z.string(),
          /** The page's CSS viewport, once a cast is running. */
          viewport: z.object({ width: z.number(), height: z.number() }).nullable(),
        })
        .nullable(),
    }),
  },
  navigate: {
    input: z.object({ threadId: z.string().min(1), url: z.string().min(1) }).strict(),
    output: z.object({ url: z.string() }),
  },
  input: {
    input: z.object({ threadId: z.string().min(1), event: inputEventSchema }).strict(),
    /** `false` means nothing is casting, so the event was dropped. */
    output: z.object({ ok: z.boolean() }),
  },
} satisfies PluginRpcContract;

/** What one `view` call tells the panel. Imported type-only by `app.tsx`. */
export type PanelView = z.infer<typeof panelRpcContract.view.output>;

export interface PanelRpcDeps {
  pluginId: string;
  /** Resolved per call, not per load: `bb.sdk` throws before the server binds. */
  token(): Promise<string>;
  resolveSessionKey: SessionKeyResolver;
  operations: Pick<Operations, "open">;
  pages: Pick<Pages, "existingPageInfo">;
  screencast: Pick<Screencast, "dispatchInput" | "viewportOf">;
  profileFor(sessionKey: string): Promise<string>;
}

/**
 * What the address bar means by "example.com".
 *
 * Only a missing scheme is filled in, and only with https. A scheme that is
 * present is passed through untouched even when it is one `operations.open`
 * will refuse: the user should see that refusal, not a silently rewritten
 * URL that opens something else.
 */
export function toNavigableUrl(typed: string): string {
  const trimmed = typed.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function createPanelRpcHandlers(
  deps: PanelRpcDeps,
): PluginRpcHandlers<typeof panelRpcContract> {
  return {
    async view({ threadId }) {
      const sessionKey = await deps.resolveSessionKey(threadId);
      // The read-only lookup, never `pageUrlFor`: opening the panel must not
      // be the reason a page exists (see stream.ts's 404 for the same rule).
      const page = await deps.pages.existingPageInfo(sessionKey);
      return {
        streamPath: `/api/v1/plugins/${deps.pluginId}/http${STREAM_PATH}`,
        token: await deps.token(),
        page: page
          ? { url: page.url, viewport: deps.screencast.viewportOf(sessionKey) }
          : null,
      };
    },

    async navigate({ threadId, url }) {
      const sessionKey = await deps.resolveSessionKey(threadId);
      const target = toNavigableUrl(url);
      // The one method that may create a page: the user asked for one by
      // typing an address and pressing Go.
      await deps.operations.open(sessionKey, target);
      return { url: target };
    },

    async input({ threadId, event }) {
      const sessionKey = await deps.resolveSessionKey(threadId);
      // A live cast is the precondition, and it is free to check: without it
      // `dispatchInput` falls back to `pageUrlFor`, which would mint a blank
      // page for a click aimed at one that has already closed. It also keeps
      // a keystroke from costing an HTTP probe plus a CDP round trip the way
      // an `existingPageInfo` check would.
      if (!deps.screencast.viewportOf(sessionKey)) return { ok: false };
      const profile = await deps.profileFor(sessionKey);
      await deps.screencast.dispatchInput(sessionKey, profile, event);
      return { ok: true };
    },
  };
}

export function registerPanelRpc(
  bb: BbPluginApi,
  deps: Omit<PanelRpcDeps, "pluginId" | "token">,
): void {
  bb.rpc.register(
    panelRpcContract,
    createPanelRpcHandlers({
      ...deps,
      pluginId: bb.pluginId,
      // Inside the thunk, so `bb.sdk` is read when a handler runs rather
      // than while the factory is still building — it is bind-gated and
      // throws before the server is listening.
      token: async () => (await bb.sdk.plugins.token({ pluginId: bb.pluginId })).token,
    }),
  );
}
