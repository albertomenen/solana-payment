use anchor_lang::prelude::*;

pub const BET_SEED: &[u8] = b"bet";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MAX_DESCRIPTION_LEN: usize = 200;
/// Ventana tras `resolve_at` en la que se acepta un precio de Pyth. Vale el
/// primero que alguien registre: después ya no se puede cambiar.
pub const PRICE_WINDOW: i64 = 1800;

/// Condición de precio resuelta por el oráculo de Pyth: "el precio de
/// `feed_id` en `resolve_at` está por encima (o por debajo) de `threshold`".
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct PriceCondition {
    /// Feed de Pyth (p. ej. SOL/USD).
    pub feed_id: [u8; 32],
    /// Umbral: `threshold * 10^expo` (p. ej. 300 $ = 30_000_000_000 con expo -8).
    pub threshold: i64,
    pub expo: i32,
    /// `true`: gana el creador si el precio es mayor que el umbral.
    /// `false`: gana el creador si el precio es menor que el umbral.
    pub above: bool,
    /// Momento (unix) a partir del cual se mira el precio.
    pub resolve_at: i64,
}

impl Bet {
    /// ¿Puede reembolsarse ya? Al vencer `resolve_deadline` o, en apuestas de
    /// precio, en cuanto pasa la ventana sin que nadie la haya resuelto.
    pub fn refundable_at(&self, now: i64) -> bool {
        now > self.resolve_deadline
            || self
                .condition
                .is_some_and(|c| now > c.resolve_at.saturating_add(PRICE_WINDOW))
    }
}

impl PriceCondition {
    /// Resultado para un precio `price * 10^exponent`. `None` si no se puede comparar.
    pub fn outcome(&self, price: i64, exponent: i32) -> Option<Outcome> {
        let min = exponent.min(self.expo);
        let scale = |v: i64, e: i32| -> Option<i128> {
            10i128
                .checked_pow(u32::try_from(e - min).ok()?)?
                .checked_mul(v as i128)
        };
        let (p, t) = (scale(price, exponent)?, scale(self.threshold, self.expo)?);
        let creator_wins = if self.above { p > t } else { p < t };
        Some(if creator_wins {
            Outcome::CreatorWins
        } else {
            Outcome::AcceptorWins
        })
    }
}

/// Resultado de una apuesta.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Outcome {
    /// Gana quien creó la apuesta (se lleva todo el bote).
    CreatorWins,
    /// Gana quien aceptó la apuesta (se lleva todo el bote).
    AcceptorWins,
    /// Empate o evento anulado: cada uno recupera su parte.
    Draw,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum BetStatus {
    /// Creada, esperando a que alguien la acepte.
    Open,
    /// Aceptada: los dos importes están bloqueados en el vault.
    Matched,
    /// Hay resultado definitivo; falta liquidar (`settle`).
    Resolved,
}

#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub creator: Pubkey,
    /// Si es `Some`, solo esa wallet puede aceptar la apuesta.
    pub opponent: Option<Pubkey>,
    /// Quien aceptó la apuesta (`Pubkey::default()` mientras esté abierta).
    pub acceptor: Pubkey,
    /// Árbitro opcional que decide si los participantes no se ponen de acuerdo.
    pub arbiter: Option<Pubkey>,
    pub mint: Pubkey,
    /// Importe que pone cada participante (el bote total es `stake * 2`).
    pub stake: u64,
    pub bet_id: u64,
    /// Fecha límite (unix) para aceptar la apuesta.
    pub accept_deadline: i64,
    /// Fecha límite (unix) para resolverla. Pasada esta fecha sin resultado,
    /// cualquiera puede llamar a `refund_expired` y cada uno recupera lo suyo.
    pub resolve_deadline: i64,
    pub creator_vote: Option<Outcome>,
    pub acceptor_vote: Option<Outcome>,
    pub outcome: Option<Outcome>,
    pub status: BetStatus,
    pub bump: u8,
    pub vault_bump: u8,
    /// Si es `Some`, la apuesta la resuelve el oráculo de Pyth (no hay votos).
    pub condition: Option<PriceCondition>,
    #[max_len(MAX_DESCRIPTION_LEN)]
    pub description: String,
}

impl Bet {
    /// Cuánto recibe cada parte (creador, aceptante) dado un resultado.
    pub fn payouts(outcome: Outcome, stake: u64) -> Option<(u64, u64)> {
        let pot = stake.checked_mul(2)?;
        Some(match outcome {
            Outcome::CreatorWins => (pot, 0),
            Outcome::AcceptorWins => (0, pot),
            Outcome::Draw => (stake, stake),
        })
    }

    /// Registra el voto de un participante. Si ambos votos coinciden, la
    /// apuesta queda resuelta. Devuelve `true` si se ha resuelto.
    pub fn record_vote(&mut self, voter: &Pubkey, outcome: Outcome) -> Result<bool> {
        if *voter == self.creator {
            self.creator_vote = Some(outcome);
        } else if *voter == self.acceptor {
            self.acceptor_vote = Some(outcome);
        } else {
            return err!(crate::errors::WagerError::NotAParticipant);
        }
        if self.creator_vote.is_some() && self.creator_vote == self.acceptor_vote {
            self.resolve(outcome);
            return Ok(true);
        }
        Ok(false)
    }

    pub fn resolve(&mut self, outcome: Outcome) {
        self.outcome = Some(outcome);
        self.status = BetStatus::Resolved;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matched_bet(creator: Pubkey, acceptor: Pubkey) -> Bet {
        Bet {
            creator,
            opponent: None,
            acceptor,
            arbiter: None,
            mint: Pubkey::new_unique(),
            stake: 50,
            bet_id: 0,
            accept_deadline: 0,
            resolve_deadline: 0,
            creator_vote: None,
            acceptor_vote: None,
            outcome: None,
            status: BetStatus::Matched,
            bump: 0,
            vault_bump: 0,
            condition: None,
            description: String::new(),
        }
    }

    #[test]
    fn payouts_are_correct() {
        assert_eq!(Bet::payouts(Outcome::CreatorWins, 50), Some((100, 0)));
        assert_eq!(Bet::payouts(Outcome::AcceptorWins, 50), Some((0, 100)));
        assert_eq!(Bet::payouts(Outcome::Draw, 50), Some((50, 50)));
        assert_eq!(Bet::payouts(Outcome::Draw, u64::MAX), None);
    }

    #[test]
    fn matching_votes_resolve() {
        let (c, a) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut bet = matched_bet(c, a);
        assert!(!bet.record_vote(&c, Outcome::CreatorWins).unwrap());
        assert_eq!(bet.status, BetStatus::Matched);
        assert!(bet.record_vote(&a, Outcome::CreatorWins).unwrap());
        assert_eq!(bet.status, BetStatus::Resolved);
        assert_eq!(bet.outcome, Some(Outcome::CreatorWins));
    }

    #[test]
    fn disagreeing_votes_do_not_resolve_and_can_change() {
        let (c, a) = (Pubkey::new_unique(), Pubkey::new_unique());
        let mut bet = matched_bet(c, a);
        bet.record_vote(&c, Outcome::CreatorWins).unwrap();
        assert!(!bet.record_vote(&a, Outcome::AcceptorWins).unwrap());
        assert_eq!(bet.outcome, None);
        // El creador reconoce que perdió.
        assert!(bet.record_vote(&c, Outcome::AcceptorWins).unwrap());
        assert_eq!(bet.outcome, Some(Outcome::AcceptorWins));
    }

    #[test]
    fn price_condition_compares_across_exponents() {
        // Umbral 300 $ con expo -8; precio 300,5 $ con expo -6.
        let cond = PriceCondition {
            feed_id: [0; 32],
            threshold: 30_000_000_000,
            expo: -8,
            above: true,
            resolve_at: 0,
        };
        assert_eq!(cond.outcome(300_500_000, -6), Some(Outcome::CreatorWins));
        assert_eq!(cond.outcome(299_900_000, -6), Some(Outcome::AcceptorWins));
        // Igual al umbral: no es "mayor que", gana el rival.
        assert_eq!(
            cond.outcome(30_000_000_000, -8),
            Some(Outcome::AcceptorWins)
        );
        let below = PriceCondition {
            above: false,
            ..cond
        };
        assert_eq!(
            below.outcome(29_999_999_999, -8),
            Some(Outcome::CreatorWins)
        );
        // Exponentes absurdos no desbordan.
        assert_eq!(cond.outcome(1, 40), None);
    }

    #[test]
    fn outsiders_cannot_vote() {
        let mut bet = matched_bet(Pubkey::new_unique(), Pubkey::new_unique());
        assert!(bet
            .record_vote(&Pubkey::new_unique(), Outcome::Draw)
            .is_err());
    }
}
