// bb's plugin kv, in a Map.
//
// Shared rather than re-declared per test file since `list` arrived: the
// reaper reads every binding through it, and three subtly different fakes
// would be three chances for a test to pass against a store the host does not
// behave like.
export interface MemoryKv {
  store: Map<string, unknown>;
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export function memoryKv(): MemoryKv {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async <T,>(key: string) => store.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    // Full keys, prefix included, sorted — what bb's kv actually returns:
    // its `list` is `select key ... where key LIKE '<prefix>%' order by key`
    // and hands back the row's key untouched (bb 0.36.0, server/dist/
    // start-server.js). pages.ts tolerates the stripped form too, but a fake
    // is only useful if it pins the shape the host really has.
    list: async (prefix?: string) =>
      [...store.keys()].filter((key) => (prefix ? key.startsWith(prefix) : true)),
  };
}
