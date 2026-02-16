use std::str::FromStr;

use reqwest::Client;
use serde::Deserialize;
use serde_json::json;
use sha3::{Digest, Keccak256};

use crate::{
    config::Config,
    error::{ApiError, ApiResult},
};

#[derive(Clone)]
pub struct StakeService {
    client: Client,
    rpc_url: Option<String>,
    contract_address: Option<String>,
    blocked_unlink_wallets: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct EthCallResponse {
    result: String,
}

#[derive(Debug, Clone)]
pub struct StakeStatus {
    pub balance_wei: u128,
    pub unlock_time_unix: u64,
}

impl StakeService {
    pub fn new(config: &Config) -> Self {
        Self {
            client: Client::new(),
            rpc_url: config.base_rpc_url.clone(),
            contract_address: config.staking_contract_address.clone(),
            blocked_unlink_wallets: config.blocked_unlink_wallets.clone(),
        }
    }

    pub async fn stake_status(&self, wallet_address: &str) -> ApiResult<StakeStatus> {
        if self
            .blocked_unlink_wallets
            .iter()
            .any(|w| w.eq_ignore_ascii_case(wallet_address))
        {
            return Ok(StakeStatus {
                balance_wei: 1,
                unlock_time_unix: u64::MAX,
            });
        }

        let balance_hex = self
            .eth_call_address_u256("stakedBalance(address)", wallet_address)
            .await?;
        let unlock_hex = self
            .eth_call_address_u256("unlockTime(address)", wallet_address)
            .await?;

        Ok(StakeStatus {
            balance_wei: parse_u256_hex_to_u128(&balance_hex)?,
            unlock_time_unix: parse_u256_hex_to_u64(&unlock_hex)?,
        })
    }

    async fn eth_call_address_u256(
        &self,
        function_sig: &str,
        wallet_address: &str,
    ) -> ApiResult<String> {
        let rpc_url = self
            .rpc_url
            .as_ref()
            .ok_or_else(|| ApiError::validation("BASE_RPC_URL is not configured"))?;
        let contract = self
            .contract_address
            .as_ref()
            .ok_or_else(|| ApiError::validation("STAKING_CONTRACT_ADDRESS is not configured"))?;

        let data = encode_call_data(function_sig, wallet_address)?;
        let body = json!({
          "jsonrpc": "2.0",
          "id": 1,
          "method": "eth_call",
          "params": [
            {
              "to": contract,
              "data": data
            },
            "latest"
          ]
        });

        let response = self
            .client
            .post(rpc_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        if !response.status().is_success() {
            return Err(ApiError::validation("stake RPC call failed"));
        }

        let payload: EthCallResponse = response
            .json()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;

        Ok(payload.result)
    }
}

fn encode_call_data(function_sig: &str, wallet_address: &str) -> ApiResult<String> {
    let wallet = wallet_address.trim().to_lowercase();
    if !wallet.starts_with("0x") || wallet.len() != 42 {
        return Err(ApiError::validation(
            "wallet_address must be 20-byte hex with 0x prefix",
        ));
    }

    let mut hasher = Keccak256::new();
    hasher.update(function_sig.as_bytes());
    let selector = hasher.finalize();

    let address_hex = wallet.trim_start_matches("0x");
    if address_hex.len() != 40 || !address_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::validation(
            "wallet_address must be 20-byte hex with 0x prefix",
        ));
    }

    let mut padded = String::from("000000000000000000000000");
    padded.push_str(address_hex);

    Ok(format!("0x{}{}", hex::encode(&selector[0..4]), padded))
}

fn parse_u256_hex_to_u128(hex_value: &str) -> ApiResult<u128> {
    let raw = hex_value.trim_start_matches("0x");
    u128::from_str_radix(raw, 16)
        .map_err(|_| ApiError::validation("value too large for u128; unsupported in MVP backend"))
}

fn parse_u256_hex_to_u64(hex_value: &str) -> ApiResult<u64> {
    let value = parse_u256_hex_to_u128(hex_value)?;
    u64::from_str(&value.to_string()).map_err(|_| ApiError::validation("invalid unlock time"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_call_data() {
        let data = encode_call_data(
            "stakedBalance(address)",
            "0x1111111111111111111111111111111111111111",
        )
        .expect("encode");
        assert_eq!(data.len(), 2 + 8 + 64);
    }

    #[test]
    fn parses_u256_hex_small() {
        let value = parse_u256_hex_to_u128("0x0de0b6b3a7640000").expect("parse");
        assert_eq!(value, 1_000_000_000_000_000_000u128);
    }
}
