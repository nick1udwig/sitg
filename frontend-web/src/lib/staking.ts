import type { ConfirmTypedDataResponse, StakingConfigResponse } from '../types';
import { SUPPORTED_CHAIN_ID } from './chains';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export function stakingContractAddress(config: StakingConfigResponse): `0x${string}` {
  if (config.chain_id !== SUPPORTED_CHAIN_ID) {
    throw new Error(`Staking is configured for unsupported chain ${config.chain_id}.`);
  }

  const address = config.contract_address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address) || address === ZERO_ADDRESS) {
    throw new Error('The backend returned an invalid staking contract address.');
  }

  return address as `0x${string}`;
}

export function assertTypedDataUsesStakingContract(
  typedData: ConfirmTypedDataResponse,
  config: StakingConfigResponse
): void {
  const contractAddress = stakingContractAddress(config);
  if (
    typedData.domain.chainId !== config.chain_id
    || typedData.domain.verifyingContract.toLowerCase() !== contractAddress
  ) {
    throw new Error('The confirmation signature and staking transaction target do not match.');
  }
}
