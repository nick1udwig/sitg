use rust_decimal::Decimal;

use crate::config::Config;

#[derive(Clone)]
pub struct StakeService {
    blocked_unlink_wallets: Vec<String>,
}

impl StakeService {
    pub fn new(config: &Config) -> Self {
        Self {
            blocked_unlink_wallets: config.blocked_unlink_wallets.clone(),
        }
    }

    pub async fn staked_balance_wei(&self, wallet_address: &str) -> Decimal {
        if self
            .blocked_unlink_wallets
            .iter()
            .any(|w| w.eq_ignore_ascii_case(wallet_address))
        {
            Decimal::ONE
        } else {
            Decimal::ZERO
        }
    }
}
