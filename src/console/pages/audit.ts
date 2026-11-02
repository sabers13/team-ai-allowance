import type { AuditEvent } from "../../contracts.ts";
import { emptyState, field, listBlock, tableWrap } from "../components.ts";
import type { PageContext } from "../data.ts";
import { dateTime, plural } from "../format.ts";
import { html, raw } from "../html.ts";
import { layout } from "../layout.ts";

export interface AuditFilterForm {
  actorId: string | null;
  objectType: string | null;
  objectId: string | null;
  from: string | null;
  to: string | null;
}

export interface AuditPageInput {
  ctx: PageContext;
  events: AuditEvent[];
  actors: Array<{ id: string; name: string }>;
  filter: AuditFilterForm;
  limit: number;
  offset: number;
}

function jsonBlock(value: unknown): string {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pageHref(filter: AuditFilterForm, offset: number): string {
  const params = new URLSearchParams();
  if (filter.actorId !== null) params.set("actorId", filter.actorId);
  if (filter.objectType !== null) params.set("objectType", filter.objectType);
  if (filter.objectId !== null) params.set("objectId", filter.objectId);
  if (filter.from !== null) params.set("from", filter.from);
  if (filter.to !== null) params.set("to", filter.to);
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  return query === "" ? "/audit" : `/audit?${query}`;
}

export function renderAudit(input: AuditPageInput): ReturnType<typeof layout> {
  const { ctx, events, actors, filter, limit, offset } = input;

  const filterForm = html`<form class="filter-bar" method="get" action="/audit" aria-label="Filter audit events">
    <div class="field">
      <label class="field__label" for="audit-actor">Actor</label>
      <select id="audit-actor" name="actorId">
        <option value="">All actors</option>
        ${actors.map(
          (actor) =>
            html`<option value="${actor.id}"${raw(filter.actorId === actor.id ? " selected" : "")}>${actor.name}</option>`,
        )}
      </select>
    </div>
    <div class="field">
      <label class="field__label" for="audit-object">Object type</label>
      <input id="audit-object" name="objectType" type="text" value="${filter.objectType ?? ""}" placeholder="member, request, rule">
    </div>
    ${field({
      id: "audit-object-id",
      label: "Object id",
      optional: true,
      control: html`<input id="audit-object-id" name="objectId" type="text" value="${filter.objectId ?? ""}" placeholder="mem_…">`,
    })}
    ${field({
      id: "audit-from",
      label: "From",
      control: html`<input id="audit-from" name="from" type="date" value="${filter.from ?? ""}">`,
    })}
    ${field({
      id: "audit-to",
      label: "To",
      control: html`<input id="audit-to" name="to" type="date" value="${filter.to ?? ""}">`,
    })}
    <div class="field">
      <span class="field__label">&nbsp;</span>
      <div class="row">
        <button class="button button--secondary" type="submit">Filter</button>
        <a class="button button--quiet" href="/audit">Clear</a>
      </div>
    </div>
  </form>`;

  const rows = events.map(
    (event) => html`<tr>
      <td class="nowrap" data-label="When" title="${event.at}">${dateTime(event.at, ctx.timeZone)}</td>
      <td data-label="Actor">
        ${event.actor.displayName ?? event.actor.type}
        <div class="xs muted">${event.actor.type}</div>
      </td>
      <td data-label="Action"><span class="mono small">${event.action}</span></td>
      <td data-label="Object">
        <span class="small">${event.objectType}</span>
        <div class="xs muted mono">${event.objectId}</div>
      </td>
      <td class="muted small" data-label="Reason">${event.reason ?? "—"}</td>
      <td data-label="Before and after">
        <details class="audit-details">
          <summary>Show</summary>
          <div class="grid audit-json">
            <div><p class="xs muted">Before</p><pre>${jsonBlock(event.before)}</pre></div>
            <div><p class="xs muted">After</p><pre>${jsonBlock(event.after)}</pre></div>
          </div>
        </details>
      </td>
    </tr>`,
  );

  const table = html`<table class="table table--cards">
    <caption>Newest first. The log is append-only; every change writes one event.</caption>
    <thead><tr>
      <th scope="col">When</th>
      <th scope="col">Actor</th>
      <th scope="col">Action</th>
      <th scope="col">Object</th>
      <th scope="col">Reason</th>
      <th scope="col">Before and after</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  const first = events.length === 0 ? 0 : offset + 1;
  const last = offset + events.length;
  const pagination = html`<div class="row row--between" style="margin-top: 12px">
    <p class="small muted">Showing ${first}–${last} ${plural(events.length, "event", "events")}${filter.actorId === null && filter.objectType === null && filter.from === null && filter.to === null ? "" : " for these filters"}.</p>
    <div class="row">
      ${offset > 0 ? html`<a class="button button--secondary button--sm" href="${pageHref(filter, Math.max(0, offset - limit))}">Previous</a>` : ""}
      ${events.length === limit ? html`<a class="button button--secondary button--sm" href="${pageHref(filter, offset + limit)}">Next</a>` : ""}
    </div>
  </div>`;

  return layout({
    ctx,
    title: "Audit",
    subtitle: "Every mutation, with before and after. Nothing is edited or removed.",
    content: html`<section class="card" aria-labelledby="audit-title">
      <header class="card__header">
        <div class="card__titles">
          <h2 class="card__title" id="audit-title">Log</h2>
          <p class="card__subtitle">Filter by actor, object type or date. The export is available from the manager API.</p>
        </div>
      </header>
      <div class="card__body">
        ${filterForm}
        ${listBlock({
          mode: ctx.mode,
          isEmpty: events.length === 0,
          ready: html`${tableWrap("Audit events", table)}${pagination}`,
          empty: emptyState({
            title: "No audit events match",
            body: "Every decision, limit change and key action lands here. Widen the filters to see more.",
            actionHref: "/audit",
            actionLabel: "Clear filters",
          }),
          retryHref: "/audit",
          loadingLabel: "Loading audit events…",
        })}
      </div>
    </section>`,
  });
}
