/**
 * The gateway's two doors — RD-2 IX-1, FE-9, FE-10.
 *
 * A JSON-over-WebSocket stream and a REST snapshot, and on the devnet profile
 * only, the director's control proxy. The route table is built once, from the
 * profile: off devnet the director module is **never imported**, so its
 * handlers do not exist to be reached, disabled, or forgotten about.
 *
 * Everything served here is read-only and unauthenticated by design: this
 * gateway holds no keys, and the only state it has is state the chain already
 * published.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { SCHEMA_VERSION } from "../../schema/index.ts";
import type { EventHub } from "../hub.ts";
import type { IndexerProfile } from "../protocol.ts";
import type { DirectorOptions } from "./director.ts";
import { accept } from "./ws.ts";

/** What the gateway serves, and on which profile. */
export interface ServerOptions {
  readonly hub: EventHub;
  readonly profile: IndexerProfile;
  readonly port: number;
  readonly host?: string;
  /** Present only on devnet, and only then are the director routes built. */
  readonly director?: DirectorOptions;
}

/** A running gateway server. */
export interface GatewayServer {
  readonly server: Server;
  /** The port actually bound, which matters when 0 was asked for. */
  readonly port: number;
  /** The routes this profile exposes, for tests and for `/`. */
  readonly routes: readonly string[];
  close(): Promise<void>;
}

type Handler = (request: IncomingMessage, response: ServerResponse, url: URL) => void | Promise<void>;

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // The SPA is served from its own origin and this data is public and
    // read-only; without this the frontend cannot read its own gateway.
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The read-only routes, on every profile.
 *
 * `/events` exists so a client that dropped its socket, or a scrubber winding
 * back through a replay (FE-10), can ask for what it missed by sequence number
 * rather than reconnecting into a different world.
 */
function readRoutes(hub: EventHub): Map<string, Handler> {
  return new Map<string, Handler>([
    [
      "GET /health",
      (_request, response) => send(response, 200, { schemaVersion: SCHEMA_VERSION, status: hub.status() }),
    ],
    ["GET /snapshot", (_request, response) => send(response, 200, hub.snapshot())],
    [
      "GET /events",
      (_request, response, url) => {
        const since = Number(url.searchParams.get("since") ?? 0);
        send(response, 200, {
          schemaVersion: SCHEMA_VERSION,
          since: Number.isFinite(since) ? since : 0,
          events: hub.events(Number.isFinite(since) ? since : 0),
        });
      },
    ],
  ]);
}

/**
 * The director's routes — devnet only.
 *
 * The import is inside the branch: on any other profile this module is not
 * loaded and these handlers do not exist (FE-9, IX-1).
 */
async function directorRoutes(options: DirectorOptions): Promise<Map<string, Handler>> {
  const { DIRECTOR_CONTROLS, DirectorError, runControl } = await import("./director.ts");
  const routes = new Map<string, Handler>();

  for (const control of DIRECTOR_CONTROLS) {
    routes.set(`POST /director/${control}`, async (request, response) => {
      const body = await readBody(request);
      try {
        send(response, 200, { ok: true, ...(await runControl(control, body, options)) });
      } catch (error) {
        if (error instanceof DirectorError) {
          send(response, 400, { ok: false, error: error.message });
          return;
        }
        send(response, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  return routes;
}

/** Starts the gateway's HTTP and WebSocket surface. */
export async function serve(options: ServerOptions): Promise<GatewayServer> {
  const { hub, profile } = options;
  const routes = readRoutes(hub);
  if (profile === "devnet" && options.director !== undefined) {
    for (const [key, handler] of await directorRoutes(options.director)) routes.set(key, handler);
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      response.end();
      return;
    }

    if (url.pathname === "/") {
      send(response, 200, { schemaVersion: SCHEMA_VERSION, routes: [...routes.keys()], stream: "/stream" });
      return;
    }

    const handler = routes.get(`${request.method ?? "GET"} ${url.pathname}`);
    if (handler === undefined) {
      send(response, 404, { error: `no route for ${request.method} ${url.pathname}` });
      return;
    }
    void Promise.resolve(handler(request, response, url)).catch((error: unknown) => {
      if (!response.headersSent) send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/stream" && url.pathname !== "/") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const connection = accept(request, socket, head);
    if (connection === null) return;

    const unsubscribe = hub.subscribe((frame) => connection.send(JSON.stringify(frame)));
    connection.onClose(unsubscribe);
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host ?? "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    server,
    port: address.port,
    routes: [...routes.keys()],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
