use ethers_core::{
    types::transaction::eip712::Eip712,
    types::{H160, Signature},
    utils::hash_message,
};

use crate::error::{ApiError, ApiResult};

pub fn recover_personal_sign_address(message: &str, signature_hex: &str) -> ApiResult<String> {
    let signature: Signature = signature_hex
        .parse()
        .map_err(|_| ApiError::validation("signature is not valid hex signature"))?;
    let digest = hash_message(message);
    let recovered: H160 = signature
        .recover(digest)
        .map_err(|_| ApiError::validation("signature recovery failed"))?;
    Ok(format!("{:#x}", recovered))
}

pub fn recover_eip712_pr_confirmation_address(
    chain_id: u64,
    verifying_contract: &str,
    github_user_id: i64,
    github_repo_id: i64,
    pull_request_number: i32,
    head_sha: &str,
    challenge_id: &str,
    nonce: &str,
    expires_at: i64,
    signature_hex: &str,
) -> ApiResult<String> {
    let signature: Signature = signature_hex
        .parse()
        .map_err(|_| ApiError::validation("signature is not valid hex signature"))?;

    let typed_data = serde_json::json!({
      "types": {
        "EIP712Domain": [
          {"name":"name","type":"string"},
          {"name":"version","type":"string"},
          {"name":"chainId","type":"uint256"},
          {"name":"verifyingContract","type":"address"}
        ],
        "PRGateConfirmation": [
          {"name":"githubUserId","type":"uint256"},
          {"name":"githubRepoId","type":"uint256"},
          {"name":"pullRequestNumber","type":"uint256"},
          {"name":"headSha","type":"string"},
          {"name":"challengeId","type":"bytes32"},
          {"name":"nonce","type":"uint256"},
          {"name":"expiresAt","type":"uint256"}
        ]
      },
      "primaryType": "PRGateConfirmation",
      "domain": {
        "name": "SITG",
        "version": "1",
        "chainId": chain_id,
        "verifyingContract": verifying_contract
      },
      "message": {
        "githubUserId": github_user_id.to_string(),
        "githubRepoId": github_repo_id.to_string(),
        "pullRequestNumber": pull_request_number.to_string(),
        "headSha": head_sha,
        "challengeId": challenge_id,
        "nonce": nonce,
        "expiresAt": expires_at.to_string()
      }
    });

    let typed_data: ethers_core::types::transaction::eip712::TypedData =
        serde_json::from_value(typed_data)
            .map_err(|_| ApiError::validation("failed to construct typed data"))?;
    let digest = typed_data
        .encode_eip712()
        .map_err(|_| ApiError::validation("failed to hash typed data"))?;
    let recovered: H160 = signature
        .recover(digest)
        .map_err(|_| ApiError::validation("signature recovery failed"))?;
    Ok(format!("{:#x}", recovered))
}

pub fn uuid_to_bytes32_hex(id: uuid::Uuid) -> String {
    let mut bytes = [0u8; 32];
    bytes[16..].copy_from_slice(id.as_bytes());
    format!("0x{}", hex::encode(bytes))
}

pub fn uuid_to_uint256_decimal(id: uuid::Uuid) -> String {
    let bytes32 = uuid_to_bytes32_hex(id);
    let hex_value = bytes32.trim_start_matches("0x");
    let bigint = num_bigint::BigUint::parse_bytes(hex_value.as_bytes(), 16)
        .unwrap_or_else(|| num_bigint::BigUint::from(0u8));
    bigint.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_to_bytes32() {
        let id = uuid::Uuid::parse_str("2c6dc47f-00ea-401d-8d96-13794ca39f35").expect("uuid");
        let b = uuid_to_bytes32_hex(id);
        assert_eq!(b.len(), 66);
        assert!(b.starts_with("0x"));
    }
}
