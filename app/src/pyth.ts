// Oráculo de precios de Pyth, sin API de pago: Pyth mantiene en Solana una
// cuenta pública por feed (PriceUpdateV2, totalmente verificada) que se
// actualiza sola. La web la lee para mostrar el precio y la pasa al programa
// para resolver.
import { Connection, PublicKey } from "@solana/web3.js";
import { Bet, resolveWithPriceIx } from "./wager";

/** Programa de Pyth que mantiene las cuentas de precio patrocinadas. */
const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

/** Ventana tras la hora acordada en la que se acepta un precio (como en el programa). */
export const PRICE_WINDOW = 1800;

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

/** Dirección de la cuenta de precio patrocinada (shard 0) de un feed. */
export function pushFeedAddress(feedHex: string) {
  const shard = new Uint8Array(2); // u16 LE = 0
  return PublicKey.findProgramAddressSync([shard, fromHex(feedHex)], PUSH_ORACLE)[0];
}

export interface OnchainPrice {
  price: number;
  publishTime: number;
  address: PublicKey;
}

/** Lee el último precio publicado on-chain para un feed. */
export async function readPushPrice(connection: Connection, feedHex: string): Promise<OnchainPrice> {
  const address = pushFeedAddress(feedHex);
  const acc = await connection.getAccountInfo(address);
  if (!acc) throw new Error("Pyth no tiene cuenta de precio para este activo en esta red");
  const d = new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength);
  // discriminador (8) + write_authority (32) + verification_level (1 o 2) + feed_id (32)
  let o = 8 + 32;
  o += acc.data[o] === 0 ? 2 : 1;
  o += 32;
  const price = d.getBigInt64(o, true);
  const expo = d.getInt32(o + 16, true);
  const publishTime = Number(d.getBigInt64(o + 20, true));
  return { price: scaled(price, expo), publishTime, address };
}

/** Instrucción para resolver con la cuenta de precio patrocinada. */
export const resolveWithPushIx = (bet: Bet) =>
  resolveWithPriceIx(bet, pushFeedAddress(toHex(bet.condition!.feedId)));
