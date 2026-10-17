/** A scenario id: 1-64 characters, easy to read in a report and to name in a message. */
export const QA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Check a list of scenario ids. Throws `Error` for an invalid id or an exact repeat. `who` starts the message. */
export function checkQaIds(ids: readonly unknown[], who: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !QA_ID_PATTERN.test(id)) {
      throw new Error(`${who}: invalid scenario id ${JSON.stringify(id)} (use 1-64 characters of A-Z, a-z, 0-9, _ and -)`);
    }
    if (seen.has(id)) throw new Error(`${who}: duplicate scenario id "${id}"`);
    seen.add(id);
  }
}
