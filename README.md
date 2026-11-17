# Wager: apuestas P2P en Solana

Programa de Solana escrito en Rust con [Anchor](https://www.anchor-lang.com/) para que
dos personas se apuesten algo ("el Real Madrid gana la Champions") con el dinero
bloqueado en un escrow on-chain. Nadie puede tocar el bote salvo el propio programa,
que lo paga según el resultado.

## Cómo funciona

```
create_bet ──► accept_bet ──► submit_result (ambos coinciden) ──► settle
    │              │      └──► arbiter_resolve (si hay desacuerdo) ─┘
    │              └──► refund_expired (nadie resolvió antes de resolve_deadline)
    └──► cancel_bet (nadie la aceptó)
```

| Instrucción       | Quién         | Qué hace |
|-------------------|---------------|----------|
| `create_bet`      | creador       | Crea la apuesta (PDA) y deposita su parte en el vault |
| `accept_bet`      | contraparte   | Deposita su parte. Si la apuesta tiene `opponent`, solo esa wallet puede aceptarla |
| `cancel_bet`      | creador       | Mientras nadie la haya aceptado, recupera su dinero y cierra las cuentas |
| `submit_result`   | participantes | Cada uno vota `CreatorWins`, `AcceptorWins` o `Draw`. Si ambos coinciden, queda resuelta. Se puede cambiar el voto |
| `arbiter_resolve` | árbitro       | Decide el resultado si se configuró un árbitro (p. ej. ante un desacuerdo) |
| `resolve_with_price` | cualquiera | Apuestas de precio: resuelve con el primer precio de Pyth publicado tras la hora acordada |
| `settle`          | cualquiera    | Paga al ganador (o devuelve cada parte si es `Draw`) y cierra las cuentas |
| `refund_expired`  | cualquiera    | Pasado `resolve_deadline` sin resultado, devuelve a cada uno lo suyo |

`settle` y `refund_expired` no necesitan permisos: el dinero solo puede ir a cuentas de
token cuyo dueño sea el creador o el aceptante, así que un bot puede liquidar
automáticamente.

### Apuestas de precio (oráculo de Pyth, gratis)

Al crear la apuesta se puede añadir una `PriceCondition`: un feed de Pyth (p. ej.
SOL/USD), un umbral, si el creador gana por encima o por debajo y la hora `resolve_at`.
Estas apuestas no se votan ni tienen árbitro.

No usamos la API de pago de Pyth (Hermes exige clave desde la actualización Pyth Core
de agosto de 2026). En su lugar se lee la **cuenta de precio pública que Pyth mantiene
en Solana** para cada feed (`PriceUpdateV2`, totalmente verificada, propiedad del
receptor oficial de Pyth), que es gratis de leer.

`resolve_with_price` acepta el primer precio publicado en la ventana
`[resolve_at, resolve_at + 30 min]` del feed acordado y con verificación completa. El
primer precio registrado es definitivo. Si nadie resuelve dentro de la ventana, se puede
reembolsar a ambos en cuanto se cierra.

**Bot keeper** (`keeper/keeper.ts`, `.github/workflows/keeper.yml`): cada 5 minutos
resuelve las apuestas de precio en cuanto hay precio, paga las resueltas y reembolsa las
vencidas. Solo usa instrucciones sin permisos, así que no puede desviar dinero.

### Cuentas
- **`Bet`**: PDA `["bet", creator, bet_id (u64 LE)]` con los participantes, el importe,
  las fechas límite, los votos y el estado.
- **Vault**: cuenta de tokens PDA `["vault", bet]` cuya autoridad es la PDA `Bet`.

Solo admite el programa SPL Token clásico (USDC, por ejemplo). No admite Token-2022
porque extensiones como *transfer fee* o *permanent delegate* romperían las garantías
del escrow.

## Probarlo desde el móvil con Phantom (devnet)

Cada push a `main` ejecuta `.github/workflows/devnet.yml`, que:
1. Pasa los tests y compila el programa (SBF).
2. Lo despliega en **devnet**. La primera vez, si el faucet automático falla, el
   workflow espera y muestra un aviso con la dirección a la que enviar ~3 SOL de devnet
   (desde https://faucet.solana.com).
3. Publica la web (`app/`) en GitHub Pages.

En el móvil:
1. Phantom → Ajustes → Configuración de desarrollador → **Modo Testnet** → Solana Devnet.
2. SOL de prueba en https://faucet.solana.com y USDC de prueba en https://faucet.circle.com.
3. Abre la web de GitHub Pages **dentro del navegador de Phantom**, crea una apuesta y
   comparte el enlace con tu amigo.

Requisitos del repo (una vez): repositorio público y Settings → Pages → Source:
**GitHub Actions**.

## Estructura

```
programs/wager/src/
├── lib.rs               # punto de entrada (#[program])
├── state.rs             # Bet, Outcome, BetStatus y la lógica pura (votos, pagos)
├── errors.rs
└── instructions/        # una instrucción por fichero
programs/wager/tests/
└── wager.rs             # tests de integración (solana-program-test)
keeper/keeper.ts         # bot que resuelve, paga y reembolsa (GitHub Actions)
app/                     # web (React + Vite + wallet adapter)
└── src/wager.ts         # cliente del programa (codificación Borsh a mano)
.github/workflows/devnet.yml
```

## Desarrollo

```bash
cargo test                 # tests unitarios y de integración (no requieren la CLI de Solana)
anchor build               # compila a SBF y genera el IDL (requiere Solana CLI + Anchor 1.2.2)
anchor keys sync           # usa el program id del keypair generado en target/deploy
anchor deploy --provider.cluster devnet
```

Los tests de integración ejecutan el programa compilado de forma nativa sobre un banco
local con el programa SPL Token real, y cubren el flujo completo, los empates, el
árbitro, la cancelación, los reembolsos por plazo y los intentos de ataque (votos de
terceros, redirigir el pago, aceptar una apuesta reservada a otra persona).

> El `declare_id!` actual es un placeholder. Antes de desplegar, ejecuta
> `anchor keys sync` para sustituirlo por el de tu keypair.

## Próximos pasos
1. **Oráculo de eventos (Switchboard On-Demand)** para resultados deportivos.
2. Auditoría antes de mainnet. Revisar también el marco legal (en España, la Ley 13/2011
   de regulación del juego).
