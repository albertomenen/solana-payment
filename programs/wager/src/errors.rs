use anchor_lang::prelude::*;

#[error_code]
pub enum WagerError {
    #[msg("El importe debe ser mayor que cero")]
    ZeroStake,
    #[msg("La descripción es demasiado larga")]
    DescriptionTooLong,
    #[msg("Fechas límite inválidas")]
    InvalidDeadlines,
    #[msg("La apuesta no está en el estado requerido")]
    InvalidStatus,
    #[msg("El plazo para aceptar la apuesta ha terminado")]
    AcceptDeadlinePassed,
    #[msg("Esta apuesta está reservada para otra wallet")]
    NotTheOpponent,
    #[msg("No puedes aceptar tu propia apuesta")]
    CannotAcceptOwnBet,
    #[msg("Solo los participantes pueden votar el resultado")]
    NotAParticipant,
    #[msg("El plazo para resolver la apuesta ha terminado")]
    ResolveDeadlinePassed,
    #[msg("El plazo para resolver la apuesta todavía no ha terminado")]
    ResolveDeadlineNotReached,
    #[msg("Esta apuesta no tiene árbitro o no eres tú")]
    NotTheArbiter,
    #[msg("El árbitro no puede ser uno de los participantes")]
    ArbiterIsParticipant,
    #[msg("Cuenta de token incorrecta")]
    InvalidTokenAccount,
    #[msg("Desbordamiento aritmético")]
    Overflow,
}
