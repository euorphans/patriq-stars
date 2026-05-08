/**
 * Единая кнопка «шаг назад» с анимированным custom emoji (Bot API:
 * InlineKeyboardButton.icon_custom_emoji_id).
 */
export const BACK_INLINE_CUSTOM_EMOJI_ID = '5406745015365943482';
export const BACK_INLINE_TEXT = 'Обратно';

/** Plain InlineKeyboardButton; asserted for Telegraf `Markup` row typings vs Bot API emoji buttons. */
export function backInlineButton(callbackData: string): any {
  return {
    text: BACK_INLINE_TEXT,
    callback_data: callbackData,
    icon_custom_emoji_id: BACK_INLINE_CUSTOM_EMOJI_ID,
  };
}
