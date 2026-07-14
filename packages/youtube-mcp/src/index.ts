#!/usr/bin/env node
import { program } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAuth, YouTubeAuth } from "./auth.js";
import { createServer } from "./server.js";
import { homedir } from "node:os";
import { join } from "node:path";

program
  .name("youtube-mcp")
  .description("YouTube MCP server (channel stats + Analytics API)")
  .requiredOption("--slug <slug>", "Channel token slug (names the credentials file: youtube-<slug>-credentials.json)")
  .option(
    "--token-dir <dir>",
    "Directory containing credentials files",
    join(homedir(), ".config", "youtube-mcp")
  )
  .parse();

const opts = program.opts<{ slug: string; tokenDir: string }>();

const shutdown = (): never => process.exit(0);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Auth loads lazily on first tool call, so the server registers cleanly even
// before the credentials file has been created.
let auth: YouTubeAuth | null = null;
const getAuth = (): YouTubeAuth => {
  if (!auth) auth = loadAuth(opts.slug, opts.tokenDir);
  return auth;
};

const server = createServer({ getAuth });
const transport = new StdioServerTransport();
await server.connect(transport);
