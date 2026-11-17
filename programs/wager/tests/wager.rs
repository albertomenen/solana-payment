//! Tests de integración: ejecutan el programa completo (compilado de forma
//! nativa) sobre un banco local de `solana-program-test`, con el programa SPL
//! Token real.
use anchor_lang::AccountSerialize;
use anchor_lang::{
    prelude::{AccountInfo, Clock, Pubkey},
    solana_program::{entrypoint::ProgramResult, instruction::Instruction},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token;
use pyth_solana_receiver_sdk::price_update::{PriceFeedMessage, PriceUpdateV2, VerificationLevel};
use solana_account::AccountSharedData;
use solana_keypair::Keypair;
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::Transaction;
use wager::{
    errors::WagerError,
    instructions::CreateBetArgs,
    state::{Bet, BetStatus, Outcome, PriceCondition, BET_SEED, VAULT_SEED},
};

/// Comprueba que la transacción falló con el error esperado (no por otro motivo).
#[track_caller]
fn assert_err<T: std::fmt::Debug>(res: Result<T, BanksClientError>, code: u32) {
    let err = format!("{:?}", res.expect_err("se esperaba un error"));
    assert!(
        err.contains(&format!("Custom({code})")),
        "esperado Custom({code}), obtenido {err}"
    );
}

fn code(e: WagerError) -> u32 {
    u32::from(e)
}

const STAKE: u64 = 50_000_000; // 50 USDC (6 decimales)
const INITIAL: u64 = 1_000_000_000; // 1000 USDC
const HOUR: i64 = 3600;

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // Anchor exige que `accounts` y sus elementos compartan el lifetime 'info.
    let accounts: &[AccountInfo] = unsafe { std::mem::transmute(accounts) };
    wager::entry(program_id, accounts, data)
}

/// Anchor 1.2 depende de `solana-sysvar` 3.x, mientras que `solana-program-test`
/// 4.2 solo instala sus stubs de syscalls (Clock, Rent, CPI...) en la 4.x.
/// Redirigimos los stubs de la 3.x hacia los de la 4.x para que el programa,
/// compilado de forma nativa, vea el mismo runtime.
fn bridge_syscall_stubs() {
    use std::sync::{Arc, Once};
    use sysvar_v3::program_stubs as v3;
    use sysvar_v4::program_stubs as v4;

    struct Placeholder;
    impl v4::SyscallStubs for Placeholder {}

    struct V4Fwd(Arc<Box<dyn v4::SyscallStubs>>);
    struct V3Fwd(Arc<Box<dyn v4::SyscallStubs>>);

    macro_rules! forward {
        ($ty:ident, $tr:path) => {
            impl $tr for $ty {
                fn sol_log(&self, m: &str) {
                    self.0.sol_log(m)
                }
                fn sol_log_compute_units(&self) {
                    self.0.sol_log_compute_units()
                }
                fn sol_remaining_compute_units(&self) -> u64 {
                    self.0.sol_remaining_compute_units()
                }
                fn sol_invoke_signed(
                    &self,
                    ix: &Instruction,
                    infos: &[AccountInfo],
                    seeds: &[&[&[u8]]],
                ) -> ProgramResult {
                    self.0.sol_invoke_signed(ix, infos, seeds)
                }
                fn sol_get_sysvar(
                    &self,
                    id: *const u8,
                    var: *mut u8,
                    offset: u64,
                    len: u64,
                ) -> u64 {
                    self.0.sol_get_sysvar(id, var, offset, len)
                }
                fn sol_get_clock_sysvar(&self, v: *mut u8) -> u64 {
                    self.0.sol_get_clock_sysvar(v)
                }
                fn sol_get_epoch_schedule_sysvar(&self, v: *mut u8) -> u64 {
                    self.0.sol_get_epoch_schedule_sysvar(v)
                }
                fn sol_get_fees_sysvar(&self, v: *mut u8) -> u64 {
                    self.0.sol_get_fees_sysvar(v)
                }
                fn sol_get_rent_sysvar(&self, v: *mut u8) -> u64 {
                    self.0.sol_get_rent_sysvar(v)
                }
                fn sol_get_epoch_rewards_sysvar(&self, v: *mut u8) -> u64 {
                    self.0.sol_get_epoch_rewards_sysvar(v)
                }
                fn sol_get_last_restart_slot(&self, v: *mut u8) -> u64 {
                    self.0.sol_get_last_restart_slot(v)
                }
                fn sol_get_epoch_stake(&self, v: *const u8) -> u64 {
                    self.0.sol_get_epoch_stake(v)
                }
                unsafe fn sol_memcpy(&self, d: *mut u8, s: *const u8, n: usize) {
                    unsafe { self.0.sol_memcpy(d, s, n) }
                }
                unsafe fn sol_memmove(&self, d: *mut u8, s: *const u8, n: usize) {
                    unsafe { self.0.sol_memmove(d, s, n) }
                }
                unsafe fn sol_memcmp(&self, a: *const u8, b: *const u8, n: usize, r: *mut i32) {
                    unsafe { self.0.sol_memcmp(a, b, n, r) }
                }
                unsafe fn sol_memset(&self, s: *mut u8, c: u8, n: usize) {
                    unsafe { self.0.sol_memset(s, c, n) }
                }
                fn sol_get_return_data(&self) -> Option<(Pubkey, Vec<u8>)> {
                    self.0.sol_get_return_data()
                }
                fn sol_set_return_data(&self, d: &[u8]) {
                    self.0.sol_set_return_data(d)
                }
                fn sol_log_data(&self, f: &[&[u8]]) {
                    self.0.sol_log_data(f)
                }
                fn sol_get_processed_sibling_instruction(&self, i: usize) -> Option<Instruction> {
                    self.0.sol_get_processed_sibling_instruction(i)
                }
                fn sol_get_stack_height(&self) -> u64 {
                    self.0.sol_get_stack_height()
                }
            }
        };
    }
    forward!(V4Fwd, v4::SyscallStubs);
    forward!(V3Fwd, v3::SyscallStubs);

    // Se ejecuta tras el primer `start_with_context` (que instala los stubs
    // reales de la 4.x) y antes de que ningún test envíe transacciones.
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let real = Arc::new(v4::set_syscall_stubs(Box::new(Placeholder)));
        v4::set_syscall_stubs(Box::new(V4Fwd(real.clone())));
        v3::set_syscall_stubs(Box::new(V3Fwd(real)));
    });
}

struct Env {
    ctx: ProgramTestContext,
    mint: Keypair,
    creator: Keypair,
    acceptor: Keypair,
    arbiter: Keypair,
    creator_token: Pubkey,
    acceptor_token: Pubkey,
}

impl Env {
    async fn new() -> Self {
        let mut pt = ProgramTest::new("wager", wager::ID, processor!(process));
        pt.prefer_bpf(false);
        let ctx = pt.start_with_context().await;
        bridge_syscall_stubs();
        let mut env = Env {
            ctx,
            mint: Keypair::new(),
            creator: Keypair::new(),
            acceptor: Keypair::new(),
            arbiter: Keypair::new(),
            creator_token: Pubkey::default(),
            acceptor_token: Pubkey::default(),
        };
        for who in [
            env.creator.pubkey(),
            env.acceptor.pubkey(),
            env.arbiter.pubkey(),
        ] {
            env.fund(who).await;
        }
        env.create_mint().await;
        env.creator_token = env
            .create_token_account(env.creator.pubkey(), INITIAL)
            .await;
        env.acceptor_token = env
            .create_token_account(env.acceptor.pubkey(), INITIAL)
            .await;
        env
    }

    async fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(), BanksClientError> {
        let blockhash = self.ctx.get_new_latest_blockhash().await.unwrap();
        let payer = self.ctx.payer.insecure_clone();
        let mut all: Vec<&Keypair> = vec![&payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, blockhash);
        self.ctx.banks_client.process_transaction(tx).await
    }

    async fn fund(&mut self, to: Pubkey) {
        let ix = system_instruction::transfer(&self.ctx.payer.pubkey(), &to, 1_000_000_000);
        self.send(&[ix], &[]).await.unwrap();
    }

    async fn create_mint(&mut self) {
        let payer = self.ctx.payer.pubkey();
        let mint = self.mint.insecure_clone();
        let rent = self.ctx.banks_client.get_rent().await.unwrap();
        let ixs = [
            system_instruction::create_account(
                &payer,
                &mint.pubkey(),
                rent.minimum_balance(82),
                82,
                &spl_token::ID,
            ),
            spl_token::instruction::initialize_mint2(
                &spl_token::ID,
                &mint.pubkey(),
                &payer,
                None,
                6,
            )
            .unwrap(),
        ];
        self.send(&ixs, &[&mint]).await.unwrap();
    }

    async fn create_token_account(&mut self, owner: Pubkey, amount: u64) -> Pubkey {
        let payer = self.ctx.payer.pubkey();
        let account = Keypair::new();
        let rent = self.ctx.banks_client.get_rent().await.unwrap();
        let mut ixs = vec![
            system_instruction::create_account(
                &payer,
                &account.pubkey(),
                rent.minimum_balance(165),
                165,
                &spl_token::ID,
            ),
            spl_token::instruction::initialize_account3(
                &spl_token::ID,
                &account.pubkey(),
                &self.mint.pubkey(),
                &owner,
            )
            .unwrap(),
        ];
        if amount > 0 {
            ixs.push(
                spl_token::instruction::mint_to(
                    &spl_token::ID,
                    &self.mint.pubkey(),
                    &account.pubkey(),
                    &payer,
                    &[],
                    amount,
                )
                .unwrap(),
            );
        }
        self.send(&ixs, &[&account]).await.unwrap();
        account.pubkey()
    }

    async fn balance(&mut self, token_account: Pubkey) -> u64 {
        let acc = self
            .ctx
            .banks_client
            .get_account(token_account)
            .await
            .unwrap()
            .unwrap();
        u64::from_le_bytes(acc.data[64..72].try_into().unwrap())
    }

    async fn exists(&mut self, address: Pubkey) -> bool {
        self.ctx
            .banks_client
            .get_account(address)
            .await
            .unwrap()
            .is_some()
    }

    async fn bet(&mut self, bet: Pubkey) -> Bet {
        let acc = self
            .ctx
            .banks_client
            .get_account(bet)
            .await
            .unwrap()
            .unwrap();
        Bet::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    async fn now(&mut self) -> i64 {
        self.ctx
            .banks_client
            .get_sysvar::<Clock>()
            .await
            .unwrap()
            .unix_timestamp
    }

    async fn warp_to(&mut self, unix_timestamp: i64) {
        let mut clock = self.ctx.banks_client.get_sysvar::<Clock>().await.unwrap();
        clock.unix_timestamp = unix_timestamp;
        self.ctx.set_sysvar(&clock);
    }

    fn pdas(&self, bet_id: u64) -> (Pubkey, Pubkey) {
        let (bet, _) = Pubkey::find_program_address(
            &[
                BET_SEED,
                self.creator.pubkey().as_ref(),
                &bet_id.to_le_bytes(),
            ],
            &wager::ID,
        );
        let (vault, _) = Pubkey::find_program_address(&[VAULT_SEED, bet.as_ref()], &wager::ID);
        (bet, vault)
    }

    // ---- Instrucciones del programa ----

    async fn create_bet(
        &mut self,
        bet_id: u64,
        opponent: Option<Pubkey>,
        arbiter: Option<Pubkey>,
    ) -> Result<Pubkey, BanksClientError> {
        let now = self.now().await;
        self.create_bet_with(bet_id, opponent, arbiter, now + HOUR, now + 10 * HOUR, None)
            .await
    }

    async fn create_bet_with(
        &mut self,
        bet_id: u64,
        opponent: Option<Pubkey>,
        arbiter: Option<Pubkey>,
        accept_deadline: i64,
        resolve_deadline: i64,
        condition: Option<PriceCondition>,
    ) -> Result<Pubkey, BanksClientError> {
        let (bet, vault) = self.pdas(bet_id);
        let ix = Instruction {
            program_id: wager::ID,
            accounts: wager::accounts::CreateBet {
                creator: self.creator.pubkey(),
                mint: self.mint.pubkey(),
                creator_token: self.creator_token,
                bet,
                vault,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: wager::instruction::CreateBet {
                args: CreateBetArgs {
                    bet_id,
                    description: "El Real Madrid gana la Champions 2026/27".into(),
                    stake: STAKE,
                    opponent,
                    arbiter,
                    accept_deadline,
                    resolve_deadline,
                    condition,
                },
            }
            .data(),
        };
        let creator = self.creator.insecure_clone();
        self.send(&[ix], &[&creator]).await.map(|_| bet)
    }

    async fn accept_bet_as(
        &mut self,
        bet: Pubkey,
        who: &Keypair,
        token: Pubkey,
    ) -> Result<(), BanksClientError> {
        let (vault, _) = Pubkey::find_program_address(&[VAULT_SEED, bet.as_ref()], &wager::ID);
        let ix = Instruction {
            program_id: wager::ID,
            accounts: wager::accounts::AcceptBet {
                acceptor: who.pubkey(),
                bet,
                mint: self.mint.pubkey(),
                acceptor_token: token,
                vault,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: wager::instruction::AcceptBet {}.data(),
        };
        self.send(&[ix], &[who]).await
    }

    async fn accept_bet(&mut self, bet: Pubkey) -> Result<(), BanksClientError> {
        let acceptor = self.acceptor.insecure_clone();
        let token = self.acceptor_token;
        self.accept_bet_as(bet, &acceptor, token).await
    }

    async fn vote(
        &mut self,
        bet: Pubkey,
        voter: &Keypair,
        outcome: Outcome,
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: wager::ID,
            accounts: wager::accounts::SubmitResult {
                voter: voter.pubkey(),
                bet,
            }
            .to_account_metas(None),
            data: wager::instruction::SubmitResult { outcome }.data(),
        };
        self.send(&[ix], &[voter]).await
    }

    async fn arbiter_resolve(
        &mut self,
        bet: Pubkey,
        arbiter: &Keypair,
        outcome: Outcome,
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: wager::ID,
            accounts: wager::accounts::ArbiterResolve {
                arbiter: arbiter.pubkey(),
                bet,
            }
            .to_account_metas(None),
            data: wager::instruction::ArbiterResolve { outcome }.data(),
        };
        self.send(&[ix], &[arbiter]).await
    }

    async fn cancel(&mut self, bet: Pubkey) -> Result<(), BanksClientError> {
        let (vault, _) = Pubkey::find_program_address(&[VAULT_SEED, bet.as_ref()], &wager::ID);
        let ix = Instruction {
            program_id: wager::ID,
            accounts: wager::accounts::CancelBet {
                creator: self.creator.pubkey(),
                bet,
                mint: self.mint.pubkey(),
                creator_token: self.creator_token,
                vault,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: wager::instruction::CancelBet {}.data(),
        };
        let creator = self.creator.insecure_clone();
        self.send(&[ix], &[&creator]).await
    }

    /// Crea una cuenta de precio de Pyth como la que publicaría su receptor.
    fn set_price(
        &mut self,
        feed_id: [u8; 32],
        price: i64,
        prev_publish_time: i64,
        publish_time: i64,
        level: VerificationLevel,
        owner: Pubkey,
    ) -> Pubkey {
        let update = PriceUpdateV2 {
            write_authority: Pubkey::new_unique(),
            verification_level: level,
            price_message: PriceFeedMessage {
                feed_id,
                price,
                conf: 1,
                exponent: -8,
                publish_time,
                prev_publish_time,
                ema_price: price,
                ema_conf: 1,
            },
            posted_slot: 1,
        };
        let mut data = vec![];
        update.try_serialize(&mut data).unwrap();
        let address = Pubkey::new_unique();
        let mut account = AccountSharedData::new(1_000_000_000, data.len(), &owner);
        account.set_data_from_slice(&data);
        self.ctx.set_account(&address, &account);
        address
    }

    async fn resolve_with_price(
        &mut self,
        bet: Pubkey,
        price_update: Pubkey,
    ) -> Result<(), BanksClientError> {
        let ix = Instruction {
            program_id: wager::ID,
            accounts: wager::accounts::ResolveWithPrice { bet, price_update }
                .to_account_metas(None),
            data: wager::instruction::ResolveWithPrice {}.data(),
        };
        self.send(&[ix], &[]).await
    }

    fn settle_ix(
        &self,
        bet: Pubkey,
        creator_token: Pubkey,
        acceptor_token: Pubkey,
        refund: bool,
    ) -> Instruction {
        let (vault, _) = Pubkey::find_program_address(&[VAULT_SEED, bet.as_ref()], &wager::ID);
        Instruction {
            program_id: wager::ID,
            accounts: wager::accounts::Settle {
                creator: self.creator.pubkey(),
                bet,
                mint: self.mint.pubkey(),
                creator_token,
                acceptor_token,
                vault,
                token_program: spl_token::ID,
            }
            .to_account_metas(None),
            data: if refund {
                wager::instruction::RefundExpired {}.data()
            } else {
                wager::instruction::Settle {}.data()
            },
        }
    }

    async fn settle(&mut self, bet: Pubkey) -> Result<(), BanksClientError> {
        let ix = self.settle_ix(bet, self.creator_token, self.acceptor_token, false);
        self.send(&[ix], &[]).await
    }

    async fn refund_expired(&mut self, bet: Pubkey) -> Result<(), BanksClientError> {
        let ix = self.settle_ix(bet, self.creator_token, self.acceptor_token, true);
        self.send(&[ix], &[]).await
    }
}

#[tokio::test]
async fn happy_path_both_agree_and_winner_is_paid() {
    let mut env = Env::new().await;
    let bet = env.create_bet(1, None, None).await.unwrap();
    let (_, vault) = env.pdas(1);
    assert_eq!(env.balance(vault).await, STAKE);
    assert_eq!(env.bet(bet).await.status, BetStatus::Open);

    env.accept_bet(bet).await.unwrap();
    assert_eq!(env.balance(vault).await, 2 * STAKE);
    assert_eq!(env.bet(bet).await.status, BetStatus::Matched);

    // Aún no se puede liquidar: falta el resultado.
    assert_err(env.settle(bet).await, code(WagerError::InvalidStatus));

    let (creator, acceptor) = (env.creator.insecure_clone(), env.acceptor.insecure_clone());
    env.vote(bet, &creator, Outcome::CreatorWins).await.unwrap();
    env.vote(bet, &acceptor, Outcome::CreatorWins)
        .await
        .unwrap();
    assert_eq!(env.bet(bet).await.status, BetStatus::Resolved);

    env.settle(bet).await.unwrap();
    assert_eq!(env.balance(env.creator_token).await, INITIAL + STAKE);
    assert_eq!(env.balance(env.acceptor_token).await, INITIAL - STAKE);
    assert!(
        !env.exists(bet).await,
        "la cuenta de la apuesta debe cerrarse"
    );
    assert!(!env.exists(vault).await, "el vault debe cerrarse");
}

#[tokio::test]
async fn arbiter_breaks_a_disagreement() {
    let mut env = Env::new().await;
    let arbiter = env.arbiter.insecure_clone();
    let bet = env
        .create_bet(2, None, Some(arbiter.pubkey()))
        .await
        .unwrap();
    env.accept_bet(bet).await.unwrap();

    let (creator, acceptor) = (env.creator.insecure_clone(), env.acceptor.insecure_clone());
    env.vote(bet, &creator, Outcome::CreatorWins).await.unwrap();
    env.vote(bet, &acceptor, Outcome::AcceptorWins)
        .await
        .unwrap();
    assert_eq!(env.bet(bet).await.status, BetStatus::Matched);

    // Alguien que no es el árbitro no puede decidir.
    assert_err(
        env.arbiter_resolve(bet, &creator, Outcome::CreatorWins)
            .await,
        code(WagerError::NotTheArbiter),
    );

    env.arbiter_resolve(bet, &arbiter, Outcome::AcceptorWins)
        .await
        .unwrap();
    env.settle(bet).await.unwrap();
    assert_eq!(env.balance(env.creator_token).await, INITIAL - STAKE);
    assert_eq!(env.balance(env.acceptor_token).await, INITIAL + STAKE);
}

#[tokio::test]
async fn draw_returns_each_stake() {
    let mut env = Env::new().await;
    let bet = env.create_bet(3, None, None).await.unwrap();
    env.accept_bet(bet).await.unwrap();
    let (creator, acceptor) = (env.creator.insecure_clone(), env.acceptor.insecure_clone());
    env.vote(bet, &creator, Outcome::Draw).await.unwrap();
    env.vote(bet, &acceptor, Outcome::Draw).await.unwrap();
    env.settle(bet).await.unwrap();
    assert_eq!(env.balance(env.creator_token).await, INITIAL);
    assert_eq!(env.balance(env.acceptor_token).await, INITIAL);
}

#[tokio::test]
async fn creator_can_cancel_only_before_acceptance() {
    let mut env = Env::new().await;
    let bet = env.create_bet(4, None, None).await.unwrap();
    env.cancel(bet).await.unwrap();
    assert_eq!(env.balance(env.creator_token).await, INITIAL);
    assert!(!env.exists(bet).await);

    let bet = env.create_bet(5, None, None).await.unwrap();
    env.accept_bet(bet).await.unwrap();
    assert_err(env.cancel(bet).await, code(WagerError::InvalidStatus));
}

#[tokio::test]
async fn refund_after_resolve_deadline() {
    let mut env = Env::new().await;
    let bet = env.create_bet(6, None, None).await.unwrap();
    env.accept_bet(bet).await.unwrap();

    // Antes del plazo no se puede pedir reembolso.
    assert_err(
        env.refund_expired(bet).await,
        code(WagerError::ResolveDeadlineNotReached),
    );

    let deadline = env.bet(bet).await.resolve_deadline;
    env.warp_to(deadline + 1).await;

    // Pasado el plazo ya no se puede votar...
    let creator = env.creator.insecure_clone();
    assert_err(
        env.vote(bet, &creator, Outcome::CreatorWins).await,
        code(WagerError::ResolveDeadlinePassed),
    );
    // ...pero sí recuperar el dinero.
    env.refund_expired(bet).await.unwrap();
    assert_eq!(env.balance(env.creator_token).await, INITIAL);
    assert_eq!(env.balance(env.acceptor_token).await, INITIAL);
    assert!(!env.exists(bet).await);
}

#[tokio::test]
async fn cannot_accept_after_deadline() {
    let mut env = Env::new().await;
    let bet = env.create_bet(7, None, None).await.unwrap();
    let deadline = env.bet(bet).await.accept_deadline;
    env.warp_to(deadline).await;
    assert_err(
        env.accept_bet(bet).await,
        code(WagerError::AcceptDeadlinePassed),
    );
    // El creador puede recuperar su dinero.
    env.cancel(bet).await.unwrap();
    assert_eq!(env.balance(env.creator_token).await, INITIAL);
}

#[tokio::test]
async fn reserved_bet_only_accepted_by_named_opponent() {
    let mut env = Env::new().await;
    let opponent = env.acceptor.pubkey();
    let bet = env.create_bet(8, Some(opponent), None).await.unwrap();

    let stranger = Keypair::new();
    env.fund(stranger.pubkey()).await;
    let stranger_token = env.create_token_account(stranger.pubkey(), INITIAL).await;
    assert_err(
        env.accept_bet_as(bet, &stranger, stranger_token).await,
        code(WagerError::NotTheOpponent),
    );

    env.accept_bet(bet).await.unwrap();
    assert_eq!(env.bet(bet).await.acceptor, opponent);
}

#[tokio::test]
async fn outsiders_cannot_vote_or_redirect_payout() {
    let mut env = Env::new().await;
    let bet = env.create_bet(9, None, None).await.unwrap();
    env.accept_bet(bet).await.unwrap();

    let attacker = Keypair::new();
    env.fund(attacker.pubkey()).await;
    assert_err(
        env.vote(bet, &attacker, Outcome::AcceptorWins).await,
        code(WagerError::NotAParticipant),
    );

    let (creator, acceptor) = (env.creator.insecure_clone(), env.acceptor.insecure_clone());
    env.vote(bet, &creator, Outcome::AcceptorWins)
        .await
        .unwrap();
    env.vote(bet, &acceptor, Outcome::AcceptorWins)
        .await
        .unwrap();

    // Intentar cobrar en una cuenta del atacante falla.
    let attacker_token = env.create_token_account(attacker.pubkey(), 0).await;
    let ix = env.settle_ix(bet, env.creator_token, attacker_token, false);
    assert_err(
        env.send(&[ix], &[]).await,
        anchor_lang::error::ErrorCode::ConstraintTokenOwner as u32,
    );

    env.settle(bet).await.unwrap();
    assert_eq!(env.balance(env.acceptor_token).await, INITIAL + STAKE);
    assert_eq!(env.balance(attacker_token).await, 0);
}

#[tokio::test]
async fn creator_cannot_accept_own_bet() {
    let mut env = Env::new().await;
    let bet = env.create_bet(10, None, None).await.unwrap();
    let creator = env.creator.insecure_clone();
    let token = env.creator_token;
    assert_err(
        env.accept_bet_as(bet, &creator, token).await,
        code(WagerError::CannotAcceptOwnBet),
    );
}

// ---------------- Oráculo de precios (Pyth) ----------------

const SOL_FEED: [u8; 32] = [7; 32];
const PYTH: Pubkey = pyth_solana_receiver_sdk::ID;

/// Apuesta "SOL por encima de 300 $ dentro de 2 horas", aceptada.
async fn matched_price_bet(env: &mut Env, bet_id: u64) -> (Pubkey, i64) {
    let now = env.now().await;
    let resolve_at = now + 2 * HOUR;
    let cond = PriceCondition {
        feed_id: SOL_FEED,
        threshold: 300 * 100_000_000,
        expo: -8,
        above: true,
        resolve_at,
    };
    let bet = env
        .create_bet_with(
            bet_id,
            None,
            None,
            now + HOUR,
            resolve_at + 24 * HOUR,
            Some(cond),
        )
        .await
        .unwrap();
    env.accept_bet(bet).await.unwrap();
    (bet, resolve_at)
}

#[tokio::test]
async fn price_bet_is_resolved_by_pyth_and_paid() {
    let mut env = Env::new().await;
    let (bet, t) = matched_price_bet(&mut env, 20).await;

    // No se vota: decide el oráculo.
    let creator = env.creator.insecure_clone();
    assert_err(
        env.vote(bet, &creator, Outcome::CreatorWins).await,
        code(WagerError::OracleBet),
    );

    env.warp_to(t + 30).await;
    let price = env.set_price(
        SOL_FEED,
        310 * 100_000_000,
        t - 1,
        t,
        VerificationLevel::Full,
        PYTH,
    );
    env.resolve_with_price(bet, price).await.unwrap();
    let b = env.bet(bet).await;
    assert_eq!(b.status, BetStatus::Resolved);
    assert_eq!(b.outcome, Some(Outcome::CreatorWins));

    env.settle(bet).await.unwrap();
    assert_eq!(env.balance(env.creator_token).await, INITIAL + STAKE);
    assert_eq!(env.balance(env.acceptor_token).await, INITIAL - STAKE);
}

#[tokio::test]
async fn price_below_threshold_pays_acceptor() {
    let mut env = Env::new().await;
    let (bet, t) = matched_price_bet(&mut env, 21).await;
    env.warp_to(t + 5).await;
    let price = env.set_price(
        SOL_FEED,
        250 * 100_000_000,
        t - 1,
        t + 2,
        VerificationLevel::Full,
        PYTH,
    );
    env.resolve_with_price(bet, price).await.unwrap();
    assert_eq!(env.bet(bet).await.outcome, Some(Outcome::AcceptorWins));
}

#[tokio::test]
async fn pyth_resolution_rejects_bad_prices() {
    let mut env = Env::new().await;
    let (bet, t) = matched_price_bet(&mut env, 22).await;
    env.warp_to(t + 120).await;
    let p = 310 * 100_000_000;

    // Precio de otro momento: ni el canónico de t, ni demasiado tarde.
    let later = env.set_price(SOL_FEED, p, t + 10, t + 11, VerificationLevel::Full, PYTH);
    assert_err(
        env.resolve_with_price(bet, later).await,
        code(WagerError::WrongPriceTime),
    );
    let earlier = env.set_price(SOL_FEED, p, t - 5, t - 1, VerificationLevel::Full, PYTH);
    assert_err(
        env.resolve_with_price(bet, earlier).await,
        code(WagerError::WrongPriceTime),
    );
    let too_late = env.set_price(SOL_FEED, p, t - 1, t + 61, VerificationLevel::Full, PYTH);
    assert_err(
        env.resolve_with_price(bet, too_late).await,
        code(WagerError::WrongPriceTime),
    );

    // Otro activo.
    let btc = env.set_price([9; 32], p, t - 1, t, VerificationLevel::Full, PYTH);
    assert_err(
        env.resolve_with_price(bet, btc).await,
        code(WagerError::WrongPriceFeed),
    );

    // Verificación parcial.
    let partial = env.set_price(
        SOL_FEED,
        p,
        t - 1,
        t,
        VerificationLevel::Partial { num_signatures: 5 },
        PYTH,
    );
    assert_err(
        env.resolve_with_price(bet, partial).await,
        code(WagerError::UnverifiedPrice),
    );

    // Cuenta falsificada por alguien que no es el receptor de Pyth.
    let fake = env.set_price(
        SOL_FEED,
        p,
        t - 1,
        t,
        VerificationLevel::Full,
        Pubkey::new_unique(),
    );
    assert_err(
        env.resolve_with_price(bet, fake).await,
        anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram as u32,
    );

    assert_eq!(env.bet(bet).await.status, BetStatus::Matched);
}

#[tokio::test]
async fn price_bet_creation_rules() {
    let mut env = Env::new().await;
    let now = env.now().await;
    let cond = PriceCondition {
        feed_id: SOL_FEED,
        threshold: 1,
        expo: -8,
        above: true,
        resolve_at: now + HOUR,
    };

    // Aceptar después de conocer el precio no está permitido.
    let res = env
        .create_bet_with(30, None, None, now + 2 * HOUR, now + 30 * HOUR, Some(cond))
        .await;
    assert_err(res, code(WagerError::InvalidDeadlines));
    // Debe quedar al menos una hora para resolver.
    let res = env
        .create_bet_with(31, None, None, now + 60, now + HOUR + 60, Some(cond))
        .await;
    assert_err(res, code(WagerError::InvalidDeadlines));
    // Sin árbitro: decide el oráculo.
    let arbiter = Some(env.arbiter.pubkey());
    let res = env
        .create_bet_with(32, None, arbiter, now + 60, now + 30 * HOUR, Some(cond))
        .await;
    assert_err(res, code(WagerError::OracleBet));

    // Las apuestas normales no se pueden resolver con Pyth.
    let bet = env.create_bet(33, None, None).await.unwrap();
    env.accept_bet(bet).await.unwrap();
    let t = env.now().await;
    let price = env.set_price(SOL_FEED, 1, t - 1, t, VerificationLevel::Full, PYTH);
    assert_err(
        env.resolve_with_price(bet, price).await,
        code(WagerError::NotAnOracleBet),
    );
}

#[tokio::test]
async fn unresolved_price_bet_is_refunded() {
    let mut env = Env::new().await;
    let (bet, _) = matched_price_bet(&mut env, 23).await;
    let deadline = env.bet(bet).await.resolve_deadline;
    env.warp_to(deadline + 1).await;
    env.refund_expired(bet).await.unwrap();
    assert_eq!(env.balance(env.creator_token).await, INITIAL);
    assert_eq!(env.balance(env.acceptor_token).await, INITIAL);
}
