import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { EmailMessage } from "./payloads.ts";

/**
 * A very small plain-text SMTP sender.
 *
 * The product sends plain text only: no HTML template, no tracking pixel, no
 * attachment. Tests point it at a local SMTP catcher.
 * The implementation follows the standard command sequence, supports AUTH
 * PLAIN and optional STARTTLS, and always closes the socket on failure.
 */

export interface SmtpTarget {
  host: string;
  port: number;
  secure: boolean;
  starttls: boolean;
  username: string | null;
  password: string | null;
}

export interface SmtpSendOptions {
  url: string;
  message: EmailMessage;
  timeoutMs: number;
}

export function parseSmtpUrl(value: string): SmtpTarget {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid SMTP URL.");
  }
  if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") {
    throw new Error("The SMTP URL must start with smtp:// or smtps://.");
  }
  const secure = parsed.protocol === "smtps:";
  const starttls = secure || parsed.searchParams.get("starttls") === "1";
  const host = parsed.hostname;
  if (host.length === 0) throw new Error("The SMTP URL names no host.");
  const port = parsed.port.length === 0 ? (secure ? 465 : 25) : Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The SMTP URL names an invalid port.");
  }
  const username = parsed.username.length === 0 ? null : decodeURIComponent(parsed.username);
  const password = parsed.password.length === 0 ? null : decodeURIComponent(parsed.password);
  return { host, port, secure, starttls, username, password };
}

interface SmtpReply {
  code: number;
  text: string;
}

class SmtpSession {
  private socket: Socket;
  private buffer = "";
  private lines: string[] = [];
  private replies: SmtpReply[] = [];
  private waiters: Array<{ resolve: (reply: SmtpReply) => void; reject: (error: Error) => void }> =
    [];
  private closed = false;
  private readonly timeoutMs: number;

  constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    this.socket = socket;
    socket.setTimeout(this.timeoutMs, () => {
      this.fail(new Error("SMTP timed out."));
    });
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      this.drain();
    });
    socket.on("error", (error: Error) => {
      this.fail(error);
    });
    socket.on("close", () => {
      if (!this.closed) this.fail(new Error("SMTP connection closed."));
    });
  }

  private drain(): void {
    while (true) {
      const index = this.buffer.indexOf("\r\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      this.lines.push(line);
      if (/^\d{3} /u.test(line)) {
        const reply = this.reply();
        const waiter = this.waiters.shift();
        if (waiter !== undefined) waiter.resolve(reply);
        else this.replies.push(reply);
      }
    }
  }

  private reply(): SmtpReply {
    const code = Number.parseInt(this.lines[0]?.slice(0, 3) ?? "0", 10);
    const text = this.lines.map((line) => line.slice(4)).join(" ");
    this.lines = [];
    return { code, text };
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
    this.socket.destroy();
  }

  private wait(): Promise<SmtpReply> {
    const buffered = this.replies.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async expect(expected: number, command: string | null): Promise<SmtpReply> {
    if (command !== null) this.socket.write(`${command}\r\n`);
    const reply = await this.wait();
    if (reply.code !== expected) {
      throw new Error(`SMTP refused a step with status ${reply.code}.`);
    }
    return reply;
  }

  async command(command: string, expected: number): Promise<SmtpReply> {
    return this.expect(expected, command);
  }

  async upgrade(host: string): Promise<void> {
    this.socket.removeAllListeners();
    const secured = await new Promise<Socket>((resolve, reject) => {
      const socket = tlsConnect({ socket: this.socket, servername: host }, () => resolve(socket));
      socket.once("error", reject);
    });
    this.attach(secured);
  }

  write(value: string): void {
    this.socket.write(value);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.socket.end();
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

function dataLines(message: EmailMessage): string {
  const to = message.to.join(", ");
  const headers = [
    `From: ${message.from}`,
    `To: ${to}`,
    `Subject: ${message.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    `Date: ${new Date().toUTCString()}`,
  ];
  const body = message.body
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n.\r\n`;
}

export async function sendSmtpMail(options: SmtpSendOptions): Promise<void> {
  const target = parseSmtpUrl(options.url);
  const socket = target.secure
    ? tlsConnect({ host: target.host, port: target.port, servername: target.host })
    : netConnect({ host: target.host, port: target.port });
  socket.setTimeout(options.timeoutMs);

  const session = new SmtpSession(socket, options.timeoutMs);
  try {
    await session.expect(220, null);
    await session.command("EHLO localhost", 250);
    if (target.starttls && !target.secure) {
      await session.command("STARTTLS", 220);
      await session.upgrade(target.host);
      await session.command("EHLO localhost", 250);
    }
    if (target.username !== null) {
      const token = Buffer.from(`\u0000${target.username}\u0000${target.password ?? ""}`).toString(
        "base64",
      );
      await session.command(`AUTH PLAIN ${token}`, 235);
    }
    await session.command(`MAIL FROM:<${options.message.from}>`, 250);
    for (const recipient of options.message.to) {
      await session.command(`RCPT TO:<${recipient}>`, 250);
    }
    await session.command("DATA", 354);
    session.write(dataLines(options.message));
    await session.expect(250, null);
    await session.command("QUIT", 221).catch(() => undefined);
    await session.close();
  } catch (error) {
    session.destroy();
    throw error;
  }
}
