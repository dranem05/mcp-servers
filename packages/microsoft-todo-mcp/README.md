# @dranem05/microsoft-todo-mcp

An [MCP](https://modelcontextprotocol.io) server for **Microsoft To Do**. Lets AI assistants (Claude, etc.) list, create, update, complete, and delete tasks and checklist items via the Microsoft Graph API.

## Tools

| Tool | Description |
|---|---|
| `listTaskLists` | List all task lists |
| `listTasks` | List tasks with sorting (default, newest, oldest, updated, importance) |
| `getTask` | Get full details of a task including checklist items |
| `createTask` | Create a task with optional body, due date, and importance |
| `updateTask` | Update title, body, due date, or importance |
| `completeTask` | Mark a task as completed |
| `deleteTask` | Delete a task |
| `addChecklistItem` | Add a checklist item (subtask) to a task |
| `updateChecklistItem` | Check/uncheck or rename a checklist item |
| `deleteChecklistItem` | Delete a checklist item |

## Setup

### 1. Azure AD app registration

1. Go to [Azure Portal](https://portal.azure.com) > Microsoft Entra ID > App registrations > New registration
2. Name: anything you like (e.g., "MCP To Do")
3. Supported account types: choose based on your accounts
4. Redirect URI: select **Web** > `http://localhost`
5. After creation:
   - Overview > copy **Application (client) ID**
   - Certificates & secrets > New client secret > copy the **Value**
6. API permissions > Add > Microsoft Graph > Delegated:
   - `Tasks.ReadWrite`
   - `offline_access`
   - `User.Read`

### 2. Get a refresh token

Use the OAuth 2.0 authorization code flow to obtain a refresh token. You'll need to authorize with the scopes `Tasks.ReadWrite offline_access`.

### 3. Set environment variables

```bash
export MS_CLIENT_ID="your-client-id"
export MS_CLIENT_SECRET="your-client-secret"
export MS_REFRESH_TOKEN="your-refresh-token"
export MS_TENANT_ID="common"  # optional, defaults to "common"
```

### 4. Run

```bash
npx @dranem05/microsoft-todo-mcp
```

Or add to your MCP client config:

```json
{
  "mcpServers": {
    "microsoft-todo": {
      "command": "npx",
      "args": ["@dranem05/microsoft-todo-mcp"],
      "env": {
        "MS_CLIENT_ID": "your-client-id",
        "MS_CLIENT_SECRET": "your-client-secret",
        "MS_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

## License

MIT
