/**
 * The one place the event schema is versioned — RD-2 IX-2.
 *
 * Every top-level object on the wire carries `schemaVersion`. A consumer that
 * reads a version it does not know refuses the stream rather than guessing:
 * a replayed fixture (HX-5) may be months older than the frontend reading it,
 * and silently mis-reading it would make replay stop equalling live (TS-5).
 *
 * Bump on any change that an older reader would mis-read: a removed or
 * renamed field, a narrowed type, a new state in a state machine. Adding an
 * optional field does not need a bump.
 */
export const SCHEMA_VERSION = 1;

/** The version this build emits and accepts. */
export type SchemaVersion = typeof SCHEMA_VERSION;

/** Every object that travels on the IX-1 stream carries its version. */
export interface Versioned {
  readonly schemaVersion: SchemaVersion;
}
