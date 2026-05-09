import { Markup } from 'telegraf';
import { getProductEmoji } from '@/shared/utils';
import {
  I18nService,
  SupportedLanguage,
} from '@/shared/services/i18n/i18n.service';
import { backInlineButton } from '@/shared/keyboards/back-inline-button';

const keyboardCache = new Map<string, { keyboard: any; expires: number }>();
const KEYBOARD_CACHE_TTL = 300000;

function getCachedKeyboard(key: string): any | null {
  const cached = keyboardCache.get(key);
  if (cached && Date.now() < cached.expires) {
    return cached.keyboard;
  }
  return null;
}

function setCachedKeyboard(key: string, keyboard: any): void {
  keyboardCache.set(key, {
    keyboard,
    expires: Date.now() + KEYBOARD_CACHE_TTL,
  });
}

export function clearMainMenuCache(): void {
  for (const key of keyboardCache.keys()) {
    if (key.startsWith('main_')) {
      keyboardCache.delete(key);
    }
  }
}

/** Custom emoji у заголовка подписи экрана «Информация» (caption_entities). */
export const MAIN_MENU_INFO_CUSTOM_EMOJI_ID = '5334544901428229844';

/** Анимированные custom emoji (Bot API: InlineKeyboardButton.icon_custom_emoji_id). */
const MAIN_MENU_CUSTOM_EMOJI = {
  stars: '5438496463044752972',
  premium: '5217822164362739968',
  profile: '5416041192905265756',
  info: MAIN_MENU_INFO_CUSTOM_EMOJI_ID,
} as const;

/** Как в payments / cron: при пустом env кнопка «Поддержка» не пропадает. */
const DEFAULT_INFO_SUPPORT_URL = 'https://t.me/dxminus';

/** Кнопки экрана «Информация» (url + icon_custom_emoji_id). */
const INFO_MENU_CUSTOM_EMOJI = {
  /** Политика / правила */
  rules: '5282843764451195532',
  /** Конфиденциальность */
  privacy: '5296369303661067030',
  /** Поддержка */
  support: '5395695537687123235',
} as const;

/** На клавиатуре не выше этой суммы; больше — через «Свой ввод». */
const STARS_QTY_PRESET_CAP = 5000;

/**
 * Пресеты Stars: до STARS_QTY_PRESET_CAP, по 2 кнопки в ряд → максимум 3 ряда сумм.
 * Min из настроек подмешивается, max на клавиатуру не выводим, если он выше CAP.
 */
const STARS_QTY_PRESETS = [100, 500, 1000, 2500, 5000] as const;

/** Кнопка «Свой ввод» на экране количества Stars (без второй иконки-звезды). */
const STARS_QTY_MANUAL_CUSTOM_EMOJI_ID = '5395444784611480792';

function trimUrl(envVar: string | undefined): string | undefined {
  const s = envVar?.trim();
  return s && s !== '#' ? s : undefined;
}

function mainMenuInlineRows(i18n: I18nService, lang: SupportedLanguage = 'ru') {
  return [
    [
      {
        text: i18n.t('menu.main.stars', lang),
        callback_data: 'buy_stars',
        icon_custom_emoji_id: MAIN_MENU_CUSTOM_EMOJI.stars,
      },
      {
        text: i18n.t('menu.main.premium', lang),
        callback_data: 'buy_premium',
        icon_custom_emoji_id: MAIN_MENU_CUSTOM_EMOJI.premium,
      },
    ],
    [
      {
        text: i18n.t('menu.main.profile', lang),
        callback_data: 'my_profile',
        icon_custom_emoji_id: MAIN_MENU_CUSTOM_EMOJI.profile,
      },
      {
        text: i18n.t('menu.main.info', lang),
        callback_data: 'menu_info',
        icon_custom_emoji_id: MAIN_MENU_CUSTOM_EMOJI.info,
      },
    ],
  ];
}

export class MainKeyboard {
  static getPersistentKeyboard(
    i18n?: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    const startText = i18n ? i18n.t('keyboard.start', lang) : '🏠 Главное меню';

    return Markup.keyboard([[startText]])
      .resize()
      .persistent();
  }

  static getMainMenuAdmin(i18n: I18nService, lang: SupportedLanguage = 'ru') {
    return {
      reply_markup: { inline_keyboard: mainMenuInlineRows(i18n, lang) },
    };
  }

  static getMainMenu(i18n: I18nService, lang: SupportedLanguage = 'ru') {
    const cacheKey = `main_${lang}`;
    const cached = getCachedKeyboard(cacheKey);
    if (cached) return cached;

    const keyboard = {
      reply_markup: { inline_keyboard: mainMenuInlineRows(i18n, lang) },
    };
    setCachedKeyboard(cacheKey, keyboard);
    return keyboard;
  }

  /**
   * Экран «Информация».
   * Базовые ссылки: AGREEMENT_URL (правила / оферта), PRIVACY_POLICY_URL, SUPPORT_URL.
   * INFO_* — только если нужны другие URL именно для этого экрана (переопределение).
   */
  static getInfoMenu(i18n: I18nService, lang: SupportedLanguage = 'ru') {
    const rulesUrl =
      trimUrl(process.env.INFO_RULES_URL) || trimUrl(process.env.AGREEMENT_URL);
    const privacyUrl =
      trimUrl(process.env.INFO_PRIVACY_URL) ||
      trimUrl(process.env.PRIVACY_POLICY_URL);
    let offerUrl =
      trimUrl(process.env.INFO_OFFER_URL) || trimUrl(process.env.AGREEMENT_URL);
    if (offerUrl && offerUrl === rulesUrl) {
      offerUrl = undefined;
    }
    const supportUrl =
      trimUrl(process.env.INFO_SUPPORT_URL) ||
      trimUrl(process.env.SUPPORT_URL) ||
      DEFAULT_INFO_SUPPORT_URL;

    const rows: any[][] = [];

    const docRow: any[] = [];
    if (rulesUrl) {
      docRow.push({
        text: i18n.t('menu.info.btn.rules', lang),
        url: rulesUrl,
        icon_custom_emoji_id: INFO_MENU_CUSTOM_EMOJI.rules,
      });
    }
    if (privacyUrl) {
      docRow.push({
        text: i18n.t('menu.info.btn.privacy', lang),
        url: privacyUrl,
        icon_custom_emoji_id: INFO_MENU_CUSTOM_EMOJI.privacy,
      });
    }
    if (docRow.length) rows.push(docRow);

    if (offerUrl) {
      rows.push([
        Markup.button.url(i18n.t('menu.info.btn.offer', lang), offerUrl),
      ]);
    }

    if (supportUrl) {
      rows.push([
        {
          text: i18n.t('menu.info.btn.support', lang),
          url: supportUrl,
          icon_custom_emoji_id: INFO_MENU_CUSTOM_EMOJI.support,
        },
      ]);
    }

    rows.push([backInlineButton('back_to_main')]);

    return Markup.inlineKeyboard(rows);
  }

  static getPurchaseFollowUpKeyboard(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    return Markup.inlineKeyboard([[backInlineButton('back_to_main')]]);
  }

  static getProfileMenu(i18n: I18nService, lang: SupportedLanguage = 'ru') {
    const cacheKey = `profile_${lang}`;
    const cached = getCachedKeyboard(cacheKey);
    if (cached) return cached;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          i18n.t('profile.purchases', lang),
          'my_purchases',
        ),
      ],
      [backInlineButton('back_to_main')],
    ]);

    setCachedKeyboard(cacheKey, keyboard);
    return keyboard;
  }

  static getAgreementKeyboard(
    lang: SupportedLanguage = 'ru',
    i18n?: I18nService,
  ) {
    const cacheKey = `agreement_${lang}_${i18n ? 'i18n' : 'default'}`;
    const cached = getCachedKeyboard(cacheKey);
    if (cached) return cached;

    const rulesUrl = trimUrl(process.env.AGREEMENT_URL);
    const privacyUrl = trimUrl(process.env.PRIVACY_POLICY_URL);
    const rows: any[][] = [];

    const docsRow: any[] = [];
    if (rulesUrl) {
      docsRow.push({
        text: i18n ? i18n.t('menu.info.btn.rules', lang) : 'Правила',
        url: rulesUrl,
        icon_custom_emoji_id: INFO_MENU_CUSTOM_EMOJI.rules,
      });
    }
    if (privacyUrl) {
      docsRow.push({
        text: i18n ? i18n.t('menu.info.btn.privacy', lang) : 'Конфиденциальность',
        url: privacyUrl,
        icon_custom_emoji_id: INFO_MENU_CUSTOM_EMOJI.privacy,
      });
    }
    if (docsRow.length) {
      rows.push(docsRow);
    }

    let keyboard;
    if (!i18n) {
      rows.push([Markup.button.callback('Согласен', 'accept_agreement')]);
      rows.push([Markup.button.callback('Не сейчас', 'decline_agreement')]);
      keyboard = Markup.inlineKeyboard(rows);
    } else {
      rows.push([
        Markup.button.callback(
          i18n.t('start.agreement.accept', lang),
          'accept_agreement',
        ),
      ]);
      rows.push([
        Markup.button.callback(
          i18n.t('start.agreement.decline', lang),
          'decline_agreement',
        ),
      ]);
      keyboard = Markup.inlineKeyboard(rows);
    }

    setCachedKeyboard(cacheKey, keyboard);
    return keyboard;
  }

  static getBackButton(callbackData: string = 'back_to_main') {
    return Markup.inlineKeyboard([[backInlineButton(callbackData)]]);
  }

  static getRecipientSelection(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    const cacheKey = `recipient_${lang}`;
    const cached = getCachedKeyboard(cacheKey);
    if (cached) return cached;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          i18n.t('product.recipient.other', lang),
          'recipient_other',
        ),
      ],
      [
        Markup.button.callback(
          i18n.t('product.recipient.self', lang),
          'recipient_self',
        ),
      ],
      [backInlineButton('back_to_main')],
    ]);

    setCachedKeyboard(cacheKey, keyboard);
    return keyboard;
  }

  /**
   * Выбор количества Stars: пресеты (с тем же animated emoji, что «Купить звёзды»),
   * «Свой ввод» или только «Назад» в режиме ручного ввода.
   */
  static getStarsQuantityKeyboard(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
    minStars: number,
    maxStars: number,
    mode: 'pick' | 'manual' = 'pick',
  ) {
    if (mode === 'manual') {
      return Markup.inlineKeyboard([[backInlineButton('back_to_recipient')]]);
    }

    const presetSet = new Set<number>();
    for (const n of STARS_QTY_PRESETS) {
      if (
        n >= minStars &&
        n <= maxStars &&
        n <= STARS_QTY_PRESET_CAP
      ) {
        presetSet.add(n);
      }
    }
    if (minStars <= maxStars && minStars <= STARS_QTY_PRESET_CAP) {
      presetSet.add(minStars);
    }

    const merged = [...presetSet]
      .sort((a, b) => a - b)
      .slice(0, 6);
    const rows: any[][] = [];

    for (let i = 0; i < merged.length; i += 2) {
      const chunk = merged.slice(i, i + 2);
      rows.push(
        chunk.map((n) => ({
          text: n.toLocaleString('ru-RU'),
          callback_data: `stars_qty_${n}`,
          icon_custom_emoji_id: MAIN_MENU_CUSTOM_EMOJI.stars,
        })),
      );
    }

    rows.push([
      {
        text: i18n.t('product.quantity.stars.manual_btn', lang),
        callback_data: 'stars_qty_manual',
        icon_custom_emoji_id: STARS_QTY_MANUAL_CUSTOM_EMOJI_ID,
      },
    ]);
    rows.push([backInlineButton('back_to_recipient')]);

    return Markup.inlineKeyboard(rows);
  }

  static getPremiumDurationKeyboard(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    const cacheKey = `premium_dur_${lang}`;
    const cached = getCachedKeyboard(cacheKey);
    if (cached) return cached;

    const getDurationLabel = (months: number) => {
      const specificKey = `product.premium.duration.${months}`;
      const text = i18n.t(specificKey, lang);
      return text === specificKey
        ? i18n.t('product.premium.duration', lang, { months })
        : text;
    };

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(getDurationLabel(3), 'premium_duration_3')],
      [Markup.button.callback(getDurationLabel(6), 'premium_duration_6')],
      [Markup.button.callback(getDurationLabel(12), 'premium_duration_12')],
      [backInlineButton('back_to_recipient')],
    ]);

    setCachedKeyboard(cacheKey, keyboard);
    return keyboard;
  }

  static getPaymentMethodKeyboard(
    prices: any,
    tonAmount: number,
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
    enabledMethods?: string[],
    sbpLimitRub: number = 300000,
    actionPrefix: string = 'payment',
    backAction: string = 'back_to_quantity',
  ) {
    const buttons: any[] = [];

    const isEnabled = (method: string) =>
      !enabledMethods || enabledMethods.includes(method);

    const methodOrder = enabledMethods || ['PLATEGA', 'HELEKET', 'TON'];

    for (const method of methodOrder) {
      if (!isEnabled(method)) continue;

      switch (method) {
        case 'PLATEGA':
          if (prices.platega) {
            buttons.push([
              Markup.button.callback(
                `${i18n.t('payment.method.platega', lang)} — ${prices.platega.rub.toFixed(2)} ₽`,
                `${actionPrefix}_platega`,
              ),
            ]);
          }
          break;

        case 'HELEKET':
          if (prices.heleket) {
            buttons.push([
              Markup.button.callback(
                `${i18n.t('payment.method.heleket', lang)} — ${prices.heleket.usd.toFixed(2)} $`,
                `${actionPrefix}_heleket`,
              ),
            ]);
          }
          break;

        case 'TON':
          buttons.push([
            Markup.button.callback(
              `${i18n.t('payment.method.ton', lang)} — ${tonAmount.toFixed(2)} TON`,
              `${actionPrefix}_ton`,
            ),
          ]);
          break;
      }
    }

    buttons.push([backInlineButton(backAction)]);

    return Markup.inlineKeyboard(buttons);
  }

  static getMyPurchasesKeyboard(
    payments: any[],
    filter: string = 'all',
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
    page: number = 0,
    hasMore: boolean = false,
  ) {
    const paymentButtons = payments.map((payment) => {
      const fq = payment.fragment_queue?.[0];
      const deliveryPending =
        payment.status === 'COMPLETED' &&
        fq &&
        (fq.status === 'PENDING' || fq.status === 'PROCESSING');
      const deliveryFailed =
        payment.status === 'COMPLETED' && fq && fq.status === 'FAILED';

      let statusEmoji: string;
      let statusText: string;
      if (payment.status === 'CANCELLED') {
        statusEmoji = '❌';
        statusText = i18n.t('purchases.status.cancelled', lang);
      } else if (payment.status === 'FAILED') {
        statusEmoji = '🔴';
        statusText = i18n.t('purchases.status.failed', lang);
      } else if (
        payment.status === 'PENDING' ||
        payment.status === 'PROCESSING'
      ) {
        statusEmoji = '⏳';
        statusText = i18n.t('purchases.status.processing', lang);
      } else if (deliveryPending) {
        statusEmoji = '⏳';
        statusText = i18n.t('purchases.status.delivering', lang);
      } else if (deliveryFailed) {
        statusEmoji = '⏳';
        statusText = i18n.t('purchases.status.delivering', lang);
      } else {
        statusEmoji = '✅';
        statusText = i18n.t('purchases.status.completed', lang);
      }
      const productEmoji = getProductEmoji(payment.product_type);

      let amountText: string;
      if (payment.payment_method === 'TON' && payment.amount_ton) {
        amountText = `${Number(payment.amount_ton).toFixed(4)} TON`;
      } else if (payment.payment_method === 'TON' && payment.amount_usd) {
        amountText = `$${Number(payment.amount_usd).toFixed(2)}`;
      } else if (payment.payment_method === 'HELEKET' && payment.amount_usd) {
        amountText = `$${Number(payment.amount_usd).toFixed(2)}`;
      } else {
        amountText = `${Number(payment.amount_rub).toFixed(2)} ₽`;
      }

      let productLabel: string;
      if (payment.product_type === 'STARS') {
        productLabel = `⭐ ${payment.product_quantity} Stars`;
      } else if (payment.product_type === 'TON') {
        productLabel = `💎 ${payment.product_quantity} TON`;
      } else if (payment.product_type === 'PREMIUM') {
        productLabel = `👑 Premium`;
      } else {
        productLabel = `${productEmoji} ${payment.product_type} x${payment.product_quantity}`;
      }

      return [
        Markup.button.callback(
          `${statusEmoji} ${productLabel} — ${amountText} (${statusText})`,
          `payment_details_${payment.id}`,
        ),
      ];
    });

    const filterButtons = [
      Markup.button.callback(
        filter === 'all'
          ? i18n.t('purchases.filter.all.active', lang)
          : i18n.t('purchases.filter.all', lang),
        'purchases_filter_all',
      ),
      Markup.button.callback(
        filter === 'completed'
          ? i18n.t('purchases.filter.completed.active', lang)
          : i18n.t('purchases.filter.completed', lang),
        'purchases_filter_completed',
      ),
      Markup.button.callback(
        filter === 'failed'
          ? i18n.t('purchases.filter.failed.active', lang)
          : i18n.t('purchases.filter.failed', lang),
        'purchases_filter_failed',
      ),
    ];

    const navigationButtons = [];
    if (page > 0 || hasMore) {
      const navRow = [];
      if (page > 0) {
        navRow.push(backInlineButton(`purchases_page_${filter}_${page - 1}`));
      }
      if (hasMore) {
        navRow.push(
          Markup.button.callback(
            'Вперёд ➡️',
            `purchases_page_${filter}_${page + 1}`,
          ),
        );
      }
      navigationButtons.push(navRow);
    }

    return Markup.inlineKeyboard([
      ...paymentButtons,
      filterButtons,
      ...navigationButtons,
      [backInlineButton('my_profile')],
    ]);
  }

  static getTonWalletsKeyboard(
    tonLink: string,
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    const match = tonLink.match(/ton:\/\/transfer\/([^?]+)(?:\?(.+))?/);
    if (!match) {
      return Markup.inlineKeyboard([
        [Markup.button.url(i18n.t('payment.ton.wallets', lang), tonLink)],
        [Markup.button.url(i18n.t('payment.ton.tonkeeper', lang), tonLink)],
        [Markup.button.url(i18n.t('payment.ton.tonhub', lang), tonLink)],
        [backInlineButton('back_to_main')],
      ]);
    }

    const address = match[1];
    const queryString = match[2] || '';
    const params = new URLSearchParams(queryString);
    const amount = params.get('amount') || '';
    const text = params.get('text') || '';

    const queryParams = new URLSearchParams();
    if (amount) queryParams.set('amount', amount);
    if (text) queryParams.set('text', text);

    const tonkeeperQueryParams = new URLSearchParams();
    if (amount) tonkeeperQueryParams.set('amount', amount);
    if (text) tonkeeperQueryParams.set('text', text);
    const tonkeeperQueryStr = tonkeeperQueryParams.toString();

    const amountTon = amount ? (parseInt(amount, 10) / 1e9).toFixed(9) : '';
    const tonhubQueryParams = new URLSearchParams();
    if (amountTon) tonhubQueryParams.set('amount', amountTon);
    if (text) tonhubQueryParams.set('text', text);
    const tonhubQueryStr = tonhubQueryParams.toString();

    const tonkeeperLink = `https://app.tonkeeper.com/transfer/${address}${tonkeeperQueryStr ? `?${tonkeeperQueryStr}` : ''}`;
    const tonhubLink = `https://tonhub.com/transfer/${address}${tonhubQueryStr ? `?${tonhubQueryStr}` : ''}`;

    return Markup.inlineKeyboard([
      [Markup.button.url(i18n.t('payment.ton.wallets', lang), tonLink)],
      [Markup.button.url(i18n.t('payment.ton.tonkeeper', lang), tonkeeperLink)],
      [Markup.button.url(i18n.t('payment.ton.tonhub', lang), tonhubLink)],
      [backInlineButton('back_to_main')],
    ]);
  }

  static getPaymentUrlKeyboard(
    paymentUrl: string,
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    return Markup.inlineKeyboard([
      [Markup.button.url(i18n.t('payment.pay', lang), paymentUrl)],
      [backInlineButton('back_to_main')],
    ]);
  }

  static getPaymentDetailsKeyboard(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    return Markup.inlineKeyboard([[backInlineButton('my_purchases')]]);
  }
}
