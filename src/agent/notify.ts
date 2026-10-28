/**
 * Best-effort Telegram notifications (`src/agent/notify`).
 *
 * Notifications are a convenience, never a dependency: a missing token or a
 * failed send is logged and swallowed so the run's real outcome (PR opened /
 * diagnosis failed) is decided by the verifiers, not by Telegram.
 */

/** Where to send; both values come from repository secrets. */
export interface TelegramOptions {
  botToken: string | undefined;
  chatId: string | undefined;
  /** Injectable transport for tests; defaults to `globalThis.fetch`. */
  transport?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
}

/** Escape the three characters Telegram's HTML mode cares about. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Send an HTML message. Returns `true` when Telegram accepted it.
 *
 * Console output is the fallback channel: GitHub keeps it in the job log, so
 * a missing chat id still leaves an audit trail.
 */
export async function notify(options: TelegramOptions, html: string): Promise<boolean> {
  if (options.botToken === undefined || options.chatId === undefined) {
    console.log(`[agent] ${html.replace(/<[^>]+>/g, '')}`);
    return false;
  }

  const transport = options.transport ?? globalThis.fetch;
  try {
    const response = await transport(
      `https://api.telegram.org/bot${options.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: options.chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok) {
      console.error(
        `[agent] telegram ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error('[agent] telegram send failed', error);
    return false;
  }
}
