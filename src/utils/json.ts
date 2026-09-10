/**
 * Loose shape for untrusted platform JSON.
 *
 * Adapters reach into deeply nested API responses with optional chaining;
 * spelling out full interfaces for every site's payload would be larger than
 * the adapters themselves and would rot with every upstream layout change.
 * `JsonRecord` keeps that access ergonomic while satisfying the
 * no-explicit-any lint rule: every value is `unknown`-backed and every
 * nested access stays an optional chain on a possibly-undefined object.
 *
 * This is NOT a validation boundary — it only types the traversal. Fields
 * that reach the DB still pass through explicit `typeof`/`Number.isFinite`
 * guards at their buildPost call sites.
 */
export type JsonValue = string | number | boolean | null | JsonRecord | JsonValue[];

export interface JsonRecord {
  [key: string]: JsonValue | undefined;
}

/** Narrow an untrusted value to a JsonRecord (arrays and primitives rejected). */
export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/**
 * The first candidate that actually carries keys, else `{}`.
 *
 * `asRecord()` returns `{}` for a miss and **`{}` is truthy**, so the natural
 * `asRecord(a) || asRecord(b)` idiom silently drops `b` — the fallback is dead
 * code that reads as if it works. Use this whenever "try one path, then
 * another" is meant, so the intent is expressible and testable.
 */
export function firstFilled(...candidates: JsonRecord[]): JsonRecord {
  return candidates.find((candidate) => Object.keys(candidate).length > 0) ?? {};
}
