import {
  MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID,
  MAIN_MENU_STARS_CUSTOM_EMOJI_ID,
  PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID,
  PAYMENT_PAY_CUSTOM_EMOJI_ID,
} from '@/shared/keyboards/main.keyboard';
import { formatDateTimeMoscow } from '@/shared/utils/date.utils';
import {
  isFreekassaCardPayment,
  isFreekassaCryptoPayment,
} from '@/shared/utils/freekassa-payment.util';
import { getProductName } from '@/shared/utils/product.utils';

export type SalesNotificationPayload = {
  text: string;
  entities: any[];
};

type SalesPayment = {
  created_at: Date | string;
  order_number: number | string;
  user_telegram_id?: string | null;
  recipient_username?: string | null;
  recipient_name?: string | null;
  product_type: string;
  product_quantity: string;
  payment_method: string;
  crypto_currency?: string | null;
  amount_rub?: unknown;
  amount_usd?: unknown;
  amount_ton?: unknown;
  net_profit_rub?: unknown;
};

function premiumDurationText(months: string): string {
  const m = parseInt(months, 10);
  if (m === 3) return '3 месяца';
  if (m === 6) return '6 месяцев';
  if (m === 12) return '12 месяцев';
  return `${months} мес.`;
}

function resolveSalesProductLine(
  payment: SalesPayment,
): { text: string; customEmojiId?: string } {
  const t = payment.product_type?.toUpperCase();
  if (t === 'STARS') {
    return {
      text: `${payment.product_quantity} звёзд`,
      customEmojiId: MAIN_MENU_STARS_CUSTOM_EMOJI_ID,
    };
  }
  if (t === 'PREMIUM') {
    return {
      text: `Premium на ${premiumDurationText(payment.product_quantity)}`,
      customEmojiId: MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID,
    };
  }
  if (t === 'TON') {
    return {
      text: `${payment.product_quantity} TON`,
      customEmojiId: PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID,
    };
  }
  return { text: getProductName(payment as any) };
}

function resolveSalesPaymentMethodLabel(payment: SalesPayment): string {
  if (payment.payment_method === 'TON') return 'TON';
  if (isFreekassaCryptoPayment(payment)) return 'Криптовалюта';
  if (isFreekassaCardPayment(payment)) return 'Карта';
  if (payment.payment_method === 'FREEKASSA') return 'СБП';
  if (payment.payment_method === 'HELEKET') return 'Криптовалюта';
  return payment.payment_method;
}

function resolveSalesAmountText(payment: SalesPayment): string {
  const amountRub = parseFloat(String(payment.amount_rub ?? 0));
  const amountUsd = parseFloat(String(payment.amount_usd ?? 0));
  const amountTon = parseFloat(String(payment.amount_ton ?? 0));

  let amountText: string;
  if (payment.payment_method === 'TON' && amountTon > 0) {
    amountText = `${amountTon.toFixed(9)} TON`;
  } else if (
    (payment.payment_method === 'HELEKET' || isFreekassaCryptoPayment(payment)) &&
    amountUsd > 0
  ) {
    amountText = `$${amountUsd.toFixed(2)}`;
  } else {
    amountText = `${amountRub.toFixed(2)} ₽`;
  }

  return amountText;
}

/** Уведомление в канал продаж: plain text + entities (без HTML и системных emoji). */
export function buildSalesNotificationPayload(
  payment: SalesPayment,
): SalesNotificationPayload {
  const baseStar = '\u2B50';
  const title = 'Новая продажа';
  const entities: SalesNotificationPayload['entities'] = [
    {
      type: 'custom_emoji',
      offset: 0,
      length: 1,
      custom_emoji_id: PAYMENT_PAY_CUSTOM_EMOJI_ID,
    },
    { type: 'bold', offset: 2, length: title.length },
  ];

  let text = `${baseStar} ${title}\n\n`;

  const appendField = (label: string, value: string) => {
    const start = text.length;
    text += `${label} ${value}\n`;
    const idx = text.indexOf(label, start);
    if (idx >= 0) {
      entities.push({ type: 'bold', offset: idx, length: label.length });
    }
  };

  const timeStr = `${formatDateTimeMoscow(new Date(payment.created_at))} (МСК)`;
  appendField('Время:', timeStr);

  const orderHash = `#${payment.order_number}`;
  const orderLabel = 'Номер заказа:';
  const orderStart = text.length;
  text += `${orderLabel} ${orderHash}\n`;
  const orderLabelIdx = text.indexOf(orderLabel, orderStart);
  if (orderLabelIdx >= 0) {
    entities.push({
      type: 'bold',
      offset: orderLabelIdx,
      length: orderLabel.length,
    });
  }
  const hashIdx = text.indexOf(orderHash, orderStart);
  if (hashIdx >= 0) {
    entities.push({ type: 'code', offset: hashIdx, length: orderHash.length });
  }

  const buyerInfo = payment.user_telegram_id
    ? `ID: ${payment.user_telegram_id}`
    : 'Не указан';
  appendField('Покупатель:', buyerInfo);

  const recipient =
    payment.recipient_username || payment.recipient_name || null;
  const recipientInfo = recipient ? `@${recipient}` : 'Не указан';
  appendField('Получатель:', recipientInfo);

  const product = resolveSalesProductLine(payment);
  const productLabel = 'Товар:';
  const productLinePlain = product.customEmojiId
    ? `${productLabel} ${baseStar} ${product.text}`
    : `${productLabel} ${product.text}`;
  const productStart = text.length;
  text += `${productLinePlain}\n`;
  const productLabelIdx = productLinePlain.indexOf(productLabel);
  if (productLabelIdx >= 0) {
    entities.push({
      type: 'bold',
      offset: productStart + productLabelIdx,
      length: productLabel.length,
    });
  }
  if (product.customEmojiId) {
    entities.push({
      type: 'custom_emoji',
      offset: productStart + productLinePlain.indexOf(baseStar),
      length: 1,
      custom_emoji_id: product.customEmojiId,
    });
  }

  appendField('Способ оплаты:', resolveSalesPaymentMethodLabel(payment));
  appendField('Сумма оплаты:', resolveSalesAmountText(payment));

  const netProfit = parseFloat(String(payment.net_profit_rub ?? 0));
  appendField('Наш доход:', `${netProfit.toFixed(2)} ₽`);

  return { text: text.trimEnd(), entities };
}
