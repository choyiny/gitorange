// Money is whole cents. Every amount so far is Canadian dollars.

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const dollars = (Math.abs(cents) / 100).toFixed(2);
  return `${sign}$${dollars}`;
}

export function parseMoney(text: string): number {
  const cleaned = text.replace(/[^0-9.-]/g, '');
  return Math.round(Number.parseFloat(cleaned) * 100);
}
