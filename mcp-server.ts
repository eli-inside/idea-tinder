/**
 * Idea Tinder MCP Server
 * 
 * Implements MCP protocol (SSE transport) for AI agent integration.
 * Runs on port 3002 alongside the main server.
 * 
 * Endpoints:
 *   GET  /mcp/{token}/sse      - Establish SSE connection
 *   POST /mcp/{token}/message  - Send JSON-RPC messages
 */

import { Database } from "bun:sqlite";

const db = new Database("/home/eli/idea-tinder/ideas.db");
const PORT = 3002;

interface Session {
  userId: number;
  email: string;
  controller: ReadableStreamDefaultController;
  messageId: number;
}

const sessions = new Map<string, Session>();

// Validate token and get user
function getUserByToken(token: string): { id: number; email: string; name: string | null } | null {
  return db.query("SELECT id, email, name FROM users WHERE mcp_token = ?").get(token) as any;
}

// Send SSE event
function sendEvent(session: Session, event: string, data: any) {
  const encoder = new TextEncoder();
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  session.controller.enqueue(encoder.encode(message));
}

// Send JSON-RPC response
function sendResponse(session: Session, id: string | number, result: any) {
  sendEvent(session, "message", {
    jsonrpc: "2.0",
    id,
    result,
  });
}

// Send JSON-RPC error
function sendError(session: Session, id: string | number | null, code: number, message: string) {
  sendEvent(session, "message", {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

// Handle tool calls
function handleToolCall(session: Session, id: string | number, name: string, args: any) {
  const userId = session.userId;

  switch (name) {
    case "list_saved_ideas": {
      const limit = args?.limit || 10;
      const category = args?.category;

      let query = `
        SELECT i.title, i.source, i.summary, i.url, i.category, i.content_type,
               s.feedback as hot_take, s.swiped_at
        FROM ideas i
        JOIN swipes s ON i.id = s.idea_id
        WHERE s.user_id = ? AND s.direction = 'right'
      `;
      const params: any[] = [userId];

      if (category) {
        query += " AND i.category = ?";
        params.push(category);
      }

      query += " ORDER BY s.swiped_at DESC LIMIT ?";
      params.push(limit);

      const ideas = db.query(query).all(...params);
      sendResponse(session, id, {
        content: [{ type: "text", text: JSON.stringify(ideas, null, 2) }],
      });
      break;
    }

    case "search_ideas": {
      const searchQuery = args?.query;
      if (!searchQuery) {
        sendResponse(session, id, {
          content: [{ type: "text", text: "Error: query parameter is required" }],
          isError: true,
        });
        return;
      }

      const pattern = `%${searchQuery}%`;
      const ideas = db.query(`
        SELECT i.title, i.source, i.summary, i.url, i.category,
               s.feedback as hot_take, s.swiped_at
        FROM ideas i
        JOIN swipes s ON i.id = s.idea_id
        WHERE s.user_id = ? AND s.direction = 'right'
        AND (i.title LIKE ? OR i.summary LIKE ? OR s.feedback LIKE ?)
        ORDER BY s.swiped_at DESC
        LIMIT 20
      `).all(userId, pattern, pattern, pattern);

      sendResponse(session, id, {
        content: [{ type: "text", text: JSON.stringify(ideas, null, 2) }],
      });
      break;
    }

    case "get_preferences": {
      const stats = db.query(`
        SELECT 
          COUNT(*) as total_swipes,
          SUM(CASE WHEN direction = 'right' THEN 1 ELSE 0 END) as saved,
          SUM(CASE WHEN direction = 'left' THEN 1 ELSE 0 END) as dismissed
        FROM swipes WHERE user_id = ?
      `).get(userId) as any;

      const categories = db.query(`
        SELECT i.category, COUNT(*) as count
        FROM swipes s
        JOIN ideas i ON s.idea_id = i.id
        WHERE s.user_id = ? AND s.direction = 'right'
        GROUP BY i.category
        ORDER BY count DESC
      `).all(userId);

      sendResponse(session, id, {
        content: [{
          type: "text",
          text: JSON.stringify({ stats, favoriteCategories: categories }, null, 2),
        }],
      });
      break;
    }

    case "add_idea": {
      const { title, source, summary, url, category } = args || {};

      if (!title || !source || !summary) {
        sendResponse(session, id, {
          content: [{ type: "text", text: "Error: title, source, and summary are required" }],
          isError: true,
        });
        return;
      }

      db.query(`
        INSERT INTO ideas (title, source, summary, url, category, source_feed, content_type)
        VALUES (?, ?, ?, ?, ?, 'mcp', 'article')
      `).run(title, source, summary, url || null, category || "custom");

      sendResponse(session, id, {
        content: [{ type: "text", text: `Added "${title}" to your idea queue.` }],
      });
      break;
    }

    default:
      sendError(session, id, -32601, `Unknown tool: ${name}`);
  }
}

// Handle JSON-RPC request
function handleRequest(session: Session, message: any) {
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      sendResponse(session, id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "idea-tinder",
          version: "1.0.0",
        },
      });
      break;

    case "tools/list":
      sendResponse(session, id, {
        tools: [
          {
            name: "list_saved_ideas",
            description: "Get your saved ideas with hot takes. Returns ideas you swiped right on.",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Max ideas to return (default 10)" },
                category: { type: "string", description: "Filter by category (optional)" },
              },
            },
          },
          {
            name: "search_ideas",
            description: "Search through your saved ideas by title, summary, or hot take.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
              },
              required: ["query"],
            },
          },
          {
            name: "get_preferences",
            description: "Get your swipe statistics and category preferences.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "add_idea",
            description: "Add a new idea to your queue for later triage.",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Idea title" },
                source: { type: "string", description: "Source name" },
                summary: { type: "string", description: "Brief summary" },
                url: { type: "string", description: "Link (optional)" },
                category: { type: "string", description: "Category (optional)" },
              },
              required: ["title", "source", "summary"],
            },
          },
        ],
      });
      break;

    case "tools/call":
      handleToolCall(session, id, params?.name, params?.arguments);
      break;

    case "notifications/initialized":
      // Client acknowledges initialization - no response needed
      console.log(`[MCP] Session ${session.email} initialized`);
      break;

    default:
      if (id) {
        sendError(session, id, -32601, `Method not found: ${method}`);
      }
  }
}

// HTTP server
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Parse path: /mcp/{token}/sse or /mcp/{token}/message
    const pathMatch = url.pathname.match(/^\/mcp\/([^\/]+)\/(sse|message)$/);
    if (!pathMatch) {
      // Root endpoint - return info
      if (url.pathname === "/" || url.pathname === "/mcp") {
        return new Response(JSON.stringify({
          name: "idea-tinder-mcp",
          version: "1.0.0",
          description: "MCP server for Idea Tinder. Use /mcp/{your-token}/sse to connect.",
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const [, token, endpoint] = pathMatch;

    // Validate token
    const user = getUserByToken(token);
    if (!user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sessionId = `${user.id}-${Date.now()}`;

    // SSE endpoint
    if (endpoint === "sse" && req.method === "GET") {
      console.log(`[MCP] SSE connection from ${user.email}`);

      const stream = new ReadableStream({
        start(controller) {
          const session: Session = {
            userId: user.id,
            email: user.email,
            controller,
            messageId: 0,
          };
          sessions.set(sessionId, session);

          // Send endpoint event (tells client where to POST messages)
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`event: endpoint\ndata: /mcp/${token}/message?sessionId=${sessionId}\n\n`));
        },
        cancel() {
          console.log(`[MCP] SSE closed for ${user.email}`);
          sessions.delete(sessionId);
        },
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Message endpoint
    if (endpoint === "message" && req.method === "POST") {
      const querySessionId = url.searchParams.get("sessionId");
      if (!querySessionId) {
        return new Response(JSON.stringify({ error: "Missing sessionId" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const session = sessions.get(querySessionId);
      if (!session) {
        return new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const message = await req.json();
        console.log(`[MCP] Message from ${user.email}:`, message.method || message.id);
        handleRequest(session, message);

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  },
});

console.log(`Idea Tinder MCP Server running on http://localhost:${PORT}`);
console.log(`Connect via: https://idea-tinder.eli-inside.ai/mcp/{your-token}/sse`);

