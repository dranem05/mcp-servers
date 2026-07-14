# @dranem05/youtube-mcp

MCP server for YouTube channel analytics. Read-only: channel stats, raw
[YouTube Analytics API](https://developers.google.com/youtube/analytics)
queries, and weekly (Mon–Sun) metrics rollups suited to marketing and
growth trackers.

## Tools

| Tool | What it does |
|---|---|
| `youtube_channel_stats` | Lifetime snapshot for the authorized channel: subscribers, total views, video count. Also the quickest "which channel am I authorized as?" check. |
| `youtube_analytics_query` | Raw Analytics API passthrough — any metrics/dimensions/filters/sort over a date range (e.g. `views,estimatedMinutesWatched,subscribersGained` by `day` or `video`). |
| `youtube_weekly_metrics` | Monday-to-Sunday weekly buckets of views, watch minutes, and subscribers gained/lost/net. Emits every week in range (zero weeks included); incomplete trailing weeks are flagged `partial`. |

## Setup

### 1. Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com) and create (or pick) a project
2. Enable the **YouTube Data API v3** and the **YouTube Analytics API**
3. Create an **OAuth 2.0 Client ID** (Desktop app) and note the Client ID and Client Secret

### 2. Get a refresh token

Use the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) or your own
OAuth flow to obtain a refresh token with these scopes:

```
https://www.googleapis.com/auth/youtube.readonly
https://www.googleapis.com/auth/yt-analytics.readonly
```

**Important:** at the Google account chooser, pick the **channel identity** you
want analytics for. Brand-account channels appear as their own entry, separate
from the user account that manages them — analytics are scoped to whichever
identity you authorize.

### 3. Write the credentials file

The server reads `<token-dir>/youtube-<slug>-credentials.json` (default token
dir: `~/.config/youtube-mcp/`). The slug is any name you choose — it lets one
machine hold tokens for several channels.

```json
{
  "client_id": "your-client-id",
  "client_secret": "your-client-secret",
  "refresh_token": "your-refresh-token"
}
```

```bash
mkdir -p ~/.config/youtube-mcp && chmod 700 ~/.config/youtube-mcp
# create the file, then:
chmod 600 ~/.config/youtube-mcp/youtube-mychannel-credentials.json
```

How the file gets minted is up to you — a company-shared OAuth client, your own
script, the Playground token pasted by hand — the server only cares about the
three fields above.

### 4. Build and run

Not published to npm — build from source:

```bash
git clone https://github.com/dranem05/mcp-servers.git
cd mcp-servers/packages/youtube-mcp
npm install && npm run build
```

Or grab just this package without the rest of the repo:

```bash
npx degit dranem05/mcp-servers/packages/youtube-mcp youtube-mcp
cd youtube-mcp && npm install && npm run build
```

Register with your MCP client (Claude Code shown):

```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["/path/to/youtube-mcp/dist/index.js", "--slug", "mychannel"]
    }
  }
}
```

Add `--token-dir /some/dir` to read credentials from a non-default location.
The server starts fine before the credentials file exists (auth is lazy);
the first tool call reports exactly what's missing.

## Notes

- Analytics dates are in the channel's timezone; YouTube recomputes recent
  days, so values for the last day or two may drift slightly between queries.
- `youtube_weekly_metrics` is designed for "complete weeks only" ingestion:
  ignore rows flagged `partial` if you're appending to a durable dataset.

## License

MIT
