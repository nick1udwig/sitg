use ethers_core::{
    types::transaction::eip712::Eip712,
    types::{H160, Signature},
    utils::hash_message,
};

use crate::error::{ApiError, ApiResult};

pub struct PrConfirmationSignaturePayload<'a> {
    pub chain_id: u64,
    pub verifying_contract: &'a str,
    pub github_user_id: i64,
    pub github_repo_id: i64,
    pub pull_request_number: i32,
    pub head_sha: &'a str,
    pub challenge_id: &'a str,
    pub nonce: &'a str,
    pub expires_at: i64,
}

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
    payload: &PrConfirmationSignaturePayload<'_>,
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
        "chainId": payload.chain_id,
        "verifyingContract": payload.verifying_contract
      },
      "message": {
        "githubUserId": payload.github_user_id.to_string(),
        "githubRepoId": payload.github_repo_id.to_string(),
        "pullRequestNumber": payload.pull_request_number.to_string(),
        "headSha": payload.head_sha,
        "challengeId": payload.challenge_id,
        "nonce": payload.nonce,
        "expiresAt": payload.expires_at.to_string()
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
    use ethers_core::{
        k256::ecdsa::SigningKey,
        types::transaction::eip712::TypedData,
        utils::secret_key_to_address,
    };

    #[test]
    fn uuid_to_bytes32() {
        let id = uuid::Uuid::parse_str("2c6dc47f-00ea-401d-8d96-13794ca39f35").expect("uuid");
        let b = uuid_to_bytes32_hex(id);
        assert_eq!(b.len(), 66);
        assert!(b.starts_with("0x"));
    }

    #[test]
    fn uuid_to_uint256_decimal_is_stable() {
        let id = uuid::Uuid::parse_str("2c6dc47f-00ea-401d-8d96-13794ca39f35").expect("uuid");
        let decimal = uuid_to_uint256_decimal(id);
        assert_eq!(decimal, "59055977586658741076653971232858021685");
    }

    #[test]
    fn rejects_invalid_personal_sign_signature() {
        let err = recover_personal_sign_address("hello", "0x123")
            .expect_err("invalid signature should fail");
        assert!(matches!(err, ApiError::Validation(_)));
    }

    #[test]
    fn recovers_eip712_confirmation_signer() {
        let payload = PrConfirmationSignaturePayload {
            chain_id: 8453,
            verifying_contract: "0x1111111111111111111111111111111111111111",
            github_user_id: 2002,
            github_repo_id: 999,
            pull_request_number: 42,
            head_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            challenge_id: "0x000000000000000000000000000000002c6dc47f00ea401d8d9613794ca39f35",
            nonce: "59055977586658741076653971232858021685",
            expires_at: 1_735_689_600,
        };
        let typed_data: TypedData = serde_json::from_value(serde_json::json!({
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
            "chainId": 8453,
            "verifyingContract": "0x1111111111111111111111111111111111111111"
          },
          "message": {
            "githubUserId": "2002",
            "githubRepoId": "999",
            "pullRequestNumber": "42",
            "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "challengeId": "0x000000000000000000000000000000002c6dc47f00ea401d8d9613794ca39f35",
            "nonce": "59055977586658741076653971232858021685",
            "expiresAt": "1735689600"
          }
        }))
        .expect("construct independently specified typed data");
        let digest = typed_data.encode_eip712().expect("hash typed data");
        let signing_key = SigningKey::from_slice(&[7_u8; 32]).expect("test signing key");
        let (signature, recovery_id) = signing_key
            .sign_prehash_recoverable(&digest)
            .expect("sign typed-data digest");
        let mut encoded_signature = [0_u8; 65];
        encoded_signature[..64].copy_from_slice(&signature.to_bytes());
        encoded_signature[64] = recovery_id.to_byte() + 27;

        let recovered = recover_eip712_pr_confirmation_address(
            &payload,
            &format!("0x{}", hex::encode(encoded_signature)),
        )
        .expect("recover typed-data signer");
        assert_eq!(
            recovered,
            format!("{:#x}", secret_key_to_address(&signing_key))
        );
    }
}
