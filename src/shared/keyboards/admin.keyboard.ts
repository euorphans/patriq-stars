import { Markup } from 'telegraf';
import {
  formatShortDateTimeMoscow,
  formatShortDateMoscow,
} from '@/shared/utils';
import { backInlineButton } from '@/shared/keyboards/back-inline-button';

export class AdminKeyboard {
  static getMainMenu(showCloseButton: boolean = false) {
    const buttons = [];

    buttons.push([
      Markup.button.callback('💳 Платежные системы', 'payment_systems'),
      Markup.button.callback('💰 Наша наценка', 'service_markup'),
    ]);
    buttons.push([
      Markup.button.callback('🔀 Методы оплаты', 'payment_methods_toggle'),
      Markup.button.callback('🔄 Failover', 'failover_settings'),
    ]);
    buttons.push([
      Markup.button.callback('🛡 Защита курса', 'rate_protection'),
      Markup.button.callback('📏 Лимиты покупки', 'purchase_limits'),
    ]);
    buttons.push([Markup.button.callback('📢 Рассылка', 'admin_broadcast')]);
    buttons.push([Markup.button.callback('📺 Каналы', 'channels_menu')]);
    buttons.push([
      Markup.button.callback('🚫 Блокировка пользователя', 'admin_blocking'),
      Markup.button.callback('🔍 Поиск', 'admin_search'),
    ]);
    buttons.push([
      Markup.button.callback(
        '❗️ Застрявшие платежи',
        'admin_failed_deliveries',
      ),
    ]);
    buttons.push([
      Markup.button.callback('🕵️ Поймать мошенника', 'admin_fraud'),
    ]);
    buttons.push([
      Markup.button.callback('🧩 Fragment аккаунты', 'fragment_accounts'),
    ]);
    buttons.push([Markup.button.callback('🟢 Остановить бота', 'toggle_bot')]);
    buttons.push([Markup.button.callback('📊 Статистика', 'admin_stats')]);

    if (showCloseButton) {
      buttons.push([Markup.button.callback('❌ Закрыть', 'admin_close')]);
    }

    return Markup.inlineKeyboard(buttons);
  }

  static getBroadcastSubmenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📤 Отправить рассылку', 'broadcast_start')],
      [Markup.button.callback('📋 Шаблоны кнопок', 'btn_tpl_list')],
      [backInlineButton('admin_back')],
    ]);
  }

  static getBroadcastAudienceMenu() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '👥 Всем пользователям',
          'broadcast_audience_all',
        ),
      ],
      [
        Markup.button.callback(
          '⭐ Только Premium',
          'broadcast_audience_premium',
        ),
      ],
      [
        Markup.button.callback(
          '👤 Без Premium',
          'broadcast_audience_non_premium',
        ),
      ],
      [Markup.button.callback('❌ Отменить', 'broadcast_cancel')],
    ]);
  }

  static getChannelsSubmenu() {
    const buttons: any[][] = [
      [Markup.button.callback('📺 Каналы подписки', 'admin_channels')],
      [Markup.button.callback('📊 Каналы продаж', 'sales_channels')],
      [
        Markup.button.callback(
          '💰 Порог уведомлений о продажах (₽)',
          'sales_notification_min_rub',
        ),
      ],
      [
        Markup.button.callback(
          '⚠️ Каналы недостатка средств',
          'insufficient_funds_channels',
        ),
      ],
      [Markup.button.callback('🚨 Канал мошенников', 'fraud_channels')],
      [backInlineButton('admin_back')],
    ];
    return Markup.inlineKeyboard(buttons);
  }

  static getStatsMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('📅 Статистика за период', 'stats_period')],
      [Markup.button.callback('🔄 Обновить', 'stats_refresh')],
      [backInlineButton('admin_back')],
    ]);
  }

  static getChannelsMenu(channels: any[] = []) {
    const buttons = [];

    if (channels.length > 0) {
      buttons.push([
        Markup.button.callback('➕ Добавить канал', 'channel_add'),
      ]);
      buttons.push([
        Markup.button.callback('➖ Удалить канал', 'channel_remove'),
      ]);
    } else {
      buttons.push([
        Markup.button.callback('➕ Добавить канал', 'channel_add'),
      ]);
    }

    buttons.push([backInlineButton('channels_menu')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getChannelDeleteMenu(channels: any[]) {
    const buttons = channels.map((channel) => [
      Markup.button.callback(
        `🗑 ${channel.channel_name || channel.channel_id}`,
        `channel_delete_${channel.channel_id}`,
      ),
    ]);
    buttons.push([backInlineButton('admin_channels')]);
    return Markup.inlineKeyboard(buttons);
  }

  static getBroadcastConfirm(showSendAll: boolean = false) {
    const buttons = [];

    buttons.push([
      Markup.button.callback('🧪 Тест (только админам)', 'broadcast_test'),
    ]);

    if (showSendAll) {
      buttons.push([
        Markup.button.callback('📤 Отправить ВСЕМ', 'broadcast_send_all'),
      ]);
    }

    buttons.push([Markup.button.callback('❌ Отменить', 'broadcast_cancel')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getBroadcastButtonsMenu(
    buttons: Array<{ text: string; url: string }> = [],
    hasTemplates: boolean = false,
  ) {
    const keyboardButtons: any[] = [];

    buttons.forEach((button) => {
      keyboardButtons.push([Markup.button.url(button.text, button.url)]);
    });

    const controlButtons: any[] = [];

    if (buttons.length < 10) {
      controlButtons.push(
        Markup.button.callback('➕ Добавить кнопку', 'broadcast_add_button'),
      );
    }

    if (buttons.length > 0) {
      controlButtons.push(
        Markup.button.callback(
          '🗑 Удалить последнюю',
          'broadcast_remove_button',
        ),
      );
    }

    if (controlButtons.length > 0) {
      keyboardButtons.push(controlButtons);
    }

    if (hasTemplates) {
      keyboardButtons.push([
        Markup.button.callback(
          '📋 Добавить из шаблонов',
          'broadcast_add_from_template',
        ),
      ]);
    }

    keyboardButtons.push([
      Markup.button.callback('✅ Завершить', 'broadcast_finish_buttons'),
    ]);
    keyboardButtons.push([
      Markup.button.callback('❌ Отменить', 'broadcast_cancel'),
    ]);

    return Markup.inlineKeyboard(keyboardButtons);
  }

  static getButtonTemplatesMenu(
    templates: Array<{ id: string; name: string; buttons: any[] }> = [],
  ) {
    const buttons: any[][] = [];

    for (const tpl of templates) {
      buttons.push([
        Markup.button.callback(
          `📋 ${tpl.name} (${tpl.buttons.length} кн.)`,
          `btn_tpl_view_${tpl.id}`,
        ),
      ]);
    }

    buttons.push([
      Markup.button.callback('➕ Создать шаблон', 'btn_tpl_create'),
    ]);
    buttons.push([backInlineButton('admin_broadcast')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getButtonTemplateDetailMenu(templateId: string) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '🗑 Удалить шаблон',
          `btn_tpl_delete_${templateId}`,
        ),
      ],
      [backInlineButton('btn_tpl_list')],
    ]);
  }

  static getBroadcastSelectTemplateMenu(
    templates: Array<{ id: string; name: string; buttons: any[] }> = [],
  ) {
    const buttons: any[][] = [];

    for (const tpl of templates) {
      buttons.push([
        Markup.button.callback(
          `📋 ${tpl.name} (${tpl.buttons.length} кн.)`,
          `broadcast_use_template_${tpl.id}`,
        ),
      ]);
    }

    buttons.push([
      backInlineButton('broadcast_back_to_buttons'),
    ]);

    return Markup.inlineKeyboard(buttons);
  }

  static getBlockingMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🚫 Заблокировать пользователя', 'block_user')],
      [
        Markup.button.callback(
          '✅ Разблокировать пользователя',
          'unblock_user',
        ),
      ],
      [Markup.button.callback('🚫 Массовая блокировка', 'mass_block_user')],
      [Markup.button.callback('🔓 Снять ограничения капчи', 'captcha_unban')],
      [backInlineButton('admin_back')],
    ]);
  }

  static getSettingsMenu(
    botEnabled: boolean,
    showPaymentSystems: boolean = false,
    paymentCaptchaEnabled: boolean = true,
  ) {
    const buttons = [
      [
        Markup.button.callback(
          botEnabled ? '🟢 Бот включен' : '🔴 Бот выключен',
          'toggle_bot',
        ),
      ],
      [
        Markup.button.callback(
          paymentCaptchaEnabled
            ? '🎯 Капча перед оплатой: вкл'
            : '🎯 Капча перед оплатой: выкл',
          'toggle_payment_captcha',
        ),
      ],
    ];

    if (showPaymentSystems) {
      buttons.push([
        Markup.button.callback('💰 Комиссии и наценки', 'payment_systems'),
      ]);
    }

    buttons.push([backInlineButton('admin_back')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getPaymentSystemsMenu(freekassaFee: number, tonFee: number) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `Freekassa (${freekassaFee.toFixed(1)}%)`,
          'fee_freekassa',
        ),
      ],
      [Markup.button.callback(`TON (${tonFee.toFixed(1)}%)`, 'fee_ton')],
      [backInlineButton('admin_back')],
    ]);
  }

  static getServiceMarkupMenu(freekassaMarkup: number, tonMarkup: number) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `Freekassa (${freekassaMarkup.toFixed(1)}%)`,
          'markup_freekassa',
        ),
      ],
      [Markup.button.callback(`TON (${tonMarkup.toFixed(1)}%)`, 'markup_ton')],
      [backInlineButton('admin_back')],
    ]);
  }

  static getPaymentMethodsToggleMenu(
    methods: Array<{ method: string; enabled: boolean }>,
  ) {
    const METHOD_NAMES: Record<string, string> = {
      FREEKASSA: '💵 СБП (Freekassa)',
      FREEKASSA_CARD: '💳 Карта 5.7 (Freekassa)',
      FREEKASSA_CRYPTO: '🪙 Крипто (Freekassa)',
      TON: '💎 TON',
    };

    const buttons = methods.map((m, index) => {
      const name = METHOD_NAMES[m.method] || m.method;
      const statusEmoji = m.enabled ? '🟢' : '🔴';

      const moveButtons: any[] = [];
      if (index > 0) {
        moveButtons.push(Markup.button.callback('⬆️', `pm_up_${m.method}`));
      }
      if (index < methods.length - 1) {
        moveButtons.push(Markup.button.callback('⬇️', `pm_down_${m.method}`));
      }

      if (moveButtons.length > 0) {
        return [
          Markup.button.callback(
            `${statusEmoji} ${name}`,
            `toggle_pm_${m.method}`,
          ),
          ...moveButtons,
        ];
      }

      return [
        Markup.button.callback(
          `${statusEmoji} ${name}`,
          `toggle_pm_${m.method}`,
        ),
      ];
    });

    buttons.push([backInlineButton('admin_back')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getFailoverMenu(config: {
    failoverEnabled: boolean;
    autoRecovery: boolean;
    threshold: number;
    cooldownMinutes: number;
    failoverActive: boolean;
  }) {
    const buttons: any[][] = [];

    buttons.push([
      Markup.button.callback(
        `${config.failoverEnabled ? '✅' : '❌'} Авто-переключение`,
        'failover_toggle',
      ),
      Markup.button.callback(
        `${config.autoRecovery ? '✅' : '❌'} Авто-восстановление`,
        'failover_toggle_recovery',
      ),
    ]);

    buttons.push([
      Markup.button.callback(
        `⚠️ Порог: ${config.threshold} ошибок`,
        'failover_set_threshold',
      ),
    ]);

    buttons.push([
      Markup.button.callback(
        `⏱ Откат через: ${config.cooldownMinutes} мин`,
        'failover_set_cooldown',
      ),
    ]);

    buttons.push([backInlineButton('admin_back')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getSearchMenu() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '🔍 Поиск конкретного платежа',
          'search_specific',
        ),
      ],
      [
        Markup.button.callback(
          '📋 Поиск всех покупок пользователя',
          'search_user_purchases',
        ),
      ],
      [backInlineButton('admin_back')],
    ]);
  }

  static getSearchResultsMenu(
    payments: any[],
    currentPage: number = 0,
    totalPages: number = 1,
  ): any {
    const ITEMS_PER_PAGE = 10;
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pagePayments = payments.slice(startIndex, endIndex);

    const buttons = pagePayments.map((payment) => {
      const fq = payment.fragment_queue?.[0];

      let statusLabel: string;
      if (payment.status === 'FRAUD') {
        statusLabel = '🚨 Мошенник';
      } else if (payment.status === 'CANCELLED') {
        statusLabel = '❌ Отменён';
      } else if (payment.status === 'FAILED') {
        statusLabel = '❌ Ошибка оплаты';
      } else if (payment.status === 'REFUNDED') {
        statusLabel = '💸 Возврат';
      } else if (payment.status === 'PENDING') {
        statusLabel = '⏳ Ожидает оплаты';
      } else if (payment.status === 'PROCESSING') {
        statusLabel = '⏳ Оплата в процессе';
      } else if (fq?.status === 'FAILED') {
        statusLabel = '❌';
      } else if (fq?.status === 'PENDING') {
        statusLabel = '⏳ Доставка ожидает';
      } else if (fq?.status === 'PROCESSING') {
        statusLabel = '⏳ Доставка в процессе';
      } else {
        statusLabel = '✅';
      }

      const date = new Date(payment.created_at);
      const formattedDate = formatShortDateTimeMoscow(date);
      const recipient =
        payment.recipient_username || payment.recipient_name || 'self';
      const recipientDisplay = recipient.startsWith('@')
        ? recipient.length > 8
          ? recipient.substring(0, 8) + '...'
          : recipient
        : recipient.length > 5
          ? recipient.substring(0, 5) + '...'
          : recipient;

      const productEmoji =
        payment.product_type === 'STARS'
          ? '⭐️'
          : payment.product_type === 'TON'
            ? '💎'
            : '👑';
      const productDisplay =
        payment.product_type === 'PREMIUM'
          ? `${productEmoji} ${payment.product_quantity}м`
          : `${productEmoji} ${payment.product_quantity}`;

      const label = `${statusLabel} | ${productDisplay} → ${recipientDisplay} | #${payment.order_number} | ${formattedDate}`;

      return [Markup.button.callback(label, `payment_details_${payment.id}`)];
    });

    if (totalPages > 1) {
      const navButtons = [];
      if (currentPage > 0) {
        navButtons.push(
          backInlineButton(`payments_page_${currentPage - 1}`),
        );
      }
      navButtons.push(
        Markup.button.callback(
          `${currentPage + 1}/${totalPages}`,
          'payments_page_info',
        ),
      );
      if (currentPage < totalPages - 1) {
        navButtons.push(
          Markup.button.callback(
            'Вперёд ▶️',
            `payments_page_${currentPage + 1}`,
          ),
        );
      }
      buttons.push(navButtons);
    }

    buttons.push([backInlineButton('admin_search')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getSalesChannelsMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('➕ Добавить канал', 'sales_channel_add')],
      [Markup.button.callback('🗑 Удалить канал', 'sales_channel_remove')],
      [
        Markup.button.callback(
          '💰 Порог суммы (₽)',
          'sales_notification_min_rub',
        ),
      ],
      [backInlineButton('channels_menu')],
    ]);
  }

  static getInsufficientFundsChannelsMenu() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          '➕ Добавить канал',
          'insufficient_funds_channel_add',
        ),
      ],
      [
        Markup.button.callback(
          '🗑 Удалить канал',
          'insufficient_funds_channel_remove',
        ),
      ],
      [backInlineButton('channels_menu')],
    ]);
  }

  static getInsufficientFundsChannelDeleteMenu(channels: any[]) {
    const buttons = channels.map((ch) => [
      Markup.button.callback(
        `🗑 ${ch.channel_name || 'Без названия'}`,
        `delete_insufficient_funds_channel:${ch.channel_id}`,
      ),
    ]);
    buttons.push([backInlineButton('insufficient_funds_channels')]);
    return Markup.inlineKeyboard(buttons);
  }

  static getFraudChannelsMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('➕ Добавить канал', 'fraud_channel_add')],
      [Markup.button.callback('🗑 Удалить канал', 'fraud_channel_remove')],
      [backInlineButton('channels_menu')],
    ]);
  }

  static getFraudChannelDeleteMenu(channels: any[]) {
    const buttons = channels.map((ch) => [
      Markup.button.callback(
        `🗑 ${ch.channel_name || 'Без названия'}`,
        `delete_fraud_channel:${ch.channel_id}`,
      ),
    ]);
    buttons.push([backInlineButton('fraud_channels')]);
    return Markup.inlineKeyboard(buttons);
  }

  static getSalesChannelDeleteMenu(channels: any[]) {
    const buttons = channels.map((ch) => [
      Markup.button.callback(
        `🗑 ${ch.channel_name || 'Без названия'}`,
        `delete_sales_channel:${ch.channel_id}`,
      ),
    ]);
    buttons.push([backInlineButton('sales_channels')]);
    return Markup.inlineKeyboard(buttons);
  }

  static getRateProtectionMenu(
    minTonRate: number,
    minUsdtRate: number,
    currentTonRate: number,
    currentUsdtRate: number,
  ) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `TON: мин ${minTonRate > 0 ? minTonRate.toFixed(4) : 'откл'} USD (сейчас: ${currentTonRate.toFixed(4)})`,
          'set_min_ton_rate',
        ),
      ],
      [
        Markup.button.callback(
          `USDT: мин ${minUsdtRate > 0 ? minUsdtRate.toFixed(2) : 'откл'} RUB (сейчас: ${currentUsdtRate.toFixed(2)})`,
          'set_min_usdt_rate',
        ),
      ],
      [backInlineButton('admin_back')],
    ]);
  }

  static getPurchaseLimitsMenu(limits: {
    minStars: number;
    maxStars: number;
    minTon: number;
    maxTon: number;
    sbpLimitRub: number;
    sbpLimitStars: number;
  }) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          `⭐ Мин. звёзд: ${limits.minStars}`,
          'set_min_stars',
        ),
        Markup.button.callback(
          `⭐ Макс. звёзд: ${limits.maxStars}`,
          'set_max_stars',
        ),
      ],
      [
        Markup.button.callback(`💎 Мин. TON: ${limits.minTon}`, 'set_min_ton'),
        Markup.button.callback(`💎 Макс. TON: ${limits.maxTon}`, 'set_max_ton'),
      ],
      [
        Markup.button.callback(
          `💳 СБП лимит (₽): ${limits.sbpLimitRub.toLocaleString('ru')}`,
          'set_sbp_limit',
        ),
      ],
      [
        Markup.button.callback(
          `⭐ Макс. звёзд за 1 платёж СБП/Карта: ${limits.sbpLimitStars.toLocaleString('ru')}`,
          'set_sbp_limit_stars',
        ),
      ],
      [backInlineButton('admin_back')],
    ]);
  }

  static getBackToAdmin() {
    return Markup.inlineKeyboard([
      [backInlineButton('admin_back')],
    ]);
  }

  static getBackToBlocking() {
    return Markup.inlineKeyboard([
      [backInlineButton('admin_blocking')],
    ]);
  }

  static getBackToFraud() {
    return Markup.inlineKeyboard([
      [backInlineButton('admin_fraud')],
    ]);
  }

  static getBackToSearch() {
    return Markup.inlineKeyboard([
      [backInlineButton('admin_search')],
    ]);
  }

  static getBackToPaymentSystems() {
    return Markup.inlineKeyboard([
      [backInlineButton('payment_systems')],
    ]);
  }

  static getBackToServiceMarkup() {
    return Markup.inlineKeyboard([
      [backInlineButton('service_markup')],
    ]);
  }

  static getBackToFailover() {
    return Markup.inlineKeyboard([
      [backInlineButton('failover_settings')],
    ]);
  }

  static getBackToRateProtection() {
    return Markup.inlineKeyboard([
      [backInlineButton('rate_protection')],
    ]);
  }

  static getBackToStats() {
    return Markup.inlineKeyboard([
      [backInlineButton('admin_stats')],
    ]);
  }

  static getFraudMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('➕ Добавить мошенника', 'fraud_add')],
      [Markup.button.callback('➖ Убрать из мошенников', 'fraud_unban')],
      [Markup.button.callback('📋 Список мошенников', 'fraud_list')],
      [Markup.button.callback('⚙️ Настройки автоловли', 'fraud_settings')],
      [backInlineButton('admin_back')],
    ]);
  }

  static getFraudSettingsMenu(settings: {
    phoneFraudEnabled: boolean;
    phoneFraudMinAmount: number;
    cardFraudEnabled: boolean;
    cardFraudMinAmount: number;
    cancellationFraudEnabled: boolean;
    cancellationFraudMinAmount: number;
  }) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          settings.phoneFraudEnabled
            ? '🟢 Разные номера: Вкл'
            : '🔴 Разные номера: Выкл',
          'toggle_phone_fraud',
        ),
      ],
      [
        Markup.button.callback(
          `💰 Мин. сумма (номера): ${settings.phoneFraudMinAmount} ₽`,
          'set_phone_fraud_amount',
        ),
      ],
      [
        Markup.button.callback(
          settings.cardFraudEnabled
            ? '🟢 Разные карты: Вкл'
            : '🔴 Разные карты: Выкл',
          'toggle_card_fraud',
        ),
      ],
      [
        Markup.button.callback(
          `💰 Мин. сумма (карты): ${settings.cardFraudMinAmount} ₽`,
          'set_card_fraud_amount',
        ),
      ],
      [
        Markup.button.callback(
          settings.cancellationFraudEnabled
            ? '🟢 3 отмены подряд: Вкл'
            : '🔴 3 отмены подряд: Выкл',
          'toggle_cancellation_fraud',
        ),
      ],
      [
        Markup.button.callback(
          `💰 Мин. сумма (отмены): ${settings.cancellationFraudMinAmount} ₽`,
          'set_cancellation_fraud_amount',
        ),
      ],
      [backInlineButton('admin_fraud')],
    ]);
  }

  static getFailedDeliveriesMenu(
    payments: any[],
    currentPage: number = 0,
    totalPages: number = 1,
  ): any {
    if (isNaN(currentPage) || currentPage < 0) {
      console.warn(`Invalid currentPage: ${currentPage}, resetting to 0`);
      currentPage = 0;
    }

    const ITEMS_PER_PAGE = 10;
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pagePayments = payments.slice(startIndex, endIndex);

    const buttons = pagePayments.map((payment) => {
      const productEmoji =
        payment.product_type === 'STARS'
          ? '⭐️'
          : payment.product_type === 'TON'
            ? '💎'
            : '👑';
      const date = new Date(payment.created_at);
      const formattedDate = formatShortDateTimeMoscow(date);
      const recipient =
        payment.recipient_username || payment.recipient_name || 'self';
      const recipientDisplay = recipient.startsWith('@')
        ? recipient.length > 8
          ? recipient.substring(0, 8) + '...'
          : recipient
        : recipient.length > 5
          ? recipient.substring(0, 5) + '...'
          : recipient;

      const productDisplay =
        payment.product_type === 'PREMIUM'
          ? `${productEmoji} ${payment.product_quantity}м`
          : `${productEmoji} ${payment.product_quantity}`;

      const amountDisplay =
        payment.payment_method === 'TON'
          ? `${Number(payment.amount_ton || 0).toFixed(2)} TON`
          : `${Number(payment.amount_rub || 0).toFixed(0)}₽`;

      let statusEmoji = '❗️';

      const fq = payment.fragment_queue?.[0];
      if (!fq) {
        statusEmoji = '🚫';
      } else if (fq.status === 'FAILED') {
        statusEmoji = '❌';
      } else if (fq.status === 'PROCESSING') {
        statusEmoji = '📦⏳';
      }

      const label = `${statusEmoji} ${productDisplay} → ${recipientDisplay} | ${amountDisplay} | ${formattedDate}`;

      return [Markup.button.callback(label, `payment_details_${payment.id}`)];
    });

    if (totalPages > 1) {
      const navButtons = [];
      if (currentPage > 0) {
        navButtons.push(
          backInlineButton(`failed_deliveries_page_${currentPage - 1}`),
        );
      }
      navButtons.push(
        Markup.button.callback(
          `${currentPage + 1}/${totalPages}`,
          'failed_deliveries_page_info',
        ),
      );
      if (currentPage < totalPages - 1) {
        navButtons.push(
          Markup.button.callback(
            'Вперёд ▶️',
            `failed_deliveries_page_${currentPage + 1}`,
          ),
        );
      }
      buttons.push(navButtons);
    }

    buttons.push([
      Markup.button.callback('📥 Экспорт ID транзакций', 'export_stuck_txids'),
    ]);
    buttons.push([
      Markup.button.callback('🔄 Обновить', 'admin_failed_deliveries'),
    ]);
    buttons.push([backInlineButton('admin_back')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getFraudListMenu(
    fraudsters: any[],
    currentPage: number = 0,
    totalPages: number = 1,
  ): any {
    const ITEMS_PER_PAGE = 10;
    const startIndex = currentPage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageFraudsters = fraudsters.slice(startIndex, endIndex);

    const buttons = pageFraudsters.map((fraud) => {
      const identifier = fraud.telegram_id
        ? `ID: ${fraud.telegram_id}`
        : fraud.username
          ? `@${fraud.username}`
          : 'Неизвестен';

      const date = new Date(fraud.created_at);
      const formattedDate = formatShortDateMoscow(date);

      const label = `🚫 ${identifier} | ${formattedDate}`;

      return [Markup.button.callback(label, `fraud_remove_${fraud.id}`)];
    });

    if (totalPages > 1) {
      const navButtons = [];
      if (currentPage > 0) {
        navButtons.push(
          backInlineButton(`fraud_page_${currentPage - 1}`),
        );
      }
      navButtons.push(
        Markup.button.callback(
          `${currentPage + 1}/${totalPages}`,
          'fraud_page_info',
        ),
      );
      if (currentPage < totalPages - 1) {
        navButtons.push(
          Markup.button.callback('Вперёд ▶️', `fraud_page_${currentPage + 1}`),
        );
      }
      buttons.push(navButtons);
    }

    buttons.push([Markup.button.callback('📥 Скачать список', 'fraud_export')]);
    buttons.push([backInlineButton('admin_fraud')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getFragmentAccountsMenu(
    accounts: Array<{
      id: string;
      name: string;
      is_active: boolean;
      queue_count: number;
    }>,
  ) {
    const buttons = [];

    for (const acc of accounts) {
      const statusIcon = acc.is_active ? '🟢' : '🔴';
      const queueInfo = acc.queue_count > 0 ? ` (📦${acc.queue_count})` : '';
      buttons.push([
        Markup.button.callback(
          `${statusIcon} ${acc.name}${queueInfo}`,
          `frag_acc_${acc.id}`,
        ),
      ]);
    }

    buttons.push([
      Markup.button.callback('➕ Добавить аккаунт', 'frag_acc_add'),
    ]);
    buttons.push([
      Markup.button.callback('🔍 Проверить все аккаунты', 'frag_acc_check_all'),
    ]);
    buttons.push([backInlineButton('admin_back')]);

    return Markup.inlineKeyboard(buttons);
  }

  static getFragmentAccountDetail(accountId: string, isActive: boolean) {
    const toggleText = isActive ? '🔴 Отключить' : '🟢 Включить';

    return Markup.inlineKeyboard([
      [Markup.button.callback(toggleText, `frag_acc_toggle_${accountId}`)],
      [
        Markup.button.callback(
          '🔑 Обновить токены',
          `frag_acc_update_${accountId}`,
        ),
      ],
      [Markup.button.callback('🗑 Удалить', `frag_acc_delete_${accountId}`)],
      [backInlineButton('fragment_accounts')],
    ]);
  }
}
