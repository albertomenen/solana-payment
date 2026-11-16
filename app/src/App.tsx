import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { DEFAULT_MINT, PROGRAM_ID } from "./config";
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

// ---------- utilidades ----------

const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;
const now = () => Math.floor(Date.now() / 1000);
const fmtDate = (t: number) =>
  new Date(t * 1000).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });

function fmtAmount(v: bigint, decimals: number) {
  const s = v.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
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
    if (code === 1) return "Saldo de tokens insuficiente";
    return `Error del programa (código ${code})`;
  }
  if (/User rejected/i.test(text)) return "Has cancelado la operación en la wallet";
  if (/insufficient (funds|lamports)|no record of a prior credit/i.test(text))
    return "No tienes SOL de prueba para pagar la comisión (consíguelo en faucet.solana.com)";
  return (e as Error)?.message ?? String(e);
}

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/** Firma con la wallet, envía y espera confirmación. */
function useSend() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; sig?: string } | null>(null);

  const send = useCallback(
    async (ixs: TransactionInstruction[], okText: string) => {
      if (!publicKey) return false;
      setBusy(true);
      setMsg(null);
      try {
        const latest = await connection.getLatestBlockhash();
        const tx = new Transaction({ feePayer: publicKey, ...latest }).add(...ixs);
        const sig = await sendTransaction(tx, connection);
        const res = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        if (res.value.err) {
          const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
          throw { logs: t?.meta?.logMessages ?? [], message: JSON.stringify(res.value.err) };
        }
        setMsg({ ok: true, text: okText, sig });
        return true;
      } catch (e) {
        console.error(e);
        setMsg({ ok: false, text: explainError(e) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [connection, publicKey, sendTransaction],
  );
  return { send, busy, msg };
}

function Status({ msg }: { msg: ReturnType<typeof useSend>["msg"] }) {
  if (!msg) return null;
  return (
    <p className={msg.ok ? "ok" : "err"}>
      {msg.text}
      {msg.sig && (
        <>
          {" · "}
          <a className={msg.ok ? "ok" : "err"} target="_blank" rel="noreferrer"
            href={`https://explorer.solana.com/tx/${msg.sig}?cluster=devnet`}>
            ver transacción
          </a>
        </>
      )}
    </p>
  );
}

// ---------- app ----------

export function App() {
  const hash = useHashRoute();
  const { wallets } = useWallet();
  const betAddr = hash.startsWith("#/bet/") ? hash.slice(6) : null;
  const noWallet = wallets.length === 0;
  const here = window.location.href;

  return (
    <main>
      <header>
        <h1>
          <a href="#/">Apuestas entre amigos</a>
          <span className="badge">devnet</span>
        </h1>
        <WalletMultiButton />
      </header>

      {noWallet && (
        <div className="banner">
          No se detecta ninguna wallet. En el móvil, abre esta página dentro de Phantom:{" "}
          <a href={`https://phantom.app/ul/browse/${encodeURIComponent(here)}?ref=${encodeURIComponent(window.location.origin)}`}>
            Abrir en Phantom
          </a>
        </div>
      )}

      {betAddr ? <BetView address={betAddr} /> : <Home />}

      <p className="muted">
        Red de pruebas (devnet): el dinero no es real. Programa{" "}
        <a className="muted" target="_blank" rel="noreferrer"
          href={`https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`}>
          {short(PROGRAM_ID)}
        </a>
      </p>
    </main>
  );
}

function Home() {
  return (
    <>
      <CreateBet />
      <BetList />
      <Help />
    </>
  );
}

function Help() {
  return (
    <div className="card">
      <h2>Cómo conseguir dinero de prueba</h2>
      <ol className="muted">
        <li>En Phantom: Ajustes → Configuración de desarrollador → Modo Testnet → Solana Devnet.</li>
        <li>SOL para comisiones: <a target="_blank" rel="noreferrer" href="https://faucet.solana.com">faucet.solana.com</a></li>
        <li>USDC de prueba: <a target="_blank" rel="noreferrer" href="https://faucet.circle.com">faucet.circle.com</a> (elige Solana Devnet).</li>
      </ol>
    </div>
  );
}

function CreateBet() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { send, busy, msg } = useSend();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("1");
  const [opponent, setOpponent] = useState("");
  const [arbiter, setArbiter] = useState("");
  const [acceptHours, setAcceptHours] = useState("24");
  const [resolveHours, setResolveHours] = useState("168");
  const [mintStr, setMintStr] = useState(DEFAULT_MINT);
  const [balance, setBalance] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setBalance(null);
    if (!publicKey) return;
    try {
      const mint = new PublicKey(mintStr);
      connection
        .getTokenAccountBalance(ata(mint, publicKey))
        .then((b) => setBalance(b.value.uiAmountString ?? "0"))
        .catch(() => setBalance("0"));
    } catch {
      /* mint inválido */
    }
  }, [connection, publicKey, mintStr, msg]);

  async function submit() {
    setError("");
    if (!publicKey) return;
    const opp = parseKey(opponent);
    const arb = parseKey(arbiter);
    if (opp === "invalid" || arb === "invalid") return setError("Alguna dirección no es válida");
    if (!description.trim()) return setError("Escribe sobre qué es la apuesta");
    let mint: PublicKey;
    let decimals: number;
    try {
      mint = new PublicKey(mintStr);
      decimals = (await getMint(connection, mint)).decimals;
    } catch {
      return setError("El token no existe en devnet");
    }
    const stake = parseAmount(amount, decimals);
    if (!stake || stake <= 0n) return setError("Importe no válido");
    const a = Number(acceptHours.replace(",", "."));
    const r = Number(resolveHours.replace(",", "."));
    if (!(a > 0 && r > a)) return setError("El plazo para resolver debe ser mayor que el de aceptar");

    const betId = crypto.getRandomValues(new BigUint64Array(1))[0];
    const t = now();
    const { bet, ix } = createBetIx({
      creator: publicKey,
      mint,
      betId,
      description: description.trim(),
      stake,
      opponent: opp,
      arbiter: arb,
      acceptDeadline: t + Math.round(a * 3600),
      resolveDeadline: t + Math.round(r * 3600),
    });
    if (await send([ix], "Apuesta creada")) window.location.hash = `#/bet/${bet.toBase58()}`;
  }

  return (
    <div className="card">
      <h2>Nueva apuesta</h2>
      <label>¿Qué apostáis?</label>
      <input value={description} maxLength={200} placeholder="El Real Madrid gana la Champions"
        onChange={(e) => setDescription(e.target.value)} />
      <label>Importe que pone cada uno (USDC){balance !== null && ` · tienes ${balance}`}</label>
      <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <label>Rival (opcional: solo esta wallet podrá aceptar)</label>
      <input value={opponent} placeholder="Dirección de Solana" onChange={(e) => setOpponent(e.target.value)} />
      <div className="row">
        <div>
          <label>Aceptar en (horas)</label>
          <input inputMode="decimal" value={acceptHours} onChange={(e) => setAcceptHours(e.target.value)} />
        </div>
        <div>
          <label>Resolver en (horas)</label>
          <input inputMode="decimal" value={resolveHours} onChange={(e) => setResolveHours(e.target.value)} />
        </div>
      </div>
      <details>
        <summary>Opciones avanzadas</summary>
        <label>Árbitro (opcional: decide si no os ponéis de acuerdo)</label>
        <input value={arbiter} placeholder="Dirección de Solana" onChange={(e) => setArbiter(e.target.value)} />
        <label>Token (mint)</label>
        <input value={mintStr} onChange={(e) => setMintStr(e.target.value)} />
      </details>
      <button className="btn" disabled={!publicKey || busy} onClick={submit}>
        {publicKey ? (busy ? "Firmando…" : "Crear apuesta") : "Conecta tu wallet"}
      </button>
      {error && <p className="err">{error}</p>}
      <Status msg={msg} />
    </div>
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

  const me = publicKey?.toBase58();
  const mine = (bets ?? []).filter((b) => b.creator.toBase58() === me || b.acceptor.toBase58() === me);
  const open = (bets ?? []).filter(
    (b) =>
      b.status === BetStatus.Open &&
      b.creator.toBase58() !== me &&
      (!b.opponent || b.opponent.toBase58() === me) &&
      b.acceptDeadline > now(),
  );

  const item = (b: Bet) => (
    <a key={b.address.toBase58()} href={`#/bet/${b.address.toBase58()}`}>
      <div>{b.description}</div>
      <div className="muted">{statusText(b)}</div>
    </a>
  );

  return (
    <>
      {publicKey && (
        <div className="card list">
          <h2>Mis apuestas</h2>
          {error ? null : bets === null ? <p className="muted">Cargando…</p> : mine.length ? mine.map(item) : <p className="muted">Todavía no tienes apuestas.</p>}
        </div>
      )}
      <div className="card list">
        <h2>Apuestas abiertas para ti</h2>
        {error ? <p className="err">No se pudo conectar con devnet: {error}</p>
          : bets === null ? <p className="muted">Cargando…</p> : open.length ? open.map(item) : <p className="muted">No hay apuestas abiertas.</p>}
      </div>
    </>
  );
}

function statusText(b: Bet) {
  if (b.status === BetStatus.Open) return b.acceptDeadline > now() ? "Esperando rival" : "Caducada sin aceptar";
  if (b.status === BetStatus.Matched) return b.resolveDeadline > now() ? "En juego" : "Plazo vencido: se puede reembolsar";
  return "Resuelta: pendiente de cobro";
}

function BetView({ address }: { address: string }) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { send, busy, msg } = useSend();
  const [bet, setBet] = useState<Bet | null | undefined>(undefined);
  const [loadError, setLoadError] = useState("");
  const [decimals, setDecimals] = useState(6);
  const [copied, setCopied] = useState(false);

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

  if (loadError) return <div className="card err">No se pudo conectar con devnet: {loadError}</div>;
  if (bet === undefined) return <div className="card muted">Cargando…</div>;
  if (bet === null)
    return (
      <div className="card">
        <p>Esta apuesta no existe o ya se ha liquidado (las cuentas se cierran al pagar).</p>
        <a href="#/">Volver</a>
      </div>
    );

  const me = publicKey?.toBase58();
  const isCreator = me === bet.creator.toBase58();
  const isAcceptor = bet.status !== BetStatus.Open && me === bet.acceptor.toBase58();
  const isArbiter = !!bet.arbiter && me === bet.arbiter.toBase58();
  const who = (k: PublicKey) => (k.toBase58() === me ? "Tú" : short(k));
  const t = now();
  const amount = fmtAmount(bet.stake, decimals);
  const pot = fmtAmount(bet.stake * 2n, decimals);

  const outcomeLabel = (o: Outcome | null) =>
    o === null ? "—"
      : o === Outcome.CreatorWins ? `Gana ${who(bet.creator)}`
      : o === Outcome.AcceptorWins ? `Gana ${who(bet.acceptor)}`
      : "Empate / anulada";

  const act = async (ixs: TransactionInstruction[], ok: string) => {
    if (await send(ixs, ok)) await reload();
  };

  const share = async () => {
    const url = window.location.href;
    try {
      if (navigator.share) await navigator.share({ title: bet.description, url });
      else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
      }
    } catch {
      /* cancelado */
    }
  };

  const canAccept =
    publicKey && bet.status === BetStatus.Open && !isCreator && !isArbiter && t < bet.acceptDeadline &&
    (!bet.opponent || bet.opponent.toBase58() === me);
  const canVote = (isCreator || isAcceptor) && bet.status === BetStatus.Matched && t <= bet.resolveDeadline;
  const myVote = isCreator ? bet.creatorVote : isAcceptor ? bet.acceptorVote : null;

  return (
    <div className="card">
      <p className="desc">{bet.description}</p>
      <dl className="kv">
        <dt>Estado</dt><dd>{statusText(bet)}</dd>
        <dt>Cada uno pone</dt><dd>{amount} USDC (bote {pot})</dd>
        <dt>Creador</dt><dd>{who(bet.creator)}</dd>
        <dt>Rival</dt>
        <dd>{bet.status !== BetStatus.Open ? who(bet.acceptor) : bet.opponent ? `${who(bet.opponent)} (reservada)` : "Cualquiera"}</dd>
        {bet.arbiter && (<><dt>Árbitro</dt><dd>{who(bet.arbiter)}</dd></>)}
        <dt>Aceptar antes de</dt><dd>{fmtDate(bet.acceptDeadline)}</dd>
        <dt>Resolver antes de</dt><dd>{fmtDate(bet.resolveDeadline)}</dd>
        {bet.status !== BetStatus.Open && (
          <>
            <dt>Voto creador</dt><dd>{outcomeLabel(bet.creatorVote)}</dd>
            <dt>Voto rival</dt><dd>{outcomeLabel(bet.acceptorVote)}</dd>
          </>
        )}
        {bet.outcome !== null && (<><dt>Resultado</dt><dd><strong>{outcomeLabel(bet.outcome)}</strong></dd></>)}
      </dl>

      {bet.status === BetStatus.Open && (
        <button className="btn secondary" onClick={share}>{copied ? "Enlace copiado" : "Compartir enlace con tu amigo"}</button>
      )}

      {canAccept && (
        <button className="btn" disabled={busy} onClick={() => act([acceptBetIx(bet, publicKey!)], "Apuesta aceptada")}>
          Aceptar y poner {amount} USDC
        </button>
      )}

      {isCreator && bet.status === BetStatus.Open && (
        <button className="btn secondary" disabled={busy} onClick={() => act([cancelBetIx(bet)], "Apuesta cancelada y dinero devuelto")}>
          Cancelar y recuperar mi dinero
        </button>
      )}

      {canVote && (
        <>
          <p className="muted">
            ¿Qué ha pasado? Si los dos votáis lo mismo, la apuesta se resuelve.
            {myVote !== null && ` Tu voto actual: ${outcomeLabel(myVote)}.`}
          </p>
          {[Outcome.CreatorWins, Outcome.AcceptorWins, Outcome.Draw].map((o) => (
            <button key={o} className="btn secondary" disabled={busy}
              onClick={() => act([submitResultIx(bet, publicKey!, o)], "Voto registrado")}>
              {outcomeLabel(o)}
            </button>
          ))}
        </>
      )}

      {isArbiter && bet.status === BetStatus.Matched && t <= bet.resolveDeadline && (
        <>
          <p className="muted">Eres el árbitro: tu decisión es definitiva.</p>
          {[Outcome.CreatorWins, Outcome.AcceptorWins, Outcome.Draw].map((o) => (
            <button key={o} className="btn secondary" disabled={busy}
              onClick={() => act([arbiterResolveIx(bet, publicKey!, o)], "Resultado decidido")}>
              Decidir: {outcomeLabel(o)}
            </button>
          ))}
        </>
      )}

      {publicKey && bet.status === BetStatus.Resolved && (
        <button className="btn" disabled={busy} onClick={() => act(settleIxs(bet, publicKey, false), "¡Pagado!")}>
          Liquidar y pagar
        </button>
      )}

      {publicKey && bet.status === BetStatus.Matched && t > bet.resolveDeadline && (
        <button className="btn" disabled={busy} onClick={() => act(settleIxs(bet, publicKey, true), "Dinero devuelto a los dos")}>
          Reembolsar a los dos
        </button>
      )}

      {!publicKey && <p className="muted">Conecta tu wallet para participar.</p>}
      <Status msg={msg} />
    </div>
  );
}
