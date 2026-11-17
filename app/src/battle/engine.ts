// Motor de batalla de memecoins: estadísticas a partir de datos de mercado y
// combate por turnos determinista (misma semilla => misma batalla).
import type { CoinData } from "./data";

export type MonType = "pump" | "ballena" | "diamante" | "fantasma";

export const TYPE_INFO: Record<MonType, { label: string; emoji: string; beats: MonType }> = {
  pump: { label: "Pump", emoji: "🔥", beats: "ballena" },
  ballena: { label: "Ballena", emoji: "🐋", beats: "diamante" },
  diamante: { label: "Diamante", emoji: "💎", beats: "fantasma" },
  fantasma: { label: "Fantasma", emoji: "👻", beats: "pump" },
};

export interface Stats {
  hp: number;
  atk: number;
  def: number;
  spd: number;
  spc: number; // especial: "remontada" de las olvidadas
}

export interface Fighter {
  coin: CoinData;
  type: MonType;
  stats: Stats;
  /** Puntuación z del movimiento reciente (24 h) frente a su volatilidad. */
  z: number;
  /** 0..1: lo "olvidada" que está (caída desde máximos, poco movimiento). */
  forgotten: number;
}

/** Puntos totales iguales para todas: lo que cambia es el reparto. */
const BUDGET = 300;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
/** Mapea log10(v) del rango [lo, hi] a 0..1. */
const logScale = (v: number, lo: number, hi: number) =>
  clamp((Math.log10(Math.max(v, 1e-12)) - lo) / (hi - lo), 0, 1);

/** Volatilidad diaria típica (fracción): histórico si existe, si no, estimada. */
export function dailyVol(c: CoinData) {
  if (c.history?.dailyVol) return clamp(c.history.dailyVol, 0.005, 2);
  const { h1, h6, h24 } = c.change;
  // Escalado tipo raíz del tiempo de los movimientos recientes.
  const est = Math.max(Math.abs(h24), Math.abs(h6) * 2, Math.abs(h1) * 4.9) / 100;
  return clamp(est, 0.02, 2);
}

export function makeFighter(c: CoinData): Fighter {
  const vol = dailyVol(c);
  const z = clamp(c.change.h24 / 100 / vol, -4, 4);
  const turnover = c.volume24 / Math.max(c.marketCap, 1);
  const drawdown = c.history?.drawdown ?? 0;
  const daysSinceAth = c.history?.daysSinceAth ?? 0;
  const forgotten = clamp(
    0.55 * drawdown + 0.25 * clamp(daysSinceAth / 365, 0, 1) + 0.2 * (1 - logScale(turnover, -3.5, 0)),
    0,
    1,
  );

  // Puntuaciones 0..1 de cada faceta.
  const momentum = sigmoid(z * 1.2);
  const stability = clamp(1 - Math.log10(vol * 100) / 2.3, 0, 1) * 0.6 + logScale(c.liquidity / Math.max(c.marketCap, 1), -3, -0.5) * 0.4;
  const speed = logScale(turnover, -3, 0.3);
  const size = logScale(c.marketCap, 4, 10);
  const age = clamp((Date.now() - (c.createdAt || Date.now())) / (86400_000 * 730), 0, 1);

  // Reparto del presupuesto: base fija + parte proporcional al perfil.
  const w = {
    hp: 0.6 + 0.6 * size + 0.4 * age,
    atk: 0.6 + 1.2 * momentum,
    def: 0.6 + 1.0 * stability,
    spd: 0.6 + 1.0 * speed,
    spc: 0.4 + 1.4 * forgotten,
  };
  const total = w.hp + w.atk + w.def + w.spd + w.spc;
  const pts = (k: keyof typeof w) => Math.round((w[k] / total) * BUDGET);
  const stats: Stats = { hp: pts("hp"), atk: pts("atk"), def: pts("def"), spd: pts("spd"), spc: pts("spc") };

  const type: MonType =
    forgotten > 0.6 ? "fantasma"
      : momentum > 0.7 ? "pump"
      : c.marketCap > 3e8 ? "ballena"
      : stability > 0.55 ? "diamante"
      : momentum >= 0.5 ? "pump"
      : "fantasma";

  return { coin: c, type, stats, z, forgotten };
}

// ---------------- combate ----------------

/** PRNG determinista (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(...parts: string[]) {
  let h = 2166136261;
  for (const c of parts.join("|")) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const MOVES: Record<MonType, { name: string; power: number }[]> = {
  pump: [{ name: "Vela verde", power: 1 }, { name: "To the moon", power: 1.35 }],
  ballena: [{ name: "Coletazo", power: 1 }, { name: "Tsunami de liquidez", power: 1.3 }],
  diamante: [{ name: "Manos de diamante", power: 0.9 }, { name: "Brillo cortante", power: 1.25 }],
  fantasma: [{ name: "Susurro", power: 0.95 }, { name: "Remontada", power: 1.45 }],
};

export type BattleEvent =
  | { kind: "attack"; by: 0 | 1; move: string; damage: number; crit: boolean; effective: boolean; hp: [number, number] }
  | { kind: "miss"; by: 0 | 1; move: string }
  | { kind: "revive"; by: 0 | 1; hp: [number, number] }
  | { kind: "end"; winner: 0 | 1; turns: number };

const maxHp = (f: Fighter) => 60 + f.stats.hp * 2;

/** Simula la batalla completa. `seed` la hace reproducible. */
export function simulate(a: Fighter, b: Fighter, seed: number): BattleEvent[] {
  const r = rng(seed);
  const f = [a, b] as const;
  const hp: [number, number] = [maxHp(a), maxHp(b)];
  const revived = [false, false];
  const events: BattleEvent[] = [];

  for (let turn = 1; turn <= 40; turn++) {
    // Más velocidad => más probabilidad de golpear primero.
    const first: 0 | 1 = r() < f[0].stats.spd / (f[0].stats.spd + f[1].stats.spd) ? 0 : 1;
    for (const by of [first, (1 - first) as 0 | 1]) {
      const me = f[by];
      const foe = f[1 - by];
      const myHpFrac = hp[by] / maxHp(me);
      const moves = MOVES[me.type];
      const move = r() < 0.3 ? moves[1] : moves[0];

      if (r() < 0.1) {
        events.push({ kind: "miss", by, move: move.name });
        continue;
      }
      // Críticos: base + especial; las olvidadas aún más cuanto peor van.
      let critChance = 0.06 + me.stats.spc / 900;
      if (me.type === "fantasma") critChance += (1 - myHpFrac) * 0.15 * (0.5 + me.forgotten);
      const crit = r() < critChance;
      const effective = TYPE_INFO[me.type].beats === foe.type;
      // "Furia": moverse mucho respecto a lo normal da un pequeño extra.
      const fury = 1 + clamp(me.z, 0, 3) * 0.04;
      const base = 20 * move.power * (me.stats.atk / (me.stats.atk + foe.stats.def)) * 2;
      const damage = Math.max(
        1,
        Math.round(base * fury * (effective ? 1.1 : 1) * (crit ? 1.8 : 1) * (0.65 + r() * 0.7)),
      );
      hp[1 - by] = Math.max(0, hp[1 - by] - damage);
      events.push({ kind: "attack", by, move: move.name, damage, crit, effective, hp: [hp[0], hp[1]] });

      if (hp[1 - by] === 0) {
        // Las fantasma pueden resucitar una vez.
        const loser = (1 - by) as 0 | 1;
        if (f[loser].type === "fantasma" && !revived[loser] && r() < 0.12 + 0.2 * f[loser].forgotten) {
          revived[loser] = true;
          hp[loser] = Math.round(maxHp(f[loser]) * 0.25);
          events.push({ kind: "revive", by: loser, hp: [hp[0], hp[1]] });
          continue;
        }
        events.push({ kind: "end", winner: by, turns: turn });
        return events;
      }
    }
  }
  // Sin KO: gana quien conserve más vida proporcional.
  const winner: 0 | 1 = hp[0] / maxHp(a) >= hp[1] / maxHp(b) ? 0 : 1;
  events.push({ kind: "end", winner, turns: 40 });
  return events;
}

export { maxHp };
