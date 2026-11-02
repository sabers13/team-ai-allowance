import type { Period } from "../../contracts.ts";
import {
  card,
  emptyState,
  field,
  formError,
  listBlock,
  statusPill,
  tableWrap,
} from "../components.ts";
import type { PageContext, SetupData } from "../data.ts";
import { dateOnly, dateTime, initials } from "../format.ts";
import { html, raw } from "../html.ts";
import { periodLabel, roleLabel } from "../labels.ts";
import { layout } from "../layout.ts";
import { statusView } from "../status.ts";

export interface SetupReveal {
  displayName: string;
  keyAlias: string;
  secret: string;
  memberId: string;
}

export interface SetupPageInput {
  ctx: PageContext;
  data: SetupData;
  reveal: SetupReveal | null;
  formError: string | null;
}

function doctorCell(value: boolean): ReturnType<typeof html> {
  return value
    ? html`<span class="doctor-ok">Yes</span>`
    : html`<span class="doctor-bad">No</span>`;
}

function enrolCard(input: SetupPageInput): ReturnType<typeof html> {
  const { ctx } = input;
  const reveal =
    input.reveal === null
      ? ""
      : html`<div class="banner banner--info" role="status">
          <div class="banner__text">
            <p class="banner__title">${input.reveal.displayName} is enrolled. Copy the key now.</p>
            <p class="banner__message">The key is shown once and only its hash is stored. Alias ${input.reveal.keyAlias}.</p>
            <pre class="secret">${input.reveal.secret}</pre>
            <p style="margin-top: 8px"><a class="button button--secondary button--sm" href="/setup/bundle/${input.reveal.memberId}">Download the config bundle</a></p>
          </div>
        </div>`;

  return card({
    id: "enrol",
    title: "Add a member",
    subtitle: "Creates the member, a gateway key and a per-CLI config bundle.",
    body: html`${reveal}${formError(input.formError)}
      <form method="post" action="/setup/members">
        <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
        <input type="hidden" name="returnTo" value="/setup">
        <div class="field-row">
          ${field({
            id: "enrol-name",
            label: "Display name",
            hint: "An invented first name is enough for a demo.",
            control: html`<input id="enrol-name" name="displayName" type="text" maxlength="60" required autocomplete="off">`,
          })}
          ${field({
            id: "enrol-email",
            label: "E-mail",
            optional: true,
            hint: "Used only for manager sign-in and notices.",
            control: html`<input id="enrol-email" name="email" type="email" maxlength="120" autocomplete="off">`,
          })}
          ${field({
            id: "enrol-role",
            label: "Role",
            control: html`<select id="enrol-role" name="role">
              <option value="member">Member</option>
              <option value="manager">Manager</option>
            </select>`,
          })}
        </div>
        <div class="field-row" style="margin-top: 12px">
          ${field({
            id: "enrol-budget",
            label: "Budget, USD",
            hint: "The member's own period budget.",
            control: html`<input id="enrol-budget" name="budgetUsd" type="number" inputmode="decimal" min="0.01" step="0.01" value="20.00" required>`,
          })}
          ${field({
            id: "enrol-period",
            label: "Period",
            control: html`<select id="enrol-period" name="period">
              ${(["daily", "weekly", "monthly"] as const).map(
                (period: Period) =>
                  html`<option value="${period}"${raw(period === "weekly" ? " selected" : "")}>${periodLabel(period)}</option>`,
              )}
            </select>`,
          })}
        </div>
        <div class="form-actions form-actions--end">
          <button class="button button--primary" type="submit">Create member and key</button>
        </div>
      </form>
      <p class="xs muted" style="margin-top: 8px">The member's key is never shown again and is never sent to the browser once this page is left.</p>`,
  });
}

function membersCard(input: SetupPageInput): ReturnType<typeof html> {
  const { ctx, data } = input;
  const rows = data.members.map((row) => {
    const status = statusView(row.policy, row.spendUsd);
    const lastReport = row.reports.reduce<string | null>(
      (latest, report) => (latest === null || report.at > latest ? report.at : latest),
      null,
    );
    return html`<tr>
      <td data-label="Member">
        <span class="member-name">
          <span class="avatar" aria-hidden="true">${initials(row.member.displayName)}</span>
          <a class="member-name__text" href="/members/${row.member.id}">${row.member.displayName}</a>
        </span>
      </td>
      <td data-label="Role">${roleLabel(row.member.role)}</td>
      <td data-label="Alias"><span class="mono xs">${row.member.keyAlias}</span></td>
      <td data-label="Status">${statusPill(status)}</td>
      <td data-label="Last doctor" class="nowrap">${lastReport === null ? "Never" : dateTime(lastReport, ctx.timeZone)}</td>
      <td data-label="Bundle"><a href="/setup/bundle/${row.member.id}">Download</a></td>
    </tr>`;
  });

  const table = html`<table class="table table--cards">
    <caption>Members, their key alias and the last doctor report.</caption>
    <thead><tr>
      <th scope="col">Member</th><th scope="col">Role</th><th scope="col">Alias</th>
      <th scope="col">Status</th><th scope="col">Last doctor</th><th scope="col">Bundle</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  return card({
    title: "Members and bundles",
    subtitle: "Each bundle carries the key in an env file and the per-CLI config for this member.",
    body: listBlock({
      mode: ctx.mode,
      isEmpty: data.members.length === 0,
      ready: tableWrap("Members and bundles", table),
      empty: emptyState({
        title: "No members yet",
        body: "Create the first member above to get a key and a config bundle.",
        actionHref: "#enrol",
        actionLabel: "Add a member",
      }),
      retryHref: "/setup",
      loadingLabel: "Loading members…",
    }),
  });
}

function packCard(input: SetupPageInput): ReturnType<typeof html> {
  const { data } = input;
  return card({
    title: "Managed config pack",
    subtitle: `Version ${data.packVersion ?? "not generated"}. Installs the lock-down files for Claude Code, OpenCode and Codex.`,
    body: listBlock({
      mode: input.ctx.mode,
      isEmpty: data.packFiles.length === 0,
      ready: html`<ul class="stack stack--tight" style="list-style: none">
        ${data.packFiles.map(
          (file) => html`<li class="row row--between">
            <span class="mono small">${file}</span>
            <span class="xs muted">root-owned, mode 0644</span>
          </li>`,
        )}
      </ul>
      <p class="small muted" style="margin-top: 12px">The pack is generated once per team. The install script prints each file and asks before writing; it never uses sudo on a host.</p>`,
      empty: emptyState({
        title: "No pack generated",
        body: "The setup pack is generated from the team policy. It appears here once the generator has run.",
      }),
      retryHref: "/setup",
      loadingLabel: "Loading the pack…",
    }),
  });
}

function doctorCard(input: SetupPageInput): ReturnType<typeof html> {
  const { ctx, data } = input;
  const reports = data.members.flatMap((row) =>
    row.reports.map((report) => ({ member: row.member, report })),
  );

  const rows = reports.map(
    ({ member, report }) => html`<tr>
      <td data-label="Member">${member.displayName}</td>
      <td data-label="CLI">
        <span class="mono small">${report.cli}</span>
        <span class="xs muted"> ${report.version}</span>
        ${report.notes.length === 0 ? "" : html`<div class="xs muted">${report.notes.join(" · ")}</div>`}
      </td>
      <td data-label="Gateway">${doctorCell(report.gatewayOk)}</td>
      <td data-label="MCP">${doctorCell(report.mcpOk)}</td>
      <td data-label="Managed config">${doctorCell(report.managedConfig)}</td>
      <td data-label="Checked" class="nowrap" title="${report.at}">${dateOnly(report.at, ctx.timeZone)}</td>
    </tr>`,
  );

  const table = html`<table class="table table--cards">
    <caption>The last doctor report per member and CLI. Doctor checks the gateway route, MCP registration and managed config.</caption>
    <thead><tr>
      <th scope="col">Member</th><th scope="col">CLI</th>
      <th scope="col">Gateway</th><th scope="col">MCP</th><th scope="col">Managed config</th>
      <th scope="col">Checked</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  return card({
    title: "Doctor reports",
    subtitle:
      "Last known state of each member's CLIs. A failed row is visible before the member loses a call.",
    body: listBlock({
      mode: ctx.mode,
      isEmpty: reports.length === 0,
      ready: tableWrap("Doctor reports", table),
      empty: emptyState({
        title: "No doctor reports",
        body: "A member's CLI posts a report when `taa doctor` runs.",
      }),
      retryHref: "/setup",
      loadingLabel: "Loading doctor reports…",
    }),
  });
}

export function renderSetup(input: SetupPageInput): ReturnType<typeof layout> {
  const { ctx, data } = input;
  return layout({
    ctx,
    title: "Setup",
    subtitle: `Enrolment and lock-down for ${data.team.name}.`,
    content: html`<div class="grid">
      <div class="col-7">${enrolCard(input)}</div>
      <div class="col-5">
        ${card({
          title: "Gateway",
          subtitle: "The control service's own connection to LiteLLM.",
          body: html`<p class="row" style="gap: 8px">
            ${
              data.gatewayHealthy
                ? html`<span class="pill pill--ok"><span class="pill__dot" aria-hidden="true"></span>Reachable</span>`
                : html`<span class="pill pill--blocked"><span class="pill__dot" aria-hidden="true"></span>Unreachable</span>`
            }
            <span class="muted small">checked ${dateTime(data.gatewayCheckedAt, ctx.timeZone)}</span>
          </p>
          <p class="xs muted" style="margin-top: 8px">If the gateway is unreachable, decisions still record but key changes wait for the next reconcile.</p>`,
        })}
      </div>
      <div class="col-12">${membersCard(input)}</div>
      <div class="col-5">${packCard(input)}</div>
      <div class="col-7">${doctorCard(input)}</div>
    </div>`,
  });
}
