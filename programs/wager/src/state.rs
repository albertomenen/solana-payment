use anchor_lang::prelude::*;

pub const BET_SEED: &[u8] = b"bet";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MAX_DESCRIPTION_LEN: usize = 200;

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
    fn outsiders_cannot_vote() {
        let mut bet = matched_bet(Pubkey::new_unique(), Pubkey::new_unique());
        assert!(bet
            .record_vote(&Pubkey::new_unique(), Outcome::Draw)
            .is_err());
    }
}
