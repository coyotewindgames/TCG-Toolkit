/**
 * Outbound email transport.
 *
 * Two implementations:
 *  - `ConsoleMailer` — logs the message to the server log AND appends it to
 *    `apps/api/.tmp/dev-emails.log` so dev users can grab the URL even after
 *    the terminal scrolls. Default in dev, and the fallback in production if
 *    `RESEND_API_KEY` is not set (with a loud warning, since prod really
 *    shouldn't be running without email).
 *  - `ResendMailer` — minimal `fetch` POST to https://api.resend.com/emails.
 *    Chosen because Resend has a generous free tier and a tiny HTTP surface,
 *    so we don't need to pull in their SDK.
 *
 * Use `getMailer()` everywhere; it picks the right impl off env once at boot.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getLogger } from '../../common/logger';
import { loadEnv } from '../../config/env';

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text body, always sent. HTML is optional. */
  text: string;
  html?: string;
  /** Override the sender; defaults to `MAIL_FROM`. */
  from?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Where ConsoleMailer mirrors messages so dev can `cat` them. Relative to
 * the API workspace cwd (which is how `npm run dev:api` launches us). */
const DEV_LOG_PATH = resolve(process.cwd(), '.tmp', 'dev-emails.log');

class ConsoleMailer implements Mailer {
  constructor(private readonly fallbackFrom: string) {}

  async send(msg: MailMessage): Promise<void> {
    const from = msg.from ?? this.fallbackFrom;
    const banner =
      '\n' +
      '╔' + '═'.repeat(78) + '╗\n' +
      '║  DEV MAILER — email NOT actually sent (set RESEND_API_KEY to enable).      ║\n' +
      '╚' + '═'.repeat(78) + '╝\n' +
      `From:    ${from}\n` +
      `To:      ${msg.to}\n` +
      `Subject: ${msg.subject}\n` +
      '---\n' +
      msg.text +
      '\n' + '─'.repeat(80) + '\n';

    // WARN level so it's hard to miss in any log filter.
    getLogger().warn({ mailer: 'console', to: msg.to, subject: msg.subject }, banner);

    // Mirror to a file so users can `Get-Content -Wait apps/api/.tmp/dev-emails.log`.
    // Best-effort: never throw out of send().
    try {
      mkdirSync(dirname(DEV_LOG_PATH), { recursive: true });
      appendFileSync(
        DEV_LOG_PATH,
        `\n[${new Date().toISOString()}]${banner}`,
        'utf8',
      );
    } catch (err) {
      getLogger().debug({ err }, 'console mailer: failed to write dev-emails.log');
    }
  }
}

class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly defaultFrom: string,
  ) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: msg.from ?? this.defaultFrom,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend send failed (${res.status}): ${body}`);
    }
  }
}

let cached: Mailer | null = null;

export function getMailer(): Mailer {
  if (cached) return cached;
  const env = loadEnv();
  const from = env.MAIL_FROM ?? 'TCG Toolkit <onboarding@resend.dev>';

  if (env.RESEND_API_KEY) {
    getLogger().info({ from }, '[mailer] using Resend transport');
    cached = new ResendMailer(env.RESEND_API_KEY, from);
  } else {
    if (env.NODE_ENV === 'production') {
      getLogger().warn(
        '[mailer] RESEND_API_KEY is not set in production; falling back to console logging. ' +
          'Password reset emails will NOT be delivered.',
      );
    } else {
      getLogger().info(
        `[mailer] dev mode: messages will be logged here and appended to ${DEV_LOG_PATH}. ` +
          'Set RESEND_API_KEY in apps/api/.env to send real emails.',
      );
    }
    cached = new ConsoleMailer(from);
  }
  return cached;
}

/** Test-only hook to substitute a stub. */
export function __setMailerForTests(m: Mailer | null): void {
  cached = m;
}
