import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CoinData, DEMO_COINS, PRESETS, fetchCoin, searchCoins } from "./data";
import { BattleEvent, Fighter, TYPE_INFO, hashSeed, makeFighter, maxHp, simulate } from "./engine";
import { SpriteStyle, buildSprite, monsterSprite } from "./sprite";

const StyleCtx = createContext<SpriteStyle>("logo");

// ---------------- utilidades ----------------

const fmtUsd = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)} B$` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} M$` : v >= 1e3 ? `${(v / 1e3).toFixed(0)} k$` : `${v.toFixed(0)} $`;
const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} %`;

function useSprite(f: Fighter | null) {
  const style = useContext(StyleCtx);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!f) return setUrl(null);
    let alive = true;
    setUrl(monsterSprite(f.coin.mint, f.type)); // al instante, mientras carga el logo
    buildSprite(f.coin.mint, f.type, f.coin.image, style).then((s) => alive && setUrl(s.url));
    return () => {
      alive = false;
    };
  }, [f, style]);
  return url;
}

/** Logo original (no necesita CORS para mostrarse). */
function Logo({ f, size = 20 }: { f: Fighter; size?: number }) {
  const [ok, setOk] = useState(true);
  if (!f.coin.image || !ok) return null;
  return <img className="coin-logo" src={f.coin.image} width={size} height={size} alt="" onError={() => setOk(false)} />;
}

function Sprite({ f, flip, className = "" }: { f: Fighter; flip?: boolean; className?: string }) {
  const url = useSprite(f);
  return url ? <img className={`sprite ${flip ? "flip" : ""} ${className}`} src={url} alt={f.coin.symbol} /> : <div className="sprite" />;
}

function StatBar({ label, v }: { label: string; v: number }) {
  return (
    <div className="statbar">
      <span>{label}</span>
      <div className="track"><div className="fill" style={{ width: `${Math.min(100, (v / 110) * 100)}%` }} /></div>
      <strong>{v}</strong>
    </div>
  );
}

// ---------------- selector de luchador ----------------

function Picker({ onPick, demo }: { onPick: (c: CoinData) => void; demo: boolean }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ mint: string; symbol: string; name: string }[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (demo || q.trim().length < 2) return setResults([]);
    const t = setTimeout(() => searchCoins(q.trim()).then(setResults).catch(() => setResults([])), 350);
    return () => clearTimeout(t);
  }, [q, demo]);

  async function pick(mint: string) {
    setLoading(mint);
    setError("");
    try {
      onPick(await fetchCoin(mint));
    } catch (e) {
      setError(`No se pudieron cargar los datos (${(e as Error).message}). Prueba el modo demo.`);
    } finally {
      setLoading(null);
    }
  }

  if (demo)
    return (
      <div className="chips left">
        {DEMO_COINS.map((c) => (
          <button key={c.mint} className="chip" onClick={() => onPick(c)}>{c.symbol}</button>
        ))}
      </div>
    );

  return (
    <div>
      <div className="chips left">
        {PRESETS.map((p) => (
          <button key={p.mint} className="chip" disabled={!!loading} onClick={() => pick(p.mint)}>
            {loading === p.mint ? "…" : p.symbol}
          </button>
        ))}
      </div>
      <input className="input" style={{ marginTop: 10 }} value={q} placeholder="Busca una memecoin o pega su dirección"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && q.trim().length > 30 && pick(q.trim())} />
      {results.length > 0 && (
        <div className="list" style={{ marginTop: 8 }}>
          {results.map((r) => (
            <button key={r.mint} className="row-item" style={{ border: 0, textAlign: "left" }} disabled={!!loading} onClick={() => pick(r.mint)}>
              <div className="main">
                <div className="t">{loading === r.mint ? "Cargando…" : r.symbol}</div>
                <div className="s">{r.name}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {error && <p className="toast err">{error}</p>}
    </div>
  );
}

function FighterCard({ f, side, onClear }: { f: Fighter; side: string; onClear: () => void }) {
  const t = TYPE_INFO[f.type];
  const c = f.coin;
  return (
    <div className="fighter-card reveal">
      <div className="fc-head">
        <Sprite f={f} className="idle" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="muted" style={{ fontSize: "0.75rem" }}>{side}</div>
          <div className="fc-name"><Logo f={f} />{c.symbol} <span className={`type-pill t-${f.type}`}>{t.emoji} {t.label}</span></div>
          <div className="muted" style={{ fontSize: "0.78rem" }}>
            MC {fmtUsd(c.marketCap)} · 24 h {fmtPct(c.change.h24)}
            {f.z > 1.5 && " · ¡despierta!"}
          </div>
        </div>
        <button className="icon-btn" aria-label="Cambiar" onClick={onClear}>✕</button>
      </div>
      <StatBar label="Vida" v={f.stats.hp} />
      <StatBar label="Ataque" v={f.stats.atk} />
      <StatBar label="Defensa" v={f.stats.def} />
      <StatBar label="Velocidad" v={f.stats.spd} />
      <StatBar label="Especial" v={f.stats.spc} />
    </div>
  );
}

// ---------------- arena ----------------

function eventText(e: BattleEvent, f: [Fighter, Fighter]) {
  const n = (i: 0 | 1) => f[i].coin.symbol;
  switch (e.kind) {
    case "attack":
      return `${n(e.by)} usa ${e.move}${e.crit ? ". ¡Golpe crítico!" : ""}${e.effective ? " ¡Es muy eficaz!" : ""}`;
    case "miss":
      return `${n(e.by)} usa ${e.move}… ¡pero falla!`;
    case "revive":
      return `¡${n(e.by)} resucita desde el olvido!`;
    case "end":
      return `¡${n(e.winner)} gana la batalla!`;
  }
}

function Arena({ f, seed, onExit, onRematch }: { f: [Fighter, Fighter]; seed: number; onExit: () => void; onRematch: () => void }) {
  const events = useMemo(() => simulate(f[0], f[1], seed), [f, seed]);
  const [step, setStep] = useState(-1);
  const [hp, setHp] = useState<[number, number]>([maxHp(f[0]), maxHp(f[1])]);
  const [anim, setAnim] = useState<{ atk?: 0 | 1; hit?: 0 | 1; dmg?: { side: 0 | 1; v: number; crit: boolean }; key: number }>({ key: 0 });
  const shakeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (step + 1 >= events.length) return;
      const e = events[step + 1];
      setStep(step + 1);
      if (e.kind === "attack") {
        setAnim({ atk: e.by, key: step });
        setTimeout(() => {
          setHp(e.hp);
          setAnim({ hit: (1 - e.by) as 0 | 1, dmg: { side: (1 - e.by) as 0 | 1, v: e.damage, crit: e.crit }, key: step });
          if (e.crit) {
            navigator.vibrate?.(40);
            shakeRef.current?.classList.remove("shake");
            void shakeRef.current?.offsetWidth;
            shakeRef.current?.classList.add("shake");
          }
        }, 260);
      } else if (e.kind === "revive") {
        setHp(e.hp);
        setAnim({ key: step });
      } else if (e.kind === "end") {
        navigator.vibrate?.([20, 60, 20]);
      }
    }, step < 0 ? 700 : 1150);
    return () => clearTimeout(t);
  }, [step, events]);

  const current = step >= 0 ? events[step] : null;
  const end = current?.kind === "end" ? current : null;

  const side = (i: 0 | 1) => {
    const pct = (100 * hp[i]) / maxHp(f[i]);
    const ko = end && end.winner !== i;
    return (
      <div className={`arena-side s${i}`}>
        <div className="hpbox">
          <div className="hp-name"><span style={{ display: "flex", gap: 5, alignItems: "center" }}><Logo f={f[i]} size={14} />{f[i].coin.symbol}</span> <span>{TYPE_INFO[f[i].type].emoji}</span></div>
          <div className="hp-track"><div className={`hp-fill ${pct < 25 ? "low" : pct < 50 ? "mid" : ""}`} style={{ width: `${pct}%` }} /></div>
          <div className="hp-num">{hp[i]} / {maxHp(f[i])}</div>
        </div>
        <div className="sprite-wrap">
          <Sprite f={f[i]} flip={i === 0}
            className={[
              anim.atk === i ? `lunge${i}` : "",
              anim.hit === i ? "hit" : "",
              ko ? "ko" : "",
              end?.winner === i ? "win" : "",
              current?.kind === "revive" && current.by === i ? "revive" : "",
              !anim.atk && anim.atk !== 0 && !end ? "idle" : "",
            ].join(" ")}
            key={`${i}-${anim.key}`} />
          {anim.dmg?.side === i && (
            <span className={`dmg ${anim.dmg.crit ? "crit" : ""}`} key={`d${anim.key}`}>-{anim.dmg.v}</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <div className="arena" ref={shakeRef}>
        {side(1)}
        {side(0)}
      </div>
      <div className="battle-log" key={step}>
        {current ? eventText(current, f) : `¡${f[0].coin.symbol} desafía a ${f[1].coin.symbol}!`}
      </div>
      {end && (
        <div className="reveal">
          <button className="btn" onClick={onRematch}>Revancha</button>
          <button className="btn ghost" onClick={onExit}>Cambiar luchadores</button>
          <p className="hint center">Semilla de la batalla: {seed}. La misma semilla repite exactamente el mismo combate.</p>
        </div>
      )}
    </div>
  );
}

// ---------------- página ----------------

export function BattlePage() {
  const [demo, setDemo] = useState(false);
  const [style, setStyle] = useState<SpriteStyle>(() => {
    try {
      return (localStorage.getItem("spriteStyle") as SpriteStyle) || "logo";
    } catch {
      return "logo";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("spriteStyle", style);
    } catch {
      /* sin almacenamiento */
    }
  }, [style]);
  const [coins, setCoins] = useState<[CoinData | null, CoinData | null]>([null, null]);
  const [seed, setSeed] = useState<number | null>(null);

  const fighters = useMemo(
    () => coins.map((c) => (c ? makeFighter(c) : null)) as [Fighter | null, Fighter | null],
    [coins],
  );
  const ready = fighters[0] && fighters[1];
  const set = (i: 0 | 1) => (c: CoinData | null) => setCoins((cs) => (i === 0 ? [c, cs[1]] : [cs[0], c]));

  const fight = () =>
    setSeed(hashSeed(coins[0]!.mint, coins[1]!.mint, String(Date.now())));

  if (seed !== null && ready)
    return (
      <StyleCtx.Provider value={style}>
        <Arena f={[fighters[0]!, fighters[1]!]} seed={seed}
          onExit={() => setSeed(null)} onRematch={() => setSeed(hashSeed(String(seed), String(Date.now())))} />
      </StyleCtx.Provider>
    );

  return (
    <StyleCtx.Provider value={style}>
      <div className="hero" style={{ paddingTop: 10 }}>
        <div className="big" style={{ fontSize: "1.7rem" }}>Batalla de memecoins</div>
        <div className="sub">Las estadísticas salen del mercado: no gana la más grande, sino la que mejor se mueve para lo que suele moverse.</div>
      </div>

      <div className="field">
        <label>Aspecto de los luchadores</label>
        <div className="segmented" data-pos={style === "logo" ? 0 : 1}>
          <button className={style === "logo" ? "on" : ""} onClick={() => setStyle("logo")}>Logo en pixel art</button>
          <button className={style === "monster" ? "on" : ""} onClick={() => setStyle("monster")}>Monstruo</button>
        </div>
      </div>

      {([0, 1] as const).map((i) => (
        <div className="field" key={i}>
          <label>{i === 0 ? "Tu luchador" : "Rival"}</label>
          {fighters[i] ? (
            <FighterCard f={fighters[i]!} side={i === 0 ? "Tu luchador" : "Rival"} onClear={() => set(i)(null)} />
          ) : (
            <Picker demo={demo} onPick={set(i)} />
          )}
        </div>
      ))}

      <div className="field">
        <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 500 }}>
          <input type="checkbox" checked={demo} onChange={(e) => { setDemo(e.target.checked); setCoins([null, null]); }} />
          Modo demo (monedas inventadas, sin conexión)
        </label>
      </div>

      <details className="adv">
        <summary>¿Cómo se calculan las estadísticas?</summary>
        <ul className="hint" style={{ paddingLeft: 18 }}>
          <li><strong>Ataque:</strong> cuánto ha subido en 24 h comparado con lo que suele moverse.</li>
          <li><strong>Defensa:</strong> estabilidad y liquidez respecto a su tamaño.</li>
          <li><strong>Velocidad:</strong> volumen respecto a su market cap.</li>
          <li><strong>Vida:</strong> tamaño y antigüedad.</li>
          <li><strong>Especial:</strong> lo olvidada que está. Las 👻 Fantasma hacen más críticos cuanto peor van y pueden resucitar.</li>
          <li>Todas tienen los mismos puntos en total; solo cambia el reparto.</li>
          <li>Tipos: 🔥 Pump vence a 🐋 Ballena, que vence a 💎 Diamante, que vence a 👻 Fantasma, que vence a 🔥 Pump.</li>
        </ul>
      </details>

      <div className="cta-bar">
        <div className="inner">
          <button className="btn" disabled={!ready} onClick={fight}>
            {ready ? `¡${fighters[0]!.coin.symbol} contra ${fighters[1]!.coin.symbol}!` : "Elige dos luchadores"}
          </button>
        </div>
      </div>
    </StyleCtx.Provider>
  );
}
