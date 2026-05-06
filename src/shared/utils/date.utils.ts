export function toMoscowTime(date: Date): Date {
  return new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
}

export function formatDateTimeMoscow(date: Date): string {
  const moscowDate = toMoscowTime(date);
  const day = String(moscowDate.getDate()).padStart(2, '0');
  const month = String(moscowDate.getMonth() + 1).padStart(2, '0');
  const year = moscowDate.getFullYear();
  const hours = String(moscowDate.getHours()).padStart(2, '0');
  const minutes = String(moscowDate.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

export function formatDateMoscow(date: Date): string {
  const moscowDate = toMoscowTime(date);
  const day = String(moscowDate.getDate()).padStart(2, '0');
  const month = String(moscowDate.getMonth() + 1).padStart(2, '0');
  const year = moscowDate.getFullYear();
  return `${day}.${month}.${year}`;
}

export function formatShortDateTimeMoscow(date: Date): string {
  const moscowDate = toMoscowTime(date);
  const day = String(moscowDate.getDate()).padStart(2, '0');
  const month = String(moscowDate.getMonth() + 1).padStart(2, '0');
  const hours = String(moscowDate.getHours()).padStart(2, '0');
  const minutes = String(moscowDate.getMinutes()).padStart(2, '0');
  return `${day}.${month} ${hours}:${minutes}`;
}

export function formatShortDateMoscow(date: Date): string {
  const moscowDate = toMoscowTime(date);
  const day = String(moscowDate.getDate()).padStart(2, '0');
  const month = String(moscowDate.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}

const MOSCOW_TZ = 'Europe/Moscow';

/** Same calendar date in Moscow for both instants (for daily resets). */
export function isSameCalendarDayMoscow(a: Date, b: Date): boolean {
  const opts = { timeZone: MOSCOW_TZ } as const;
  return a.toLocaleDateString('en-CA', opts) === b.toLocaleDateString('en-CA', opts);
}
