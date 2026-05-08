#!/usr/bin/env node
/**
 * Microsoft To Do MCP Server
 *
 * A lightweight MCP server for Microsoft To Do, built with
 * @modelcontextprotocol/sdk and the Microsoft Graph REST API.
 * Reads OAuth credentials from environment variables.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Auth setup -----------------------------------------------------------

const clientId = process.env.MS_CLIENT_ID;
const clientSecret = process.env.MS_CLIENT_SECRET;
const refreshToken = process.env.MS_REFRESH_TOKEN;
const tenantId = process.env.MS_TENANT_ID ?? "common";

if (!clientId || !clientSecret || !refreshToken) {
  process.stderr.write(
    "microsoft-todo-mcp: MS_CLIENT_ID, MS_CLIENT_SECRET, and MS_REFRESH_TOKEN must be set\n"
  );
  process.exit(1);
}

const TOKEN_URL = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const body = new URLSearchParams({
    client_id: clientId!,
    client_secret: clientSecret!,
    refresh_token: refreshToken!,
    grant_type: "refresh_token",
    scope: "https://graph.microsoft.com/Tasks.ReadWrite offline_access",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedAccessToken;
}

async function graphGet(path: string): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function graphPost(path: string, body: any): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph POST ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function graphPatch(path: string, body: any): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph PATCH ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function graphDelete(path: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph DELETE ${path} failed (${res.status}): ${text}`);
  }
}

// Paginated GET — follows @odata.nextLink
async function graphGetAll<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = `${GRAPH_BASE}${path}`;
  const token = await getAccessToken();
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph GET ${url} failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as {
      value: T[];
      "@odata.nextLink"?: string;
    };
    items.push(...data.value);
    url = data["@odata.nextLink"] ?? null;
  }
  return items;
}

// --- Types ----------------------------------------------------------------

interface TodoTaskList {
  id: string;
  displayName: string;
  isOwner: boolean;
  isShared: boolean;
  wellknownListName: string;
}

interface ChecklistItem {
  id?: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime?: string;
}

interface TodoTask {
  id: string;
  title: string;
  body?: { content: string; contentType: string };
  status: string;
  importance: string;
  isReminderOn: boolean;
  dueDateTime?: { dateTime: string; timeZone: string };
  completedDateTime?: { dateTime: string; timeZone: string };
  createdDateTime: string;
  lastModifiedDateTime: string;
  checklistItems?: ChecklistItem[];
}

// --- MCP server -----------------------------------------------------------

const server = new McpServer({
  name: "microsoft-todo",
  version: "0.1.0",
});

// --- Tools ----------------------------------------------------------------

server.tool(
  "listTaskLists",
  "List all Microsoft To Do task lists for this account",
  {},
  async () => {
    const lists = await graphGetAll<TodoTaskList>("/me/todo/lists");
    const text = lists
      .map((l) => `- ${l.displayName} (id: ${l.id})${l.wellknownListName !== "none" ? ` [${l.wellknownListName}]` : ""}`)
      .join("\n");
    return { content: [{ type: "text", text: text || "No task lists found." }] };
  }
);

server.tool(
  "listTasks",
  "List tasks in a Microsoft To Do list. Use sort to control ordering.",
  {
    taskListId: z
      .string()
      .describe("Task list ID (use listTaskLists to find IDs)"),
    showCompleted: z
      .boolean()
      .default(false)
      .describe("Include completed tasks"),
    sort: z
      .enum(["default", "newest", "oldest", "updated", "importance"])
      .default("default")
      .describe("Sort order: default (API order), newest/oldest (by creation date), updated (last modified), importance"),
    limit: z
      .number()
      .optional()
      .describe("Max number of tasks to return (default: all)"),
  },
  async ({ taskListId, showCompleted, sort, limit }) => {
    let filter = "";
    if (!showCompleted) {
      filter = "?$filter=status ne 'completed'";
    }
    const allItems = await graphGetAll<TodoTask>(
      `/me/todo/lists/${taskListId}/tasks${filter}`
    );

    // Sort
    switch (sort) {
      case "newest":
        allItems.sort(
          (a, b) =>
            new Date(b.createdDateTime).getTime() -
            new Date(a.createdDateTime).getTime()
        );
        break;
      case "oldest":
        allItems.sort(
          (a, b) =>
            new Date(a.createdDateTime).getTime() -
            new Date(b.createdDateTime).getTime()
        );
        break;
      case "updated":
        allItems.sort(
          (a, b) =>
            new Date(b.lastModifiedDateTime).getTime() -
            new Date(a.lastModifiedDateTime).getTime()
        );
        break;
      case "importance": {
        const rank: Record<string, number> = { high: 0, normal: 1, low: 2 };
        allItems.sort(
          (a, b) => (rank[a.importance] ?? 1) - (rank[b.importance] ?? 1)
        );
        break;
      }
      default:
        break;
    }

    const items = limit && limit > 0 ? allItems.slice(0, limit) : allItems;

    const lines: string[] = [];
    items.forEach((t, i) => {
      const num = i + 1;
      const status = t.status === "completed" ? "[x]" : "[ ]";
      const due = t.dueDateTime
        ? ` (due: ${t.dueDateTime.dateTime.split("T")[0]})`
        : "";
      const imp =
        t.importance !== "normal" ? ` [${t.importance}]` : "";
      const body =
        t.body && t.body.content && t.body.content.trim()
          ? ` — ${t.body.content.trim().substring(0, 100)}`
          : "";
      const updated = ` (updated: ${t.lastModifiedDateTime.split("T")[0]})`;
      lines.push(
        `${num}. ${status} ${t.title}${due}${imp}${body}${updated} (id: ${t.id})`
      );

      // Show checklist items as sub-items
      if (t.checklistItems && t.checklistItems.length > 0) {
        t.checklistItems.forEach((cl, j) => {
          const clStatus = cl.isChecked ? "[x]" : "[ ]";
          lines.push(`${num}.${j + 1}. ${clStatus} ${cl.displayName}`);
        });
      }
    });

    return {
      content: [{ type: "text", text: lines.join("\n") || "No tasks found." }],
    };
  }
);

server.tool(
  "getTask",
  "Get details of a specific task including checklist items",
  {
    taskListId: z.string().describe("Task list ID"),
    taskId: z.string().describe("Task ID"),
  },
  async ({ taskListId, taskId }) => {
    const t = (await graphGet(
      `/me/todo/lists/${taskListId}/tasks/${taskId}`
    )) as TodoTask;

    // Also fetch checklist items
    const checklistItems = await graphGetAll<ChecklistItem>(
      `/me/todo/lists/${taskListId}/tasks/${taskId}/checklistItems`
    );

    const text = JSON.stringify(
      {
        id: t.id,
        title: t.title,
        body: t.body,
        status: t.status,
        importance: t.importance,
        isReminderOn: t.isReminderOn,
        dueDateTime: t.dueDateTime,
        completedDateTime: t.completedDateTime,
        createdDateTime: t.createdDateTime,
        lastModifiedDateTime: t.lastModifiedDateTime,
        checklistItems,
      },
      null,
      2
    );
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "createTask",
  "Create a new task in a Microsoft To Do list",
  {
    taskListId: z.string().describe("Task list ID"),
    title: z.string().describe("Task title"),
    body: z.string().optional().describe("Task body/notes"),
    due: z
      .string()
      .optional()
      .describe("Due date in YYYY-MM-DD format"),
    importance: z
      .enum(["low", "normal", "high"])
      .default("normal")
      .describe("Task importance"),
  },
  async ({ taskListId, title, body, due, importance }) => {
    const requestBody: Record<string, any> = { title, importance };
    if (body) {
      requestBody.body = { content: body, contentType: "text" };
    }
    if (due) {
      requestBody.dueDateTime = {
        dateTime: `${due}T00:00:00.0000000`,
        timeZone: "UTC",
      };
    }

    const res = (await graphPost(
      `/me/todo/lists/${taskListId}/tasks`,
      requestBody
    )) as TodoTask;
    return {
      content: [
        {
          type: "text",
          text: `Created task: "${res.title}" (id: ${res.id})`,
        },
      ],
    };
  }
);

server.tool(
  "updateTask",
  "Update an existing task (title, body, due date, importance)",
  {
    taskListId: z.string().describe("Task list ID"),
    taskId: z.string().describe("Task ID to update"),
    title: z.string().optional().describe("New title"),
    body: z.string().optional().describe("New body/notes"),
    due: z
      .string()
      .optional()
      .describe("New due date in YYYY-MM-DD format"),
    importance: z
      .enum(["low", "normal", "high"])
      .optional()
      .describe("New importance"),
  },
  async ({ taskListId, taskId, title, body, due, importance }) => {
    const requestBody: Record<string, any> = {};
    if (title !== undefined) requestBody.title = title;
    if (body !== undefined)
      requestBody.body = { content: body, contentType: "text" };
    if (due !== undefined)
      requestBody.dueDateTime = {
        dateTime: `${due}T00:00:00.0000000`,
        timeZone: "UTC",
      };
    if (importance !== undefined) requestBody.importance = importance;

    const res = (await graphPatch(
      `/me/todo/lists/${taskListId}/tasks/${taskId}`,
      requestBody
    )) as TodoTask;
    return {
      content: [
        {
          type: "text",
          text: `Updated task: "${res.title}" (id: ${res.id})`,
        },
      ],
    };
  }
);

server.tool(
  "completeTask",
  "Mark a task as completed",
  {
    taskListId: z.string().describe("Task list ID"),
    taskId: z.string().describe("Task ID to complete"),
  },
  async ({ taskListId, taskId }) => {
    const res = (await graphPatch(
      `/me/todo/lists/${taskListId}/tasks/${taskId}`,
      { status: "completed" }
    )) as TodoTask;
    return {
      content: [
        {
          type: "text",
          text: `Completed task: "${res.title}" (id: ${res.id})`,
        },
      ],
    };
  }
);

server.tool(
  "deleteTask",
  "Delete a task from a Microsoft To Do list",
  {
    taskListId: z.string().describe("Task list ID"),
    taskId: z.string().describe("Task ID to delete"),
  },
  async ({ taskListId, taskId }) => {
    await graphDelete(`/me/todo/lists/${taskListId}/tasks/${taskId}`);
    return {
      content: [{ type: "text", text: `Deleted task ${taskId}` }],
    };
  }
);

server.tool(
  "addChecklistItem",
  "Add a checklist item (subtask) to an existing task",
  {
    taskListId: z.string().describe("Task list ID"),
    taskId: z.string().describe("Parent task ID"),
    displayName: z.string().describe("Checklist item text"),
  },
  async ({ taskListId, taskId, displayName }) => {
    const res = (await graphPost(
      `/me/todo/lists/${taskListId}/tasks/${taskId}/checklistItems`,
      { displayName }
    )) as ChecklistItem;
    return {
      content: [
        {
          type: "text",
          text: `Added checklist item: "${res.displayName}" (id: ${res.id})`,
        },
      ],
    };
  }
);

server.tool(
  "updateChecklistItem",
  "Update a checklist item (mark checked/unchecked or rename)",
  {
    taskListId: z.string().describe("Task list ID"),
    taskId: z.string().describe("Parent task ID"),
    checklistItemId: z.string().describe("Checklist item ID"),
    displayName: z.string().optional().describe("New display name"),
    isChecked: z.boolean().optional().describe("Checked state"),
  },
  async ({ taskListId, taskId, checklistItemId, displayName, isChecked }) => {
    const body: Record<string, any> = {};
    if (displayName !== undefined) body.displayName = displayName;
    if (isChecked !== undefined) body.isChecked = isChecked;

    const res = (await graphPatch(
      `/me/todo/lists/${taskListId}/tasks/${taskId}/checklistItems/${checklistItemId}`,
      body
    )) as ChecklistItem;
    return {
      content: [
        {
          type: "text",
          text: `Updated checklist item: "${res.displayName}" (checked: ${res.isChecked})`,
        },
      ],
    };
  }
);

server.tool(
  "deleteChecklistItem",
  "Delete a checklist item from a task",
  {
    taskListId: z.string().describe("Task list ID"),
    taskId: z.string().describe("Parent task ID"),
    checklistItemId: z.string().describe("Checklist item ID to delete"),
  },
  async ({ taskListId, taskId, checklistItemId }) => {
    await graphDelete(
      `/me/todo/lists/${taskListId}/tasks/${taskId}/checklistItems/${checklistItemId}`
    );
    return {
      content: [
        { type: "text", text: `Deleted checklist item ${checklistItemId}` },
      ],
    };
  }
);

// --- Start ----------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("microsoft-todo-mcp: server started\n");
}

main().catch((err) => {
  process.stderr.write(`microsoft-todo-mcp: fatal error: ${err}\n`);
  process.exit(1);
});
