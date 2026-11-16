use super::{close_vault, pay_from_vault};
use crate::{errors::WagerError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

/// Liquidación sin permisos: cualquiera puede ejecutarla (p. ej. un bot), ya
/// que el dinero solo puede ir a las cuentas de los participantes.
#[derive(Accounts)]
pub struct Settle<'info> {
    /// CHECK: recibe la renta de las cuentas cerradas; validada con `address`.
    #[account(mut, address = bet.creator)]
    pub creator: UncheckedAccount<'info>,

    #[account(mut, has_one = mint, close = creator)]
    pub bet: Account<'info, Bet>,

    pub mint: Account<'info, Mint>,

    #[account(mut, token::mint = mint, token::authority = bet.creator)]
    pub creator_token: Account<'info, TokenAccount>,

    #[account(mut, token::mint = mint, token::authority = bet.acceptor)]
    pub acceptor_token: Account<'info, TokenAccount>,

    #[account(mut, seeds = [VAULT_SEED, bet.key().as_ref()], bump = bet.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Paga según el resultado acordado y cierra la apuesta.
pub fn settle(ctx: Context<Settle>) -> Result<()> {
    let bet = &ctx.accounts.bet;
    require!(bet.status == BetStatus::Resolved, WagerError::InvalidStatus);
    let outcome = bet.outcome.ok_or(WagerError::InvalidStatus)?;
    payout(ctx.accounts, outcome)
}

/// Si nadie resolvió antes de `resolve_deadline`, cada uno recupera lo suyo.
pub fn refund_expired(ctx: Context<Settle>) -> Result<()> {
    let bet = &ctx.accounts.bet;
    require!(bet.status == BetStatus::Matched, WagerError::InvalidStatus);
    require!(
        Clock::get()?.unix_timestamp > bet.resolve_deadline,
        WagerError::ResolveDeadlineNotReached
    );
    payout(ctx.accounts, Outcome::Draw)
}

fn payout(a: &Settle, outcome: Outcome) -> Result<()> {
    let (to_creator, to_acceptor) =
        Bet::payouts(outcome, a.bet.stake).ok_or(WagerError::Overflow)?;

    pay_from_vault(
        &a.token_program,
        &a.vault,
        &a.mint,
        &a.creator_token,
        &a.bet,
        to_creator,
    )?;
    pay_from_vault(
        &a.token_program,
        &a.vault,
        &a.mint,
        &a.acceptor_token,
        &a.bet,
        to_acceptor,
    )?;
    close_vault(
        &a.token_program,
        &a.vault,
        &a.creator.to_account_info(),
        &a.bet,
    )?;

    emit!(BetSettled {
        bet: a.bet.key(),
        outcome,
        to_creator,
        to_acceptor,
    });
    Ok(())
}

#[event]
pub struct BetSettled {
    pub bet: Pubkey,
    pub outcome: Outcome,
    pub to_creator: u64,
    pub to_acceptor: u64,
}
