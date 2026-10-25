/** 1234 → "12.34" */
export function format(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents);
  return `${sign}${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`;
}
