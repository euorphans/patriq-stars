import { ProductType } from '@prisma/client';

export function computeMopsCoinsForPayment(
  product_type: ProductType,
  product_quantity: string,
): number {
  switch (product_type) {
    case 'STARS': {
      const n = parseFloat(product_quantity);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.floor(n);
    }
    case 'TON': {
      const n = parseFloat(product_quantity);
      if (!Number.isFinite(n) || n <= 0) return 0;
      return Math.round(n * 100);
    }
    case 'PREMIUM': {
      const m = parseInt(product_quantity, 10);
      if (m === 3) return 1000;
      if (m === 6) return 1500;
      if (m === 12) return 3000;
      return 0;
    }
    default:
      return 0;
  }
}
