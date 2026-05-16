import type { Telegraf } from 'telegraf';
import {
  MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID,
  MAIN_MENU_STARS_CUSTOM_EMOJI_ID,
  PAYMENT_METHOD_CARD_CUSTOM_EMOJI_ID,
  PAYMENT_METHOD_HELEKET_CUSTOM_EMOJI_ID,
  PAYMENT_METHOD_SBP_CUSTOM_EMOJI_ID,
  PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID,
  PAYMENT_RECIPIENT_CUSTOM_EMOJI_ID,
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

const EMOJI_PLACEHOLDER = '\u2B50';

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

function resolveSalesPaymentMethod(
  payment: SalesPayment,
): { label: string; customEmojiId?: string } {
  if (payment.payment_method === 'TON') {
    return { label: 'TON', customEmojiId: PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID };
  }
  if (isFreekassaCryptoPayment(payment)) {
    return {
      label: 'Криптовалюта',
      customEmojiId: PAYMENT_METHOD_HELEKET_CUSTOM_EMOJI_ID,
    };
  }
  if (isFreekassaCardPayment(payment)) {
    return { label: 'Карта', customEmojiId: PAYMENT_METHOD_CARD_CUSTOM_EMOJI_ID };
  }
  if (payment.payment_method === 'FREEKASSA') {
    return { label: 'СБП', customEmojiId: PAYMENT_METHOD_SBP_CUSTOM_EMOJI_ID };
  }
  if (payment.payment_method === 'HELEKET') {
    return {
      label: 'Криптовалюта',
      customEmojiId: PAYMENT_METHOD_HELEKET_CUSTOM_EMOJI_ID,
    };
  }
  return { label: payment.payment_method };
}

function resolveSalesAmountText(payment: SalesPayment): string {
  const amountRub = parseFloat(String(payment.amount_rub ?? 0));
  const amountUsd = parseFloat(String(payment.amount_usd ?? 0));
  const amountTon = parseFloat(String(payment.amount_ton ?? 0));

  if (payment.payment_method === 'TON' && amountTon > 0) {
    return `${amountTon.toFixed(9)} TON`;
  }
  if (
    (payment.payment_method === 'HELEKET' || isFreekassaCryptoPayment(payment)) &&
    amountUsd > 0
  ) {
    return `$${amountUsd.toFixed(2)}`;
  }
  return `${amountRub.toFixed(2)} ₽`;
}

/** Уведомление в канал продаж: plain text + custom_emoji entities. */
export function buildSalesNotificationPayload(
  payment: SalesPayment,
): SalesNotificationPayload {
  const title = 'Новая продажа';
  const entities: any[] = [
    {
      type: 'custom_emoji',
      offset: 0,
      length: 1,
      custom_emoji_id: MAIN_MENU_STARS_CUSTOM_EMOJI_ID,
    },
    { type: 'bold', offset: 2, length: title.length },
  ];

  let text = `${EMOJI_PLACEHOLDER} ${title}\n\n`;

  const pushCustomEmoji = (offset: number, customEmojiId: string) => {
    entities.push({
      type: 'custom_emoji',
      offset,
      length: 1,
      custom_emoji_id: customEmojiId,
    });
  };

  const appendField = (
    label: string,
    value: string,
    leadingEmojiId?: string,
  ) => {
    const linePlain = leadingEmojiId
      ? `${label} ${EMOJI_PLACEHOLDER} ${value}`
      : `${label} ${value}`;
    const start = text.length;
    text += `${linePlain}\n`;

    const labelIdx = linePlain.indexOf(label);
    if (labelIdx >= 0) {
      entities.push({
        type: 'bold',
        offset: start + labelIdx,
        length: label.length,
      });
    }

    if (leadingEmojiId) {
      const emojiIdx = linePlain.indexOf(EMOJI_PLACEHOLDER);
      if (emojiIdx >= 0) {
        pushCustomEmoji(start + emojiIdx, leadingEmojiId);
      }
    }
  };

  appendField(
    'Время:',
    `${formatDateTimeMoscow(new Date(payment.created_at))} (МСК)`,
  );

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
  appendField('Получатель:', recipientInfo, PAYMENT_RECIPIENT_CUSTOM_EMOJI_ID);

  const product = resolveSalesProductLine(payment);
  appendField('Товар:', product.text, product.customEmojiId);

  const method = resolveSalesPaymentMethod(payment);
  appendField('Способ оплаты:', method.label, method.customEmojiId);

  appendField('Сумма оплаты:', resolveSalesAmountText(payment));

  const netProfit = parseFloat(String(payment.net_profit_rub ?? 0));
  appendField('Наш доход:', `${netProfit.toFixed(2)} ₽`);

  return { text: text.trimEnd(), entities };
}

/**
 * Custom emoji работают только у основного бота магазина.
 * Сначала шлём им; если в канале его нет — fallback на админ-бота (без анимации).
 */
export async function sendSalesChannelNotification(
  mainBot: Telegraf,
  adminBot: Telegraf,
  channelId: string,
  payload: SalesNotificationPayload,
): Promise<'main' | 'admin'> {
  try {
    await mainBot.telegram.sendMessage(channelId, payload.text, {
      entities: payload.entities,
    });
    return 'main';
  } catch {
    await adminBot.telegram.sendMessage(channelId, payload.text, {
      entities: payload.entities,
    });
    return 'admin';
  }
}
