#!/usr/bin/env node
/**
 * Google Tasks MCP Server
 *
 * A lightweight MCP server for Google Tasks, built with
 * @modelcontextprotocol/sdk and googleapis. Reads OAuth credentials
 * from environment variables.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google, type tasks_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";

// --- Auth setup -----------------------------------------------------------

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

if (!clientId || !clientSecret || !refreshToken) {
  process.stderr.write(
    "google-tasks-mcp: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN must be set\n"
  );
  process.exit(1);
}

const oauth2 = new OAuth2Client(clientId, clientSecret);
oauth2.setCredentials({ refresh_token: refreshToken });

const tasks: tasks_v1.Tasks = google.tasks({ version: "v1", auth: oauth2 });

// --- MCP server -----------------------------------------------------------

const server = new McpServer({
  name: "google-tasks",
  version: "0.1.0",
});

// --- Tools ----------------------------------------------------------------

server.tool(
  "listTaskLists",
  "List all Google Tasks lists for this account",
  {},
  async () => {
    const res = await tasks.tasklists.list({ maxResults: 100 });
    const items = res.data.items ?? [];
    const text = items
      .map((tl) => `- ${tl.title} (id: ${tl.id})`)
      .join("\n");
    return { content: [{ type: "text", text: text || "No task lists found." }] };
  }
);

server.tool(
  "listTasks",
  "List tasks in a Google Tasks list. By default sorted by UI position. Use sort=newest or sort=updated to sort by approximate creation date or last modified.",
  {
    taskListId: z
      .string()
      .default("@default")
      .describe("Task list ID (use @default for the primary list)"),
    showCompleted: z
      .boolean()
      .default(false)
      .describe("Include completed tasks"),
    showHidden: z
      .boolean()
      .default(false)
      .describe("Include hidden/deleted tasks"),
    sort: z
      .enum(["position", "newest", "oldest", "updated"])
      .default("position")
      .describe("Sort order: position (UI order), newest/oldest (by ID, approximates creation date), updated (last modified)"),
    limit: z
      .number()
      .optional()
      .describe("Max number of tasks to return (default: all)"),
  },
  async ({ taskListId, showCompleted, showHidden, sort, limit }) => {
    const allItems: tasks_v1.Schema$Task[] = [];
    let pageToken: string | undefined;
    do {
      const res = await tasks.tasks.list({
        tasklist: taskListId,
        showCompleted,
        showHidden,
        maxResults: 100,
        pageToken,
      });
      allItems.push(...(res.data.items ?? []));
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    // Extract the numeric task segment from the base64 ID for creation-order sorting
    const taskSeq = (id: string | null | undefined): number => {
      if (!id) return 0;
      try {
        const decoded = Buffer.from(id, "base64").toString("utf-8");
        const parts = decoded.split(":");
        return parseInt(parts[parts.length - 1], 10) || 0;
      } catch {
        return 0;
      }
    };

    const sortItems = (items: tasks_v1.Schema$Task[]) => {
      switch (sort) {
        case "newest":
          items.sort((a, b) => taskSeq(b.id) - taskSeq(a.id));
          break;
        case "oldest":
          items.sort((a, b) => taskSeq(a.id) - taskSeq(b.id));
          break;
        case "updated":
          items.sort((a, b) =>
            (b.updated ?? "").localeCompare(a.updated ?? "")
          );
          break;
        case "position":
        default:
          items.sort((a, b) =>
            (a.position ?? "").localeCompare(b.position ?? "")
          );
          break;
      }
    };

    // Build parent→children map
    const childrenOf = new Map<string, tasks_v1.Schema$Task[]>();
    const topLevel: tasks_v1.Schema$Task[] = [];
    for (const t of allItems) {
      if (t.parent) {
        const siblings = childrenOf.get(t.parent) ?? [];
        siblings.push(t);
        childrenOf.set(t.parent, siblings);
      } else {
        topLevel.push(t);
      }
    }

    // Sort top-level and each children group
    sortItems(topLevel);
    for (const children of childrenOf.values()) {
      sortItems(children);
    }

    // Apply limit to top-level tasks only (children come along with their parent)
    const roots = limit && limit > 0 ? topLevel.slice(0, limit) : topLevel;

    // Recursively render with hierarchical numbering
    const lines: string[] = [];
    const render = (items: tasks_v1.Schema$Task[], prefix: string) => {
      items.forEach((t, i) => {
        const num = `${prefix}${i + 1}`;
        const status = t.status === "completed" ? "[x]" : "[ ]";
        const due = t.due ? ` (due: ${t.due.split("T")[0]})` : "";
        const notes = t.notes ? ` — ${t.notes}` : "";
        const updated = t.updated ? ` (updated: ${t.updated.split("T")[0]})` : "";
        lines.push(`${num}. ${status} ${t.title}${due}${notes}${updated} (id: ${t.id})`);
        const children = t.id ? childrenOf.get(t.id) : undefined;
        if (children && children.length > 0) {
          render(children, `${num}.`);
        }
      });
    };
    render(roots, "");

    return { content: [{ type: "text", text: lines.join("\n") || "No tasks found." }] };
  }
);

server.tool(
  "getTask",
  "Get details of a specific task",
  {
    taskListId: z
      .string()
      .default("@default")
      .describe("Task list ID"),
    taskId: z.string().describe("Task ID"),
  },
  async ({ taskListId, taskId }) => {
    const res = await tasks.tasks.get({ tasklist: taskListId, task: taskId });
    const t = res.data;
    const text = JSON.stringify(
      {
        id: t.id,
        title: t.title,
        notes: t.notes,
        status: t.status,
        due: t.due,
        completed: t.completed,
        deleted: t.deleted,
        hidden: t.hidden,
        parent: t.parent,
        position: t.position,
        links: t.links,
        updated: t.updated,
        etag: t.etag,
        selfLink: t.selfLink,
        kind: t.kind,
      },
      null,
      2
    );
    return { content: [{ type: "text", text }] };
  }
);

server.tool(
  "createTask",
  "Create a new task in a Google Tasks list",
  {
    taskListId: z
      .string()
      .default("@default")
      .describe("Task list ID"),
    title: z.string().describe("Task title"),
    notes: z.string().optional().describe("Task notes/description"),
    due: z
      .string()
      .optional()
      .describe("Due date in YYYY-MM-DD format"),
    parent: z
      .string()
      .optional()
      .describe("Parent task ID to create as a subtask"),
  },
  async ({ taskListId, title, notes, due, parent }) => {
    const body: tasks_v1.Schema$Task = { title };
    if (notes) body.notes = notes;
    if (due) body.due = `${due}T00:00:00.000Z`;

    const res = await tasks.tasks.insert({
      tasklist: taskListId,
      parent,
      requestBody: body,
    });
    return {
      content: [
        {
          type: "text",
          text: `Created task: "${res.data.title}" (id: ${res.data.id})`,
        },
      ],
    };
  }
);

server.tool(
  "updateTask",
  "Update an existing task (title, notes, due date)",
  {
    taskListId: z
      .string()
      .default("@default")
      .describe("Task list ID"),
    taskId: z.string().describe("Task ID to update"),
    title: z.string().optional().describe("New title"),
    notes: z.string().optional().describe("New notes"),
    due: z
      .string()
      .optional()
      .describe("New due date in YYYY-MM-DD format"),
  },
  async ({ taskListId, taskId, title, notes, due }) => {
    const current = await tasks.tasks.get({
      tasklist: taskListId,
      task: taskId,
    });
    const body: tasks_v1.Schema$Task = { ...current.data };
    if (title !== undefined) body.title = title;
    if (notes !== undefined) body.notes = notes;
    if (due !== undefined) body.due = `${due}T00:00:00.000Z`;

    const res = await tasks.tasks.update({
      tasklist: taskListId,
      task: taskId,
      requestBody: body,
    });
    return {
      content: [
        {
          type: "text",
          text: `Updated task: "${res.data.title}" (id: ${res.data.id})`,
        },
      ],
    };
  }
);

server.tool(
  "completeTask",
  "Mark a task as completed",
  {
    taskListId: z
      .string()
      .default("@default")
      .describe("Task list ID"),
    taskId: z.string().describe("Task ID to complete"),
  },
  async ({ taskListId, taskId }) => {
    const current = await tasks.tasks.get({
      tasklist: taskListId,
      task: taskId,
    });
    const res = await tasks.tasks.update({
      tasklist: taskListId,
      task: taskId,
      requestBody: {
        ...current.data,
        status: "completed",
      },
    });
    return {
      content: [
        {
          type: "text",
          text: `Completed task: "${res.data.title}" (id: ${res.data.id})`,
        },
      ],
    };
  }
);

server.tool(
  "deleteTask",
  "Delete a task from a Google Tasks list",
  {
    taskListId: z
      .string()
      .default("@default")
      .describe("Task list ID"),
    taskId: z.string().describe("Task ID to delete"),
  },
  async ({ taskListId, taskId }) => {
    await tasks.tasks.delete({ tasklist: taskListId, task: taskId });
    return {
      content: [{ type: "text", text: `Deleted task ${taskId}` }],
    };
  }
);

server.tool(
  "moveTask",
  "Move a task to a different position (reorder or nest under a parent)",
  {
    taskListId: z
      .string()
      .default("@default")
      .describe("Task list ID"),
    taskId: z.string().describe("Task ID to move"),
    parent: z
      .string()
      .optional()
      .describe("New parent task ID (omit to move to top level)"),
    previous: z
      .string()
      .optional()
      .describe("Task ID to place after (omit to move to first position)"),
  },
  async ({ taskListId, taskId, parent, previous }) => {
    const res = await tasks.tasks.move({
      tasklist: taskListId,
      task: taskId,
      parent,
      previous,
    });
    return {
      content: [
        {
          type: "text",
          text: `Moved task: "${res.data.title}" (id: ${res.data.id})`,
        },
      ],
    };
  }
);

// --- Start ----------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("google-tasks-mcp: server started\n");
}

main().catch((err) => {
  process.stderr.write(`google-tasks-mcp: fatal error: ${err}\n`);
  process.exit(1);
});
