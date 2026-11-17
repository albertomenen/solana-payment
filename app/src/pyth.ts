// Oráculo de precios de Pyth: precios en vivo (Hermes) y resolución on-chain.
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Bet, resolveWithPriceIx } from "./wager";

const HERMES = "https://hermes.pyth.network";

/** Feeds de Pyth (los mismos ids en devnet y mainnet). */
export const FEEDS = [
  { symbol: "SOL", id: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  { symbol: "BTC", id: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { symbol: "ETH", id: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
] as const;

/** Exponente con el que guardamos los umbrales (8 decimales). */
export const THRESHOLD_EXPO = -8;

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));

export function feedSymbol(feedId: Uint8Array) {
  const hex = toHex(feedId);
  return FEEDS.find((f) => f.id === hex)?.symbol ?? `0x${hex.slice(0, 6)}…`;
}

/** Valor real de `value * 10^expo`. */
export const scaled = (value: bigint, expo: number) => Number(value) * 10 ** expo;

interface HermesResponse {
  binary: { data: string[] };
  parsed: { id: string; price: { price: string; expo: number; publish_time: number } }[];
}

async function hermes(path: string): Promise<HermesResponse> {
  const res = await fetch(`${HERMES}${path}`);
  if (!res.ok) throw new Error(`Pyth no respondió (${res.status})`);
  return res.json();
}

/** Precio actual en dólares. */
export async function latestPrice(feedHex: string): Promise<number> {
  const r = await hermes(`/v2/updates/price/latest?ids[]=${feedHex}&parsed=true`);
  const p = r.parsed[0].price;
  return Number(p.price) * 10 ** p.expo;
}

/** Actualización firmada del precio en el instante `t` (la primera con publish_time >= t). */
async function updateAt(feedHex: string, t: number) {
  const r = await hermes(`/v2/updates/price/${t}?ids[]=${feedHex}&encoding=base64&parsed=true`);
  const p = r.parsed[0].price;
  return { data: r.binary.data, price: Number(p.price) * 10 ** p.expo, publishTime: p.publish_time };
}

type SignAll = <T extends VersionedTransaction>(txs: T[]) => Promise<T[]>;

/**
 * Publica en Solana el precio firmado de `resolve_at` (verificación completa
 * de Wormhole) y, en la misma tanda, llama a `resolve_with_price`.
 * Phantom pide firmar varias transacciones de golpe.
 */
export async function resolveWithPyth(
  connection: Connection,
  wallet: { publicKey: PublicKey; signTransaction: unknown; signAllTransactions: SignAll },
  bet: Bet,
) {
  const cond = bet.condition!;
  const feedHex = toHex(cond.feedId);
  const update = await updateAt(feedHex, cond.resolveAt);

  // El SDK de Pyth (con Anchor) es pesado: se carga solo al resolver.
  const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
  const receiver = new PythSolanaReceiver({
    connection,
    // El SDK espera la interfaz de wallet de Anchor.
    wallet: wallet as unknown as ConstructorParameters<typeof PythSolanaReceiver>[0]["wallet"],
  });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates(update.data);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => [
    { instruction: resolveWithPriceIx(bet, getPriceUpdateAccount(`0x${feedHex}`)), signers: [] },
  ]);
  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 50_000 });
  await receiver.provider.sendAll(txs, { skipPreflight: true, commitment: "confirmed" });
  return update.price;
}
