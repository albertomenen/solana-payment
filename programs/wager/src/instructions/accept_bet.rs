use crate::{errors::WagerError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(Accounts)]
pub struct AcceptBet<'info> {
    pub acceptor: Signer<'info>,

    #[account(mut, has_one = mint)]
    pub bet: Account<'info, Bet>,

    pub mint: Account<'info, Mint>,

    #[account(mut, token::mint = mint, token::authority = acceptor)]
    pub acceptor_token: Account<'info, TokenAccount>,

    #[account(mut, seeds = [VAULT_SEED, bet.key().as_ref()], bump = bet.vault_bump)]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn accept_bet(ctx: Context<AcceptBet>) -> Result<()> {
    let acceptor = ctx.accounts.acceptor.key();
    let bet = &mut ctx.accounts.bet;

    require!(bet.status == BetStatus::Open, WagerError::InvalidStatus);
    require!(
        Clock::get()?.unix_timestamp < bet.accept_deadline,
        WagerError::AcceptDeadlinePassed
    );
    require_keys_neq!(acceptor, bet.creator, WagerError::CannotAcceptOwnBet);
    if let Some(opponent) = bet.opponent {
        require_keys_eq!(acceptor, opponent, WagerError::NotTheOpponent);
    }
    require!(
        bet.arbiter != Some(acceptor),
        WagerError::ArbiterIsParticipant
    );

    bet.acceptor = acceptor;
    bet.status = BetStatus::Matched;
    let stake = bet.stake;

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.acceptor_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.acceptor.to_account_info(),
            },
        ),
        stake,
        ctx.accounts.mint.decimals,
    )?;

    emit!(BetAccepted {
        bet: ctx.accounts.bet.key(),
        acceptor,
    });
    Ok(())
}

#[event]
pub struct BetAccepted {
    pub bet: Pubkey,
    pub acceptor: Pubkey,
}
