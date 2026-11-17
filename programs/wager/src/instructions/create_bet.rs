use crate::{errors::WagerError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateBetArgs {
    pub bet_id: u64,
    pub description: String,
    pub stake: u64,
    pub opponent: Option<Pubkey>,
    pub arbiter: Option<Pubkey>,
    pub accept_deadline: i64,
    pub resolve_deadline: i64,
    /// Si se indica, la apuesta la resuelve el oráculo de Pyth.
    pub condition: Option<PriceCondition>,
}

#[derive(Accounts)]
#[instruction(args: CreateBetArgs)]
pub struct CreateBet<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    pub mint: Account<'info, Mint>,

    #[account(mut, token::mint = mint, token::authority = creator)]
    pub creator_token: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        space = 8 + Bet::INIT_SPACE,
        seeds = [BET_SEED, creator.key().as_ref(), &args.bet_id.to_le_bytes()],
        bump,
    )]
    pub bet: Account<'info, Bet>,

    #[account(
        init,
        payer = creator,
        token::mint = mint,
        token::authority = bet,
        seeds = [VAULT_SEED, bet.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn create_bet(ctx: Context<CreateBet>, args: CreateBetArgs) -> Result<()> {
    require!(args.stake > 0, WagerError::ZeroStake);
    args.stake.checked_mul(2).ok_or(WagerError::Overflow)?;
    require!(
        args.description.len() <= MAX_DESCRIPTION_LEN,
        WagerError::DescriptionTooLong
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        now < args.accept_deadline && args.accept_deadline < args.resolve_deadline,
        WagerError::InvalidDeadlines
    );
    let creator = ctx.accounts.creator.key();
    require!(
        args.opponent != Some(creator),
        WagerError::CannotAcceptOwnBet
    );
    if let Some(arbiter) = args.arbiter {
        require!(
            arbiter != creator && Some(arbiter) != args.opponent,
            WagerError::ArbiterIsParticipant
        );
    }
    if let Some(cond) = &args.condition {
        // Nadie puede aceptar cuando ya se conoce el precio, y la ventana de
        // resolución debe caber antes de `resolve_deadline`.
        require!(
            args.accept_deadline <= cond.resolve_at
                && cond
                    .resolve_at
                    .checked_add(PRICE_WINDOW)
                    .is_some_and(|t| t <= args.resolve_deadline),
            WagerError::InvalidDeadlines
        );
        require!(args.arbiter.is_none(), WagerError::OracleBet);
        require!(
            (-18..=18).contains(&cond.expo),
            WagerError::InvalidCondition
        );
    }

    ctx.accounts.bet.set_inner(Bet {
        creator,
        opponent: args.opponent,
        acceptor: Pubkey::default(),
        arbiter: args.arbiter,
        mint: ctx.accounts.mint.key(),
        stake: args.stake,
        bet_id: args.bet_id,
        accept_deadline: args.accept_deadline,
        resolve_deadline: args.resolve_deadline,
        creator_vote: None,
        acceptor_vote: None,
        outcome: None,
        status: BetStatus::Open,
        bump: ctx.bumps.bet,
        vault_bump: ctx.bumps.vault,
        condition: args.condition,
        description: args.description,
    });

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.creator_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.creator.to_account_info(),
            },
        ),
        args.stake,
        ctx.accounts.mint.decimals,
    )?;

    emit!(BetCreated {
        bet: ctx.accounts.bet.key(),
        creator,
        stake: args.stake,
    });
    Ok(())
}

#[event]
pub struct BetCreated {
    pub bet: Pubkey,
    pub creator: Pubkey,
    pub stake: u64,
}
