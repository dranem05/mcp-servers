import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google } from "googleapis";
import { z } from "zod";
import { YouTubeAuth } from "./auth.js";
import { buildUpdatedSnippet, MAX_DESCRIPTION_LENGTH } from "./video-snippet.js";

export interface ServerContext {
  getAuth: () => YouTubeAuth;
  // Scopes granted on the current credentials, per the credentials file
  // (see auth.ts). Used for pre-flight scope checks on write tools.
  getScopes: () => string[];
}

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(e: unknown): { content: Array<{ type: "text"; text: string }> } {
  const msg = e instanceof Error ? e.message : String(e);
  return textResult({ error: msg });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(name: string, value: string): void {
  if (!DATE_RE.test(value)) throw new Error(`${name} must be YYYY-MM-DD, got: ${value}`);
}

// Day-of-week for a YYYY-MM-DD string, 0=Sunday..6=Saturday (UTC-safe).
function dow(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Monday of the week containing dateStr.
function mondayOf(dateStr: string): string {
  return addDays(dateStr, -((dow(dateStr) + 6) % 7));
}

// OAuth scopes for the write tools. `comments.insert`/`comments.update`
// accept exactly one scope (force-ssl); `videos.update` accepts any of the
// three "youtube" family scopes. See each tool's assertScope() call.
const SCOPE_FORCE_SSL = "https://www.googleapis.com/auth/youtube.force-ssl";
const SCOPE_YOUTUBE = "https://www.googleapis.com/auth/youtube";
const SCOPE_YOUTUBE_PARTNER = "https://www.googleapis.com/auth/youtubepartner";

// Fails fast with an actionable message when the current credentials lack
// a required scope, instead of letting the API return an opaque 403 after
// a round trip.
function assertScope(scopes: string[], acceptable: string[], action: string): void {
  if (acceptable.some((s) => scopes.includes(s))) return;
  throw new Error(
    `${action} requires one of these OAuth scopes: ${acceptable.join(", ")}. ` +
      `Granted scopes on this credential: ${scopes.length ? scopes.join(", ") : "none recorded"}. ` +
      `Re-mint the token with a write scope included, then retry.`
  );
}

// Reword a 403 from a comment write as an ownership hint — YouTube only
// allows editing/moderating comments the authorized channel authored.
function wrapOwnershipError(e: unknown): unknown {
  const msg = e instanceof Error ? e.message : String(e);
  if (/403/.test(msg) || /forbidden/i.test(msg)) {
    return new Error(
      `${msg}\nLikely cause: this comment was not authored by the authorized channel — YouTube only allows editing your own comments.`
    );
  }
  return e;
}

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer({
    name: "youtube-mcp",
    version: "0.1.0",
  });

  const dataApi = () => google.youtube({ version: "v3", auth: ctx.getAuth() });
  const analyticsApi = () => google.youtubeAnalytics({ version: "v2", auth: ctx.getAuth() });

  // The channel ID of the authorized identity, for the video-ownership
  // check in youtube_video_update_description.
  async function getOwnChannelId(): Promise<string | undefined> {
    const res = await dataApi().channels.list({ mine: true, part: ["id"] });
    return res.data.items?.[0]?.id ?? undefined;
  }

  server.tool(
    "youtube_channel_stats",
    "Lifetime stats snapshot for the authorized channel: subscriber count, total views, video count",
    {},
    async () => {
      try {
        const res = await dataApi().channels.list({
          mine: true,
          part: ["snippet", "statistics"],
        });
        const ch = res.data.items?.[0];
        if (!ch) return textResult({ error: "No channel found for the authorized identity." });
        return textResult({
          channelId: ch.id,
          title: ch.snippet?.title,
          subscribers: ch.statistics?.subscriberCount,
          totalViews: ch.statistics?.viewCount,
          videos: ch.statistics?.videoCount,
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.tool(
    "youtube_analytics_query",
    "Raw YouTube Analytics API query against the authorized channel (ids=channel==MINE). Dates are in the channel's timezone. Useful metrics: views, estimatedMinutesWatched, averageViewDuration, subscribersGained, subscribersLost, impressions (if available), likes, comments, shares.",
    {
      startDate: z.string().describe("YYYY-MM-DD (inclusive)"),
      endDate: z.string().describe("YYYY-MM-DD (inclusive)"),
      metrics: z.string().describe("Comma-separated metrics, e.g. 'views,estimatedMinutesWatched,subscribersGained,subscribersLost'"),
      dimensions: z.string().optional().describe("Comma-separated dimensions, e.g. 'day' or 'video'"),
      filters: z.string().optional().describe("Analytics API filters expression, e.g. 'video==VIDEO_ID'"),
      sort: z.string().optional().describe("Comma-separated sort fields, e.g. 'day' or '-views'"),
      maxResults: z.number().optional().describe("Row cap (API default applies if omitted)"),
    },
    async ({ startDate, endDate, metrics, dimensions, filters, sort, maxResults }) => {
      try {
        assertDate("startDate", startDate);
        assertDate("endDate", endDate);
        const res = await analyticsApi().reports.query({
          ids: "channel==MINE",
          startDate,
          endDate,
          metrics,
          dimensions,
          filters,
          sort,
          maxResults,
        });
        return textResult({
          columnHeaders: res.data.columnHeaders?.map((h) => h.name),
          rows: res.data.rows ?? [],
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.tool(
    "youtube_weekly_metrics",
    "Weekly (Mon–Sun) channel metrics: views, watch minutes, subscribers gained/lost/net per week. One row per week; weeks whose Sunday is in the future or beyond available data are flagged partial.",
    {
      startMonday: z.string().describe("YYYY-MM-DD, must be a Monday"),
      endDate: z.string().optional().describe("YYYY-MM-DD (inclusive); defaults to yesterday"),
    },
    async ({ startMonday, endDate }) => {
      try {
        assertDate("startMonday", startMonday);
        if (dow(startMonday) !== 1) {
          throw new Error(`startMonday ${startMonday} is not a Monday (Monday of that week: ${mondayOf(startMonday)})`);
        }
        const yesterday = addDays(new Date().toISOString().slice(0, 10), -1);
        const end = endDate ?? yesterday;
        assertDate("endDate", end);

        const res = await analyticsApi().reports.query({
          ids: "channel==MINE",
          startDate: startMonday,
          endDate: end,
          metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost",
          dimensions: "day",
          sort: "day",
        });

        type Week = {
          weekStart: string;
          views: number;
          watchMinutes: number;
          subsGained: number;
          subsLost: number;
          netSubs: number;
          daysWithData: number;
          partial?: boolean;
        };
        const weeks = new Map<string, Week>();
        for (const row of res.data.rows ?? []) {
          const [day, views, mins, gained, lost] = row as [string, number, number, number, number];
          const wk = mondayOf(day);
          const w =
            weeks.get(wk) ??
            ({ weekStart: wk, views: 0, watchMinutes: 0, subsGained: 0, subsLost: 0, netSubs: 0, daysWithData: 0 } as Week);
          w.views += views;
          w.watchMinutes += mins;
          w.subsGained += gained;
          w.subsLost += lost;
          w.netSubs = w.subsGained - w.subsLost;
          w.daysWithData += 1;
          weeks.set(wk, w);
        }

        // Emit every Monday in range, including zero weeks the API returned no rows for.
        const out: Week[] = [];
        for (let wk = startMonday; wk <= end; wk = addDays(wk, 7)) {
          const w =
            weeks.get(wk) ??
            ({ weekStart: wk, views: 0, watchMinutes: 0, subsGained: 0, subsLost: 0, netSubs: 0, daysWithData: 0 } as Week);
          if (addDays(wk, 6) > end) w.partial = true;
          out.push(w);
        }
        return textResult({ endDate: end, weeks: out });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.tool(
    "youtube_comment_post",
    "Post a new top-level comment on a video, as the authorized channel. " +
      "There is no API to pin a comment — pinning is a YouTube Studio-only action with no `commentThreads`/`comments` equivalent in the Data API. " +
      "If you need this comment pinned, post it here, then pin it by hand in Studio. " +
      "Requires the youtube.force-ssl OAuth scope.",
    {
      videoId: z.string().describe("Target video ID"),
      text: z.string().min(1).describe("Comment text (plain text; YouTube renders basic line breaks)"),
    },
    async ({ videoId, text }) => {
      try {
        assertScope(ctx.getScopes(), [SCOPE_FORCE_SSL], "Posting a comment");
        const res = await dataApi().commentThreads.insert({
          part: ["snippet"],
          requestBody: {
            snippet: {
              videoId,
              topLevelComment: { snippet: { textOriginal: text } },
            },
          },
        });
        return textResult({
          commentThreadId: res.data.id,
          topLevelCommentId: res.data.snippet?.topLevelComment?.id,
          videoId,
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.tool(
    "youtube_comment_reply",
    "Reply to an existing top-level comment, as the authorized channel. Requires the youtube.force-ssl OAuth scope.",
    {
      parentId: z.string().describe("ID of the top-level comment to reply to"),
      text: z.string().min(1).describe("Reply text"),
    },
    async ({ parentId, text }) => {
      try {
        assertScope(ctx.getScopes(), [SCOPE_FORCE_SSL], "Replying to a comment");
        const res = await dataApi().comments.insert({
          part: ["snippet"],
          requestBody: { snippet: { parentId, textOriginal: text } },
        });
        return textResult({ commentId: res.data.id, parentId });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  server.tool(
    "youtube_comment_update",
    "Edit the text of a comment the authorized channel authored (top-level comment or reply). YouTube rejects edits to comments authored by other users. Requires the youtube.force-ssl OAuth scope.",
    {
      commentId: z.string().describe("ID of the comment to edit"),
      text: z.string().min(1).describe("New comment text, replacing the existing text"),
    },
    async ({ commentId, text }) => {
      try {
        assertScope(ctx.getScopes(), [SCOPE_FORCE_SSL], "Editing a comment");
        const res = await dataApi().comments.update({
          part: ["snippet"],
          requestBody: { id: commentId, snippet: { textOriginal: text } },
        });
        return textResult({ commentId: res.data.id });
      } catch (e) {
        return errorResult(wrapOwnershipError(e));
      }
    }
  );

  server.tool(
    "youtube_video_update_description",
    "Replace a video's description, preserving every other snippet field (title, categoryId, tags, defaultLanguage, defaultAudioLanguage). " +
      "This is a strict read-modify-write: videos.update replaces the whole `snippet` part, so a naive description-only payload would silently wipe the rest. " +
      `Rejects videos the authorized channel does not own, and descriptions over ${MAX_DESCRIPTION_LENGTH} characters, before calling the API. ` +
      "Per-language localized descriptions in the video's `localizations` are untouched by this call (a snippet-only update cannot reach them) and are reported back if present, so a stale localized override doesn't go unnoticed. " +
      "Requires a write-capable OAuth scope (youtube, youtube.force-ssl, or youtubepartner).",
    {
      videoId: z.string().describe("Target video ID"),
      description: z
        .string()
        .max(MAX_DESCRIPTION_LENGTH)
        .describe(`New description text, up to ${MAX_DESCRIPTION_LENGTH} characters`),
    },
    async ({ videoId, description }) => {
      try {
        assertScope(
          ctx.getScopes(),
          [SCOPE_YOUTUBE, SCOPE_FORCE_SSL, SCOPE_YOUTUBE_PARTNER],
          "Updating a video description"
        );

        const lookup = await dataApi().videos.list({
          part: ["snippet", "status", "localizations"],
          id: [videoId],
        });
        const video = lookup.data.items?.[0];
        if (!video || !video.snippet) {
          throw new Error(
            `videos.list returned no snippet for id ${videoId} — the video does not exist, is not visible to this credential, or the ID is wrong. Refusing to update without a snippet to preserve.`
          );
        }

        const ownChannelId = await getOwnChannelId();
        if (ownChannelId && video.snippet.channelId && video.snippet.channelId !== ownChannelId) {
          throw new Error(
            `Video ${videoId} belongs to channel ${video.snippet.channelId}, not the authorized channel (${ownChannelId}). Refusing to update a video this credential does not own.`
          );
        }

        const mergedSnippet = buildUpdatedSnippet(video.snippet, description);

        const res = await dataApi().videos.update({
          part: ["snippet"],
          requestBody: { id: videoId, snippet: mergedSnippet },
        });

        const localizedLanguages = Object.keys(video.localizations ?? {});

        return textResult({
          videoId: res.data.id,
          title: res.data.snippet?.title,
          description: res.data.snippet?.description,
          categoryId: res.data.snippet?.categoryId,
          tags: res.data.snippet?.tags,
          ...(localizedLanguages.length
            ? {
                localizationsNotUpdated: {
                  languages: localizedLanguages,
                  note: "This video has per-language localized descriptions for these language codes. This call only updates the default-language snippet description; the localized overrides are unchanged and may now be stale relative to it.",
                },
              }
            : {}),
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  return server;
}
