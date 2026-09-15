/**
 * Conversions for `<input type="datetime-local">`.
 *
 * The input speaks local wall time with no zone on it; everything we store and
 * send is UTC ISO. Slicing an ISO string into the input skips the conversion
 * and silently moves the value by the visitor's offset on every round trip, so
 * both directions go through here.
 */

/** The instant as the wall time the input expects: `YYYY-MM-DDTHH:mm`. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** The input's wall time as a UTC ISO string, or undefined if it is unusable. */
export function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
