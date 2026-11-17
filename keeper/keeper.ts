// Bot "keeper": resuelve con Pyth las apuestas de precio en cuanto hay precio,
// paga las apuestas resueltas y reembolsa las vencidas. Todas son instrucciones
// sin permisos, así que el bot no puede desviar dinero: solo ahorra clics.
//
// Uso: RPC_URL=... KEYPAIR_PATH=... node keeper.cjs  (ver .github/workflows/keeper.yml)
import { readFileSync } from "node:fs";
import { Connection, Keypair, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { Bet, BetStatus, fetchAllBets, settleIxs } from "../app/src/wager";
import { PRICE_WINDOW, readPushPrice, resolveWithPushIx, toHex } from "../app/src/pyth";

const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR_PATH!, "utf8"))));
const connection = new Connection(rpc, "confirmed");

async function send(label: string, bet: Bet, ixs: TransactionInstruction[]) {
  try {
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [keeper]);
    console.log(`✅ ${label} ${bet.address.toBase58()} (${bet.description}) → ${sig}`);
  } catch (e) {
    console.log(`⚠️ ${label} ${bet.address.toBase58()}: ${(e as Error).message.split("\n")[0]}`);
  }
}

const now = Math.floor(Date.now() / 1000);

async function main() {
  const bets = await fetchAllBets(connection);
  console.log(`Keeper ${keeper.publicKey.toBase58()} · ${bets.length} apuestas`);
  for (const bet of bets) {
    try {
      await handle(bet);
    } catch (e) {
      console.log(`⚠️ ${bet.address.toBase58()}: ${(e as Error).message}`);
    }
  }
}

async function handle(bet: Bet) {
  const cond = bet.condition;
  if (bet.status === BetStatus.Resolved) {
    await send("Pagada", bet, settleIxs(bet, keeper.publicKey, false));
  } else if (bet.status === BetStatus.Matched && cond && now >= cond.resolveAt && now <= cond.resolveAt + PRICE_WINDOW) {
    const p = await readPushPrice(connection, toHex(cond.feedId));
    if (p.publishTime < cond.resolveAt) {
      console.log(`⏳ ${bet.address.toBase58()}: aún no hay precio de Pyth posterior a la hora acordada`);
      return;
    }
    // Resolver y pagar en la misma transacción.
    await send(`Resuelta con ${p.price} y pagada`, bet, [resolveWithPushIx(bet), ...settleIxs(bet, keeper.publicKey, false)]);
  } else if (bet.status === BetStatus.Matched && (now > bet.resolveDeadline || (cond && now > cond.resolveAt + PRICE_WINDOW))) {
    await send("Reembolsada", bet, settleIxs(bet, keeper.publicKey, true));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
