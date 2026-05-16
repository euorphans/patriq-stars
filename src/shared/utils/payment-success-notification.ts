import { ProductType } from '@prisma/client';
import type { Telegraf } from 'telegraf';
import {
  buildPaymentAcceptedCaptionPayload,
  orderStatusPhotoOptions,
  OrderStatusCaptionPayload,
} from '@/shared/utils/order-status-notification.util';

export const PURCHASE_FOLLOWUP_IMAGE = './images/main_menu.webp';

export function buildPurchaseFollowUpCaption(payment: {
  product_type: ProductType | string;
  product_quantity: string;
  order_number: number | string;
}): OrderStatusCaptionPayload {
  return buildPaymentAcceptedCaptionPayload({
    orderNumber: payment.order_number,
    productType: payment.product_type,
    productQuantity: payment.product_quantity,
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
    caption: OrderStatusCaptionPayload;
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

  await bot.telegram.sendPhoto(
    chatId,
    { source: params.imagePath },
    {
      ...orderStatusPhotoOptions(params.caption),
      reply_markup: params.reply_markup,
    },
  );
  await deleteDetails();
}
