import { createTransport } from "nodemailer";

export type MailMessage = { to: string; subject: string; text: string };

export type Mailer = {
  send(message: MailMessage): Promise<void>;
};

/** Collects messages in memory (tests). */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** Sends over SMTP (`SMTP_URL`, e.g. `smtp://localhost:1025` for Mailpit). */
export class SmtpMailer implements Mailer {
  readonly #transport: ReturnType<typeof createTransport>;
  readonly #from: string;

  constructor(opts: { smtpUrl: string; from: string }) {
    this.#transport = createTransport(opts.smtpUrl);
    this.#from = opts.from;
  }

  async send(message: MailMessage): Promise<void> {
    await this.#transport.sendMail({
      from: this.#from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}

/** Default From: `SCAD <no-reply@{auth host without port}>`. */
export function defaultFromAddress(baseDomain: string): string {
  const host = `auth.${baseDomain}`.replace(/:\d+$/, "");
  return `SCAD <no-reply@${host}>`;
}
