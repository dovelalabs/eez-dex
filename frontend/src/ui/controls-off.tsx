/**
 * The scripted demo controls, where they do not exist — RD-2 FE-9.
 *
 * On any profile but devnet, `vite.config.ts` resolves the `@demo-controls`
 * specifier to this module instead of the devnet one. FE-9 asks for the demo
 * affordances to be *compiled out*, not hidden behind a flag, and this is what
 * makes that true: the devnet module is never imported, so it is never
 * bundled, and nothing that names its endpoints appears in the output.
 *
 * The two exports match the ones the devnet module provides, so nothing above
 * this line knows which of the two it is talking to.
 */

import type { AppState } from "../state/app.ts";
import type { AppApi, DemoControl } from "./api.ts";

/** Renders nothing: on this profile there is nothing to render. */
export function DemoControls(_props: {
  readonly state: AppState;
  readonly api: AppApi;
}): React.JSX.Element | null {
  return null;
}

/** There is no control surface on this profile, and no endpoint behind one. */
export function runDemoControl(_indexerUrl: string, control: DemoControl, _value: number): Promise<string> {
  return Promise.resolve(`${control} is not available on this profile`);
}
