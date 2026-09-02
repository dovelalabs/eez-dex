/**
 * The A.4 state machines, walked rather than asserted — RD-2 IX-2, A.4.
 *
 * `schema/` states which transitions exist; this states how the gateway gets
 * from where a window or an order was to where the chain says it is now. It
 * matters because the chain does not announce every step: a `WindowSettled`
 * log seen by a gateway that never observed the submission is still a window
 * that passed through `settling`, and emitting `open -> settled` would hand
 * the frontend a transition its reducer is entitled to reject.
 *
 * The walk is a breadth-first search over the frozen tables, so the path is
 * the shortest legal one and a path that does not exist is an error here
 * rather than an illegal event on the wire.
 */

import type { OrderState, Transitions, WindowState } from "../schema/index.ts";
import { ORDER_TRANSITIONS, WINDOW_TRANSITIONS } from "../schema/index.ts";

/** No sequence of legal transitions joins two states. */
export class IllegalTransition extends Error {}

/**
 * The states to pass through to get from `from` to `to`, excluding `from`.
 *
 * An empty array means the object is already there.
 */
export function path<S extends string>(table: Transitions<S>, from: S, to: S): readonly S[] {
  if (from === to) return [];

  const previous = new Map<S, S>();
  const queue: S[] = [from];
  const seen = new Set<S>([from]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of table[current]) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      if (next === to) {
        const steps: S[] = [];
        for (let step: S | undefined = to; step !== undefined && step !== from; step = previous.get(step)) {
          steps.unshift(step);
        }
        return steps;
      }
      queue.push(next);
    }
  }

  throw new IllegalTransition(`no path from ${from} to ${to}`);
}

/** The window states to pass through, A.4's machine. */
export function windowPath(from: WindowState, to: WindowState): readonly WindowState[] {
  return path(WINDOW_TRANSITIONS, from, to);
}

/** The order states to pass through, A.4's machine. */
export function orderPath(from: OrderState, to: OrderState): readonly OrderState[] {
  return path(ORDER_TRANSITIONS, from, to);
}
