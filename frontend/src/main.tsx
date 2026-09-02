/**
 * The SPA entry point — RD-2 WP-6, FE-9, FE-10, FE-11.
 *
 * Everything below is one wiring decision: choose the source the mode calls
 * for, point it at the one reducer, and hand the component tree a small `api`
 * for the three writes the product has. Replay, live and demo differ here and
 * nowhere else — which is the requirement that makes FE-10's modes and FE-12's
 * honest clock cheap instead of triplicated (FE-11).
 *
 * **No keys in the browser** beyond the user's own wallet session: this file
 * holds an address and a provider handle, and every signature is the wallet's
 * own dialogue with its user.
 */

import { StrictMode, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { createRoot } from "react-dom/client";

import { runDemoControl } from "@demo-controls";
import { readConfig, type AppConfig } from "./config.ts";
import type { Quote } from "./domain/quote.ts";
import { initialState, reduce, type Action } from "./state/app.ts";
import { ReplaySource } from "./stream/replay.ts";
import { SocketSource } from "./stream/socket.ts";
import type { Source } from "./stream/source.ts";
import { nowUnix } from "./stream/source.ts";
import { App } from "./ui/App.tsx";
import type { AppApi, DemoControl } from "./ui/api.ts";
import { connect, discoverProviders, send, switchChain, type Session } from "./wallet/provider.ts";
import { encodeCancel, encodePlace, quantity } from "./wallet/calldata.ts";

import "./ui/tokens.css";

/**
 * The source this mode reads from.
 *
 * `replay` reads a recording as a static asset, so the recorded run plays with
 * nothing behind it (§10). Pointing `observe` at a gateway that is itself
 * replaying goes through the socket unchanged, and the app cannot tell the
 * difference — which is IX-1's requirement, from the other direction.
 */
function createSource(config: AppConfig, dispatch: (action: Action) => void): Source {
  if (config.mode === "replay") {
    return new ReplaySource({ fixtureUrl: config.fixtureUrl, dispatch, speed: config.speed });
  }
  return new SocketSource({ indexerUrl: config.indexerUrl, dispatch });
}

function Root({ config }: { readonly config: AppConfig }): React.JSX.Element {
  const [state, dispatch] = useReducer(reduce, config, initialState);
  const source = useRef<Source | null>(null);
  const session = useRef<Session | null>(null);

  useEffect(() => {
    const running = createSource(config, dispatch);
    source.current = running;
    running.start();
    return () => {
      running.stop();
      source.current = null;
    };
  }, [config]);

  const connectWallet = useCallback(async (): Promise<void> => {
    dispatch({ type: "wallet", wallet: { state: "connecting", error: null } });
    try {
      const providers = await discoverProviders();
      const first = providers[0];
      if (first === undefined) {
        dispatch({
          type: "wallet",
          wallet: { state: "absent", error: "No wallet announced itself. Install one, or keep watching read-only." },
        });
        return;
      }
      let open = await connect(first);
      if (config.chainIdHex !== null && open.chainIdHex.toLowerCase() !== config.chainIdHex.toLowerCase()) {
        await switchChain(open, config.chainIdHex);
        open = await connect(first);
      }
      session.current = open;
      const wrongChain =
        config.chainIdHex !== null && open.chainIdHex.toLowerCase() !== config.chainIdHex.toLowerCase();
      dispatch({
        type: "wallet",
        wallet: {
          state: wrongChain ? "wrong_chain" : "connected",
          address: open.address,
          chainIdHex: open.chainIdHex,
          providerName: open.providerName,
          error: wrongChain ? `This build trades on chain ${config.chainIdHex}.` : null,
        },
      });
    } catch (error) {
      dispatch({ type: "wallet", wallet: { state: "disconnected", error: describe(error) } });
    }
  }, [config]);

  const submit = useCallback(
    async (kind: "place" | "cancel", data: string, value: bigint, orderId: string | null): Promise<void> => {
      const open = session.current;
      if (open === null) {
        dispatch({ type: "wallet", wallet: { error: "Connect a wallet first." } });
        return;
      }
      if (config.windowBook === "") {
        dispatch({
          type: "submission",
          submission: {
            kind,
            state: "failed",
            txHash: null,
            orderId,
            detail: "This build has no WindowBook address configured.",
            atUnix: nowUnix(),
          },
        });
        return;
      }

      dispatch({
        type: "submission",
        submission: { kind, state: "signing", txHash: null, orderId, detail: null, atUnix: nowUnix() },
      });
      try {
        const txHash = await send(open, {
          to: config.windowBook,
          data,
          ...(value > 0n ? { value: quantity(value) } : {}),
        });
        dispatch({
          type: "submission",
          // Submitted, and no further. An order becomes real when the stream
          // says the book took it, and confirmed when its window settles (FE-2).
          submission: { kind, state: "submitted", txHash, orderId, detail: null, atUnix: nowUnix() },
        });
      } catch (error) {
        dispatch({
          type: "submission",
          submission: { kind, state: "failed", txHash: null, orderId, detail: describe(error), atUnix: nowUnix() },
        });
      }
    },
    [config],
  );

  const placeOrder = useCallback(
    async (quote: Quote): Promise<void> => {
      const open = session.current;
      if (open === null) {
        dispatch({ type: "wallet", wallet: { error: "Connect a wallet first." } });
        return;
      }
      const sell = quote.side === "SELL_A_FOR_B" ? config.assetA : config.assetB;
      const native = /^0x0{40}$/.test(sell.address);
      await submit(
        "place",
        encodePlace({
          side: quote.side,
          sellAmount: quote.sellAmount,
          minBuyAmount: quote.minBuyAmount,
          recipient: open.address,
          expiresAfter: 1,
        }),
        // The sell asset is carried as `value` when it is the rail's native
        // asset; an ERC-20 is escrowed by the book's own transferFrom (CT-11).
        native ? quote.sellAmount : 0n,
        null,
      );
    },
    [config, submit],
  );

  const cancelOrder = useCallback(
    async (orderId: string): Promise<void> => {
      await submit("cancel", encodeCancel(orderId), 0n, orderId);
    },
    [submit],
  );

  const api: AppApi = useMemo(
    () => ({
      dispatch,
      connectWallet,
      placeOrder,
      cancelOrder,
      seek: (position: number | null) => source.current?.seek?.(position),
      setSpeed: (speed: number) => source.current?.setSpeed?.(speed),
      runControl: async (control: DemoControl, value: number) => {
        const detail = await runDemoControl(config.indexerUrl, control, value);
        dispatch({ type: "directive", control, detail });
      },
    }),
    [config, connectWallet, placeOrder, cancelOrder],
  );

  return <App state={state} api={api} />;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Root config={readConfig(import.meta.env, window.location.search)} />
    </StrictMode>,
  );
}
