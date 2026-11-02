/**
 * A real HTTP server on 127.0.0.1:0 with a cookie-aware test client.
 * No network leaves localhost.
 */

import type { AddressInfo } from "node:net";
import { type ApiLogEntry, createApiConfig, createApiServer } from "../../src/api/index.ts";
import { createFixture, type Fixture, SECRETS } from "./fixtures.ts";

export interface TestServer {
  fixture: Fixture;
  baseUrl: string;
  logs: ApiLogEntry[];
  close(): Promise<void>;
  client(): TestClient;
}

export interface TestResponse {
  status: number;
  body: unknown;
  headers: Headers;
  setCookies: string[];
}

export interface RequestOptions {
  body?: unknown;
  form?: Record<string, string>;
  /** A pre-serialised body, sent with `contentType`. */
  raw?: string;
  contentType?: string;
  bearer?: string;
  /** `undefined` sends the client's stored token; `null` sends none. */
  csrf?: string | null;
  headers?: Record<string, string>;
}

export interface StartOptions {
  loginMaxAttempts?: number;
  sessionTtlMs?: number;
  loginWindowMs?: number;
}

export class TestClient {
  readonly cookies = new Map<string, string>();
  csrfToken: string | null = null;
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<TestResponse> {
    const headers: Record<string, string> = { ...options.headers };
    const cookie = this.cookieHeader();
    if (cookie !== undefined) headers.cookie = cookie;
    if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;

    const csrf = options.csrf === undefined ? this.csrfToken : options.csrf;
    if (csrf !== null && csrf !== undefined) headers["x-csrf-token"] = csrf;

    let body: string | undefined;
    if (options.raw !== undefined) {
      headers["content-type"] = options.contentType ?? "application/json";
      body = options.raw;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    } else if (options.form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(options.form).toString();
    }

    const init: RequestInit = { method, headers, redirect: "manual" };
    if (body !== undefined) init.body = body;
    const response = await fetch(`${this.baseUrl}${path}`, init);
    const setCookies = response.headers.getSetCookie();
    for (const cookieValue of setCookies) this.storeCookie(cookieValue);
    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed, headers: response.headers, setCookies };
  }

  private storeCookie(setCookie: string): void {
    const [pair, ...attributes] = setCookie.split(";");
    if (pair === undefined) return;
    const index = pair.indexOf("=");
    if (index < 0) return;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
    if (value.length === 0 || expired) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const fixture = await createFixture();
  const config = createApiConfig({
    sessionSecret: fixture.config.sessionSecret,
    csrfSecret: fixture.config.csrfSecret,
    publicUrl: fixture.config.publicUrl,
    cookieSecure: false,
    sessionTtlMs: options.sessionTtlMs ?? fixture.config.sessionTtlMs,
    loginMaxAttempts: options.loginMaxAttempts ?? fixture.config.loginMaxAttempts,
    loginWindowMs: options.loginWindowMs ?? fixture.config.loginWindowMs,
  });
  const logs: ApiLogEntry[] = [];
  const handle = createApiServer({
    control: fixture.control,
    members: fixture.store,
    credentials: fixture.credentials,
    managerTokens: fixture.tokens,
    clock: fixture.clock,
    config,
    logger: (entry) => logs.push(entry),
  });
  await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  const address = handle.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    fixture,
    baseUrl,
    logs,
    client: () => new TestClient(baseUrl),
    close: () =>
      new Promise<void>((resolve, reject) => {
        handle.server.close((error) =>
          error === undefined || error === null ? resolve() : reject(error),
        );
      }),
  };
}

export async function csrfBootstrap(client: TestClient): Promise<string> {
  const response = await client.request("GET", "/api/auth/csrf");
  if (response.status !== 200) throw new Error(`csrf bootstrap failed: ${response.status}`);
  const token = (response.body as { csrfToken: string }).csrfToken;
  return token;
}

export async function loginWithPassword(
  client: TestClient,
  email: string,
  password: string,
): Promise<TestResponse> {
  const token = await csrfBootstrap(client);
  const response = await client.request("POST", "/login", {
    body: { email, password, _csrf: token },
  });
  if (response.status === 200) {
    client.csrfToken = (response.body as { csrfToken: string }).csrfToken;
  }
  return response;
}

export async function loginWithMemberKey(client: TestClient, key: string): Promise<TestResponse> {
  const token = await csrfBootstrap(client);
  const response = await client.request("POST", "/login", {
    body: { memberKey: key, _csrf: token },
  });
  if (response.status === 200) {
    client.csrfToken = (response.body as { csrfToken: string }).csrfToken;
  }
  return response;
}

export async function managerSessionClient(server: TestServer): Promise<TestClient> {
  const client = server.client();
  const response = await loginWithPassword(client, SECRETS.managerEmail, SECRETS.managerPassword);
  if (response.status !== 200) throw new Error(`manager login failed: ${response.status}`);
  return client;
}

export async function adminSessionClient(server: TestServer): Promise<TestClient> {
  const client = server.client();
  const response = await loginWithPassword(client, SECRETS.adminEmail, SECRETS.adminPassword);
  if (response.status !== 200) throw new Error(`admin login failed: ${response.status}`);
  return client;
}

export async function memberSessionClient(server: TestServer): Promise<TestClient> {
  const client = server.client();
  const response = await loginWithMemberKey(client, SECRETS.memberKey);
  if (response.status !== 200) throw new Error(`member login failed: ${response.status}`);
  return client;
}

export function bodyOf<T>(response: TestResponse): T {
  return response.body as T;
}
