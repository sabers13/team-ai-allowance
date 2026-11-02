import { emptyState } from "../components.ts";
import type { PageContext } from "../data.ts";
import { html } from "../html.ts";
import { layout } from "../layout.ts";

export interface ErrorPageInput {
  ctx: PageContext;
  status: number;
  title: string;
  message: string;
  retryHref: string;
}

/**
 * A console error page. It names what happened and what to do; it never shows a
 * stack trace, a key, a token or a raw provider body.
 */
export function renderError(input: ErrorPageInput): ReturnType<typeof layout> {
  return layout({
    ctx: input.ctx,
    title: input.title,
    subtitle: `Error ${input.status}`,
    content: html`<section class="card">
      ${emptyState({
        title: input.title,
        body: input.message,
        actionHref: input.retryHref,
        actionLabel: "Go back",
      })}
    </section>`,
  });
}
