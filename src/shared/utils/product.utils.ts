export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function getProductName(payment: {
  product_type: string;
  product_quantity: string | number;
}): string {
  switch (payment.product_type) {
    case 'STARS':
      return `⭐️ ${payment.product_quantity} Stars`;
    case 'TON':
      return `💎 ${payment.product_quantity} TON`;
    case 'PREMIUM':
      return `👑 Telegram Premium на ${payment.product_quantity} месяцев`;
    default:
      return 'Товар';
  }
}

export function getProductEmoji(productType: string): string {
  switch (productType) {
    case 'STARS':
      return '⭐️';
    case 'TON':
      return '💎';
    case 'PREMIUM':
      return '👑';
    default:
      return '📦';
  }
}
