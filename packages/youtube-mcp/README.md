# @dranem05/youtube-mcp

MCP server for YouTube channels: analytics (channel stats, raw
[YouTube Analytics API](https://developers.google.com/youtube/analytics)
queries, weekly Mon–Sun rollups) plus a small set of write tools for
comments and video descriptions.

## Tools

| Tool | What it does |
|---|---|
| `youtube_channel_stats` | Lifetime snapshot for the authorized channel: subscribers, total views, video count. Also the quickest "which channel am I authorized as?" check. |
| `youtube_analytics_query` | Raw Analytics API passthrough — any metrics/dimensions/filters/sort over a date range (e.g. `views,estimatedMinutesWatched,subscribersGained` by `day` or `video`). |
| `youtube_weekly_metrics` | Monday-to-Sunday weekly buckets of views, watch minutes, and subscribers gained/lost/net. Emits every week in range (zero weeks included); incomplete trailing weeks are flagged `partial`. |
| `youtube_comment_post` | Post a new top-level comment on a video, as the authorized channel. Write tool — see "Write tools" below. |
| `youtube_comment_reply` | Reply to an existing top-level comment. Write tool. |
| `youtube_comment_update` | Edit a comment the authorized channel authored. Write tool. |
| `youtube_video_update_description` | Replace a video's description without disturbing its other metadata. Write tool. |

### Write tools

These four call the Data API's `commentThreads`/`comments`/`videos` write
endpoints and need the additional OAuth scope described under
"Authentication" below.

- **No pin tool, on purpose.** The Data API has no endpoint to pin a
  comment (`comments.setModerationStatus` is comment moderation, a
  different thing — it does not pin). Pinning is a YouTube Studio-only
  action; if you need a comment pinned, post it with `youtube_comment_post`
  and pin it by hand afterward.
- **`youtube_video_update_description` is a strict read-modify-write.**
  `videos.update` replaces the *entire* `snippet` part of a video resource,
  not just the fields you send — sending only a description would silently
  wipe the title, categoryId, tags, and defaultLanguage off a live video.
  This tool fetches the current snippet first, changes only the
  description, and sends the whole thing back. It also rejects videos the
  authorized channel doesn't own and descriptions over 5000 characters
  before calling the API, rather than surfacing an opaque 403 or a
  server-side truncation.
- **Localized descriptions are a separate, unaffected thing.** A video's
  `localizations` (per-language title/description overrides) is a sibling
  field of `snippet`, not nested inside it — an update scoped to
  `part=snippet` cannot touch it either way. `youtube_video_update_description`
  reports which language codes have localized overrides in its response, so
  you notice if one is now stale relative to the description you just
  changed, but it does not update them; do that with a separate
  `videos.update` call using `part=localizations` if needed.

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

Add this scope too if you want the **write tools** (`youtube_comment_post`,
`youtube_comment_reply`, `youtube_comment_update`,
`youtube_video_update_description`) to work:

```
https://www.googleapis.com/auth/youtube.force-ssl
```

This is deliberately **opt-in, not requested by default.** Asking for a
write scope when the caller only wants analytics is a real cost — a wider
consent screen, and a token that can mutate a channel's public content
sitting around for a use case that never needed to. Request it only when
you actually intend to use the write tools. (Note for `videos.update`
specifically: it also accepts the broader `youtube` or `youtubepartner`
scopes if you already hold one of those for other reasons — `force-ssl`
alone does not need to be requested twice.)

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
  "refresh_token": "your-refresh-token",
  "scopes": ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"]
}
```

The `scopes` field is optional but recommended: the write tools read it to
fail fast with an actionable message when a token lacks the scope a write
needs, instead of surfacing the API's opaque 403. Record whatever scopes
you actually requested when minting the token.

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
- `youtube_video_update_description`'s merge logic (the part that can
  silently destroy metadata if it's wrong) has a fixture test:
  `npm run build && npm test`. The fixture is a real `videos.list` response
  with identifying values replaced by placeholders; the test asserts that
  title, categoryId, tags, and defaultLanguage all survive a description
  change untouched — not just that the description itself changed.

## License

MIT
