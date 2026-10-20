// JS dialogs (alert/confirm/prompt) that a controller command drains and reports in its own `dialogs` field.
// Zod-free, no imports.

/**
 * Puts dialogs that an OBSERVER's command drained back into the output the model gets. Every controller command
 * (a trace screenshot too) drains the pending dialogs of all tabs, so a command the model did not ask for would
 * hide them. Same rule as the controller's own merge: the output's `dialogs` stay first, the carried ones are
 * appended; an output without `dialogs` gets the field at the end. `output` is the JSON string of a tool result;
 * anything that is not a JSON object, and an empty `dialogs`, is returned as it is. Never throws.
 */
export function mergeCarriedDialogs(output: string, dialogs: readonly unknown[] | undefined): string {
  if (!dialogs || dialogs.length === 0 || typeof output !== "string") return output;
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return output;
    const record = parsed as Record<string, unknown>;
    const own = Array.isArray(record.dialogs) ? (record.dialogs as unknown[]) : [];
    return JSON.stringify({ ...record, dialogs: [...own, ...dialogs] });
  } catch {
    return output;
  }
}
