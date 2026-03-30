/**
 * MCP over HTTP — allows claude.ai to connect to Prime's MCP tools remotely.
 *
 * Mounts at /mcp on the existing Express server.
 * Uses StreamableHTTPServerTransport from the MCP SDK.
 *
 * Setup in claude.ai:
 *   Settings → Connectors → Add → paste your tunnel URL + /mcp
 */

import { randomUUID } from 'crypto';
import type { Express, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerPrimeTools, MCP_SERVER_CONFIG } from './mcp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Track active transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();

export function mountMcpHttp(app: Express) {
  // Handle MCP requests (POST for messages, GET for SSE stream, DELETE for cleanup)
  app.all('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (req.method === 'POST') {
      // Check for existing session
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // New session — create transport + server
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const server = new McpServer(MCP_SERVER_CONFIG);
      registerPrimeTools(server);

      transport.onclose = () => {
        const sid = [...transports.entries()].find(([, t]) => t === transport)?.[0];
        if (sid) transports.delete(sid);
      };

      await server.connect(transport);

      // Store transport by the session ID it generated
      const newSessionId = (transport as any).sessionId;
      if (newSessionId) transports.set(newSessionId, transport);

      await transport.handleRequest(req, res);

    } else if (req.method === 'GET') {
      // SSE stream for server-initiated messages
      if (!sessionId || !transports.has(sessionId)) {
        res.status(400).json({ error: 'Missing or invalid session ID' });
        return;
      }
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);

    } else if (req.method === 'DELETE') {
      // Session cleanup
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        transports.delete(sessionId);
      } else {
        res.status(200).end();
      }

    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  });

  console.log('  MCP HTTP endpoint mounted at /mcp');
}
