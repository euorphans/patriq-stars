import { Context } from 'telegraf';

export interface SessionData {
  productType?: 'stars' | 'ton' | 'premium';
  recipientUsername?: string;
  recipientName?: string;
  quantity?: number;
  paymentMethod?: 'platega' | 'heleket' | 'ton';
  isForSelf?: boolean;
  isAnonymous?: boolean;
  awaitingUsername?: boolean;
  awaitingQuantity?: boolean;

  awaitingBroadcast?: boolean;
  awaitingPaymentSearch?: boolean;
  searchUserPurchases?: boolean;
  awaitingBlockUser?: boolean;
  awaitingUnblockUser?: boolean;
  awaitingMassBlock?: boolean;
  awaitingStatsStartDate?: boolean;
  awaitingStatsEndDate?: boolean;
  awaitingServiceMarkup?: boolean;
  serviceMarkupSystem?: string;
  awaitingPaymentFee?: boolean;
  paymentFeeSystem?: string;
  fromAdminSearch?: boolean;
  fromFailedDeliveries?: boolean;
  failedDeliveriesPage?: number;
  awaitingStuckPaymentUsername?: boolean;
  pendingStuckPaymentId?: string;
  lastBotMessageId?: number;
  awaitingSalesChannel?: boolean;
  awaitingSalesNotificationMinRub?: boolean;
  awaitingInsufficientFundsChannel?: boolean;
  awaitingFraudChannel?: boolean;
  awaitingChannel?: boolean;
  awaitingChannelInviteLink?: boolean;
  pendingChannelId?: string;
  pendingChannelName?: string;
  awaitingMinTonRate?: boolean;
  awaitingMinUsdtRate?: boolean;
  awaitingPurchaseLimit?: boolean;
  pendingPurchaseLimitField?:
    | 'minStars'
    | 'maxStars'
    | 'minTon'
    | 'maxTon'
    | 'sbpLimitRub'
    | 'sbpLimitStars';
  awaitingFraudAmount?: boolean;
  pendingFraudAmountField?:
    | 'phoneFraudMinAmount'
    | 'cardFraudMinAmount'
    | 'cancellationFraudMinAmount';
  awaitingFraudUser?: boolean;
  awaitingFraudUnban?: boolean;
  fraudList?: any[];
  fraudCurrentPage?: number;
  isAdmin?: boolean;
  searchQuery?: string;
  searchResults?: any[];
  currentPage?: number;
  statsStartDate?: string;
  statsEndDate?: string;
  broadcastMessage?: string;
  broadcastPhoto?: string;
  broadcastPhotoFileId?: string;
  broadcastAnimation?: string;
  broadcastAnimationFileId?: string;
  broadcastVideo?: string;
  broadcastVideoFileId?: string;
  broadcastSticker?: string;
  broadcastStickerFileId?: string;
  broadcastAudio?: string;
  broadcastAudioFileId?: string;
  broadcastCaption?: string;
  broadcastMessageId?: number;
  broadcastFromChatId?: string;
  broadcastEntities?: any[];
  broadcastCaptionEntities?: any[];
  broadcastButtons?: Array<{ text: string; url: string }>;
  awaitingBroadcastButton?: boolean;
  currentBroadcastButtonText?: string;
  awaitingButtonTemplateName?: boolean;
  pendingButtonTemplateButtons?: Array<{ text: string; url: string }>;
  buttonTemplateEditId?: string;
  lastBroadcastStats?: {
    total: number;
    success: number;
    failed: number;
    date: string;
  };
  pendingDeepLink?: string;
  currentImage?: string;
  userLang?: 'ru';
  isBan?: boolean;

  awaitingFragmentAccountName?: boolean;
  awaitingFragmentAccountTokens?: boolean;
  awaitingFragmentAccountUpdate?: boolean;
  pendingFragmentAccountName?: string;
  pendingFragmentAccountId?: string;

  awaitingGiftAccountProxy?: boolean;
  awaitingGiftAccountPhone?: boolean;
  awaitingGiftAccountCode?: boolean;
  awaitingGiftAccountPassword?: boolean;
  pendingGiftAccountPhone?: string;
  pendingGiftAccountHash?: string;
  pendingGiftAccountProxy?: {
    host: string;
    port: number;
    type: string | null;
    username: string | null;
    password: string | null;
  };
  awaitingGiftProxyInput?: string;
  awaitingGiftProxyExpiry?: string;
  awaitingGiftNote?: string;

  awaitingFailoverThreshold?: boolean;
  awaitingFailoverCooldown?: boolean;

  subscriptionCheckedAt?: number;

  captchaCorrectKey?: string;
  captchaOptions?: string[];
  pendingPaymentMethod?:
    | 'platega'
    | 'heleket'
    | 'ton'
    | 'sbp2'
    | 'aurapay_sbp'
    | 'aurapay_card';
  awaitingCaptchaUnban?: boolean;

  // Broadcast target audience (Task 71)
  broadcastTargetAudience?: 'all' | 'premium' | 'non_premium';

}

export interface BotContext extends Context {
  session: SessionData;
  match?: RegExpExecArray | null;
  dbUser?: any;
}
