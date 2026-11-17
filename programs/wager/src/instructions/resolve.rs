use crate::{errors::WagerError, state::*};
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

#[derive(Accounts)]
pub struct SubmitResult<'info> {
    pub voter: Signer<'info>,
    #[account(mut)]
    pub bet: Account<'info, Bet>,
}

/// Cada participante vota el resultado. Si ambos coinciden, queda resuelta.
pub fn submit_result(ctx: Context<SubmitResult>, outcome: Outcome) -> Result<()> {
    let bet = &mut ctx.accounts.bet;
    require!(bet.condition.is_none(), WagerError::OracleBet);
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
    require!(bet.condition.is_none(), WagerError::OracleBet);
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

#[derive(Accounts)]
pub struct ResolveWithPrice<'info> {
    #[account(mut)]
    pub bet: Account<'info, Bet>,
    /// Precio verificado por el programa receptor de Pyth (Anchor comprueba
    /// el dueño y el discriminador de la cuenta).
    pub price_update: Account<'info, PriceUpdateV2>,
}

/// Resuelve una apuesta de precio con el precio de Pyth del momento acordado.
/// Sin permisos: cualquiera puede llamarla porque el precio está firmado.
pub fn resolve_with_price(ctx: Context<ResolveWithPrice>) -> Result<()> {
    let bet = &mut ctx.accounts.bet;
    let cond = bet.condition.ok_or(WagerError::NotAnOracleBet)?;
    require!(bet.status == BetStatus::Matched, WagerError::InvalidStatus);
    require!(
        Clock::get()?.unix_timestamp <= bet.resolve_deadline,
        WagerError::ResolveDeadlinePassed
    );

    let update = &ctx.accounts.price_update;
    require!(
        update.verification_level == VerificationLevel::Full,
        WagerError::UnverifiedPrice
    );
    let msg = &update.price_message;
    require!(msg.feed_id == cond.feed_id, WagerError::WrongPriceFeed);
    // La actualización "canónica" del instante t es la única que cumple
    // prev_publish_time < t <= publish_time, así nadie puede elegir otra.
    require!(
        msg.prev_publish_time < cond.resolve_at
            && cond.resolve_at <= msg.publish_time
            && msg.publish_time - cond.resolve_at <= MAX_PRICE_DELAY,
        WagerError::WrongPriceTime
    );

    let outcome = cond
        .outcome(msg.price, msg.exponent)
        .ok_or(WagerError::Overflow)?;
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
