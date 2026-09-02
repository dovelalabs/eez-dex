/**
 * What the views may ask the app to do — RD-2 FE-11.
 *
 * Every write path the product has is on this interface, and there are only
 * three: place an order, cancel an order, and — on devnet — run one of the
 * scripted demo controls through the gateway's proxy (FE-9). Everything else
 * is a dispatch into the reducer or a change of the replay's position.
 *
 * Keeping it an interface is what lets the whole component tree be rendered in
 * a test with no wallet, no socket and no gateway behind it (TS-5).
 */

import type { Quote } from "../domain/quote.ts";
import type { Action } from "../state/app.ts";

/** The three controls FE-9 names, mapped to HX-3 ops by the gateway. */
export const DEMO_CONTROLS = ["burst", "drift", "stall"] as const;

/** One of them. */
export type DemoControl = (typeof DEMO_CONTROLS)[number];

/** The app, as a view may use it. */
export interface AppApi {
  readonly dispatch: (action: Action) => void;
  /** Opens a wallet session through the L2's standard providers (FE-1). */
  connectWallet(): Promise<void>;
  /** Places the quoted order through the user's wallet. */
  placeOrder(quote: Quote): Promise<void>;
  /** Cancels one open order (CT-7). */
  cancelOrder(orderId: string): Promise<void>;
  /** Parks the replay at an event, or resumes following with null (FE-10). */
  seek(position: number | null): void;
  /** Changes the replay's clock multiplier (FE-10). */
  setSpeed(speed: number): void;
  /**
   * Runs one scripted control. It exists on devnet and nowhere else: off that
   * profile the module behind it is not in the bundle at all (FE-9).
   */
  runControl(control: DemoControl, value: number): Promise<void>;
}
