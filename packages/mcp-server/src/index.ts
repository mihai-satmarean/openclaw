import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";

const GATEWAY_URL = (process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789").replace(/\/$/, "");
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (GATEWAY_TOKEN) {
    headers["Authorization"] = `Bearer ${GATEWAY_TOKEN}`;
  }
  return headers;
}

async function gatewayFetch(path: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${GATEWAY_URL}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Gateway error ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function gatewayGet(path: string): Promise<unknown> {
  const resp = await fetch(`${GATEWAY_URL}${path}`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Gateway error ${resp.status}: ${text}`);
  }
  return resp.json();
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "openclaw",
    version: "1.0.0",
  });

  server.tool(
    "openclaw_chat",
    "Send a prompt to an OpenClaw agent and get a response. Use this to interact with the AI agent configured in the gateway.",
    {
      prompt: z.string().describe("The message or prompt to send to the agent"),
      agentId: z.string().optional().describe("The agent ID to target (default: 'main')"),
      sessionKey: z.string().optional().describe("Session key for conversation continuity"),
    },
    async ({ prompt, agentId, sessionKey }) => {
      const model = agentId ? `openclaw:${agentId}` : "openclaw:main";
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      };
      if (sessionKey) {
        body["x-openclaw-session-key"] = sessionKey;
      }
      const result = (await gatewayFetch("/v1/chat/completions", body)) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = result?.choices?.[0]?.message?.content ?? "(no response)";
      return { content: [{ type: "text", text: content }] };
    },
  );

  server.tool(
    "openclaw_invoke_tool",
    "Invoke an OpenClaw gateway tool directly. Useful for calling any built-in tool the gateway exposes (e.g. sessions_list, memory_search, web_search, bash).",
    {
      tool: z.string().describe("The tool name to invoke (e.g. 'sessions_list', 'web_search', 'bash')"),
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Tool arguments as a JSON object"),
      sessionKey: z
        .string()
        .optional()
        .describe("Session key to run the tool in (default: 'main')"),
    },
    async ({ tool, args, sessionKey }) => {
      const result = await gatewayFetch("/tools/invoke", {
        tool,
        args: args ?? {},
        sessionKey: sessionKey ?? "main",
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "openclaw_send_message",
    "Send a message through an OpenClaw messaging channel (WhatsApp, Telegram, Discord, Slack, etc.).",
    {
      channel: z
        .enum(["whatsapp", "telegram", "discord", "slack", "signal", "imessage"])
        .describe("The messaging channel to use"),
      target: z
        .string()
        .describe(
          "The target recipient. For WhatsApp/Signal: phone number (+1234567890). For Telegram: chat ID or username. For Discord/Slack: channel ID.",
        ),
      message: z.string().describe("The message text to send"),
    },
    async ({ channel, target, message }) => {
      const result = await gatewayFetch("/tools/invoke", {
        tool: "message_send",
        args: {
          channel,
          target,
          message,
        },
        sessionKey: "main",
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "openclaw_list_sessions",
    "List all active sessions in the OpenClaw gateway, including their current state and recent activity.",
    {},
    async () => {
      const result = await gatewayFetch("/tools/invoke", {
        tool: "sessions_list",
        args: {},
        sessionKey: "main",
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "openclaw_health",
    "Check the health status of the OpenClaw gateway and its configured channels.",
    {},
    async () => {
      try {
        const result = await gatewayGet("/health");
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Gateway unreachable: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

const app = express();
app.use(express.json());

const sessions = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId)!;
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };
    const server = createServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "No session. Use POST /mcp to initialize." });
    return;
  }
  const transport = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
    sessions.delete(sessionId);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", gateway: GATEWAY_URL });
});

app.listen(PORT, () => {
  console.log(`OpenClaw MCP server listening on port ${PORT}`);
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
});
