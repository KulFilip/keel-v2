import { Item } from './item';

export interface Order {
  id: string;
  items: Item[];
  total: number;
  paid: number;
}

export function pay(o: Order) {
  o.paid = o.total;
}
