// Cliente mínimo del programa `wager`: codifica instrucciones y decodifica
// cuentas con el mismo formato (Borsh) que genera Anchor.
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import { PROGRAM_ID } from "./config";

export enum Outcome {
  CreatorWins = 0,
  AcceptorWins = 1,
  Draw = 2,
}

export enum BetStatus {
  Open = 0,
  Matched = 1,
  Resolved = 2,
}

// sha256("global:<instrucción>")[0..8] y sha256("account:Bet")[0..8].
const IX = {
  createBet: [197, 42, 153, 2, 59, 63, 143, 246],
  acceptBet: [251, 25, 85, 221, 41, 69, 191, 252],
  cancelBet: [17, 248, 130, 128, 153, 227, 231, 9],
  submitResult: [240, 42, 89, 180, 10, 239, 9, 214],
  arbiterResolve: [72, 74, 145, 98, 97, 32, 107, 5],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
  refundExpired: [118, 153, 164, 244, 40, 128, 242, 250],
};
const BET_DISCRIMINATOR = new Uint8Array([147, 23, 35, 59, 15, 75, 155, 32]);

/** Mensajes de `programs/wager/src/errors.rs` (códigos 6000+). */
export const PROGRAM_ERRORS = [
  "El importe debe ser mayor que cero",
  "La descripción es demasiado larga",
  "Fechas límite inválidas",
  "La apuesta no está en el estado requerido",
  "El plazo para aceptar la apuesta ha terminado",
  "Esta apuesta está reservada para otra wallet",
  "No puedes aceptar tu propia apuesta",
  "Solo los participantes pueden votar el resultado",
  "El plazo para resolver la apuesta ha terminado",
  "El plazo para resolver la apuesta todavía no ha terminado",
  "Esta apuesta no tiene árbitro o no eres tú",
  "El árbitro no puede ser uno de los participantes",
  "Cuenta de token incorrecta",
  "Desbordamiento aritmético",
];

// ---------- Borsh ----------

class Writer {
  private bytes: number[] = [];
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i]);
    return this;
  }
  u8(v: number) {
    return this.raw([v]);
  }
  u64(v: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    return this.raw(b);
  }
  i64(v: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, v, true);
    return this.raw(b);
  }
  string(s: string) {
    const b = new TextEncoder().encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length, true);
    return this.raw(len).raw(b);
  }
  optPubkey(k: PublicKey | null) {
    return k ? this.u8(1).raw(k.toBytes()) : this.u8(0);
  }
  done() {
    return Buffer.from(this.bytes);
  }
}

class Reader {
  private o = 0;
  private view: DataView;
  constructor(private b: Uint8Array) {
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8() {
    return this.b[this.o++];
  }
  u64() {
    const v = this.view.getBigUint64(this.o, true);
    this.o += 8;
    return v;
  }
  i64() {
    const v = this.view.getBigInt64(this.o, true);
    this.o += 8;
    return v;
  }
  pubkey() {
    const k = new PublicKey(this.b.slice(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  optPubkey() {
    return this.u8() ? this.pubkey() : null;
  }
  optU8() {
    return this.u8() ? this.u8() : null;
  }
  string() {
    const len = this.view.getUint32(this.o, true);
    this.o += 4;
    const s = new TextDecoder().decode(this.b.slice(this.o, this.o + len));
    this.o += len;
    return s;
  }
}

// ---------- Cuentas ----------

export interface Bet {
  address: PublicKey;
  creator: PublicKey;
  opponent: PublicKey | null;
  acceptor: PublicKey;
  arbiter: PublicKey | null;
  mint: PublicKey;
  stake: bigint;
  betId: bigint;
  acceptDeadline: number;
  resolveDeadline: number;
  creatorVote: Outcome | null;
  acceptorVote: Outcome | null;
  outcome: Outcome | null;
  status: BetStatus;
  description: string;
}

export function decodeBet(address: PublicKey, data: Uint8Array): Bet {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== BET_DISCRIMINATOR[i]) throw new Error("No es una cuenta Bet");
  }
  const r = new Reader(data.subarray(8));
  const bet = {
    address,
    creator: r.pubkey(),
    opponent: r.optPubkey(),
    acceptor: r.pubkey(),
    arbiter: r.optPubkey(),
    mint: r.pubkey(),
    stake: r.u64(),
    betId: r.u64(),
    acceptDeadline: Number(r.i64()),
    resolveDeadline: Number(r.i64()),
    creatorVote: r.optU8(),
    acceptorVote: r.optU8(),
    outcome: r.optU8(),
    status: r.u8(),
  };
  r.u8(); // bump
  r.u8(); // vault_bump
  return { ...bet, description: r.string() };
}

export async function fetchBet(conn: Connection, address: PublicKey) {
  const info = await conn.getAccountInfo(address);
  return info ? decodeBet(address, info.data) : null;
}

export async function fetchAllBets(conn: Connection): Promise<Bet[]> {
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(BET_DISCRIMINATOR) } }],
  });
  return accounts.map((a) => decodeBet(a.pubkey, a.account.data));
}

// ---------- PDAs ----------

export function betPda(creator: PublicKey, betId: bigint) {
  const id = new Uint8Array(8);
  new DataView(id.buffer).setBigUint64(0, betId, true);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bet"), creator.toBuffer(), id],
    PROGRAM_ID,
  )[0];
}

export function vaultPda(bet: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), bet.toBuffer()],
    PROGRAM_ID,
  )[0];
}

export const ata = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner);

// ---------- Instrucciones ----------

const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({
  pubkey,
  isSigner,
  isWritable,
});

const ix = (keys: ReturnType<typeof m>[], data: Buffer) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys, data });

export interface CreateBetParams {
  creator: PublicKey;
  mint: PublicKey;
  betId: bigint;
  description: string;
  stake: bigint;
  opponent: PublicKey | null;
  arbiter: PublicKey | null;
  acceptDeadline: number;
  resolveDeadline: number;
}

export function createBetIx(p: CreateBetParams) {
  const bet = betPda(p.creator, p.betId);
  const data = new Writer()
    .raw(IX.createBet)
    .u64(p.betId)
    .string(p.description)
    .u64(p.stake)
    .optPubkey(p.opponent)
    .optPubkey(p.arbiter)
    .i64(BigInt(p.acceptDeadline))
    .i64(BigInt(p.resolveDeadline))
    .done();
  return {
    bet,
    ix: ix(
      [
        m(p.creator, true, true),
        m(p.mint, false, false),
        m(ata(p.mint, p.creator), false, true),
        m(bet, false, true),
        m(vaultPda(bet), false, true),
        m(TOKEN_PROGRAM_ID, false, false),
        m(SystemProgram.programId, false, false),
      ],
      data,
    ),
  };
}

export function acceptBetIx(bet: Bet, acceptor: PublicKey) {
  return ix(
    [
      m(acceptor, true, false),
      m(bet.address, false, true),
      m(bet.mint, false, false),
      m(ata(bet.mint, acceptor), false, true),
      m(vaultPda(bet.address), false, true),
      m(TOKEN_PROGRAM_ID, false, false),
    ],
    new Writer().raw(IX.acceptBet).done(),
  );
}

export function cancelBetIx(bet: Bet) {
  return ix(
    [
      m(bet.creator, true, true),
      m(bet.address, false, true),
      m(bet.mint, false, false),
      m(ata(bet.mint, bet.creator), false, true),
      m(vaultPda(bet.address), false, true),
      m(TOKEN_PROGRAM_ID, false, false),
    ],
    new Writer().raw(IX.cancelBet).done(),
  );
}

export function submitResultIx(bet: Bet, voter: PublicKey, outcome: Outcome) {
  return ix(
    [m(voter, true, false), m(bet.address, false, true)],
    new Writer().raw(IX.submitResult).u8(outcome).done(),
  );
}

export function arbiterResolveIx(bet: Bet, arbiter: PublicKey, outcome: Outcome) {
  return ix(
    [m(arbiter, true, false), m(bet.address, false, true)],
    new Writer().raw(IX.arbiterResolve).u8(outcome).done(),
  );
}

/** `settle` o `refund_expired`. Crea antes las cuentas de token si faltan. */
export function settleIxs(bet: Bet, payer: PublicKey, refund: boolean) {
  const creatorAta = ata(bet.mint, bet.creator);
  const acceptorAta = ata(bet.mint, bet.acceptor);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, creatorAta, bet.creator, bet.mint),
    createAssociatedTokenAccountIdempotentInstruction(payer, acceptorAta, bet.acceptor, bet.mint),
    ix(
      [
        m(bet.creator, false, true),
        m(bet.address, false, true),
        m(bet.mint, false, false),
        m(creatorAta, false, true),
        m(acceptorAta, false, true),
        m(vaultPda(bet.address), false, true),
        m(TOKEN_PROGRAM_ID, false, false),
      ],
      new Writer().raw(refund ? IX.refundExpired : IX.settle).done(),
    ),
  ];
}
