/**
 * What arrives on the wire, checked at the door — RD-2 IX-2, FE-11.
 *
 * The schema is versioned in one place and a consumer that reads a version it
 * does not know **refuses the stream rather than guessing** (`schema/version`),
 * because a recorded run may be months older than the app replaying it and
 * mis-reading it silently would make replay stop equalling live (TS-5).
 *
 * The checks here are the ones a reader owes the sender: the version, the
 * envelope's shape, and the event kind. Everything deeper is the gateway's own
 * boundary check (`src/validate.ts`), which this app does not repeat.
 */

import type { ServerFrame } from "@eez-dex/indexer";
import type { SlotEvent } from "@eez-dex/indexer/schema";
import { SCHEMA_VERSION, SLOT_EVENT_KINDS } from "@eez-dex/indexer/schema";

/** A frame or a recording this build will not read. */
export class UnreadableStream extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Whether a value is an event of the version and shape this build speaks. */
export function isSlotEvent(value: unknown): value is SlotEvent {
  return (
    isObject(value) &&
    value["schemaVersion"] === SCHEMA_VERSION &&
    typeof value["seq"] === "number" &&
    typeof value["atUnix"] === "number" &&
    typeof value["kind"] === "string" &&
    (SLOT_EVENT_KINDS as readonly string[]).includes(value["kind"])
  );
}

/**
 * Reads one WebSocket frame.
 *
 * Throws {@link UnreadableStream} rather than returning null: a frame this
 * build cannot read is a reason to close the connection and say so, not a
 * frame to skip quietly on the way to rendering a state that is missing it.
 */
export function parseFrame(text: string): ServerFrame {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UnreadableStream("the stream sent something that is not JSON");
  }
  if (!isObject(value)) throw new UnreadableStream("a frame that is not an object");

  switch (value["type"]) {
    case "snapshot": {
      const snapshot = value["snapshot"];
      if (!isObject(snapshot)) throw new UnreadableStream("a snapshot frame without a snapshot");
      requireVersion(snapshot["schemaVersion"]);
      return value as unknown as ServerFrame;
    }
    case "status": {
      const status = value["status"];
      if (!isObject(status)) throw new UnreadableStream("a status frame without a status");
      requireVersion(status["schemaVersion"]);
      return value as unknown as ServerFrame;
    }
    case "event": {
      const event = value["event"];
      if (!isSlotEvent(event)) {
        requireVersion(isObject(event) ? event["schemaVersion"] : undefined);
        throw new UnreadableStream("an event frame this build does not recognise");
      }
      return { type: "event", event };
    }
    default:
      throw new UnreadableStream(`a frame of an unknown type: ${String(value["type"])}`);
  }
}

/**
 * Reads a recorded run: the gateway's `{schemaVersion, events}` document, or a
 * bare event log, which is the shape HX-5 writes.
 */
export function parseRecording(value: unknown): readonly SlotEvent[] {
  const raw = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value["events"])
      ? (value["events"] as unknown[])
      : null;
  if (raw === null) throw new UnreadableStream("a recording that is not an event log");

  return raw.map((event, index) => {
    if (!isSlotEvent(event)) {
      requireVersion(isObject(event) ? event["schemaVersion"] : undefined);
      throw new UnreadableStream(`a recorded event this build does not recognise, at index ${index}`);
    }
    return event;
  });
}

function requireVersion(version: unknown): void {
  if (version !== SCHEMA_VERSION) {
    throw new UnreadableStream(
      `schema version ${String(version)}: this build reads version ${SCHEMA_VERSION} and will not guess at another`,
    );
  }
}
