import { createTransport } from "nodemailer";
import type { Mailer, MailMessage } from "./jobs.js";

/** Expiry warnings over SMTP (`SMTP_URL`; Mailpit locally). Same setup as the gateway's magic links. */
export class SmtpMailer implements Mailer {
  readonly #transport: ReturnType<typeof createTransport>;
  readonly #from: string;

  constructor(opts: { smtpUrl: string; from: string }) {
    this.#transport = createTransport(opts.smtpUrl);
    this.#from = opts.from;
  }

  async send(message: MailMessage): Promise<void> {
    await this.#transport.sendMail({ from: this.#from, ...message });
  }
}

/** Without SMTP the warning is only logged (recipient and subject, never tokens). */
export class LogMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    console.warn(`SMTP_URL is not set; not sending "${message.subject}" to ${message.to}`);
  }
}

/** Default From: `SCAD <no-reply@{auth host without port}>`. */
export function defaultFromAddress(baseDomain: string): string {
  return `SCAD <no-reply@${`auth.${baseDomain}`.replace(/:\d+$/, "")}>`;
}
