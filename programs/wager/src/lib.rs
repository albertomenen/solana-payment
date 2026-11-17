//! Wager: apuestas P2P entre dos personas con el dinero bloqueado en un
//! escrow on-chain.
//!
//! Flujo: `create_bet` → `accept_bet` → (`submit_result` por ambos |
//! `arbiter_resolve`) → `settle`. Salidas de emergencia: `cancel_bet`
//! (nadie aceptó) y `refund_expired` (nadie resolvió a tiempo).
use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::Outcome;

declare_id!("27TbWS3buShwDkm9qzVW2cx8fHFHbborQwb2qRsHYw39");

#[program]
pub mod wager {
    use super::*;

    pub fn create_bet(ctx: Context<CreateBet>, args: CreateBetArgs) -> Result<()> {
        instructions::create_bet(ctx, args)
    }

    pub fn accept_bet(ctx: Context<AcceptBet>) -> Result<()> {
        instructions::accept_bet(ctx)
    }

    pub fn cancel_bet(ctx: Context<CancelBet>) -> Result<()> {
        instructions::cancel_bet(ctx)
    }

    pub fn submit_result(ctx: Context<SubmitResult>, outcome: Outcome) -> Result<()> {
        instructions::submit_result(ctx, outcome)
    }

    pub fn arbiter_resolve(ctx: Context<ArbiterResolve>, outcome: Outcome) -> Result<()> {
        instructions::arbiter_resolve(ctx, outcome)
    }

    pub fn resolve_with_price(ctx: Context<ResolveWithPrice>) -> Result<()> {
        instructions::resolve_with_price(ctx)
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle(ctx)
    }

    pub fn refund_expired(ctx: Context<Settle>) -> Result<()> {
        instructions::refund_expired(ctx)
    }
}
