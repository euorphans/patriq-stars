import { ProductType } from '@prisma/client';
import type { Telegraf } from 'telegraf';
import type { PrismaService } from '@/shared/services/prisma/prisma.service';
import {
  I18nService,
  SupportedLanguage,
} from '@/shared/services/i18n/i18n.service';
import { getProductName } from './product.utils';

/** Доп. сообщение после успешной оплаты (реферальная ссылка, без бонусных баллов). */
export const PURCHASE_FOLLOWUP_IMAGE = './images/referral.webp';

export async function buildPurchaseFollowUpCaption(
  _prisma: PrismaService,
  i18n: I18nService,
  lang: SupportedLanguage,
  payment: {
    product_type: ProductType;
    product_quantity: string;
  },
  buyerTelegramId: string,
): Promise<string> {
  const purchaseHtml = getProductName(payment);
  const botUrl = process.env.BOT_URL || 'https://t.me/MopsStarsBot';
  const referralLink = `${botUrl}?start=ref${buyerTelegramId}`;
  return i18n.t('payment.followup_caption', lang, {
    purchaseHtml,
    referralLink,
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
