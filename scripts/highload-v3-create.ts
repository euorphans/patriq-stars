import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
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

function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a valid number`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const subwalletId = parseNumberEnv('HL_SUBWALLET_ID', 0x10ad);
  const timeout = parseNumberEnv('HL_TIMEOUT', 3600);
  const workchain = parseNumberEnv('HL_WORKCHAIN', 0);
  const network =
    process.env.HL_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

  const outputPath = path.resolve(
    process.env.HL_WALLET_FILE || '.wallet.highload-v3.json',
  );

  if (fs.existsSync(outputPath)) {
    throw new Error(
      `Wallet file already exists: ${outputPath}. Delete it or set HL_WALLET_FILE.`,
    );
  }

  const mnemonicWords = await mnemonicNew(24);
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
    timeout,
    subwalletId,
    workchain,
  );

  const config: WalletConfig = {
    mnemonic: mnemonicWords.join(' '),
    address: wallet.address.toString({ bounceable: false, testOnly: network === 'testnet' }),
    subwalletId,
    timeout,
    workchain,
    network,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

  console.log(`Wallet file saved: ${outputPath}`);
  console.log(`Address: ${config.address}`);
  console.log('Next: fund this address, then run `npm run wallet:hlv3:activate`.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
