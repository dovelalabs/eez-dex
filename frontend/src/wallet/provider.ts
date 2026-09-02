/**
 * Wallet connection through the L2's standard providers — RD-2 FE-1, FE-11.
 *
 * EIP-6963 discovery first, `window.ethereum` second: both are the standard
 * surfaces an L2 wallet exposes, and between them they cover every wallet a
 * user is likely to have without this app bundling a connector library.
 *
 * **No keys in the browser beyond the user's own wallet session** (FE-11).
 * Nothing here stores, derives or transmits key material; the app holds an
 * address and a chain id, and every signature is the wallet's own dialogue
 * with its user.
 */

/** The slice of EIP-1193 this app uses. */
export interface Eip1193Provider {
  request(args: { readonly method: string; readonly params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): void;
}

/** An announced provider, with the name it announced (EIP-6963). */
export interface DiscoveredProvider {
  readonly name: string;
  readonly provider: Eip1193Provider;
}

interface Eip6963Detail {
  readonly info: { readonly name: string; readonly rdns: string };
  readonly provider: Eip1193Provider;
}

/**
 * Collects the providers that announce themselves, plus the injected one.
 *
 * EIP-6963's announcement is synchronous in practice but arrives on an event,
 * so this waits a short beat. A user with no wallet gets an empty list, which
 * the UI states plainly rather than treating as an error (§7 preamble).
 */
export async function discoverProviders(timeoutMs = 300): Promise<readonly DiscoveredProvider[]> {
  if (typeof window === "undefined") return [];
  const found = new Map<string, DiscoveredProvider>();

  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail;
    if (detail?.provider === undefined) return;
    found.set(detail.info.rdns, { name: detail.info.name, provider: detail.provider });
  };

  window.addEventListener("eip6963:announceProvider", listener);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  window.removeEventListener("eip6963:announceProvider", listener);

  const injected = (window as { ethereum?: Eip1193Provider }).ethereum;
  if (found.size === 0 && injected !== undefined) found.set("injected", { name: "Injected wallet", provider: injected });
  return [...found.values()];
}

/** An open wallet session: an address, a chain, and the provider behind them. */
export interface Session {
  readonly address: string;
  readonly chainIdHex: string;
  readonly providerName: string;
  readonly provider: Eip1193Provider;
}

/** Asks the wallet for an account. Rejects if the user declines — as it should. */
export async function connect(discovered: DiscoveredProvider): Promise<Session> {
  const accounts = (await discovered.provider.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts[0];
  if (address === undefined) throw new Error("the wallet returned no account");
  const chainIdHex = (await discovered.provider.request({ method: "eth_chainId" })) as string;
  return { address: address.toLowerCase(), chainIdHex, providerName: discovered.name, provider: discovered.provider };
}

/** Asks the wallet to move to the L2 this build trades on. */
export async function switchChain(session: Session, chainIdHex: string): Promise<void> {
  await session.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
}

/** One transaction, as `eth_sendTransaction` takes it. */
export interface Transaction {
  readonly to: string;
  readonly data: string;
  /** Zone ETH carried as `value` — the sell asset in the genesis form (FL-3). */
  readonly value?: string;
}

/** Sends a transaction and returns its hash. The wallet does the signing. */
export async function send(session: Session, transaction: Transaction): Promise<string> {
  const hash = await session.provider.request({
    method: "eth_sendTransaction",
    params: [{ from: session.address, ...transaction }],
  });
  return String(hash);
}
