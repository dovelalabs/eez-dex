/**
 * A WebSocket server, in the small — RD-2 IX-1.
 *
 * IX-1 asks for JSON over WebSocket. The package has no runtime dependencies
 * and this gateway only ever *sends*: it needs the handshake, text frames out,
 * and enough of the frame reader to answer a ping and honour a close. That is
 * a hundred lines of RFC 6455, and it is less to trust than a dependency whose
 * other ninety per cent this service never executes.
 *
 * There is no receive path into the gateway's state. A client that sends a
 * data frame is ignored: the stream is read-only, and the one control surface
 * the product has is the devnet director's REST routes (FE-9).
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/** RFC 6455's handshake constant. */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** One accepted connection. */
export interface WebSocketConnection {
  /** Sends one text frame. Does nothing once the socket has gone. */
  send(text: string): void;
  close(): void;
  /** Runs when the peer or the socket closes it. */
  onClose(listener: () => void): void;
}

/** Encodes one unmasked server frame. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Completes the handshake and returns the connection, or null if the request
 * was not a WebSocket upgrade this server can answer.
 */
export function accept(request: IncomingMessage, socket: Duplex, head: Buffer): WebSocketConnection | null {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }

  const digest = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${digest}`,
      "\r\n",
    ].join("\r\n"),
  );
  if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") socket.setNoDelay(true);

  let closed = false;
  const listeners: (() => void)[] = [];
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const listener of listeners) listener();
  };

  let buffer: Buffer<ArrayBufferLike> = Buffer.concat([head]);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    buffer = drain(buffer, socket, finish);
  });
  socket.on("close", finish);
  socket.on("error", finish);

  return {
    send(text: string) {
      if (closed || socket.destroyed) return;
      socket.write(frame(OPCODE_TEXT, Buffer.from(text, "utf8")));
    },
    close() {
      if (closed || socket.destroyed) return;
      socket.write(frame(OPCODE_CLOSE, Buffer.alloc(0)));
      socket.end();
      finish();
    },
    onClose(listener: () => void) {
      if (closed) listener();
      else listeners.push(listener);
    },
  };
}

/**
 * Consumes whole frames from `buffer`, answering the control ones.
 *
 * Data frames are dropped: the stream has no receive path (IX-1).
 */
function drain(buffer: Buffer<ArrayBufferLike>, socket: Duplex, finish: () => void): Buffer<ArrayBufferLike> {
  for (;;) {
    if (buffer.length < 2) return buffer;
    const opcode = buffer[0]! & 0x0f;
    const masked = (buffer[1]! & 0x80) !== 0;
    let length = buffer[1]! & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < offset + 2) return buffer;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return buffer;
      const wide = buffer.readBigUInt64BE(offset);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
        socket.destroy();
        finish();
        return Buffer.alloc(0);
      }
      length = Number(wide);
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (buffer.length < offset + maskLength + length) return buffer;

    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
    if (mask !== null) {
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    }
    buffer = buffer.subarray(offset + maskLength + length);

    if (opcode === OPCODE_CLOSE) {
      socket.end(frame(OPCODE_CLOSE, Buffer.alloc(0)));
      finish();
      return Buffer.alloc(0);
    }
    if (opcode === OPCODE_PING) socket.write(frame(OPCODE_PONG, payload));
  }
}
