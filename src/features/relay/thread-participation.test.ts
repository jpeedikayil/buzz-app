import { afterEach, expect, it, vi } from "vitest";
import { browserThreadParticipation } from "./thread-participation";

afterEach(() => vi.unstubAllGlobals());

// A stubbed IndexedDB whose first open is blocked and whose next one opens.
function openOnSecondAttempt() {
  const get = {
    onsuccess: () => {},
    onerror: () => {},
    result: [["c0:root", 1000]],
  };
  const db = {
    onversionchange: () => {},
    close: vi.fn(),
    transaction: () => ({ objectStore: () => ({ get: () => get }) }),
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
  return { opens, get };
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
  await expect(read).resolves.toEqual(new Map([["c0:root", 1000]]));
});
