/**
 * The slice of the Web Storage API the action cache needs (pen-editor passes
 * `localStorage`). Synchronous on purpose: the cache is read and written
 * inline in the loop.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** An in-memory `KeyValueStorage` — a cache that lives as long as the object. */
export function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}
