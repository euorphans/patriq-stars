/** Ошибки Telegram API от действий пользователя (блокировка бота и т.п.) — не считаем критичными. */
export function isIgnorableTelegramUserError(err: unknown): boolean {
  if (err == null) return false;
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const lower = msg.toLowerCase();
  if (lower.includes('bot was blocked by the user')) return true;
  if (lower.includes('user is deactivated')) return true;
  if (
    lower.includes('forbidden') &&
    lower.includes('403') &&
    lower.includes('bot')
  )
    return true;

  const any = err as {
    response?: { error_code?: number; description?: string };
    code?: number;
  };
  if (any.response?.error_code === 403) {
    const d = String(any.response.description || '').toLowerCase();
    if (d.includes('blocked') || d.includes('deactivated')) return true;
  }
  if (any.code === 403 && lower.includes('forbidden')) return true;

  return false;
}
