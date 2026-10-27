import { afterEach, expect, it, vi } from "vitest";
import { browserThreadParticipation } from "./thread-participation";

afterEach(() => vi.unstubAllGlobals());

// A stubbed IndexedDB whose first open is blocked and whose next one opens,
// holding one record, and whose writes land in `put`.
function openOnSecondAttempt(result: unknown = [["c0:root", 1000]]) {
  const get = {
    onsuccess: () => {},
    onerror: () => {},
    result,
  };
  const put = vi.fn();
  const db = {
    onversionchange: () => {},
    close: vi.fn(),
    transaction: () => {
      const tx = {
        oncomplete: () => {},
        onabort: () => {},
        onerror: () => {},
        error: null,
        objectStore: () => ({
          get: () => get,
          put: (...args: unknown[]) => {
            put(...args);
            queueMicrotask(() => tx.oncomplete());
          },
        }),
      };
      return tx;
    },
  };
  const opens: {
    onupgradeneeded: () => void;
    onsuccess: () => void;
    onerror: () => void;
    onblocked: () => void;
    result: typeof db;
    error: null;
  }[] = [];
  vi.stubGlobal("indexedDB", {
    open() {
      const request = {
        onupgradeneeded: () => {},
        onsuccess: () => {},
        onerror: () => {},
        onblocked: () => {},
        result: db,
        error: null,
      };
      opens.push(request);
      queueMicrotask(() =>
        opens.length === 1 ? request.onblocked() : request.onsuccess(),
      );
      return request;
    },
  });
  return { opens, get, put };
}
async function opened(result?: unknown) {
  const stub = openOnSecondAttempt(result);
  const storage = browserThreadParticipation("relay:viewer");
  await storage.read().catch(() => {});
  // Answers a read once it listens for the result.
  const read = async () => {
    const idle = stub.get.onsuccess;
    const pending = storage.read();
    await vi.waitFor(() => expect(stub.get.onsuccess).not.toBe(idle));
    stub.get.onsuccess();
    return pending;
  };
  return { ...stub, storage, read };
}

it("a blocked open is not held against the next read", async () => {
  const { opens, get } = openOnSecondAttempt();
  const storage = browserThreadParticipation("relay:viewer");
  await expect(storage.read()).rejects.toThrow("Close other Buzz windows");
  const idle = get.onsuccess;
  const read = storage.read();
  await vi.waitFor(() => expect(opens).toHaveLength(2));
  // The read has reached its transaction once it listens for the result.
  await vi.waitFor(() => expect(get.onsuccess).not.toBe(idle));
  get.onsuccess();
  await expect(read).resolves.toEqual({ roots: new Map([["c0:root", 1000]]) });
});

it("the record round-trips with its walk mark, and the former bare list still reads", async () => {
  const { storage, read, put } = await opened({
    roots: [["c0:root", 1000]],
    walk: { since: 1500 },
  });
  await expect(read()).resolves.toEqual({
    roots: new Map([["c0:root", 1000]]),
    walk: { since: 1500 },
  });
  await storage.write({
    roots: new Map([["c0:root", 2000]]),
    walk: { since: 2500 },
  });
  expect(put).toHaveBeenCalledWith(
    { roots: [["c0:root", 2000]], walk: { since: 2500 } },
    "relay:viewer",
  );
  await storage.write({ roots: new Map() });
  expect(put).toHaveBeenLastCalledWith({ roots: [] }, "relay:viewer");
});

it("a malformed walk reads as no walk", async () => {
  const { read } = await opened({
    roots: [["c0:root", 1000], "junk"],
    walk: { since: -1 },
  });
  await expect(read()).resolves.toEqual({
    roots: new Map([["c0:root", 1000]]),
  });
});
