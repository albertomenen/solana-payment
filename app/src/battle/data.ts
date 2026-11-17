// Datos de mercado de memecoins de Solana (APIs públicas de DexScreener y
// GeckoTerminal), con datos de ejemplo por si fallan.

export interface CoinData {
  mint: string;
  symbol: string;
  name: string;
  image?: string;
  priceUsd: number;
  /** Variación en % (DexScreener). */
  change: { m5: number; h1: number; h6: number; h24: number };
  volume24: number;
  liquidity: number;
  marketCap: number;
  createdAt?: number; // ms
  history?: {
    dailyVol: number; // desviación típica de los retornos diarios (fracción)
    drawdown: number; // 0..1 caída desde el máximo
    daysSinceAth: number;
  };
  demo?: boolean;
}

export const PRESETS = [
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { symbol: "POPCAT", mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr" },
  { symbol: "SAMO", mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" },
];

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

interface DexPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
}

function fromPair(p: DexPair): CoinData {
  return {
    mint: p.baseToken.address,
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    image: p.info?.imageUrl,
    priceUsd: num(p.priceUsd),
    change: {
      m5: num(p.priceChange?.m5),
      h1: num(p.priceChange?.h1),
      h6: num(p.priceChange?.h6),
      h24: num(p.priceChange?.h24),
    },
    volume24: num(p.volume?.h24),
    liquidity: num(p.liquidity?.usd),
    marketCap: num(p.marketCap) || num(p.fdv),
    createdAt: p.pairCreatedAt,
  };
}

const bestPair = (pairs: DexPair[], mint?: string) =>
  pairs
    .filter((p) => p.chainId === "solana" && (!mint || p.baseToken.address === mint))
    .sort((a, b) => num(b.liquidity?.usd) - num(a.liquidity?.usd))[0];

/** Histórico diario (GeckoTerminal): volatilidad, máximo y días desde el máximo. */
async function history(pool: string): Promise<CoinData["history"]> {
  const res = await fetch(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/day?limit=365`,
  );
  if (!res.ok) return undefined;
  const list: number[][] = (await res.json())?.data?.attributes?.ohlcv_list ?? [];
  if (list.length < 3) return undefined;
  const rows = [...list].sort((a, b) => a[0] - b[0]); // [ts, o, h, l, c, v]
  const closes = rows.map((r) => r[4]).filter((c) => c > 0);
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i])).slice(-30);
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const dailyVol = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length);
  let ath = 0;
  let athTs = rows[0][0];
  for (const r of rows) if (r[2] > ath) [ath, athTs] = [r[2], r[0]];
  const last = closes[closes.length - 1];
  return {
    dailyVol,
    drawdown: ath > 0 ? Math.max(0, 1 - last / ath) : 0,
    daysSinceAth: Math.max(0, (Date.now() / 1000 - athTs) / 86400),
  };
}

export async function fetchCoin(mint: string): Promise<CoinData> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!res.ok) throw new Error(`DexScreener respondió ${res.status}`);
  const pair = bestPair((await res.json()).pairs ?? [], mint);
  if (!pair) throw new Error("No hay mercado en Solana para ese token");
  const coin = fromPair(pair);
  coin.history = await history(pair.pairAddress).catch(() => undefined);
  return coin;
}

export async function searchCoins(q: string): Promise<{ mint: string; symbol: string; name: string; image?: string }[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  const pairs: DexPair[] = (await res.json()).pairs ?? [];
  const seen = new Set<string>();
  return pairs
    .filter((p) => p.chainId === "solana")
    .sort((a, b) => num(b.liquidity?.usd) - num(a.liquidity?.usd))
    .filter((p) => !seen.has(p.baseToken.address) && seen.add(p.baseToken.address))
    .slice(0, 6)
    .map((p) => ({ mint: p.baseToken.address, symbol: p.baseToken.symbol, name: p.baseToken.name, image: p.info?.imageUrl }));
}

const DAY = 86400_000;

/** Monedas de ejemplo (inventadas) para probar sin conexión. */
export const DEMO_COINS: CoinData[] = [
  {
    mint: "demoBallena1111111111111111111111111111111", symbol: "WHALE", name: "Whale Dog", demo: true,
    priceUsd: 0.000021, change: { m5: 0.1, h1: 0.4, h6: 1.2, h24: 2.1 },
    volume24: 90e6, liquidity: 40e6, marketCap: 1.6e9, createdAt: Date.now() - 900 * DAY,
    history: { dailyVol: 0.05, drawdown: 0.45, daysSinceAth: 300 },
  },
  {
    mint: "demoPump11111111111111111111111111111111111", symbol: "ROCKET", name: "Rocket Cat", demo: true,
    priceUsd: 0.0042, change: { m5: 2.5, h1: 9, h6: 31, h24: 74 },
    volume24: 14e6, liquidity: 1.1e6, marketCap: 9e6, createdAt: Date.now() - 12 * DAY,
    history: { dailyVol: 0.35, drawdown: 0.05, daysSinceAth: 0.5 },
  },
  {
    mint: "demoFantasma111111111111111111111111111111", symbol: "OLDIE", name: "Forgotten Frog", demo: true,
    priceUsd: 0.00000031, change: { m5: 0, h1: 0.2, h6: 0.6, h24: 3.4 },
    volume24: 6e3, liquidity: 30e3, marketCap: 210e3, createdAt: Date.now() - 1100 * DAY,
    history: { dailyVol: 0.02, drawdown: 0.97, daysSinceAth: 980 },
  },
  {
    mint: "demoDiamante11111111111111111111111111111", symbol: "STONE", name: "Stone Hands", demo: true,
    priceUsd: 0.31, change: { m5: 0, h1: -0.2, h6: 0.5, h24: -1.1 },
    volume24: 1.2e6, liquidity: 5e6, marketCap: 60e6, createdAt: Date.now() - 500 * DAY,
    history: { dailyVol: 0.03, drawdown: 0.3, daysSinceAth: 120 },
  },
];
