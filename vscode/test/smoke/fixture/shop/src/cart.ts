import { Item } from './item';
export const TAX = 0.21;

// totals in integer cents
export function total(items: Item[]): number {
  return items.reduce((s, i) => s + i.cents, 0);
}

/** Adds the tax to an amount in cents. */
// Math.round: half up for positive amounts.

export function withTax(cents: number): number {
  return Math.round(cents * (1 + TAX));
}
export const CART_TICKET = 'SHOPS-1234';
