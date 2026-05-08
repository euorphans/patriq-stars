/**
 * Анимированный «крестик» вместо Unicode ❌ (Bot API: MessageEntity custom_emoji).
 */
export const ERROR_CUSTOM_EMOJI_ID = '5210952531676504517';

const PLACEHOLDER = '\u2060';

function leadingErrorEntities() {
  return [
    {
      type: 'custom_emoji' as const,
      offset: 0,
      length: 1,
      custom_emoji_id: ERROR_CUSTOM_EMOJI_ID,
    },
  ];
}

/**
 * HTML-текст ошибки: в начале кастомный emoji + пробел + тело (в JSON/i18n без ❌).
 * Совместимо с parse_mode HTML (Telegram применяет оба).
 */
export function htmlErrorWithLeadingCustomEmoji(html: string): {
  text: string;
  parse_mode: 'HTML';
  caption_entities: ReturnType<typeof leadingErrorEntities>;
  entities: ReturnType<typeof leadingErrorEntities>;
} {
  const trimmed = html.trimStart();
  const text = `${PLACEHOLDER} ${trimmed}`;
  const ent = leadingErrorEntities();
  return {
    text,
    parse_mode: 'HTML',
    caption_entities: ent,
    entities: ent,
  };
}

/** Опции подписи к фото (editOrSendPhoto / sendCachedPhoto). */
export function htmlErrorPhotoCaptionOptions(html: string): {
  caption: string;
  parse_mode: 'HTML';
  caption_entities: ReturnType<typeof leadingErrorEntities>;
} {
  const e = htmlErrorWithLeadingCustomEmoji(html);
  return {
    caption: e.text,
    parse_mode: e.parse_mode,
    caption_entities: e.caption_entities,
  };
}
