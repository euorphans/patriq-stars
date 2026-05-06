// eslint-disable-next-line @typescript-eslint/no-require-imports
const tweetNacl = require('tweetnacl') as typeof import('tweetnacl');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash, createHmac } = require('crypto') as typeof import('crypto');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tonCrypto = require('@ton/crypto') as Record<string, unknown>;

let patched = 0;

if (tweetNacl?.sign?.detached && typeof tonCrypto?.sign === 'function') {
  tonCrypto.sign = function patchedSign(
    message: Buffer | Uint8Array,
    secretKey: Buffer | Uint8Array,
  ): Buffer {
    return Buffer.from(
      tweetNacl.sign.detached(
        new Uint8Array(message),
        new Uint8Array(secretKey),
      ),
    );
  };
  patched++;
}

if (
  tweetNacl?.sign?.detached?.verify &&
  typeof tonCrypto?.signVerify === 'function'
) {
  tonCrypto.signVerify = function patchedVerify(
    message: Buffer | Uint8Array,
    signature: Buffer | Uint8Array,
    publicKey: Buffer | Uint8Array,
  ): boolean {
    return tweetNacl.sign.detached.verify(
      new Uint8Array(message),
      new Uint8Array(signature),
      new Uint8Array(publicKey),
    );
  };
  patched++;
}

if (typeof tonCrypto?.sha256_sync === 'function') {
  tonCrypto.sha256_sync = function patchedSha256Sync(
    data: Buffer | Uint8Array,
  ): Buffer {
    return createHash('sha256').update(data).digest();
  };
  patched++;
}

if (typeof tonCrypto?.sha256 === 'function') {
  tonCrypto.sha256 = async function patchedSha256(
    data: Buffer | Uint8Array,
  ): Promise<Buffer> {
    return createHash('sha256').update(data).digest();
  };
  patched++;
}

if (typeof tonCrypto?.hmac_sha512 === 'function') {
  tonCrypto.hmac_sha512 = async function patchedHmac(
    key: Buffer | Uint8Array,
    data: Buffer | Uint8Array,
  ): Promise<Buffer> {
    return createHmac('sha512', key).update(data).digest();
  };
  patched++;
}

if (patched > 0) {
  console.log(
    `[CryptoPatch] @ton/crypto patched: ${patched} WASM function(s) → Node.js built-in + tweetnacl pure-JS`,
  );
} else {
  console.warn('[CryptoPatch] WARNING: no @ton/crypto functions were patched');
}
