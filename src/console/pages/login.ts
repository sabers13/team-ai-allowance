import { formError } from "../components.ts";
import type { Theme, Viewer } from "../data.ts";
import { type Html, html } from "../html.ts";

export interface LoginPageInput {
  theme: Theme;
  error: string | null;
  next: string;
  viewer: Viewer | null;
  gatewayName: string;
}

/**
 * The sign-in page. It has no navigation because there is no session yet, and
 * it is the only page that renders outside the console shell.
 */
export function renderLogin(input: LoginPageInput): Html {
  return html`<!doctype html>
<html lang="en" data-theme="${input.theme}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Sign in · Allowance console</title>
  <link rel="stylesheet" href="/console.css">
</head>
<body class="page-body login-body">
  <a class="skip-link" href="#main">Skip to content</a>
  <main id="main" class="login" tabindex="-1">
    <div class="card card--primary login__card">
      <p class="brand" style="margin-bottom: 16px">
        <span class="brand__mark" aria-hidden="true">
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false"><path d="M2 3.5h10M2 7h7M2 10.5h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </span>
        <span class="brand__name">Allowance</span>
      </p>
      <h1 class="page__title">Sign in</h1>
      <p class="muted small">Managers and admins sign in with e-mail and password. Members sign in with the gateway key from setup.</p>
      ${formError(input.error)}
      <form method="post" action="/login" style="margin-top: 16px">
        <input type="hidden" name="next" value="${input.next}">
        <div class="field">
          <label class="field__label" for="login-email">E-mail</label>
          <input id="login-email" name="email" type="email" autocomplete="username" required>
        </div>
        <div class="field">
          <label class="field__label" for="login-password">Password</label>
          <input id="login-password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <div class="form-actions">
          <button class="button button--primary button--block" type="submit">Sign in</button>
        </div>
      </form>
      <p class="login__foot xs muted" style="margin-top: 16px">Member with a gateway key?</p>
      <form method="post" action="/login">
        <input type="hidden" name="next" value="${input.next}">
        <div class="field">
          <label class="field__label" for="login-member-key">Member key</label>
          <input id="login-member-key" name="memberKey" type="password" autocomplete="off" spellcheck="false">
        </div>
        <div class="form-actions">
          <button class="button button--secondary button--block" type="submit">Sign in with a member key</button>
        </div>
      </form>
      <p class="xs muted" style="margin-top: 16px">Signed in against ${input.gatewayName}. Sessions last 12 hours and are httpOnly and SameSite=Strict.</p>
    </div>
    <p class="login__foot xs muted">team-ai-allowance · no prompt or response text is stored</p>
  </main>
</body>
</html>`;
}
