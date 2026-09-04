import { describe, expect, it } from 'vitest';
import { assertTypedDataUsesStakingContract, stakingContractAddress } from './staking';
import type { ConfirmTypedDataResponse } from '../types';

const configuredAddress = '0x1111111111111111111111111111111111111111';

function typedData(verifyingContract = configuredAddress, chainId = 8453): ConfirmTypedDataResponse {
  return {
    domain: { name: 'SITG', version: '1', chainId, verifyingContract: verifyingContract as `0x${string}` },
    primaryType: 'PRGateConfirmation',
    message: {
      githubUserId: 1,
      githubRepoId: 2,
      pullRequestNumber: 3,
      headSha: 'abc',
      challengeId: '0x01',
      nonce: '1',
      expiresAt: 1
    }
  };
}

describe('staking configuration validation', () => {
  it('accepts a non-zero contract on the supported chain', () => {
    expect(stakingContractAddress({ chain_id: 8453, contract_address: configuredAddress }))
      .toBe(configuredAddress);
  });

  it('rejects zero addresses and unsupported chains', () => {
    expect(() => stakingContractAddress({
      chain_id: 8453,
      contract_address: '0x0000000000000000000000000000000000000000'
    })).toThrow(/invalid staking contract/i);
    expect(() => stakingContractAddress({ chain_id: 1, contract_address: configuredAddress }))
      .toThrow(/unsupported chain/i);
  });

  it('rejects typed data for a different transaction target', () => {
    expect(() => assertTypedDataUsesStakingContract(
      typedData('0x2222222222222222222222222222222222222222'),
      { chain_id: 8453, contract_address: configuredAddress }
    )).toThrow(/do not match/i);
  });
});
