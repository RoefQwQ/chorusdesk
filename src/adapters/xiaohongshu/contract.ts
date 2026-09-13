import type { XhsProfileSnapshot, RawXhsNote } from './collector';

/**
 * Validation for the snapshot the page hands back.
 *
 * Everything from an injected collector is UNTRUSTED: the page is third-party code
 * running alongside anything else the user has open, and its shape changes without
 * telling us. This is the only module that knows that shape, so a change in the DOM
 * or the state object is a one-file fix here (AGENTS rule 9) — the adapter, the
 * handler and the db never learn it.
 *
 * The bounds mirror `douyin/contract.ts`: array counts, text and URL lengths, and
 * an https-only media check. What is rejected rather than coerced:
 *
 *  - a note with no stable id (it could not be deduped or tombstoned)
 *  - a note whose time is not a finite positive number (it would sort as 1970)
 *  - a media URL that is not http(s) (it would be handed to `<img src>`)
 *
 * A rejected note is DROPPED, not replaced by a placeholder: a partial note is a
 * post the user cannot open, and silently keeping it is how a broken parser turns
 * into "this creator posted less" instead of an error.
 */

/** Longest fields accepted from the page, in characters. */
const MAX_ID = 64;
const MAX_TITLE = 500;
const MAX_TOKEN = 512;
const MAX_NAME = 200;
const MAX_URL = 2048;
/** Upper bound on notes one collection may return. */
const MAX_NOTES = 5000;
/** Plausible publication window, in ms: 2000-01-01 .. now + 1 day. */
const MIN_TIME = 946_684_800_000;
const MAX_TIME_SKEW = 86_400_000;

const text = (v: unknown, max: number): string =>
  typeof v === 'string' && v.length > max ? v.slice(0, max) : typeof v === 'string' ? v : '';

/** An http(s) URL, or empty. Rejects `javascript:`, `data:` and relative values. */
function httpUrl(v: unknown, max = MAX_URL): string {
  const raw = text(v, max).trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return raw;
  } catch {
    return '';
  }
}

/** Xiaohongshu note ids are 24 lowercase hex characters. */
function isNoteId(v: string): boolean {
  return /^[0-9a-f]{24}$/.test(v);
}

function normalizeNote(raw: unknown): RawXhsNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;

  const id = text(rec.id, MAX_ID).trim();
  if (!isNoteId(id)) return null;

  const time = typeof rec.time === 'number' && Number.isFinite(rec.time) ? rec.time : 0;
  const now = Date.now();
  // A note with no usable time would sort to the epoch and look like the oldest
  // thing in the library. Drop it rather than guess.
  if (time < MIN_TIME || time > now + MAX_TIME_SKEW) return null;

  const coverUrl = httpUrl(rec.coverUrl);
  const noteUrl = httpUrl(rec.noteUrl);
  // The click target is the point of the post; without it there is nothing to open.
  if (!noteUrl) return null;

  return {
    id,
    xsecToken: text(rec.xsecToken, MAX_TOKEN),
    title: text(rec.title, MAX_TITLE),
    type: rec.type === 'video' ? 'video' : 'normal',
    time,
    likedCount: text(rec.likedCount, 32),
    nickname: text(rec.nickname, MAX_NAME),
    avatar: httpUrl(rec.avatar),
    coverUrl,
    noteUrl,
  };
}

/**
 * Validate a raw snapshot from the page.
 *
 * Returns `null` when the shape is wrong in a way that means "this is not a
 * profile snapshot at all" (no object, no user id). A snapshot with zero valid
 * notes is returned as-is: whether that is an empty profile or a login wall is the
 * adapter's decision, from `requiresLogin` and the count, not this module's.
 */
export function normalizeXhsSnapshot(raw: unknown): XhsProfileSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;

  const notesIn = Array.isArray(rec.notes) ? rec.notes : [];
  if (notesIn.length > MAX_NOTES) return null;

  const notes: RawXhsNote[] = [];
  const seen = new Set<string>();
  for (const item of notesIn) {
    const note = normalizeNote(item);
    if (!note) continue;
    // The page already dedupes; this is the boundary, so it does not get to decide.
    if (seen.has(note.id)) continue;
    seen.add(note.id);
    notes.push(note);
  }

  const userId = text(rec.userId, MAX_ID).trim();
  const authorName = text(rec.authorName, MAX_NAME);
  // No author and no notes is not a profile we can act on; with notes, the id can
  // be empty for a document that served the feed without a header.
  if (!userId && notes.length === 0) return null;

  const stated = typeof rec.statedTotal === 'number' && Number.isFinite(rec.statedTotal)
    ? Math.max(0, Math.trunc(rec.statedTotal))
    : null;

  return {
    userId,
    authorName,
    authorAvatar: httpUrl(rec.authorAvatar),
    notes,
    saturated: rec.saturated === true,
    statedTotal: stated,
    requiresLogin: rec.requiresLogin === true,
  };
}
