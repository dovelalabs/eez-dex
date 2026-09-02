/**
 * The demo director — RD-2 FE-9. **Devnet only.**
 *
 * Three controls, each mapping to an HX-3 scenario through the indexer's
 * control proxy: a burst of orders from the scripted accounts, a mid-window
 * move of the L1 pool price, and a stalled builder. The gateway holds no keys
 * and neither does this panel; both are asking WP-4's harness to do something
 * to an enclave that only exists on a devnet.
 *
 * **Compiled out elsewhere, not hidden.** `vite.config.ts` resolves the
 * `@demo-controls` specifier to this module on the devnet profile and to a
 * module that renders nothing on every other, so on a testnet or mainnet build
 * this file is never imported, never bundled, and its routes are never named
 * anywhere in the output. The gateway does the same thing from the other side:
 * off devnet the proxy's routes do not exist to be reached (IX-1).
 */

import { useState } from "react";

import type { AppState } from "../state/app.ts";
import type { AppApi, DemoControl } from "../ui/api.ts";
import { Notice, Panel } from "../ui/parts.tsx";

/** One control, its parameter and the range the proxy will accept. */
interface Control {
  readonly control: DemoControl;
  readonly label: string;
  readonly parameter: string;
  readonly min: number;
  readonly max: number;
  readonly initial: number;
  readonly explains: string;
}

const CONTROLS: readonly Control[] = [
  {
    control: "burst",
    label: "Burst of orders",
    parameter: "orders",
    min: 1,
    max: 64,
    initial: 8,
    explains: "Places orders from the scripted accounts, so one window holds a settlement worth watching (A.6).",
  },
  {
    control: "drift",
    label: "Move the L1 price",
    parameter: "basis points",
    min: -10_000,
    max: 10_000,
    initial: 50,
    explains: "Moves the pool mid-window: the settler selects the subset still inside its limit and the rest roll (FL-8).",
  },
  {
    control: "stall",
    label: "Stall the builder",
    parameter: "slots",
    min: 1,
    max: 12,
    initial: 2,
    explains: "The bundle is not included: the window stretches, and a stalled chain is a visibly stalled window (FE-12).",
  },
];

/** POSTs one control to the gateway's proxy. Devnet only, by construction. */
export async function runDemoControl(indexerUrl: string, control: DemoControl, value: number): Promise<string> {
  const url = new URL(indexerUrl);
  url.pathname = `/director/${control}`;
  const parameter = control === "burst" ? "orders" : control === "drift" ? "bps" : "slots";
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [parameter]: value }),
  });
  const body = (await response.json()) as { ok?: boolean; error?: string; exitCode?: number | null };
  if (response.ok && body.ok === true) return `ran with ${parameter} ${value} (exit ${String(body.exitCode ?? 0)})`;
  return `refused: ${body.error ?? response.status}`;
}

/** FE-9's three controls. */
export function DemoControls({
  state,
  api,
}: {
  readonly state: AppState;
  readonly api: AppApi;
}): React.JSX.Element | null {
  const [values, setValues] = useState<Readonly<Record<string, number>>>(
    Object.fromEntries(CONTROLS.map((control) => [control.control, control.initial])),
  );

  // Demo mode is the only one that drives an enclave; observing a devnet
  // gateway does not make the scenario available to push around.
  if (state.config.mode !== "demo") return null;

  return (
    <Panel title="Director" aside={<span>devnet only</span>}>
      {CONTROLS.map((control) => (
        <div key={control.control} className="stack">
          <div className="row-tight">
            <input
              type="number"
              className="num"
              min={control.min}
              max={control.max}
              value={values[control.control] ?? control.initial}
              aria-label={`${control.label} — ${control.parameter}`}
              onChange={(event) =>
                setValues({ ...values, [control.control]: Number(event.target.value) })
              }
            />
            <button onClick={() => void api.runControl(control.control, values[control.control] ?? control.initial)}>
              {control.label}
            </button>
          </div>
          <p className="small faint">{control.explains}</p>
        </div>
      ))}
      {state.directive === null ? null : (
        <Notice>
          {state.directive.control}: {state.directive.detail}
        </Notice>
      )}
    </Panel>
  );
}
