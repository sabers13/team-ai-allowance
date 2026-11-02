import type { ModelEntry } from "../../contracts.ts";
import { lineChart } from "../chart.ts";
import {
  card,
  emptyState,
  field,
  formError,
  listBlock,
  progressBar,
  statusPill,
  tableWrap,
} from "../components.ts";
import type { MyData, PageContext } from "../data.ts";
import { dateTime, usd } from "../format.ts";
import { html } from "../html.ts";
import { modelStateLabel, requestKindLabel, requestStateLabel, requestSubject } from "../labels.ts";
import { layout } from "../layout.ts";
import { requestStateTone, statusView } from "../status.ts";
import { dailySeries } from "../usage.ts";

export interface MyPageInput {
  ctx: PageContext;
  data: MyData;
  formError: string | null;
}

function requestForm(input: MyPageInput): ReturnType<typeof html> {
  const { ctx, data } = input;
  const requestable = data.allowedModels.filter((model) => model.state !== "blocked");
  return html`<form method="post" action="/me/requests">
    <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
    <input type="hidden" name="returnTo" value="/me">
    ${formError(input.formError)}
    <div class="field">
      <label class="field__label" for="request-kind">What do you need?</label>
      <select id="request-kind" name="kind" required>
        <option value="more_budget">More budget</option>
        <option value="model_unlock">A model unlock</option>
        <option value="suggestion">A suggestion for my manager</option>
      </select>
    </div>
    ${field({
      id: "request-amount",
      label: "Amount, USD",
      optional: true,
      hint: "For a budget request. Your manager can approve a smaller amount.",
      control: html`<input id="request-amount" name="amountUsd" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="5.00">`,
    })}
    ${field({
      id: "request-model",
      label: "Model",
      optional: true,
      hint: "For a model unlock.",
      control: html`<select id="request-model" name="modelId">
        <option value="">Not a model request</option>
        ${requestable.map(
          (model) =>
            html`<option value="${model.id}">${model.displayName} (${modelStateLabel(model.state)})</option>`,
        )}
      </select>`,
    })}
    <div class="field">
      <label class="field__label" for="request-message">Reason</label>
      <p class="field__hint" id="request-message-hint">One or two sentences. Your manager sees this, not your prompt or response text.</p>
      <textarea id="request-message" name="message" rows="3" maxlength="600" required></textarea>
    </div>
    <div class="form-actions form-actions--end">
      <button class="button button--primary" type="submit">Send request</button>
    </div>
  </form>`;
}

function requestsTable(input: MyPageInput): ReturnType<typeof html> {
  const { ctx, data } = input;
  const rows = data.requests.map(
    (request) => html`<tr>
      <td data-label="Request">
        <span class="small">${requestKindLabel(request.kind)} · ${requestSubject(request)}</span>
        <div class="xs muted">${request.message.length > 80 ? `${request.message.slice(0, 79)}…` : request.message}</div>
      </td>
      <td data-label="State"><span class="pill pill--${requestStateTone(request.state)}">${requestStateLabel(request.state)}</span></td>
      <td data-label="Sent" class="nowrap" title="${request.createdAt}">${dateTime(request.createdAt, ctx.timeZone)}</td>
      <td data-label="Action">
        ${
          request.state === "pending"
            ? html`<form method="post" action="/me/requests/${request.id}/cancel">
              <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
              <input type="hidden" name="returnTo" value="/me">
              <button class="button button--quiet button--sm" type="submit">Cancel</button>
            </form>`
            : html`<span class="xs muted">—</span>`
        }
      </td>
    </tr>`,
  );

  return tableWrap(
    "My requests",
    html`<table class="table">
      <caption>Your requests and their state.</caption>
      <thead><tr><th scope="col">Request</th><th scope="col">State</th><th scope="col">Sent</th><th scope="col">Action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`,
  );
}

function usageChart(input: MyPageInput): ReturnType<typeof html> {
  const { ctx, data } = input;
  const chart = dailySeries(data.usage, data.allowedModels, ctx.now, ctx.timeZone, 30);
  return listBlock({
    mode: ctx.mode,
    isEmpty: chart.series.length === 0,
    ready: lineChart({
      title: "My daily spend, last 30 days",
      description: "One line per model, with the same daily values in the table below the chart.",
      labels: chart.labels,
      series: chart.series,
      formatValue: (value) => (value === 0 ? "USD 0" : `USD ${value.toFixed(2)}`),
    }),
    empty: emptyState({
      title: "No usage in the last 30 days",
      body: "Your spend appears here after the gateway records the first call.",
    }),
    retryHref: "/me",
    loadingLabel: "Loading usage…",
  });
}

export function renderMe(input: MyPageInput): ReturnType<typeof layout> {
  const { ctx, data } = input;
  const status = statusView(data.policy, data.spendUsd);
  const remaining = Math.max(0, data.policy.effectiveBudgetUsd - data.spendUsd);

  return layout({
    ctx,
    title: "My allowance",
    subtitle: `${data.member.displayName} · ${data.team.name}`,
    content: html`<div class="grid">
      <section class="card card--primary col-8" aria-labelledby="remaining-title">
        <h2 class="card__title" id="remaining-title">Remaining</h2>
        <p class="metric__value" style="margin-top: 8px">${usd(remaining)}</p>
        <p class="metric__sub">of ${usd(data.policy.effectiveBudgetUsd)} · ${usd(data.spendUsd)} spent · resets ${dateTime(data.resetAt, ctx.timeZone)}</p>
        ${progressBar(data.spendUsd, data.policy.effectiveBudgetUsd, "Spend against my budget")}
        <p class="row" style="margin-top: 8px">${statusPill(status)}<span class="muted small">${status.title}</span></p>
        <p class="xs muted" style="margin-top: 8px">The gateway refuses a call at the hard limit. The console and the notice are near-real-time, within one poll interval.</p>
      </section>

      <section class="card col-4" aria-labelledby="models-title">
        <h2 class="card__title" id="models-title">Models you can use</h2>
        <div class="card__body" style="margin-top: 12px">${listBlock({
          mode: ctx.mode,
          isEmpty: data.allowedModels.length === 0,
          ready: html`<ul class="stack stack--tight" style="list-style: none">
            ${data.allowedModels.map(
              (model: ModelEntry) => html`<li>
                <span class="row row--between">
                  <span class="mono small">${model.id}</span>
                  <span class="pill pill--${model.state === "enabled" ? "ok" : "soft"}">${modelStateLabel(model.state)}</span>
                </span>
                <span class="xs muted">${usd(model.inputPer1MUsd)} in / ${usd(model.outputPer1MUsd)} out per 1M tokens</span>
              </li>`,
            )}
          </ul>`,
          empty: emptyState({
            title: "No models allowed",
            body: "Ask your manager to unlock a model.",
          }),
          retryHref: "/me",
          loadingLabel: "Loading models…",
        })}</div>
      </section>

      <div class="col-7">
        ${card({
          title: "Ask for more",
          subtitle: `Requests go to your manager. Pending requests expire after 72 hours.`,
          body: requestForm(input),
        })}
      </div>

      <div class="col-5">
        ${card({
          title: "Spend, last 30 days",
          subtitle: "The table under the chart carries the same numbers.",
          body: usageChart(input),
        })}
      </div>

      <section class="card col-12" aria-labelledby="my-requests-title">
        <header class="card__header">
          <div class="card__titles">
            <h2 class="card__title" id="my-requests-title">My requests</h2>
            <p class="card__subtitle">${data.requests.length} in the last 30 days.</p>
          </div>
        </header>
        <div class="card__body">${listBlock({
          mode: ctx.mode,
          isEmpty: data.requests.length === 0,
          ready: requestsTable(input),
          empty: emptyState({
            title: "No requests yet",
            body: "Use the form above when you need more budget or a model.",
          }),
          retryHref: "/me",
          loadingLabel: "Loading requests…",
        })}</div>
      </section>

      <div class="col-12">
        <p class="small muted">Inline hints: <span class="mono">my_allowance</span>, <span class="mono">request_more_budget</span> and <span class="mono">request_model</span> are also available in your CLI's MCP desk. <a href="/setup">Setup</a> explains how to connect.</p>
      </div>
    </div>`,
  });
}
