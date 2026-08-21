import type { youtube_v3 } from "googleapis";

// YouTube's documented cap on video description length.
export const MAX_DESCRIPTION_LENGTH = 5000;

/**
 * videos.update replaces the *entire* `snippet` part of a video resource,
 * not just the fields present in the request body — sending only
 * `description` silently wipes title, categoryId, tags, and
 * defaultLanguage off a live video. This helper takes the snippet exactly
 * as returned by videos.list and returns a new object with only
 * `description` changed, so the caller can send the whole thing back
 * intact. It does not mutate the input.
 *
 * Note on `localizations`: that field lives on the video resource, as a
 * sibling of `snippet`, not nested inside it. An update that specifies
 * `part=snippet` cannot touch `localizations` regardless of what this
 * function returns — the API only replaces the parts named in `part`. So
 * there is no risk of this merge wiping localized overrides; callers should
 * still surface their existence (see server.ts), since a per-language
 * description override left stale after a default-language description
 * change is a real, if different, kind of drift.
 */
export function buildUpdatedSnippet(
  snippet: youtube_v3.Schema$VideoSnippet,
  description: string
): youtube_v3.Schema$VideoSnippet {
  return { ...snippet, description };
}
