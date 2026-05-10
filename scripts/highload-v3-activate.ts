import { mnemonicToPrivateKey } from '@ton/crypto';
import { Address, internal, SendMode, TonClient, toNano } from '@ton/ton';
import { HighloadWalletV3 } from '@tonkite/highload-wallet-v3';
import * as fs from 'fs';
import * as path from 'path';

type WalletConfig = {
  mnemonic: string;
  address: string;
  subwalletId: number;
  timeout: number;
  workchain: number;
  network: 'mainnet' | 'testnet';
};

function getEndpoint(network: WalletConfig['network']): string {
  return network === 'mainnet'
    ? 'https://toncenter.com/api/v2/jsonRPC'
    : 'https://testnet.toncenter.com/api/v2/jsonRPC';
}

function getFallbackEndpoint(network: WalletConfig['network']): string {
  return network === 'mainnet'
    ? 'https://mainnet-v4.tonhubapi.com'
    : 'https://testnet-v4.tonhubapi.com';
}

function stringifyError(error: unknown): string {
  if (error && typeof error === 'object') {
    const maybeAny = error as any;
    const parts: string[] = [];

    if (typeof maybeAny.message === 'string') {
      parts.push(maybeAny.message);
    }

    if (typeof maybeAny.response?.status === 'number') {
      parts.push(`status=${maybeAny.response.status}`);
    }

    if (maybeAny.response?.data) {
      try {
        parts.push(`response=${JSON.stringify(maybeAny.response.data)}`);
      } catch {
        parts.push('response=[unserializable]');
      }
    }

    return parts.join(' | ');
  }

  return String(error);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const walletFile = path.resolve(
    process.env.HL_WALLET_FILE || '.wallet.highload-v3.json',
  );
  if (!fs.existsSync(walletFile)) {
    throw new Error(
      `Wallet file not found: ${walletFile}. Run wallet:hlv3:create first.`,
    );
  }

  const config = JSON.parse(
    fs.readFileSync(walletFile, 'utf-8'),
  ) as WalletConfig;

  const mnemonicWords = config.mnemonic.trim().split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(mnemonicWords);

  const sequence = {
    shift: 0,
    bitNumber: 0,
    current() {
      return (this.shift << 10) | this.bitNumber;
    },
    next() {
      this.bitNumber += 1;
      if (this.bitNumber > 1022) {
        this.bitNumber = 0;
        this.shift = (this.shift + 1) % 8192;
      }
      return (this.shift << 10) | this.bitNumber;
    },
  };

  const wallet = new HighloadWalletV3(
    sequence as any,
    keyPair.publicKey,
    config.timeout,
    config.subwalletId,
    config.workchain,
  );

  const apiKey = process.env.TONCENTER_API_KEY?.split(',')[0]?.trim();
  const clients = [
    new TonClient({
      endpoint: getEndpoint(config.network),
      apiKey: apiKey || undefined,
    }),
    new TonClient({
      endpoint: getFallbackEndpoint(config.network),
    }),
  ];
  const expectedAddress = wallet.address.toString({
    bounceable: false,
    testOnly: config.network === 'testnet',
  });
  if (expectedAddress !== config.address) {
    throw new Error(
      `Wallet config mismatch: derived address ${expectedAddress} differs from file address ${config.address}`,
    );
  }

  const state = await clients[0].getContractState(wallet.address);
  const balanceTon = Number(state.balance) / 1e9;
  console.log(
    `Current state: ${state.state}, balance: ${balanceTon.toFixed(6)} TON`,
  );
  if (state.state !== 'active' && state.balance <= 0n) {
    throw new Error(
      'Wallet has zero balance. Fund this address first, then retry activation.',
    );
  }

  if (state.state === 'active') {
    console.log('Wallet is already active. Nothing to activate.');
    return;
  }

  const destination = process.env.HL_DESTINATION || config.address;
  const amount = process.env.HL_AMOUNT || '0.01';
  const createdAt = Math.floor(Date.now() / 1000) - 30;

  const transfer = {
    to: Address.parse(destination),
    value: toNano(amount),
    bounce: false,
  };

  let lastError: unknown;
  const maxAttemptsPerClient = 3;
  for (const client of clients) {
    const provider = client.provider(wallet.address, wallet.init);

    for (let attempt = 1; attempt <= maxAttemptsPerClient; attempt++) {
      try {
        const queryId = sequence.current();
        await wallet.sendExternal(provider, keyPair.secretKey, {
          message: internal(transfer),
          mode: SendMode.PAY_GAS_SEPARATELY,
          queryId,
          createdAt: createdAt - (attempt - 1) * 10,
        });
        sequence.next();
        console.log(`Activation sent via ${client.parameters.endpoint}`);
        console.log(`queryId: ${queryId}`);
        console.log(`createdAt: ${createdAt - (attempt - 1) * 10}`);
        console.log('External message sent.');
        console.log(`Wallet address: ${wallet.address.toString()}`);
        console.log('Check explorer status; wallet should become active.');
        return;
      } catch (error) {
        lastError = error;
        const asText = stringifyError(error);
        const isRateLimited = asText.includes('"code":429');
        const isServerError = asText.includes('status code 500');
        const hasRetryBudget = attempt < maxAttemptsPerClient;
        if ((isRateLimited || isServerError) && hasRetryBudget) {
          await delay(1200 * attempt);
          continue;
        }
        break;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Activation failed');
}

main().catch((error) => {
  console.error(stringifyError(error));
  process.exit(1);
});
