import type { ConfirmTypedData } from './types';

type HexString = `0x${string}`;

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?: (eventName: string, handler: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

function getProvider(): EthereumProvider {
  if (!window.ethereum) {
    throw new Error('No injected wallet found. Install or enable a wallet extension.');
  }

  return window.ethereum;
}

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

export async function connectInjectedWallet(): Promise<HexString> {
  const provider = getProvider();
  const accounts = (await provider.request({
    method: 'eth_requestAccounts'
  })) as string[];

  if (!accounts.length) {
    throw new Error('Wallet did not return an account.');
  }

  return accounts[0] as HexString;
}

export async function signMessageWithInjectedWallet(
  message: string,
  expectedAddress?: string
): Promise<string> {
  const provider = getProvider();
  const account = await connectInjectedWallet();
  if (expectedAddress && normalizeAddress(account) !== normalizeAddress(expectedAddress)) {
    throw new Error('Connected wallet does not match the linked wallet for this challenge.');
  }

  const signature = (await provider.request({
    method: 'personal_sign',
    params: [message, account]
  })) as string;

  if (!signature) {
    throw new Error('Wallet signature failed.');
  }

  return signature;
}

export async function signTypedDataWithInjectedWallet(
  typedData: ConfirmTypedData,
  expectedAddress?: string
): Promise<string> {
  const provider = getProvider();
  const account = await connectInjectedWallet();
  if (expectedAddress && normalizeAddress(account) !== normalizeAddress(expectedAddress)) {
    throw new Error('Connected wallet does not match the linked wallet for this challenge.');
  }

  const signature = (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [account, JSON.stringify(typedData)]
  })) as string;

  if (!signature) {
    throw new Error('Typed data signature failed.');
  }

  return signature;
}
