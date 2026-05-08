import { ProductType } from '@prisma/client';
import type { Telegraf } from 'telegraf';
import {
  I18nService,
  SupportedLanguage,
} from '@/shared/services/i18n/i18n.service';
import { getProductName } from './product.utils';

export const PURCHASE_FOLLOWUP_IMAGE = './images/main_menu.webp';

export async function buildPurchaseFollowUpCaption(
  i18n: I18nService,
  lang: SupportedLanguage,
  payment: {
    product_type: ProductType;
    product_quantity: string;
  },
): Promise<string> {
  const purchaseHtml = getProductName(payment);
  return i18n.t('payment.followup_caption', lang, {
    purchaseHtml,
  });
}

/**
 * Отдельное фото в чат после оплаты (основное сообщение заказа не трогаем).
 */
export async function sendOrEditPaymentSuccessPhoto(
  bot: Telegraf,
  params: {
    userTelegramId: string;
    paymentMessageId?: string | null;
    detailsMessageId?: string | null;
    caption: string;
    imagePath: string;
    reply_markup: { inline_keyboard: any[][] };
  },
): Promise<void> {
  const chatId = params.userTelegramId;

  const deleteDetails = async () => {
    if (!params.detailsMessageId) return;
    try {
      await bot.telegram.deleteMessage(
        chatId,
        parseInt(String(params.detailsMessageId), 10),
      );
    } catch {}
  };

  await bot.telegram.sendPhoto(chatId, { source: params.imagePath }, {
    caption: params.caption,
    parse_mode: 'HTML',
    reply_markup: params.reply_markup,
  });
  await deleteDetails();
}
