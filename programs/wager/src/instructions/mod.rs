pub mod accept_bet;
pub mod cancel_bet;
pub mod create_bet;
pub mod resolve;
pub mod settle;

pub use accept_bet::*;
pub use cancel_bet::*;
pub use create_bet::*;
pub use resolve::*;
pub use settle::*;

use crate::state::{Bet, BET_SEED};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

/// Transfiere `amount` desde el vault firmando con la PDA de la apuesta.
pub(crate) fn pay_from_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    bet: &Account<'info, Bet>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bet_id = bet.bet_id.to_le_bytes();
    let seeds: &[&[u8]] = &[BET_SEED, bet.creator.as_ref(), &bet_id, &[bet.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: bet.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

/// Cierra el vault (ya vacío) y devuelve su renta a `destination`.
pub(crate) fn close_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    destination: &AccountInfo<'info>,
    bet: &Account<'info, Bet>,
) -> Result<()> {
    let bet_id = bet.bet_id.to_le_bytes();
    let seeds: &[&[u8]] = &[BET_SEED, bet.creator.as_ref(), &bet_id, &[bet.bump]];
    token::close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: destination.clone(),
            authority: bet.to_account_info(),
        },
        &[seeds],
    ))
}
