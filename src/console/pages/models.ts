import { card, emptyState, listBlock, metric, tableWrap } from "../components.ts";
import type { ModelsData, PageContext } from "../data.ts";
import { money } from "../format.ts";
import { type Html, html } from "../html.ts";
import { modelStateLabel } from "../labels.ts";
import { layout } from "../layout.ts";

function statePill(state: "enabled" | "approval-required" | "blocked") {
  const tone = state === "enabled" ? "ok" : state === "approval-required" ? "soft" : "blocked";
  return html`<span class="pill pill--${tone}">${modelStateLabel(state)}</span>`;
}

export function renderModels(input: { ctx: PageContext; data: ModelsData }): Html {
  const { ctx, data } = input;
  const enabled = data.models.filter((row) => row.model.state === "enabled").length;
  const approval = data.models.filter((row) => row.model.state === "approval-required").length;
  const blocked = data.models.filter((row) => row.model.state === "blocked").length;
  const totalRequests = data.models.reduce((sum, row) => sum + row.requestsLast30Days, 0);

  const rows = data.models.map(
    (row) => html`<tr>
      <td data-label="Model">
        <span class="mono small">${row.model.id}</span>
        <div class="muted xs">${row.model.displayName}</div>
      </td>
      <td data-label="State">${statePill(row.model.state)}</td>
      <td class="mono xs" data-label="Route">${row.model.route}</td>
      <td class="numeric" data-label="Input / 1M">${money(row.model.inputPer1MUsd)}</td>
      <td class="numeric" data-label="Output / 1M">${money(row.model.outputPer1MUsd)}</td>
      <td class="numeric" data-label="Members allowed">${row.membersAllowed}</td>
      <td class="numeric" data-label="Requests, 30 days">${row.requestsLast30Days}</td>
    </tr>`,
  );

  const table = html`<table class="table table--cards">
    <caption>The team catalogue. Prices are US dollars per one million tokens.</caption>
    <thead>
      <tr>
        <th scope="col">Model</th>
        <th scope="col">State</th>
        <th scope="col">Route</th>
        <th scope="col" class="numeric">Input / 1M</th>
        <th scope="col" class="numeric">Output / 1M</th>
        <th scope="col" class="numeric">Members allowed</th>
        <th scope="col" class="numeric">Requests, 30 days</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;

  return layout({
    ctx,
    title: "Models",
    subtitle: "The catalogue the gateway serves this team.",
    actions: html`<a class="button button--secondary" href="/rules">Rules and policy</a>`,
    content: html`<div class="grid">
      <div class="col-3">${card({ title: "Enabled", body: metric({ label: "Models", value: String(enabled), sub: "Available to every member" }) })}</div>
      <div class="col-3">${card({ title: "Approval required", body: metric({ label: "Models", value: String(approval), sub: "Only with an active grant", tone: "soft" }) })}</div>
      <div class="col-3">${card({ title: "Blocked", body: metric({ label: "Models", value: String(blocked), sub: "Never served, even with a grant", tone: blocked > 0 ? "blocked" : "neutral" }) })}</div>
      <div class="col-3">${card({ title: "Requests", body: metric({ label: "Last 30 days", value: String(totalRequests), sub: "Model unlocks and suggestions" }) })}</div>

      <section class="card col-12" aria-labelledby="catalogue-title">
        <header class="card__header">
          <div class="card__titles">
            <h2 class="card__title" id="catalogue-title">Catalogue</h2>
            <p class="card__subtitle">A blocked model stays blocked even when a member holds a grant.</p>
          </div>
        </header>
        <div class="card__body">${listBlock({
          mode: ctx.mode,
          isEmpty: data.models.length === 0,
          ready: tableWrap("Model catalogue", table),
          empty: emptyState({
            title: "No models in the catalogue",
            body: "Add models to the team policy before enrolling members.",
          }),
          retryHref: "/models",
          loadingLabel: "Loading models…",
        })}</div>
      </section>

      <div class="col-12">
        <p class="small muted">Prices come from the team catalogue. Allowance is enforced by the gateway per key; the console shows the current state, not a cap of its own.</p>
      </div>
    </div>`,
  });
}
