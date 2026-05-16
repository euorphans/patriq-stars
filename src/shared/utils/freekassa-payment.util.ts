/** Маркер в `crypto_currency` для Freekassa-крипто (SCI). */
export const FREEKASSA_CRYPTO_MARKER = 'USD';

/** Маркер в `crypto_currency` для Freekassa-карты (API i=36). */
export const FREEKASSA_CARD_MARKER = 'CARD';

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
