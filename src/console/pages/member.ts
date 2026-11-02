import type { ModelEntry } from "../../contracts.ts";
import { lineChart } from "../chart.ts";
import {
  card,
  emptyState,
  field,
  formError,
  listBlock,
  metric,
  progressBar,
  statusPill,
  tableWrap,
} from "../components.ts";
import type { MemberDetail, PageContext } from "../data.ts";
import { dateTime, initials, percent, percentText, usd } from "../format.ts";
import { type Html, html, raw } from "../html.ts";
import { grantSummary, modelStateLabel, periodLabel, roleLabel } from "../labels.ts";
import { layout } from "../layout.ts";
import { statusView } from "../status.ts";
import { dailySeries } from "../usage.ts";

export interface MemberPageInput {
  ctx: PageContext;
  detail: MemberDetail;
  models: ModelEntry[];
  /** Present once after a key rotation. */
  revealedSecret: string | null;
  formError: string | null;
}

function limitsCard(input: MemberPageInput): Html {
  const { detail, ctx } = input;
  const limits = detail.limits;
  const id = detail.member.id;
  return card({
    title: "Limits",
    subtitle: `Budget per ${periodLabel(limits.period).toLowerCase()} period, enforced at the gateway.`,
    actions: html`<a class="button button--quiet button--sm" href="/requests?memberId=${id}">Requests</a>`,
    body: html`${formError(input.formError)}
      <form method="post" action="/members/${id}/limits">
        <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
        <input type="hidden" name="returnTo" value="/members/${id}">
        <div class="field-row">
          ${field({
            id: "limit-budget",
            label: "Period budget",
            hint: "US dollars, two decimals.",
            control: html`<input id="limit-budget" name="budgetUsd" type="number" inputmode="decimal" min="0" step="0.01" value="${limits.budgetUsd.toFixed(2)}" required>`,
          })}
          ${field({
            id: "limit-period",
            label: "Period",
            control: html`<select id="limit-period" name="period">
              ${(["daily", "weekly", "monthly"] as const).map(
                (period) =>
                  html`<option value="${period}"${raw(limits.period === period ? " selected" : "")}>${periodLabel(period)}</option>`,
              )}
            </select>`,
          })}
        </div>
        <div class="field-row" style="margin-top: 12px">
          ${field({
            id: "limit-tokens",
            label: "Token cap",
            optional: true,
            hint: "Watcher-enforced. Empty means no cap.",
            control: html`<input id="limit-tokens" name="tokenCap" type="number" inputmode="numeric" min="1" step="1" value="${limits.tokenCap ?? ""}">`,
          })}
          ${field({
            id: "limit-rpm",
            label: "Requests per minute",
            optional: true,
            control: html`<input id="limit-rpm" name="rpm" type="number" inputmode="numeric" min="1" step="1" value="${limits.rpm ?? ""}">`,
          })}
          ${field({
            id: "limit-tpm",
            label: "Tokens per minute",
            optional: true,
            control: html`<input id="limit-tpm" name="tpm" type="number" inputmode="numeric" min="1" step="1" value="${limits.tpm ?? ""}">`,
          })}
        </div>
        <div class="form-actions form-actions--end">
          <button class="button button--primary" type="submit">Save limits</button>
        </div>
      </form>`,
  });
}

function keyCard(input: MemberPageInput): Html {
  const { detail, ctx } = input;
  const member = detail.member;
  const key = detail.keyState;
  // The effective status, not only the manual block flag: a hard-limit or
  // token-cap block also stops the key at the gateway (review S2).
  const status = statusPill(statusView(detail.policy, detail.spendUsd));

  const secretBanner =
    input.revealedSecret === null
      ? ""
      : html`<div class="banner banner--info" role="status">
          <div class="banner__text">
            <p class="banner__title">New key, shown once</p>
            <p class="banner__message">Copy this key into the member's config now. It is not stored and cannot be shown again.</p>
            <pre class="secret">${input.revealedSecret}</pre>
          </div>
        </div>`;

  const blockForm = key.blocked
    ? html`<form method="post" action="/members/${member.id}/key/unblock">
          <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
          <input type="hidden" name="returnTo" value="/members/${member.id}">
          <button class="button button--secondary" type="submit">Unblock key</button>
        </form>`
    : html`<details class="disclosure">
          <summary>Block this key</summary>
          <form method="post" action="/members/${member.id}/key/block">
            <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
            <input type="hidden" name="returnTo" value="/members/${member.id}">
            ${field({
              id: "block-reason",
              label: "Reason",
              hint: "Stored in the audit log and shown to the member.",
              control: html`<input id="block-reason" name="reason" type="text" maxlength="200" placeholder="For example: unusual spend">`,
            })}
            <button class="button button--danger" type="submit">Block key for ${member.displayName}</button>
          </form>
        </details>`;

  return card({
    title: "Key",
    subtitle: `Alias ${member.keyAlias}`,
    body: html`${secretBanner}
      <div class="key-state">${status}${key.reason !== null ? html`<span class="muted small">${key.reason}</span>` : ""}</div>
      <dl class="defs" style="margin-top: 12px">
        <div class="defs__row"><dt class="defs__label">Last rotated</dt><dd class="defs__value">${key.lastRotatedAt === null ? "Never" : dateTime(key.lastRotatedAt, ctx.timeZone)}</dd></div>
        <div class="defs__row"><dt class="defs__label">Stored material</dt><dd class="defs__value">sha256 hash only</dd></div>
      </dl>
      <div class="stack stack--tight" style="margin-top: 12px">
        ${blockForm}
        <details class="disclosure">
          <summary>Rotate this key</summary>
          <p class="small muted" style="margin: 4px 0 8px">The current key stops working immediately. The member must paste the new key into their config.</p>
          <form method="post" action="/members/${member.id}/key/rotate">
            <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
            <input type="hidden" name="returnTo" value="/members/${member.id}">
            <button class="button button--danger" type="submit">Rotate key for ${member.displayName}</button>
          </form>
        </details>
      </div>`,
  });
}

function modelsCard(input: MemberPageInput): Html {
  const { detail, models, ctx } = input;
  const selected = new Set(detail.selectedModelIds);
  const noneSelected = detail.selectedModelIds.length === 0;
  const sorted = [...models].sort((left, right) => left.sortOrder - right.sortOrder);

  const rows = sorted.map((model) => {
    const selectable = model.state === "enabled";
    const checked = selectable && (noneSelected || selected.has(model.id));
    const granted = detail.policy.allowedModels.includes(model.id);
    const statePill =
      model.state === "enabled"
        ? html``
        : html`<span class="pill pill--${model.state === "blocked" ? "blocked" : "soft"}">${modelStateLabel(model.state)}</span>`;
    const note =
      model.state === "blocked"
        ? html`<span class="field__hint">Not available to this team.</span>`
        : model.state === "approval-required"
          ? html`<span class="field__hint">${granted ? "An active grant allows it now." : "Needs an approved grant from the Requests page."}</span>`
          : html``;
    return html`<li class="check" style="border-bottom: 1px solid var(--border)">
      <input id="model-${model.id}" name="modelId" type="checkbox" value="${model.id}"${raw(checked ? " checked" : "")}${raw(selectable ? "" : " disabled")}>
      <label class="check__label" for="model-${model.id}">
        <span class="mono small">${model.id}</span> <span class="muted small">${model.displayName}</span>
        ${statePill}
        ${note}
      </label>
    </li>`;
  });

  return card({
    title: "Allowed models",
    subtitle: "Enabled models only. Leave everything unticked to allow every enabled model.",
    body: html`${formError(input.formError)}
      <form method="post" action="/members/${detail.member.id}/models">
        <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
        <input type="hidden" name="returnTo" value="/members/${detail.member.id}">
        <ul style="list-style: none">${rows}</ul>
        <div class="form-actions form-actions--end">
          <button class="button button--primary" type="submit">Save models</button>
        </div>
      </form>`,
  });
}

function grantsCard(input: MemberPageInput): Html {
  const { detail, models, ctx } = input;
  const active = detail.grants.filter(
    (grant) =>
      grant.revokedAt === null && (grant.expiresAt === null || new Date(grant.expiresAt) > ctx.now),
  );
  return card({
    title: "Grants",
    subtitle: "Active budget, token-cap and model grants, including approved requests.",
    body: listBlock({
      mode: ctx.mode,
      isEmpty: active.length === 0,
      ready: html`<div>
        ${active.map(
          (grant) => html`<div class="grant-row">
            <div>
              <p class="small">${grantSummary(grant, models)}</p>
              <p class="xs muted">From ${grant.issuedBy} · starts ${dateTime(grant.startsAt, ctx.timeZone)}</p>
            </div>
            <div class="row">
              <p class="xs muted nowrap">${grant.expiresAt === null ? "Permanent" : `Until ${dateTime(grant.expiresAt, ctx.timeZone)}`}</p>
              <form method="post" action="/members/${detail.member.id}/grants/${grant.id}/revoke">
                <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
                <input type="hidden" name="returnTo" value="/members/${detail.member.id}">
                <input type="hidden" name="reason" value="Revoked by a manager from the member page.">
                <button class="button button--quiet button--sm" type="submit">Revoke</button>
              </form>
            </div>
          </div>`,
        )}
      </div>`,
      empty: emptyState({
        title: "No active grants",
        body: "Approved requests and automatic rules appear here until they expire or are revoked.",
      }),
      retryHref: `/members/${detail.member.id}`,
      loadingLabel: "Loading grants…",
    }),
  });
}

function usageCard(input: MemberPageInput): Html {
  const { detail, models, ctx } = input;
  const chart = dailySeries(detail.usage, models, ctx.now, ctx.timeZone, 30);
  return card({
    title: "Spend, last 30 days",
    subtitle: "By model. The table under the chart carries the same numbers.",
    body: listBlock({
      mode: ctx.mode,
      isEmpty: chart.series.length === 0,
      ready: lineChart({
        title: `Daily spend for ${detail.member.displayName}, last 30 days`,
        description: "One line per model, with the same daily values in the table below the chart.",
        labels: chart.labels,
        series: chart.series,
        formatValue: (value) => (value === 0 ? "USD 0" : `USD ${value.toFixed(2)}`),
      }),
      empty: emptyState({
        title: "No usage in the last 30 days",
        body: "The watcher records spend after the first gateway poll.",
      }),
      retryHref: `/members/${detail.member.id}`,
      loadingLabel: "Loading usage…",
    }),
  });
}

function auditCard(input: MemberPageInput): Html {
  const { detail, ctx } = input;
  const table = html`<table class="table table--cards">
    <caption>Recent audit events for ${detail.member.displayName}.</caption>
    <thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Reason</th></tr></thead>
    <tbody>
      ${detail.audit.map(
        (event) => html`<tr>
          <td class="nowrap" title="${event.at}" data-label="When">${dateTime(event.at, ctx.timeZone)}</td>
          <td data-label="Actor">${event.actor.displayName ?? event.actor.type}</td>
          <td class="mono small" data-label="Action">${event.action}</td>
          <td class="muted small" data-label="Reason">${event.reason ?? "—"}</td>
        </tr>`,
      )}
    </tbody>
  </table>`;
  return card({
    title: "Audit",
    subtitle: "Every change is appended; nothing is edited or removed.",
    actions: html`<a class="button button--quiet button--sm" href="/audit?objectId=${detail.member.id}">Full audit</a>`,
    body: listBlock({
      mode: ctx.mode,
      isEmpty: detail.audit.length === 0,
      ready: tableWrap("Recent audit events", table),
      empty: emptyState({
        title: "No audit events yet",
        body: "Limit changes, decisions and key actions appear here.",
      }),
      retryHref: `/members/${detail.member.id}`,
      loadingLabel: "Loading audit events…",
    }),
  });
}

export function renderMember(input: MemberPageInput): Html {
  const { detail, ctx } = input;
  const status = statusView(detail.policy, detail.spendUsd);
  const used = percent(detail.spendUsd, detail.policy.effectiveBudgetUsd);
  const blockedReason =
    detail.policy.blocked && detail.policy.blockedReason !== null
      ? html`<p class="muted small" style="margin-top: 4px">${detail.policy.blockedReason}</p>`
      : "";

  return layout({
    ctx,
    title: detail.member.displayName,
    subtitle: `${roleLabel(detail.member.role)} · ${detail.team.name} · ${detail.member.email ?? "no e-mail"}`,
    breadcrumb: html`<a href="/#members">Members</a> / ${detail.member.displayName}`,
    actions: html`<a class="button button--secondary" href="/requests?memberId=${detail.member.id}">Requests</a>`,
    content: html`<section class="card card--primary" aria-labelledby="member-summary-title">
      <div class="row row--between" style="align-items: flex-start">
        <div class="row" style="align-items: flex-start">
          <span class="avatar" style="width: 48px; height: 48px; font-size: 16px" aria-hidden="true">${initials(detail.member.displayName)}</span>
          <div>
            <h2 class="card__title" id="member-summary-title">${detail.member.displayName}</h2>
            <p class="card__subtitle">${detail.member.keyAlias}</p>
            ${blockedReason}
          </div>
        </div>
        ${statusPill(status)}
      </div>
      <div class="grid" style="margin-top: 16px">
        <div class="col-4">${metric({ label: "Spend this period", value: usd(detail.spendUsd), sub: `${percentText(detail.spendUsd, detail.policy.effectiveBudgetUsd)} of ${usd(detail.policy.effectiveBudgetUsd)}` })}</div>
        <div class="col-4">${metric({ label: "Budget", value: usd(detail.policy.effectiveBudgetUsd), sub: `${periodLabel(detail.limits.period)} · ${detail.policy.grants.length} active ${detail.policy.grants.length === 1 ? "grant" : "grants"}` })}</div>
        <div class="col-4">${metric({ label: "Token cap", value: detail.policy.effectiveTokenCap === null ? "None" : detail.policy.effectiveTokenCap.toLocaleString("en-GB"), sub: "Watcher-enforced, within one poll interval" })}</div>
      </div>
      ${progressBar(detail.spendUsd, detail.policy.effectiveBudgetUsd, `${detail.member.displayName}'s spend against the budget`)}
      <p class="xs muted" style="margin-top: 8px">${used}% used. Allowed models: ${detail.policy.allowedModels.length === 0 ? "none" : detail.policy.allowedModels.join(", ")}.</p>
    </section>

    <div class="grid" style="margin-top: 16px">
      <div class="col-8">${limitsCard(input)}</div>
      <div class="col-4">${keyCard(input)}</div>
      <div class="col-12">${modelsCard(input)}</div>
      <div class="col-5">${grantsCard(input)}</div>
      <div class="col-7">${usageCard(input)}</div>
      <div class="col-12">${auditCard(input)}</div>
    </div>`,
  });
}
