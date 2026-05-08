# @dranem05/google-tasks-mcp

An [MCP](https://modelcontextprotocol.io) server for **Google Tasks**. Lets AI assistants (Claude, etc.) list, create, update, complete, delete, and reorder tasks via the Google Tasks API.

## Tools

| Tool | Description |
|---|---|
| `listTaskLists` | List all task lists |
| `listTasks` | List tasks with sorting (position, newest, oldest, updated) and subtask hierarchy |
| `getTask` | Get full details of a task |
| `createTask` | Create a task (with optional subtask nesting) |
| `updateTask` | Update title, notes, or due date |
| `completeTask` | Mark a task as completed |
| `deleteTask` | Delete a task |
| `moveTask` | Reorder or nest a task under a parent |

## Setup

### 1. Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create a project
2. Enable the **Google Tasks API**
3. Create an **OAuth 2.0 Client ID** (Desktop app)
4. Note your Client ID and Client Secret

### 2. Get a refresh token

Use the OAuth 2.0 Playground or your own OAuth flow to obtain a refresh token with the `https://www.googleapis.com/auth/tasks` scope.

### 3. Set environment variables

```bash
export GOOGLE_CLIENT_ID="your-client-id"
export GOOGLE_CLIENT_SECRET="your-client-secret"
export GOOGLE_REFRESH_TOKEN="your-refresh-token"
```

### 4. Run

```bash
npx @dranem05/google-tasks-mcp
```

Or add to your MCP client config:

```json
{
  "mcpServers": {
    "google-tasks": {
      "command": "npx",
      "args": ["@dranem05/google-tasks-mcp"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret",
        "GOOGLE_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

## License

MIT
