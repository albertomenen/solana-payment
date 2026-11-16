import { PublicKey } from "@solana/web3.js";

// El workflow de despliegue inyecta el program id real al compilar.
export const PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_PROGRAM_ID || "27TbWS3buShwDkm9qzVW2cx8fHFHbborQwb2qRsHYw39",
);

export const RPC_URL = import.meta.env.VITE_RPC_URL || "https://api.devnet.solana.com";

/** USDC de prueba de Circle en devnet (https://faucet.circle.com). */
export const DEFAULT_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
