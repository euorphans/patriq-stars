import { ProductType } from '@prisma/client';
import type { Telegraf } from 'telegraf';
import { PrismaService } from '@/shared/services/prisma/prisma.service';
import {
  I18nService,
  SupportedLanguage,
} from '@/shared/services/i18n/i18n.service';
import { computeMopsCoinsForPayment } from './mops-coin.utils';
import { getProductName } from './product.utils';

export const MOPS_PURCHASE_SUCCESS_IMAGE = './images/mops_purchase_reward.webp';
export const MOPS_BALANCE_HEADER_IMAGE = './images/mops_bones_balance.webp';

export function formatMopsCoinsAmount(
  coins: number,
  _lang?: SupportedLanguage,
): string {
  return coins.toLocaleString('ru-RU');
}

export async function buildMopsPurchaseRewardCaption(
  _prisma: PrismaService,
  i18n: I18nService,
  lang: SupportedLanguage,
  payment: {
    product_type: ProductType;
    product_quantity: string;
  },
  buyerTelegramId: string,
): Promise<string> {
  const coins = computeMopsCoinsForPayment(
    payment.product_type,
    payment.product_quantity,
  );
  const purchaseHtml = getProductName(payment);

  const botUrl = process.env.BOT_URL || 'https://t.me/MopsStarsBot';
  const referralLink = `${botUrl}?start=ref${buyerTelegramId}`;

  return i18n.t('mops_coin.purchase_reward', lang, {
    coins: formatMopsCoinsAmount(coins, lang),
    purchaseHtml,
    referralLink,
  });
}

/**
 * Карточка награды Mops Bones: всегда новое фото в чате.
 * Сообщение оплаты (`paymentMessageId`) не трогаем — его обновляют доставка / успех заказа.
 */
export async function sendOrEditPaymentSuccessPhoto(
  bot: Telegraf,
  params: {
    userTelegramId: string;
    /** Совместимость вызовов; редактирование по этому id не выполняется. */
    paymentMessageId?: string | null;
    detailsMessageId?: string | null;
    caption: string;
    imagePath: string;
    replyMarkup: { inline_keyboard: any[][] };
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
    reply_markup: params.replyMarkup,
  });
  await deleteDetails();
}
