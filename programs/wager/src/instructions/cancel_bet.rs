use super::{close_vault, pay_from_vault};
use crate::{errors::WagerError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

/// El creador recupera su dinero mientras nadie haya aceptado la apuesta.
#[derive(Accounts)]
pub struct CancelBet<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(mut, has_one = creator, has_one = mint, close = creator)]
    pub bet: Account<'info, Bet>,

    pub mint: Account<'info, Mint>,

    #[account(mut, token::mint = mint, token::authority = creator)]
    pub creator_token: Account<'info, TokenAccount>,

    #[account(mut, seeds = [VAULT_SEED, bet.key().as_ref()], bump = bet.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn cancel_bet(ctx: Context<CancelBet>) -> Result<()> {
    let a = &ctx.accounts;
    require!(a.bet.status == BetStatus::Open, WagerError::InvalidStatus);

    pay_from_vault(
        &a.token_program,
        &a.vault,
        &a.mint,
        &a.creator_token,
        &a.bet,
        a.vault.amount,
    )?;
    close_vault(
        &a.token_program,
        &a.vault,
        &a.creator.to_account_info(),
        &a.bet,
    )?;
    Ok(())
}
