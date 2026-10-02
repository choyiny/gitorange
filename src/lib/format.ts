const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(input: string | number | Date): string {
  const date =
    typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return 'now';
  for (const [unit, s] of UNITS) {
    if (Math.abs(seconds) >= s)
      return rtf.format(Math.round(seconds / s), unit);
  }
  return 'now';
}

export function fullDate(input: string | number): string {
  const date =
    typeof input === 'number' ? new Date(input * 1000) : new Date(input);
  return date.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });
}

export function dayLabel(input: number): string {
  return new Date(input * 1000).toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export const shortSha = (sha: string) => sha.slice(0, 7);

export function firstLine(message: string) {
  const i = message.indexOf('\n');
  return i < 0 ? message : message.slice(0, i);
}

export function restOfMessage(message: string) {
  const i = message.indexOf('\n');
  return i < 0 ? '' : message.slice(i + 1).trim();
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} Bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
