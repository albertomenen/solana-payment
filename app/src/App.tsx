import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BaseWalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import type React from "react";
import { DEFAULT_MINT, PROGRAM_ID } from "./config";
import { BattlePage } from "./battle/BattlePage";
import { FEEDS, THRESHOLD_EXPO, feedSymbol, fromHex, latestPrice, resolveWithPyth, scaled, toHex } from "./pyth";
import {
  Bet,
  BetStatus,
  Outcome,
  PROGRAM_ERRORS,
  acceptBetIx,
  arbiterResolveIx,
  ata,
  cancelBetIx,
  createBetIx,
  fetchAllBets,
  fetchBet,
  settleIxs,
  submitResultIx,
} from "./wager";

// ================= utilidades =================

const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;
const now = () => Math.floor(Date.now() / 1000);
const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function fmtAmount(v: bigint, decimals: number) {
  const s = v.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, 2);
  return frac ? `${int},${frac}` : int;
}

function parseAmount(s: string, decimals: number): bigint | null {
  const m = s.trim().replace(",", ".").match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1] + frac);
}

function parseKey(s: string): PublicKey | null | "invalid" {
  if (!s.trim()) return null;
  try {
    return new PublicKey(s.trim());
  } catch {
    return "invalid";
  }
}

function explainError(e: unknown): string {
  const text = String((e as { logs?: string[] })?.logs?.join("\n") ?? "") + String((e as Error)?.message ?? e);
  const hex = text.match(/custom program error: 0x([0-9a-f]+)/i);
  if (hex) {
    const code = parseInt(hex[1], 16);
    if (code >= 6000 && PROGRAM_ERRORS[code - 6000]) return PROGRAM_ERRORS[code - 6000];
    if (code === 1) return "Saldo de USDC insuficiente";
    return `Error del programa (código ${code})`;
  }
  if (/User rejected/i.test(text)) return "Has cancelado la operación";
  if (/insufficient (funds|lamports)|no record of a prior credit/i.test(text))
    return "Necesitas SOL de prueba para la comisión";
  return (e as Error)?.message ?? String(e);
}

/** Color estable por dirección, para los avatares. */
function avatarStyle(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { background: `linear-gradient(135deg, hsl(${h} 70% 62%), hsl(${(h + 50) % 360} 70% 48%))` };
}

function Avatar({ seed, label }: { seed: string; label: string }) {
  return <div className="avatar" style={avatarStyle(seed)}>{label}</div>;
}

const initial = (s: string) => (s.trim()[0] ?? "?").toUpperCase();

const ICONS = {
  back: "M15 18l-6-6 6-6",
  plus: "M12 5v14M5 12h14",
  drop: "M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
};
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

type Msg = { ok: boolean; text: string; sig?: string } | null;

// ---------- animaciones ----------

const SUCCESS_EVENT = "wager:success";
const celebrate = (text: string) => window.dispatchEvent(new CustomEvent(SUCCESS_EVENT, { detail: text }));

/** Pantalla de éxito con un check que se dibuja, como al enviar en una wallet. */
function SuccessOverlay() {
  const [text, setText] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      setN((x) => x + 1);
    };
    window.addEventListener(SUCCESS_EVENT, on);
    return () => window.removeEventListener(SUCCESS_EVENT, on);
  }, []);
  useEffect(() => {
    if (!text) return;
    navigator.vibrate?.([12, 60, 18]);
    const t = setTimeout(() => setText(null), 1700);
    return () => clearTimeout(t);
  }, [text, n]);
  if (!text) return null;
  return (
    <div className="success-overlay" key={n} onClick={() => setText(null)}>
      <div className="success-card">
        <svg className="check" viewBox="0 0 52 52">
          <circle cx="26" cy="26" r="24" />
          <path d="M15 27l7 7 15-16" />
        </svg>
        <div className="success-text">{text}</div>
      </div>
    </div>
  );
}

/** Vibración corta al tocar botones (Android) y marca del último botón pulsado. */
function useTapFeedback() {
  useEffect(() => {
    const on = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest("button, .action, .row-item, a.btn");
      if (!el) return;
      navigator.vibrate?.(8);
      if (el.classList.contains("btn")) {
        document.querySelectorAll(".btn.last").forEach((b) => b.classList.remove("last"));
        el.classList.add("last");
      }
    };
    document.addEventListener("pointerdown", on);
    return () => document.removeEventListener("pointerdown", on);
  }, []);
}

/** Reproduce una animación de "rebote" cada vez que cambia `value`. */
function useBump<T extends HTMLElement>(value: unknown) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el) return;
    el.classList.remove("bump");
    void el.offsetWidth; // reinicia la animación
    el.classList.add("bump");
  }, [value]);
  return ref;
}

function Skeleton({ rows = 2 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="row-item skeleton">
          <div className="avatar shimmer" />
          <div className="main">
            <div className="line shimmer" style={{ width: "70%" }} />
            <div className="line shimmer" style={{ width: "35%", marginTop: 8 }} />
          </div>
        </div>
      ))}
    </>
  );
}

/** Firma con la wallet, envía y espera confirmación. */
function useSend() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  /** Ejecuta `fn` mostrando el estado (cargando, éxito o error). */
  const run = useCallback(async (fn: () => Promise<string | undefined>, okText: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const sig = await fn();
      setMsg({ ok: true, text: okText, sig });
      celebrate(okText);
      return true;
    } catch (e) {
      console.error(e);
      setMsg({ ok: false, text: explainError(e) });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const send = useCallback(
    async (ixs: TransactionInstruction[], okText: string) => {
      if (!publicKey) return false;
      return run(async () => {
        const latest = await connection.getLatestBlockhash();
        const tx = new Transaction({ feePayer: publicKey, ...latest }).add(...ixs);
        const sig = await sendTransaction(tx, connection);
        const res = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        if (res.value.err) {
          const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
          throw { logs: t?.meta?.logMessages ?? [], message: JSON.stringify(res.value.err) };
        }
        return sig;
      }, okText);
    },
    [connection, publicKey, sendTransaction, run],
  );
  return { send, run, busy, msg };
}

function Toast({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <p className={`toast ${msg.ok ? "ok" : "err"}`}>
      {msg.text}
      {msg.sig && (
        <>
          {" · "}
          <a target="_blank" rel="noreferrer" href={`https://explorer.solana.com/tx/${msg.sig}?cluster=devnet`}>
            Ver en el explorador
          </a>
        </>
      )}
    </p>
  );
}

/** Saldo de SOL y del token (por defecto USDC de devnet) de la wallet conectada. */
function useBalances(mintStr: string, refresh: unknown) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [sol, setSol] = useState<number | null>(null);
  const [token, setToken] = useState<bigint | null>(null);
  const [decimals, setDecimals] = useState<number | null>(null);

  useEffect(() => {
    setSol(null);
    setToken(null);
    let mint: PublicKey;
    try {
      mint = new PublicKey(mintStr);
    } catch {
      setDecimals(null);
      return;
    }
    getMint(connection, mint).then((m) => setDecimals(m.decimals)).catch(() => setDecimals(null));
    if (!publicKey) return;
    connection.getBalance(publicKey).then((l) => setSol(l / LAMPORTS_PER_SOL)).catch(() => {});
    connection
      .getTokenAccountBalance(ata(mint, publicKey))
      .then((b) => setToken(BigInt(b.value.amount)))
      .catch(() => setToken(0n));
  }, [connection, publicKey, mintStr, refresh]);

  return { sol, token, decimals };
}

/** Precio en vivo de un feed de Pyth (se refresca cada 10 s). */
function useLivePrice(feedHex: string | null) {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    setPrice(null);
    if (!feedHex) return;
    let alive = true;
    const load = () => latestPrice(feedHex).then((p) => alive && setPrice(p)).catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [feedHex]);
  return price;
}

const fmtUsd = (v: number) =>
  v.toLocaleString("es-ES", { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 }) + " $";

// ================= app =================

const WALLET_LABELS = {
  "change-wallet": "Cambiar wallet",
  connecting: "Conectando…",
  "copy-address": "Copiar dirección",
  copied: "Copiada",
  disconnect: "Desconectar",
  "has-wallet": "Conectar",
  "no-wallet": "Conectar",
};

export function App() {
  const hash = useHashRoute();
  const { wallets } = useWallet();
  const route = hash.startsWith("#/bet/") ? "bet" : hash === "#/new" ? "new" : hash.startsWith("#/battle") ? "battle" : "home";
  const here = window.location.href;
  useTapFeedback();

  // Hacia dentro desliza desde la derecha; al volver al inicio, desde la izquierda.
  // La dirección se fija una vez por navegación para no reiniciar la animación.
  const nav = useRef({ hash, dir: "forward" });
  if (nav.current.hash !== hash) nav.current = { hash, dir: route === "home" ? "back" : "forward" };
  const dir = nav.current.dir;

  return (
    <div className="shell">
      <div className="topbar">
        <div className="left">
          {route !== "home" && (
            <button className="icon-btn" aria-label="Volver" onClick={() => (window.location.hash = "#/")}>
              <Icon d={ICONS.back} />
            </button>
          )}
          <span className="title">{route === "new" ? "Nueva apuesta" : route === "bet" ? "Apuesta" : route === "battle" ? "Batallas" : "Apuestas"}</span>
          {route === "home" && <span className="net-pill">Devnet</span>}
        </div>
        <BaseWalletMultiButton labels={WALLET_LABELS} />
      </div>

      {wallets.length === 0 && (
        <div className="notice accent">
          <span className="dot" />
          <div>
            No se detecta ninguna wallet. En el móvil, abre esta web dentro de Phantom.{" "}
            <a href={`https://phantom.app/ul/browse/${encodeURIComponent(here)}?ref=${encodeURIComponent(window.location.origin)}`}>
              Abrir en Phantom
            </a>
          </div>
        </div>
      )}

      <div className={`page ${dir}`} key={hash}>
        {route === "bet" ? <BetView address={hash.slice(6)} /> : route === "new" ? <CreateBet /> : route === "battle" ? <BattlePage /> : <Home />}
      </div>
      <SuccessOverlay />

      <p className="muted center" style={{ fontSize: "0.75rem", marginTop: 28 }}>
        Red de pruebas: el dinero no es real ·{" "}
        <a className="muted" target="_blank" rel="noreferrer"
          href={`https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`}>
          programa {short(PROGRAM_ID)}
        </a>
      </p>
    </div>
  );
}

// ================= inicio =================

function Home() {
  const { publicKey } = useWallet();
  const { sol, token, decimals } = useBalances(DEFAULT_MINT, null);

  return (
    <>
      <div className="hero">
        {publicKey ? (
          <>
            <div className="label">Saldo para apostar</div>
            <div className="big">
              {token === null || decimals === null ? "—" : fmtAmount(token, decimals)}
              <small>USDC</small>
            </div>
            <div className="sub">{sol === null ? " " : `${sol.toLocaleString("es-ES", { maximumFractionDigits: 3 })} SOL para comisiones`}</div>
          </>
        ) : (
          <>
            <div className="big" style={{ fontSize: "1.9rem" }}>Apuesta con tus amigos</div>
            <div className="sub">El dinero queda bloqueado en un contrato y se paga solo al ganador.</div>
          </>
        )}
      </div>

      <div className="actions">
        <button className="action" onClick={() => (window.location.hash = "#/new")}>
          <span className="ic"><Icon d={ICONS.plus} /></span>Nueva apuesta
        </button>
        <a className="action" target="_blank" rel="noreferrer" href="https://faucet.circle.com">
          <span className="ic"><Icon d={ICONS.drop} /></span>USDC de prueba
        </a>
        <a className="action" target="_blank" rel="noreferrer" href="https://faucet.solana.com">
          <span className="ic"><Icon d={ICONS.bolt} /></span>SOL de prueba
        </a>
      </div>

      <a className="promo" href="#/battle">
        <span style={{ fontSize: "2rem" }}>⚔️</span>
        <div style={{ flex: 1 }}>
          <strong>Batallas de memecoins</strong>
          <span className="muted" style={{ fontSize: "0.85rem" }}>Pon a pelear tus memecoins. Prototipo, sin dinero.</span>
        </div>
        <Icon d={ICONS.back.replace("M15 18l-6-6 6-6", "M9 18l6-6-6-6")} />
      </a>

      {publicKey && sol === 0 && (
        <div className="notice">
          <span className="dot" />
          <div>Necesitas un poco de SOL de devnet para pagar las comisiones. Pídelo en <a target="_blank" rel="noreferrer" href="https://faucet.solana.com">faucet.solana.com</a>.</div>
        </div>
      )}

      <BetList />
    </>
  );
}

function statusInfo(b: Bet): { text: string; cls: string } {
  const t = now();
  if (b.status === BetStatus.Open)
    return b.acceptDeadline > t ? { text: "Esperando rival", cls: "warn" } : { text: "Caducada", cls: "" };
  if (b.status === BetStatus.Matched) {
    if (b.resolveDeadline <= t) return { text: "Plazo vencido", cls: "warn" };
    if (b.condition && b.condition.resolveAt <= t) return { text: "Lista para resolver", cls: "warn" };
    return { text: "En juego", cls: "live" };
  }
  return { text: "Lista para cobrar", cls: "done" };
}

function BetRow({ b, decimals, i }: { b: Bet; decimals: number; i: number }) {
  return (
    <a className="row-item enter" style={{ "--i": i } as React.CSSProperties} href={`#/bet/${b.address.toBase58()}`}>
      <Avatar seed={b.address.toBase58()} label={initial(b.description)} />
      <div className="main">
        <div className="t">{b.description}</div>
        <div className="s">{statusInfo(b).text}</div>
      </div>
      <div className="amt">
        {fmtAmount(b.stake * 2n, decimals)} USDC
        <div className="s">bote</div>
      </div>
    </a>
  );
}

function BetList() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [bets, setBets] = useState<Bet[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchAllBets(connection)
      .then((b) => setBets(b.sort((x, y) => y.acceptDeadline - x.acceptDeadline)))
      .catch((e) => setError(String(e?.message ?? e)));
  }, [connection]);

  if (error) return <div className="notice"><span className="dot" /><div>No se pudo conectar con devnet: {error}</div></div>;

  const me = publicKey?.toBase58();
  const mine = (bets ?? []).filter((b) => b.creator.toBase58() === me || b.acceptor.toBase58() === me);
  const open = (bets ?? []).filter(
    (b) =>
      b.status === BetStatus.Open &&
      b.creator.toBase58() !== me &&
      (!b.opponent || b.opponent.toBase58() === me) &&
      b.acceptDeadline > now(),
  );
  // Todas las apuestas de la web usan USDC de devnet (6 decimales).
  const row = (b: Bet, i: number) => <BetRow key={b.address.toBase58()} b={b} decimals={6} i={i} />;

  return (
    <>
      {publicKey && (
        <>
          <div className="section-title">Mis apuestas <span>{bets ? mine.length : ""}</span></div>
          <div className="list">
            {bets === null ? <Skeleton />
              : mine.length ? mine.map(row)
              : <div className="empty">Aún no tienes apuestas. ¡Crea la primera!</div>}
          </div>
        </>
      )}
      <div className="section-title">Abiertas para ti <span>{bets ? open.length : ""}</span></div>
      <div className="list">
        {bets === null ? <Skeleton />
          : open.length ? open.map(row)
          : <div className="empty">No hay apuestas abiertas ahora mismo.</div>}
      </div>
    </>
  );
}

// ================= crear =================

const ACCEPT_OPTS = [
  { label: "10 min", s: 600 },
  { label: "1 hora", s: 3600 },
  { label: "1 día", s: 86400 },
  { label: "1 semana", s: 604800 },
];
const RESOLVE_OPTS = [
  { label: "1 hora", s: 3600 },
  { label: "1 día", s: 86400 },
  { label: "1 semana", s: 604800 },
  { label: "1 mes", s: 2592000 },
  { label: "6 meses", s: 15552000 },
];
const QUICK_AMOUNTS = ["1", "5", "10", "25"];
const PRICE_AT_OPTS = [
  { label: "10 min", s: 600 },
  { label: "1 hora", s: 3600 },
  { label: "1 día", s: 86400 },
  { label: "1 semana", s: 604800 },
  { label: "1 mes", s: 2592000 },
];
const WEEK = 604800;

function CreateBet() {
  const { publicKey } = useWallet();
  const { send, busy, msg } = useSend();
  const [amount, setAmount] = useState("5");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"anyone" | "friend">("anyone");
  const [opponent, setOpponent] = useState("");
  const [arbiter, setArbiter] = useState("");
  const [acceptS, setAcceptS] = useState(86400);
  const [resolveS, setResolveS] = useState(2592000);
  const [mintStr, setMintStr] = useState(DEFAULT_MINT);
  const { token, decimals } = useBalances(mintStr, msg);
  // Apuesta de precio (oráculo de Pyth).
  const [kind, setKind] = useState<"vote" | "price">("vote");
  const [feed, setFeed] = useState<(typeof FEEDS)[number]>(FEEDS[0]);
  const [above, setAbove] = useState(true);
  const [thresholdStr, setThresholdStr] = useState("");
  const [priceAtS, setPriceAtS] = useState(86400);
  const livePrice = useLivePrice(kind === "price" ? feed.id : null);
  const isPrice = kind === "price";
  const threshold = Number(thresholdStr.replace(",", "."));

  // Al cambiar de activo, proponer el precio actual como umbral.
  useEffect(() => setThresholdStr(""), [feed]);
  useEffect(() => {
    if (livePrice !== null && !thresholdStr) setThresholdStr(String(Math.round(livePrice)));
  }, [livePrice, thresholdStr]);
  // En apuestas de precio, aceptar siempre antes de que se mire el precio.
  useEffect(() => {
    if (isPrice && acceptS > priceAtS) setAcceptS([...ACCEPT_OPTS].reverse().find((o) => o.s <= priceAtS)!.s);
  }, [isPrice, acceptS, priceAtS]);

  const dec = decimals ?? 6;
  const stake = parseAmount(amount || "0", dec);
  const fmt = (v: bigint) => fmtAmount(v, dec);

  const opp = mode === "friend" ? parseKey(opponent) : null;
  const arb = parseKey(arbiter);

  // Mantener "resolver" siempre después de "aceptar".
  useEffect(() => {
    if (resolveS <= acceptS) setResolveS(RESOLVE_OPTS.find((o) => o.s > acceptS)!.s);
  }, [acceptS, resolveS]);

  let blocker = "";
  if (!publicKey) blocker = "Conecta tu wallet";
  else if (!stake || stake <= 0n) blocker = "Introduce un importe";
  else if (decimals === null) blocker = "Token no válido";
  else if (token !== null && stake > token) blocker = "Saldo insuficiente";
  else if (isPrice && !(threshold > 0)) blocker = "Indica el precio";
  else if (!isPrice && !description.trim()) blocker = "Escribe qué apostáis";
  else if (mode === "friend" && (opp === null || opp === "invalid")) blocker = "Dirección del amigo no válida";
  else if (!isPrice && arb === "invalid") blocker = "Dirección del árbitro no válida";

  const priceSentence = (t: number) =>
    `${feed.symbol} ${above ? "por encima de" : "por debajo de"} ${fmtUsd(threshold || 0)} el ${fmtDate(t + priceAtS)}`;

  const amountRef = useBump<HTMLDivElement>(amount);
  const winRef = useBump<HTMLElement>(amount);

  async function paste(set: (v: string) => void) {
    try {
      set((await navigator.clipboard.readText()).trim());
    } catch {
      /* sin permiso */
    }
  }

  async function submit() {
    if (blocker || !publicKey || !stake) return;
    const betId = crypto.getRandomValues(new BigUint64Array(1))[0];
    const t = now();
    const { bet, ix } = createBetIx({
      creator: publicKey,
      mint: new PublicKey(mintStr),
      betId,
      description: isPrice ? priceSentence(t) : description.trim(),
      stake,
      opponent: opp instanceof PublicKey ? opp : null,
      arbiter: !isPrice && arb instanceof PublicKey ? arb : null,
      acceptDeadline: t + acceptS,
      resolveDeadline: isPrice ? t + priceAtS + WEEK : t + resolveS,
      condition: isPrice
        ? {
            feedId: fromHex(feed.id),
            threshold: BigInt(Math.round(threshold * 10 ** -THRESHOLD_EXPO)),
            expo: THRESHOLD_EXPO,
            above,
            resolveAt: t + priceAtS,
          }
        : null,
    });
    if (await send([ix], "¡Apuesta creada!")) window.location.hash = `#/bet/${bet.toBase58()}`;
  }

  return (
    <>
      <div className="amount-box">
        <div className="amount-input" ref={amountRef}>
          <input
            inputMode="decimal"
            aria-label="Importe"
            value={amount}
            style={{ width: `${Math.max(1, amount.length)}ch` }}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ""))}
          />
          <span className="unit">USDC</span>
        </div>
        <div className="balance-line">
          {publicKey && token !== null ? <>Disponible: {fmt(token)} USDC</> : "Lo que pone cada uno"}
          {publicKey && token !== null && token > 0n && (
            <button className="max-btn" onClick={() => setAmount(fmtAmount(token, dec).replace(",", "."))}>MÁX</button>
          )}
        </div>
        <div className="chips">
          {QUICK_AMOUNTS.map((a) => (
            <button key={a} className={`chip ${amount === a ? "on" : ""}`} onClick={() => setAmount(a)}>{a}</button>
          ))}
        </div>
      </div>

      {stake !== null && stake > 0n && (
        <div className="summary">
          <div className="line"><span>Tú pones</span><strong>{fmt(stake)} USDC</strong></div>
          <div className="line"><span>Tu rival pone</span><strong>{fmt(stake)} USDC</strong></div>
          <div className="line"><span>Si ganas te llevas</span><strong className="win" ref={winRef}>{fmt(stake * 2n)} USDC</strong></div>
        </div>
      )}

      <div className="field">
        <label>¿Cómo se decide?</label>
        <div className="segmented" data-pos={isPrice ? 1 : 0}>
          <button className={!isPrice ? "on" : ""} onClick={() => setKind("vote")}>Lo votáis vosotros</button>
          <button className={isPrice ? "on" : ""} onClick={() => setKind("price")}>Precio cripto · Pyth</button>
        </div>
      </div>

      {!isPrice ? (
        <div className="field reveal" key="vote">
          <label>¿Qué apostáis?</label>
          <input className="input" value={description} maxLength={200}
            placeholder="El Real Madrid gana la Champions" onChange={(e) => setDescription(e.target.value)} />
          <p className="hint">Tú apuestas a que ocurre; tu rival, a que no.</p>
        </div>
      ) : (
        <div className="reveal" key="price">
          <div className="field">
            <label>Activo</label>
            <div className="chips left">
              {FEEDS.map((f) => (
                <button key={f.id} className={`chip ${feed.id === f.id ? "on" : ""}`} onClick={() => setFeed(f)}>{f.symbol}</button>
              ))}
            </div>
            <p className="hint">{livePrice === null ? "Consultando precio en Pyth…" : `Ahora: ${fmtUsd(livePrice)}`}</p>
          </div>
          <div className="field">
            <label>Tú apuestas a que {feed.symbol} estará…</label>
            <div className="segmented" data-pos={above ? 0 : 1}>
              <button className={above ? "on" : ""} onClick={() => setAbove(true)}>Por encima de</button>
              <button className={!above ? "on" : ""} onClick={() => setAbove(false)}>Por debajo de</button>
            </div>
            <div className="input-wrap" style={{ marginTop: 8 }}>
              <input className="input" inputMode="decimal" value={thresholdStr}
                onChange={(e) => setThresholdStr(e.target.value.replace(/[^\d.,]/g, ""))} />
              <span className="paste" style={{ pointerEvents: "none" }}>USD</span>
            </div>
          </div>
          <div className="field">
            <label>Se mira el precio dentro de</label>
            <div className="chips left">
              {PRICE_AT_OPTS.map((o) => (
                <button key={o.s} className={`chip ${priceAtS === o.s ? "on" : ""}`} onClick={() => setPriceAtS(o.s)}>{o.label}</button>
              ))}
            </div>
          </div>
          <div className="notice accent">
            <span className="dot" />
            <div>
              Ganas tú si <strong>{priceSentence(now())}</strong>. Si no, gana tu rival.
              Lo decide el precio oficial de Pyth: nadie tiene que votar.
            </div>
          </div>
        </div>
      )}

      <div className="field">
        <label>¿Contra quién?</label>
        <div className="segmented" data-pos={mode === "friend" ? 1 : 0}>
          <button className={mode === "anyone" ? "on" : ""} onClick={() => setMode("anyone")}>Quien tenga el enlace</button>
          <button className={mode === "friend" ? "on" : ""} onClick={() => setMode("friend")}>Un amigo concreto</button>
        </div>
        {mode === "friend" && (
          <div className="input-wrap reveal" style={{ marginTop: 8 }}>
            <input className="input" value={opponent} placeholder="Dirección de Solana de tu amigo"
              onChange={(e) => setOpponent(e.target.value)} />
            <button className="paste" onClick={() => paste(setOpponent)}>Pegar</button>
          </div>
        )}
      </div>

      <div className="field">
        <label>Tiempo para aceptar</label>
        <div className="chips left">
          {ACCEPT_OPTS.filter((o) => !isPrice || o.s <= priceAtS).map((o) => (
            <button key={o.s} className={`chip ${acceptS === o.s ? "on" : ""}`} onClick={() => setAcceptS(o.s)}>{o.label}</button>
          ))}
        </div>
      </div>

      {!isPrice && <div className="field">
        <label>Se decide antes de</label>
        <div className="chips left">
          {RESOLVE_OPTS.filter((o) => o.s > acceptS).map((o) => (
            <button key={o.s} className={`chip ${resolveS === o.s ? "on" : ""}`} onClick={() => setResolveS(o.s)}>{o.label}</button>
          ))}
        </div>
        <p className="hint">Si para entonces no hay resultado, cada uno recupera su dinero.</p>
      </div>}

      <details className="adv">
        <summary>Opciones avanzadas</summary>
        {!isPrice && <div className="field">
          <label>Árbitro (opcional)</label>
          <div className="input-wrap">
            <input className="input" value={arbiter} placeholder="Decide si no os ponéis de acuerdo"
              onChange={(e) => setArbiter(e.target.value)} />
            <button className="paste" onClick={() => paste(setArbiter)}>Pegar</button>
          </div>
        </div>}
        <div className="field">
          <label>Token</label>
          <input className="input" value={mintStr} onChange={(e) => setMintStr(e.target.value.trim())} />
        </div>
      </details>

      <div className="cta-bar">
        <div className="inner">
          <button data-busy={busy || undefined} className="btn" disabled={!!blocker || busy} onClick={submit}>
            {busy ? "Confirma en tu wallet" : blocker || `Apostar ${fmt(stake!)} USDC`}
          </button>
          {blocker === "Saldo insuficiente" && (
            <p className="toast"><a target="_blank" rel="noreferrer" href="https://faucet.circle.com">Conseguir USDC de prueba</a></p>
          )}
          <Toast msg={msg} />
        </div>
      </div>
    </>
  );
}

// ================= detalle =================

function BetView({ address }: { address: string }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signAllTransactions } = useWallet();
  const { send, run, busy, msg } = useSend();
  const [bet, setBet] = useState<Bet | null | undefined>(undefined);
  const [loadError, setLoadError] = useState("");
  const [decimals, setDecimals] = useState(6);
  const [choice, setChoice] = useState<Outcome | null>(null);
  const [copied, setCopied] = useState(false);
  const [settled, setSettled] = useState(false);
  const [resolvedPrice, setResolvedPrice] = useState<number | null>(null);

  const key = useMemo(() => {
    try {
      return new PublicKey(address);
    } catch {
      return null;
    }
  }, [address]);

  const reload = useCallback(async () => {
    if (!key) return setBet(null);
    let b: Bet | null;
    try {
      b = await fetchBet(connection, key);
      setLoadError("");
    } catch (e) {
      return setLoadError(String((e as Error)?.message ?? e));
    }
    setBet(b);
    if (b) getMint(connection, b.mint).then((m) => setDecimals(m.decimals)).catch(() => {});
  }, [connection, key]);

  useEffect(() => {
    reload();
  }, [reload]);

  const { token } = useBalances(bet?.mint.toBase58() ?? DEFAULT_MINT, msg);
  const livePrice = useLivePrice(bet?.condition ? toHex(bet.condition.feedId) : null);

  if (loadError) return <div className="notice"><span className="dot" /><div>No se pudo conectar con devnet: {loadError}</div></div>;
  if (bet === undefined)
    return (
      <div className="bet-head">
        <div className="line shimmer" style={{ width: 110, height: 22, margin: "0 auto", borderRadius: 99 }} />
        <div className="line shimmer" style={{ width: "80%", height: 26, margin: "16px auto 0" }} />
        <div className="line shimmer" style={{ width: 140, height: 48, margin: "16px auto 0" }} />
      </div>
    );
  if (bet === null)
    return (
      <div className="bet-head">
        <p className="desc">{settled ? "¡Apuesta liquidada!" : "Esta apuesta ya no existe"}</p>
        <p className="muted">{settled ? "El dinero ya está en vuestras wallets." : "Puede que ya se haya pagado: al liquidar, la apuesta se cierra."}</p>
        <Toast msg={msg} />
        <div className="spacer" />
        <a className="btn ghost" href="#/">Volver al inicio</a>
      </div>
    );

  const me = publicKey?.toBase58();
  const isCreator = me === bet.creator.toBase58();
  const matched = bet.status !== BetStatus.Open;
  const isAcceptor = matched && me === bet.acceptor.toBase58();
  const isArbiter = !!bet.arbiter && me === bet.arbiter.toBase58();
  const who = (k: PublicKey) => (k.toBase58() === me ? "Tú" : short(k));
  const t = now();
  const fmt = (v: bigint) => fmtAmount(v, decimals);
  const status = statusInfo(bet);

  const cond = bet.condition;
  const condSym = cond ? feedSymbol(cond.feedId) : "";
  const condPrice = cond ? fmtUsd(scaled(cond.threshold, cond.expo)) : "";
  const creatorSays = cond ? `${cond.above ? ">" : "<"} ${condPrice}` : "sí ocurre";
  const acceptorSays = cond ? `${cond.above ? "≤" : "≥"} ${condPrice}` : "no ocurre";

  const outcomeLabel = (o: Outcome) =>
    o === Outcome.CreatorWins ? `Gana ${who(bet.creator)} (${creatorSays})`
      : o === Outcome.AcceptorWins ? `Gana ${matched ? who(bet.acceptor) : "el rival"} (${acceptorSays})`
      : "Empate / anulada";
  const voteText = (o: Outcome | null) =>
    o === null ? "Sin votar" : o === Outcome.CreatorWins ? "Vota: sí" : o === Outcome.AcceptorWins ? "Vota: no" : "Vota: empate";

  const act = async (ixs: TransactionInstruction[], ok: string) => {
    const done = await send(ixs, ok);
    if (done) {
      setChoice(null);
      await reload();
    }
    return done;
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: `Te apuesto ${fmt(bet.stake)} USDC: ${bet.description}`, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
      }
    } catch {
      /* cancelado */
    }
  };

  const canAccept =
    !!publicKey && bet.status === BetStatus.Open && !isCreator && !isArbiter && t < bet.acceptDeadline &&
    (!bet.opponent || bet.opponent.toBase58() === me);
  const canVote = !cond && (isCreator || isAcceptor) && bet.status === BetStatus.Matched && t <= bet.resolveDeadline;
  const canArbitrate = !cond && isArbiter && bet.status === BetStatus.Matched && t <= bet.resolveDeadline;
  const canResolvePyth =
    !!cond && !!publicKey && !!signAllTransactions && bet.status === BetStatus.Matched &&
    t >= cond.resolveAt && t <= bet.resolveDeadline;

  const resolvePyth = async () => {
    const done = await run(async () => {
      const price = await resolveWithPyth(connection, { publicKey: publicKey!, signTransaction, signAllTransactions: signAllTransactions! }, bet);
      setResolvedPrice(price);
      return undefined;
    }, "Resuelta con el precio de Pyth");
    if (done) await reload();
  };
  const myVote = isCreator ? bet.creatorVote : isAcceptor ? bet.acceptorVote : null;
  const lowBalance = token !== null && token < bet.stake;
  const iWon =
    (bet.outcome === Outcome.CreatorWins && isCreator) || (bet.outcome === Outcome.AcceptorWins && isAcceptor);

  return (
    <>
      <div className="bet-head">
        <span className={`status-pill ${status.cls}`}>{status.text}</span>
        <p className="desc">{bet.description}</p>
        <div className="hero" style={{ padding: "6px 0 0" }}>
          <div className="big">{fmt(bet.stake * 2n)}<small>USDC</small></div>
          <div className="sub">bote · {fmt(bet.stake)} USDC cada uno</div>
        </div>
      </div>

      <div className="versus">
        <div className={`side ${bet.outcome === Outcome.CreatorWins ? "win" : ""}`}>
          <Avatar seed={bet.creator.toBase58()} label={isCreator ? "Tú" : initial(bet.creator.toBase58())} />
          <strong>{who(bet.creator)}</strong>
          <span className="vote">{cond ? `Dice ${creatorSays}` : matched ? voteText(bet.creatorVote) : "Dice que sí"}</span>
        </div>
        <span className="vs">VS</span>
        <div className={`side ${bet.outcome === Outcome.AcceptorWins ? "win" : ""}`}>
          {matched ? (
            <>
              <Avatar seed={bet.acceptor.toBase58()} label={isAcceptor ? "Tú" : initial(bet.acceptor.toBase58())} />
              <strong>{who(bet.acceptor)}</strong>
              <span className="vote">{cond ? `Dice ${acceptorSays}` : voteText(bet.acceptorVote)}</span>
            </>
          ) : (
            <>
              <div className="avatar" style={{ background: "var(--surface-2)" }}>?</div>
              <strong>{bet.opponent ? who(bet.opponent) : "Cualquiera"}</strong>
              <span className="vote">{cond ? `Diría ${acceptorSays}` : "Diría que no"}</span>
            </>
          )}
        </div>
      </div>

      <div className="summary">
        {bet.status === BetStatus.Open && <div className="line"><span>Aceptar antes de</span><strong>{fmtDate(bet.acceptDeadline)}</strong></div>}
        {cond ? (
          <>
            <div className="line"><span>Decide</span><strong>Oráculo Pyth · {condSym}/USD</strong></div>
            <div className="line"><span>Se mira el precio</span><strong>{fmtDate(cond.resolveAt)}</strong></div>
            <div className="line"><span>Precio ahora</span><strong>{livePrice === null ? "…" : fmtUsd(livePrice)}</strong></div>
            {resolvedPrice !== null && <div className="line"><span>Precio en ese momento</span><strong>{fmtUsd(resolvedPrice)}</strong></div>}
          </>
        ) : (
          <div className="line"><span>Se decide antes de</span><strong>{fmtDate(bet.resolveDeadline)}</strong></div>
        )}
        {bet.arbiter && <div className="line"><span>Árbitro</span><strong>{who(bet.arbiter)}</strong></div>}
        {bet.outcome !== null && <div className="line"><span>Resultado</span><strong className="win">{outcomeLabel(bet.outcome)}</strong></div>}
      </div>

      {bet.status === BetStatus.Open && (isCreator || !publicKey) && (
        <button data-busy={busy || undefined} className="btn" onClick={share}>{copied ? "¡Enlace copiado!" : "Compartir con tu amigo"}</button>
      )}

      {canAccept && (
        <>
          <button data-busy={busy || undefined} className="btn" disabled={busy || lowBalance}
            onClick={() => act([acceptBetIx(bet, publicKey!)], "¡Apuesta aceptada!")}>
            {busy ? "Confirma en tu wallet" : lowBalance ? "Saldo insuficiente" : `Aceptar y apostar ${fmt(bet.stake)} USDC`}
          </button>
          <p className="hint center">Apuestas a que <strong>no</strong> ocurre. Si aciertas te llevas {fmt(bet.stake * 2n)} USDC.</p>
        </>
      )}

      {isCreator && bet.status === BetStatus.Open && (
        <button data-busy={busy || undefined} className="btn danger" disabled={busy}
          onClick={() => act([cancelBetIx(bet)], "Apuesta cancelada. Te hemos devuelto el dinero.")}>
          Cancelar y recuperar {fmt(bet.stake)} USDC
        </button>
      )}

      {(canVote || canArbitrate) && (
        <>
          <div className="section-title">
            {canArbitrate ? "Decide como árbitro" : "¿Qué ha pasado?"}
            {canVote && myVote !== null && <span>{voteText(myVote)}</span>}
          </div>
          {canVote && <p className="hint" style={{ marginTop: -4 }}>Si los dos votáis lo mismo, la apuesta se resuelve.</p>}
          <div className="options">
            {[Outcome.CreatorWins, Outcome.AcceptorWins, Outcome.Draw].map((o) => (
              <button key={o} className={`option ${(choice ?? myVote) === o ? "on" : ""}`} onClick={() => setChoice(o)} disabled={busy}>
                <span className="radio" />
                {outcomeLabel(o)}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <button data-busy={busy || undefined} className="btn" disabled={busy || choice === null || (canVote && choice === myVote)}
            onClick={() =>
              choice !== null &&
              act(
                [canArbitrate ? arbiterResolveIx(bet, publicKey!, choice) : submitResultIx(bet, publicKey!, choice)],
                canArbitrate ? "Resultado decidido" : "Voto registrado",
              )
            }>
            {busy ? "Confirma en tu wallet" : canArbitrate ? "Confirmar decisión" : "Confirmar voto"}
          </button>
        </>
      )}

      {cond && bet.status === BetStatus.Matched && t < cond.resolveAt && (
        <p className="hint center">
          El {fmtDate(cond.resolveAt)} se mirará el precio de {condSym} en Pyth. A partir de entonces cualquiera puede resolverla.
        </p>
      )}

      {canResolvePyth && (
        <>
          <button data-busy={busy || undefined} className="btn" disabled={busy} onClick={resolvePyth}>
            {busy ? "Confirma en tu wallet" : "Resolver con el precio de Pyth"}
          </button>
          <p className="hint center">Phantom te pedirá firmar varias transacciones: publican el precio firmado y resuelven la apuesta.</p>
        </>
      )}

      {publicKey && bet.status === BetStatus.Resolved && (
        <button data-busy={busy || undefined} className="btn" disabled={busy}
          onClick={async () => setSettled(await act(settleIxs(bet, publicKey, false), "¡Pagado!"))}>
          {busy ? "Confirma en tu wallet" : iWon ? `Cobrar ${fmt(bet.stake * 2n)} USDC` : "Liquidar apuesta"}
        </button>
      )}

      {publicKey && bet.status === BetStatus.Matched && t > bet.resolveDeadline && (
        <button data-busy={busy || undefined} className="btn" disabled={busy}
          onClick={async () => setSettled(await act(settleIxs(bet, publicKey, true), "Dinero devuelto a los dos"))}>
          Recuperar mi dinero
        </button>
      )}

      {!publicKey && <p className="hint center">Conecta tu wallet para participar.</p>}
      <Toast msg={msg} />
    </>
  );
}
