import nodemailer from 'nodemailer';
import { emailAvailable, env } from './env.js';

const transport = emailAvailable ? nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: Number(env.SMTP_PORT),
  secure: env.SMTP_SECURE === 'true',
  requireTLS: env.SMTP_SECURE !== 'true',
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  connectionTimeout: 10000,
  socketTimeout: 15000,
  logger: false,
  debug: false,
}) : null;

export async function sendEmail(to: string, subject: string, text: string) {
  if (!transport) return false;
  await transport.sendMail({ from: env.SMTP_FROM, to, subject, text });
  return true;
}
