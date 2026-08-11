// One page per session key, remembered across restarts and verified on use.
//
// Remembering matters because a thread that comes back after a bb restart
// should still be on its page. Verifying matters because a page can vanish
// without telling us — the panel's close button, a crash, the idle reaper —
// and a stale id must produce a fresh page rather than an error.
import type { Engine } from "./engine.js";
import { openCdp } from "./cdp.js";

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

export interface PagesDeps {
  engine: Pick<Engine, "browserCdpUrl" | "run">;
  kv: {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  log: (message: string) => void;
}

interface Binding {
  profile: string;
  targetId: string;
}

export interface Pages {
  /** The page-level CDP websocket for this session, creating it if needed. */
  pageUrlFor(sessionKey: string, profile: string): Promise<string>;
  closePage(sessionKey: string): Promise<void>;
  forget(sessionKey: string): Promise<void>;
}

const key = (sessionKey: string) => `page:${sessionKey}`;

function pageUrl(browserUrl: string, targetId: string): string {
  const base = new URL(browserUrl);
  return `${base.protocol}//${base.host}/devtools/page/${targetId}`;
}

export function createPages(deps: PagesDeps): Pages {
  // Every caller of openCdp wraps its use in try/finally so a throw mid-way
  // (a bad send, a JSON parse failure, whatever) still closes the socket —
  // no path here opens a CDP connection without a matching close on both
  // the success and the error branch.
  async function targets(browserUrl: string): Promise<TargetInfo[]> {
    const session = await openCdp(browserUrl);
    try {
      const result = await session.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
      return result.targetInfos.filter((target) => target.type === "page");
    } finally {
      session.close();
    }
  }

  return {
    async pageUrlFor(sessionKey, profile) {
      const browserUrl = await deps.engine.browserCdpUrl(profile);
      const bound = await deps.kv.get<Binding>(key(sessionKey));
      const open = await targets(browserUrl);

      if (bound && open.some((target) => target.targetId === bound.targetId)) {
        return pageUrl(browserUrl, bound.targetId);
      }

      const session = await openCdp(browserUrl);
      try {
        const created = await session.send<{ targetId: string }>("Target.createTarget", {
          url: "about:blank",
        });
        await deps.kv.set(key(sessionKey), { profile, targetId: created.targetId });
        deps.log(`created page ${created.targetId} for ${sessionKey} on ${profile}`);
        return pageUrl(browserUrl, created.targetId);
      } finally {
        session.close();
      }
    },

    async closePage(sessionKey) {
      const bound = await deps.kv.get<Binding>(key(sessionKey));
      if (!bound) return;
      const browserUrl = await deps.engine.browserCdpUrl(bound.profile);
      const session = await openCdp(browserUrl);
      try {
        await session.send("Target.closeTarget", { targetId: bound.targetId });
      } finally {
        session.close();
      }
      await deps.kv.delete(key(sessionKey));
    },

    async forget(sessionKey) {
      await deps.kv.delete(key(sessionKey));
    },
  };
}
