#!/usr/bin/env node
import { program } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadAuth, LoadedCredentials } from "./auth.js";
import { createServer } from "./server.js";
import { homedir } from "node:os";
import { join } from "node:path";

program
  .name("youtube-mcp")
  .description("YouTube MCP server (channel stats + Analytics API + comment/description writes)")
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
let loaded: LoadedCredentials | null = null;
const getLoaded = (): LoadedCredentials => {
  if (!loaded) loaded = loadAuth(opts.slug, opts.tokenDir);
  return loaded;
};

const server = createServer({
  getAuth: () => getLoaded().client,
  getScopes: () => getLoaded().scopes,
});
const transport = new StdioServerTransport();
await server.connect(transport);
