import { Markup } from 'telegraf';
import { getProductEmoji } from '@/shared/utils';
import {
  I18nService,
  SupportedLanguage,
} from '@/shared/services/i18n/i18n.service';

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

  static getMainMenuAdmin(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    /** Аккаунт и помощь сверху, затем каталог столбцом — другой порядок, чем типичная «витрина». */
    const rows: any[] = [
      [{ text: i18n.t('menu.main.profile', lang), callback_data: 'my_profile' }],
      [
        {
          text: i18n.t('menu.main.support', lang),
          url: 'https://t.me/Mops_Support',
        },
      ],
      [{ text: i18n.t('menu.main.stars', lang), callback_data: 'buy_stars' }],
      [
        { text: i18n.t('menu.main.premium', lang), callback_data: 'buy_premium' },
        { text: i18n.t('menu.main.ton', lang), callback_data: 'buy_ton' },
      ],
      [
        {
          text: i18n.t('menu.main.mops_balance', lang),
          callback_data: 'mops_balance',
        },
      ],
    ];

    return { reply_markup: { inline_keyboard: rows } };
  }

  static getMainMenu(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    const cacheKey = `main_${lang}`;
    const cached = getCachedKeyboard(cacheKey);
    if (cached) return cached;

    const rows: any[] = [
      [{ text: i18n.t('menu.main.profile', lang), callback_data: 'my_profile' }],
      [
        {
          text: i18n.t('menu.main.support', lang),
          url: 'https://t.me/Mops_Support',
        },
      ],
      [{ text: i18n.t('menu.main.stars', lang), callback_data: 'buy_stars' }],
      [
        { text: i18n.t('menu.main.premium', lang), callback_data: 'buy_premium' },
        { text: i18n.t('menu.main.ton', lang), callback_data: 'buy_ton' },
      ],
      [
        {
          text: i18n.t('menu.main.mops_balance', lang),
          callback_data: 'mops_balance',
        },
      ],
    ];

    const keyboard = { reply_markup: { inline_keyboard: rows } };
    setCachedKeyboard(cacheKey, keyboard);
    return keyboard;
  }

  static getMopsPurchaseSuccessKeyboard(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          i18n.t('referral.button', lang),
          'referral_program',
        ),
      ],
      [
        Markup.button.callback(
          i18n.t('mops_coin.balance_btn', lang),
          'mops_balance',
        ),
      ],
      [Markup.button.callback(i18n.t('common.back', lang), 'back_to_main')],
    ]);
  }

  static getReferralMenu(i18n: I18nService, lang: SupportedLanguage = 'ru') {
    return Markup.inlineKeyboard([
      [Markup.button.callback(i18n.t('common.back', lang), 'mops_balance')],
    ]);
  }

  static getMopsBalanceMenu(i18n: I18nService, lang: SupportedLanguage = 'ru') {
    const rows: any[][] = [
      [{
        text: i18n.t('mops_coin.daily_bonus_btn', lang),
        callback_data: 'mops_daily_bonus',
      }],
      [{
        text: i18n.t('mops_coin.referral_btn', lang),
        callback_data: 'mops_referral',
      }],
      [{
        text: i18n.t('mops_coin.what_is', lang),
        callback_data: 'mops_coin_info',
      }],
      [{ text: i18n.t('common.back', lang), callback_data: 'back_to_main' }],
    ];
    return { reply_markup: { inline_keyboard: rows } };
  }

  static getMopsCoinInfoMenu(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    return Markup.inlineKeyboard([
      [Markup.button.callback(i18n.t('common.back', lang), 'mops_balance')],
    ]);
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
      [
        Markup.button.callback(
          i18n.t('profile.public_offer', lang),
          'public_offer',
        ),
      ],
      [Markup.button.callback(i18n.t('common.back', lang), 'back_to_main')],
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

    let keyboard;
    if (!i18n) {
      keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Согласен', 'accept_agreement')],
        [Markup.button.callback('Не сейчас', 'decline_agreement')],
      ]);
    } else {
      keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            i18n.t('start.agreement.accept', lang),
            'accept_agreement',
          ),
        ],
        [
          Markup.button.callback(
            i18n.t('start.agreement.decline', lang),
            'decline_agreement',
          ),
        ],
      ]);
    }

    setCachedKeyboard(cacheKey, keyboard);
    return keyboard;
  }

  static getBackButton(
    callbackData: string = 'back_to_main',
    i18n?: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    const backText = i18n ? i18n.t('common.back', lang) : '◀ Выйти';
    return Markup.inlineKeyboard([
      [Markup.button.callback(backText, callbackData)],
    ]);
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
      [Markup.button.callback(i18n.t('common.back', lang), 'back_to_main')],
    ]);

    setCachedKeyboard(cacheKey, keyboard);
    return keyboard;
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
      [
        Markup.button.callback(
          i18n.t('common.back', lang),
          'back_to_recipient',
        ),
      ],
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

    buttons.push([
      Markup.button.callback(i18n.t('common.back', lang), backAction),
    ]);

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
        navRow.push(
          Markup.button.callback(
            '⬅️ Назад',
            `purchases_page_${filter}_${page - 1}`,
          ),
        );
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
      [Markup.button.callback(i18n.t('common.back', lang), 'my_profile')],
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
        [Markup.button.callback(i18n.t('common.back', lang), 'back_to_main')],
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
      [Markup.button.callback(i18n.t('common.back', lang), 'back_to_main')],
    ]);
  }

  static getPaymentUrlKeyboard(
    paymentUrl: string,
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
  ) {
    return Markup.inlineKeyboard([
      [Markup.button.url(i18n.t('payment.pay', lang), paymentUrl)],
      [Markup.button.callback(i18n.t('common.back', lang), 'back_to_main')],
    ]);
  }

  static getPaymentDetailsKeyboard(
    i18n: I18nService,
    lang: SupportedLanguage = 'ru',
    withSupport: boolean = true,
  ) {
    const buttons: any[] = [
      [
        Markup.button.callback(
          i18n.t('purchases.details.back', lang),
          'my_purchases',
        ),
      ],
    ];

    if (withSupport) {
      const supportUrl = process.env.SUPPORT_URL || 'https://t.me/Mops_Support';
      buttons.push([
        Markup.button.url(i18n.t('menu.main.support', lang), supportUrl),
      ]);
    }

    return Markup.inlineKeyboard(buttons);
  }
}
