import {
  INFO_SUPPORT_CUSTOM_EMOJI_ID,
  MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID,
  MAIN_MENU_STARS_CUSTOM_EMOJI_ID,
  PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID,
  PAYMENT_PAY_CUSTOM_EMOJI_ID,
  PAYMENT_RECIPIENT_CUSTOM_EMOJI_ID,
  PAYMENT_USERNAME_WARNING_CUSTOM_EMOJI_ID,
  PROFILE_MENU_CUSTOM_EMOJI_ID,
} from '@/shared/keyboards/main.keyboard';

export type OrderStatusCaptionPayload = {
  caption: string;
  caption_entities: any[];
};

const PLACEHOLDER = '\u2B50';

function normalizeProductType(type: string): string {
  return (type || '').toUpperCase();
}

function premiumDurationText(months: string): string {
  const m = parseInt(months, 10);
  if (m === 3) return '3 месяца';
  if (m === 6) return '6 месяцев';
  if (m === 12) return '12 месяцев';
  return `${months} мес.`;
}

export function resolveOrderProductEmojiId(productType: string): string {
  const t = normalizeProductType(productType);
  if (t === 'STARS') return MAIN_MENU_STARS_CUSTOM_EMOJI_ID;
  if (t === 'PREMIUM') return MAIN_MENU_PREMIUM_CUSTOM_EMOJI_ID;
  if (t === 'TON') return PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID;
  return MAIN_MENU_STARS_CUSTOM_EMOJI_ID;
}

function resolveProductLine(
  productType: string,
  quantity?: string | number,
): { text: string; customEmojiId: string } {
  const qty = quantity != null ? String(quantity) : undefined;
  const t = normalizeProductType(productType);
  const emojiId = resolveOrderProductEmojiId(productType);

  if (t === 'STARS') {
    return {
      text: qty ? `${qty} звёзд` : 'звёзды',
      customEmojiId: emojiId,
    };
  }
  if (t === 'PREMIUM') {
    return {
      text: qty
        ? `Premium на ${premiumDurationText(qty)}`
        : 'Telegram Premium',
      customEmojiId: emojiId,
    };
  }
  if (t === 'TON') {
    return {
      text: qty ? `${qty} TON` : 'TON',
      customEmojiId: emojiId,
    };
  }
  return {
    text: qty ? `${qty} ${productType}` : productType,
    customEmojiId: emojiId,
  };
}

function createPayloadBuilder(title: string, titleEmojiId: string) {
  const entities: any[] = [
    {
      type: 'custom_emoji',
      offset: 0,
      length: 1,
      custom_emoji_id: titleEmojiId,
    },
    { type: 'bold', offset: 2, length: title.length },
  ];
  let caption = `${PLACEHOLDER} ${title}\n\n`;

  const pushEmoji = (offset: number, customEmojiId: string) => {
    entities.push({
      type: 'custom_emoji',
      offset,
      length: 1,
      custom_emoji_id: customEmojiId,
    });
  };

  const appendEmojiLine = (customEmojiId: string, text: string) => {
    const line = `${PLACEHOLDER} ${text}`;
    const start = caption.length;
    caption += `${line}\n`;
    const emojiIdx = line.indexOf(PLACEHOLDER);
    if (emojiIdx >= 0) {
      pushEmoji(start + emojiIdx, customEmojiId);
    }
  };

  const appendProductLine = (productType: string, quantity?: string | number) => {
    const product = resolveProductLine(productType, quantity);
    appendEmojiLine(product.customEmojiId, product.text);
    return product;
  };

  const appendOrderCode = (
    orderNumber: number | string,
    lineEmojiId: string = PROFILE_MENU_CUSTOM_EMOJI_ID,
  ) => {
    const hash = `#${orderNumber}`;
    const label = 'Заказ';
    const line = `${PLACEHOLDER} ${label} ${hash}`;
    const start = caption.length;
    caption += `${line}\n`;

    const emojiIdx = line.indexOf(PLACEHOLDER);
    if (emojiIdx >= 0) {
      pushEmoji(start + emojiIdx, lineEmojiId);
    }
    const labelIdx = caption.indexOf(label, start);
    if (labelIdx >= 0) {
      entities.push({ type: 'bold', offset: labelIdx, length: label.length });
    }
    const hashIdx = caption.indexOf(hash, start);
    if (hashIdx >= 0) {
      entities.push({ type: 'code', offset: hashIdx, length: hash.length });
    }
  };

  const appendTonviewerLink = (
    url: string,
    linkText: string,
    lineEmojiId: string = PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID,
  ) => {
    caption += '\n';
    const line = `${PLACEHOLDER} ${linkText}`;
    const start = caption.length;
    caption += line;
    const emojiIdx = line.indexOf(PLACEHOLDER);
    if (emojiIdx >= 0) {
      pushEmoji(start + emojiIdx, lineEmojiId);
    }
    const linkStart = start + line.indexOf(linkText);
    entities.push({
      type: 'text_link',
      offset: linkStart,
      length: linkText.length,
      url,
    });
  };

  return {
    entities,
    get caption() {
      return caption;
    },
    set caption(value: string) {
      caption = value;
    },
    appendEmojiLine,
    appendProductLine,
    appendOrderCode,
    appendTonviewerLink,
    appendPlain(text: string) {
      caption += text;
    },
    build(): OrderStatusCaptionPayload {
      return { caption: caption.trimEnd(), caption_entities: entities };
    },
  };
}

/** Экран после оплаты: заказ принят, доставка в процессе. */
export function buildPaymentAcceptedCaptionPayload(args: {
  orderNumber: number | string;
  productType: string;
  productQuantity?: string | number;
}): OrderStatusCaptionPayload {
  const b = createPayloadBuilder('Оплата прошла', PAYMENT_PAY_CUSTOM_EMOJI_ID);

  b.appendOrderCode(args.orderNumber, PROFILE_MENU_CUSTOM_EMOJI_ID);
  b.appendProductLine(args.productType, args.productQuantity);

  b.appendPlain('\n');
  b.appendEmojiLine(
    PAYMENT_USERNAME_WARNING_CUSTOM_EMOJI_ID,
    'Отправим в ближайшие минуты.',
  );
  b.appendEmojiLine(
    PAYMENT_RECIPIENT_CUSTOM_EMOJI_ID,
    'Обычно доставка занимает 2–5 минут.',
  );

  return b.build();
}

/** Экран после доставки товара. */
export function buildOrderDeliveredCaptionPayload(args: {
  orderNumber?: number | string;
  productType: string;
  productQuantity?: string | number;
  tonscanUrl?: string | null;
}): OrderStatusCaptionPayload {
  const productEmoji = resolveOrderProductEmojiId(args.productType);
  const b = createPayloadBuilder('Готово', productEmoji);

  const product = resolveProductLine(args.productType, args.productQuantity);
  const deliveredLine = product.text.includes('Premium')
    ? `${product.text} активирован`
    : `${product.text} у получателя`;
  b.appendEmojiLine(product.customEmojiId, deliveredLine);

  if (args.orderNumber != null) {
    b.appendOrderCode(args.orderNumber, PROFILE_MENU_CUSTOM_EMOJI_ID);
  }

  if (args.tonscanUrl) {
    b.appendTonviewerLink(
      args.tonscanUrl,
      'Открыть в Tonviewer',
      PAYMENT_METHOD_TON_CUSTOM_EMOJI_ID,
    );
  }

  b.appendPlain('\n');
  b.appendEmojiLine(
    INFO_SUPPORT_CUSTOM_EMOJI_ID,
    'Вопросы — поддержка в разделе «Информация».',
  );

  return b.build();
}

export function orderStatusPhotoOptions(
  payload: OrderStatusCaptionPayload,
): { caption: string; caption_entities: any[] } {
  return {
    caption: payload.caption,
    caption_entities: payload.caption_entities,
  };
}
