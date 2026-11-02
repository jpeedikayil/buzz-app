import { vi } from "vitest";

// An in-memory IndexedDB shared by every connection. Transactions run one at
// a time in the order they were created, as overlapping readwrite
// transactions do, and complete once their last request has succeeded;
// values are structured clones. `blocked` opens are refused first, and
// `block` refuses more. It stubs the `indexedDB` and `IDBKeyRange` globals,
// which the caller unstubs (`vi.unstubAllGlobals()`).
export function memoryIndexedDB(blocked = 0) {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, readonly string[]>();
  const writes: [string, "put" | "delete", unknown][] = [];
  let upgraded = false;
  let turn = Promise.resolve();
  const table = (name: string) => {
    const rows = stores.get(name) ?? new Map<string, unknown>();
    stores.set(name, rows);
    return rows;
  };
  const scoped = (name: string, range: { only: unknown }) =>
    [...table(name)]
      .filter(
        ([, value]) => (value as { scope?: unknown }).scope === range.only,
      )
      .sort(([a], [b]) => (a < b ? -1 : 1));
  function transaction() {
    const previous = turn;
    let release = () => {};
    turn = new Promise((resolve) => {
      release = resolve;
    });
    let pending = 0;
    let done = false;
    const tx = {
      error: null,
      oncomplete: () => {},
      onabort: () => {},
      onerror: () => {},
      objectStore: (name: string) => ({
        get: (key: unknown) =>
          request(() => structuredClone(table(name).get(JSON.stringify(key)))),
        put: (value: Record<string, unknown>, key?: unknown) =>
          request(() => {
            const at = key ?? keyPaths.get(name)?.map((path) => value[path]);
            writes.push([name, "put", at]);
            table(name).set(JSON.stringify(at), structuredClone(value));
          }),
        delete: (key: unknown) =>
          request(() => {
            writes.push([name, "delete", key]);
            table(name).delete(JSON.stringify(key));
          }),
        index: () => ({
          getAll: (range: { only: unknown }, count = Infinity) =>
            request(() =>
              scoped(name, range)
                .slice(0, count)
                .map(([, value]) => structuredClone(value)),
            ),
          getAllKeys: (range: { only: unknown }) =>
            request(() => scoped(name, range).map(([key]) => JSON.parse(key))),
        }),
      }),
    };
    const finish = () => {
      if (pending || done) return;
      done = true;
      release();
      tx.oncomplete();
    };
    function request(run: () => unknown) {
      const issued = { result: undefined as unknown, onsuccess: () => {} };
      pending++;
      void previous.then(() => {
        issued.result = run();
        issued.onsuccess();
        pending--;
        finish();
      });
      return issued;
    }
    // A transaction that issues no request completes on its turn.
    void previous.then(finish);
    return tx;
  }
  const db = {
    onversionchange: () => {},
    close: vi.fn(),
    createObjectStore(name: string, options?: { keyPath?: string[] }) {
      table(name);
      if (options?.keyPath) keyPaths.set(name, options.keyPath);
      return { createIndex() {} };
    },
    transaction,
  };
  const opens: unknown[] = [];
  vi.stubGlobal("IDBKeyRange", { only: (only: unknown) => ({ only }) });
  vi.stubGlobal("indexedDB", {
    open() {
      const request = {
        result: db,
        error: null,
        onupgradeneeded: () => {},
        onsuccess: () => {},
        onerror: () => {},
        onblocked: () => {},
      };
      opens.push(request);
      queueMicrotask(() => {
        if (blocked-- > 0) return request.onblocked();
        if (!upgraded) request.onupgradeneeded();
        upgraded = true;
        request.onsuccess();
      });
      return request;
    },
  });
  return {
    opens,
    writes,
    block(count: number) {
      blocked = count;
    },
    /** Writes a stored value as another build or a tampered disk would. */
    seed(name: string, key: unknown, value: unknown) {
      table(name).set(JSON.stringify(key), structuredClone(value));
    },
    keys: (name: string) =>
      [...table(name).keys()].map((key) => JSON.parse(key)),
    /** What a store holds under `key`, as stored. */
    value: (name: string, key: unknown) =>
      structuredClone(table(name).get(JSON.stringify(key))),
  };
}
