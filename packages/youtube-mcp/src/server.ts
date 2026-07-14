import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { google } from "googleapis";
import { z } from "zod";
import { YouTubeAuth } from "./auth.js";

export interface ServerContext {
  getAuth: () => YouTubeAuth;
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

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer({
    name: "youtube-mcp",
    version: "0.1.0",
  });

  const dataApi = () => google.youtube({ version: "v3", auth: ctx.getAuth() });
  const analyticsApi = () => google.youtubeAnalytics({ version: "v2", auth: ctx.getAuth() });

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

  return server;
}
