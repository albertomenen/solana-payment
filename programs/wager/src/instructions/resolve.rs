use crate::{errors::WagerError, state::*};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SubmitResult<'info> {
    pub voter: Signer<'info>,
    #[account(mut)]
    pub bet: Account<'info, Bet>,
}

/// Cada participante vota el resultado. Si ambos coinciden, queda resuelta.
pub fn submit_result(ctx: Context<SubmitResult>, outcome: Outcome) -> Result<()> {
    let bet = &mut ctx.accounts.bet;
    require!(bet.status == BetStatus::Matched, WagerError::InvalidStatus);
    require!(
        Clock::get()?.unix_timestamp <= bet.resolve_deadline,
        WagerError::ResolveDeadlinePassed
    );
    if bet.record_vote(&ctx.accounts.voter.key(), outcome)? {
        emit!(BetResolved {
            bet: bet.key(),
            outcome
        });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ArbiterResolve<'info> {
    pub arbiter: Signer<'info>,
    #[account(mut)]
    pub bet: Account<'info, Bet>,
}

/// El árbitro (si lo hay) decide el resultado, p. ej. si hay desacuerdo.
pub fn arbiter_resolve(ctx: Context<ArbiterResolve>, outcome: Outcome) -> Result<()> {
    let bet = &mut ctx.accounts.bet;
    require!(
        bet.arbiter == Some(ctx.accounts.arbiter.key()),
        WagerError::NotTheArbiter
    );
    require!(bet.status == BetStatus::Matched, WagerError::InvalidStatus);
    require!(
        Clock::get()?.unix_timestamp <= bet.resolve_deadline,
        WagerError::ResolveDeadlinePassed
    );
    bet.resolve(outcome);
    emit!(BetResolved {
        bet: bet.key(),
        outcome
    });
    Ok(())
}

#[event]
pub struct BetResolved {
    pub bet: Pubkey,
    pub outcome: Outcome,
}
