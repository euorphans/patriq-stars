/** Маркер в `crypto_currency` для Freekassa-крипто (SCI). */
export const FREEKASSA_CRYPTO_MARKER = 'USD';

/** Маркер в `crypto_currency` для Freekassa-карты (API i=36). */
export const FREEKASSA_CARD_MARKER = 'CARD';

/** Freekassa API: СБП (API) — §1.8 / createOrder `i`. */
export const FREEKASSA_SBP_METHOD_ID = 44;

/** Freekassa API: Card RUB API (карты 5.7) — createOrder `i`. */
export const FREEKASSA_CARD_METHOD_ID = 36;

/** Freekassa SCI: USDT TRC20 (крипто). */
export const FREEKASSA_CRYPTO_METHOD_ID = 15;

export type FreekassaPaymentChannel = 'sbp' | 'card' | 'crypto';

export function isFreekassaCryptoPayment(payment: {
  payment_method: string;
  crypto_currency?: string | null;
}): boolean {
  return (
    payment.payment_method === 'FREEKASSA' &&
    payment.crypto_currency === FREEKASSA_CRYPTO_MARKER
  );
}

export function isFreekassaCardPayment(payment: {
  payment_method: string;
  crypto_currency?: string | null;
}): boolean {
  return (
    payment.payment_method === 'FREEKASSA' &&
    payment.crypto_currency === FREEKASSA_CARD_MARKER
  );
}

/** ID способа оплаты `i` для Freekassa createOrder / SCI. */
export function resolveFreekassaMethodId(channel: FreekassaPaymentChannel): number {
  switch (channel) {
    case 'card': {
      const fromEnv = parseInt(process.env.FREEKASSA_CARD_CUR_ID || '', 10);
      return Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : FREEKASSA_CARD_METHOD_ID;
    }
    case 'sbp': {
      const fromEnv = parseInt(process.env.FREEKASSA_SBP_CUR_ID || '', 10);
      return Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : FREEKASSA_SBP_METHOD_ID;
    }
    case 'crypto': {
      const fromEnv = parseInt(process.env.FREEKASSA_CRYPTO_CUR_ID || '', 10);
      return Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : FREEKASSA_CRYPTO_METHOD_ID;
    }
  }
}

export function freekassaApiMethodIds(): number[] {
  return [
    resolveFreekassaMethodId('sbp'),
    resolveFreekassaMethodId('card'),
  ];
}

export function channelFromBotPaymentMethod(
  paymentMethod: string,
): FreekassaPaymentChannel | null {
  if (paymentMethod === 'freekassa_card') return 'card';
  if (paymentMethod === 'freekassa_crypto') return 'crypto';
  if (paymentMethod === 'freekassa') return 'sbp';
  return null;
}
