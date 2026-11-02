import type { ModelEntry, Rule, TeamPolicy } from "../../contracts.ts";
import { emptyState, field, fieldset, formError, listBlock, statusPill } from "../components.ts";
import type { PageContext } from "../data.ts";
import { minutesOfDay, money, weekdayList } from "../format.ts";
import { html, raw } from "../html.ts";
import { ruleSummary } from "../labels.ts";
import { layout } from "../layout.ts";
import type { StatusView } from "../status.ts";

const CHANNELS = ["teams", "slack", "email", "webhook", "log"] as const;

const DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

function enabledPill(enabled: boolean): StatusView {
  return enabled
    ? { tone: "ok", label: "On", title: "Rule is active", description: "On" }
    : { tone: "neutral", label: "Off", title: "Rule is off", description: "Off" };
}

function ruleForm(
  rule: Rule,
  ctx: PageContext,
  models: ModelEntry[],
  isNew: boolean,
): ReturnType<typeof html> {
  const action = isNew ? "/rules" : `/rules/${rule.id}`;
  const idPrefix = isNew ? "new" : rule.id;
  const topupValues =
    rule.condition.kind === "budget_topup" ? rule.condition : { maxUsd: 2, oncePerDays: 7 };
  const modelValues =
    rule.condition.kind === "model_unlock"
      ? rule.condition
      : { modelIds: [] as string[], durationHours: 4 };

  return html`<form method="post" action="${action}">
    <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
    <input type="hidden" name="returnTo" value="/rules">
    ${isNew ? "" : html`<input type="hidden" name="kind" value="${rule.condition.kind}">`}
    ${
      isNew
        ? html`<div class="field">
          <label class="field__label" for="new-kind">Rule type</label>
          <select id="new-kind" name="kind">
            <option value="budget_topup">Budget top-up</option>
            <option value="model_unlock">Model unlock</option>
          </select>
        </div>`
        : ""
    }
    <div class="field-row">
      ${field({
        id: `rule-name-${idPrefix}`,
        label: "Name",
        control: html`<input id="rule-name-${idPrefix}" name="name" type="text" value="${rule.name}" maxlength="80" required>`,
      })}
      ${field({
        id: `rule-max-${idPrefix}`,
        label: "Maximum top-up, USD",
        hint: "Budget top-up rules only.",
        control: html`<input id="rule-max-${idPrefix}" name="maxUsd" type="number" inputmode="decimal" min="0.01" step="0.01" value="${topupValues.maxUsd.toFixed(2)}">`,
      })}
      ${field({
        id: `rule-days-${idPrefix}`,
        label: "At most once every",
        hint: "Days. Budget top-up rules only.",
        control: html`<input id="rule-days-${idPrefix}" name="oncePerDays" type="number" inputmode="numeric" min="1" step="1" value="${String(topupValues.oncePerDays)}">`,
      })}
    </div>
    <div class="field-row" style="margin-top: 12px">
      ${field({
        id: `rule-models-${idPrefix}`,
        label: "Models to unlock",
        hint: "Comma-separated ids. Model unlock rules only.",
        control: html`<input id="rule-models-${idPrefix}" name="modelIds" type="text" value="${modelValues.modelIds.join(", ")}" placeholder="${models.find((model) => model.state === "approval-required")?.id ?? "flagship"}">`,
      })}
      ${field({
        id: `rule-hours-${idPrefix}`,
        label: "Unlock duration, hours",
        hint: "Model unlock rules only.",
        control: html`<input id="rule-hours-${idPrefix}" name="durationHours" type="number" inputmode="numeric" min="1" step="1" value="${String(modelValues.durationHours)}">`,
      })}
    </div>
    <div class="check" style="margin-top: 8px">
      <input id="rule-enabled-${idPrefix}" name="enabled" type="checkbox" value="1"${raw(rule.enabled ? " checked" : "")}>
      <label class="check__label" for="rule-enabled-${idPrefix}">Rule is enabled</label>
    </div>
    <div class="form-actions form-actions--end">
      <button class="button button--primary" type="submit">${isNew ? "Create rule" : "Save rule"}</button>
    </div>
  </form>`;
}

function ruleCard(rule: Rule, ctx: PageContext, models: ModelEntry[]): ReturnType<typeof html> {
  return html`<article class="card">
    <header class="card__header">
      <div class="card__titles">
        <h3 class="card__title">${rule.name}</h3>
        <p class="card__subtitle">${ruleSummary(rule, models)}</p>
      </div>
      ${statusPill(enabledPill(rule.enabled))}
    </header>
    <details class="disclosure">
      <summary>Edit rule</summary>
      <div style="margin-top: 8px">${ruleForm(rule, ctx, models, false)}</div>
    </details>
  </article>`;
}

export interface RulesPageInput {
  ctx: PageContext;
  rules: Rule[];
  policy: TeamPolicy;
  models: ModelEntry[];
  formError: string | null;
}

function policyForm(input: RulesPageInput): ReturnType<typeof html> {
  const { ctx, policy } = input;
  const selectedChannels = new Set(
    policy.notifications.filter((entry) => entry.enabled).map((entry) => entry.channel),
  );
  return html`<form method="post" action="/rules/policy">
    <input type="hidden" name="_csrf" value="${ctx.viewer.csrfToken}">
    <input type="hidden" name="returnTo" value="/rules">
    ${formError(input.formError)}
    <div class="grid">
      <div class="col-6">
        ${fieldset(
          "Off-hours window",
          html`<div class="check">
              <input id="offhours-enabled" name="offHoursEnabled" type="checkbox" value="1"${raw(policy.offHours.enabled ? " checked" : "")}>
              <label class="check__label" for="offhours-enabled">Block spend outside working hours</label>
            </div>
            <div class="field-row" style="margin-top: 8px">
              ${field({
                id: "offhours-tz",
                label: "Time zone",
                hint: "IANA name, for example Europe/Berlin.",
                control: html`<input id="offhours-tz" name="timeZone" type="text" value="${policy.offHours.timeZone}" required>`,
              })}
              ${field({
                id: "offhours-start",
                label: "Working hours start",
                control: html`<input id="offhours-start" name="start" type="time" value="${minutesOfDay(policy.offHours.startMinute)}" required>`,
              })}
              ${field({
                id: "offhours-end",
                label: "Working hours end",
                control: html`<input id="offhours-end" name="end" type="time" value="${minutesOfDay(policy.offHours.endMinute)}" required>`,
              })}
            </div>
            <div class="field" style="margin-top: 8px">
              <span class="field__label" id="working-days-label">Working days</span>
              <div class="row" role="group" aria-labelledby="working-days-label">
                ${DAYS.map(
                  (day) => html`<label class="check" style="padding-right: 8px">
                    <input name="workingDays" type="checkbox" value="${day.value}"${raw(policy.offHours.workingDays.includes(day.value) ? " checked" : "")}>
                    <span class="check__label">${day.label.slice(0, 3)}</span>
                  </label>`,
                )}
              </div>
            </div>
            ${field({
              id: "offhours-cap",
              label: "Off-hours cap, USD",
              hint: "Spend allowed outside working hours before the key is blocked.",
              control: html`<input id="offhours-cap" name="offHoursCapUsd" type="number" inputmode="decimal" min="0" step="0.01" value="${policy.offHours.capUsd.toFixed(2)}">`,
            })}
            ${field({
              id: "offhours-holidays",
              label: "Holidays",
              optional: true,
              hint: "One YYYY-MM-DD date per line, or comma-separated.",
              control: html`<textarea id="offhours-holidays" name="holidays" rows="2">${policy.offHours.holidays.join(", ")}</textarea>`,
            })}`,
        )}
      </div>
      <div class="col-6">
        ${fieldset(
          "Thresholds and grace",
          html`<div class="field-row">
              ${field({
                id: "soft-ratio",
                label: "Soft limit, %",
                hint: "Send a soft notice at this share of the budget.",
                control: html`<input id="soft-ratio" name="softRatio" type="number" inputmode="numeric" min="1" max="100" step="1" value="${String(Math.round(policy.thresholds.softRatio * 100))}">`,
              })}
              ${field({
                id: "grace-ratio",
                label: "Grace, %",
                hint: "Extra share allowed past the budget.",
                control: html`<input id="grace-ratio" name="graceRatio" type="number" inputmode="numeric" min="0" max="100" step="1" value="${String(Math.round(policy.thresholds.graceRatio * 100))}">`,
              })}
              ${field({
                id: "unusual-min",
                label: "Unusual spend minimum, USD",
                hint: "A window below this never raises an alert.",
                control: html`<input id="unusual-min" name="unusualSpendMinUsd" type="number" inputmode="decimal" min="0" step="0.01" value="${policy.unusualSpendMinUsd.toFixed(2)}">`,
              })}
            </div>
            <p class="field__hint" style="margin-top: 8px">Effective status: OK under the soft limit, Soft limit at or above it, Grace at or above 100%, Blocked at 100% plus grace.</p>
            <div class="field" style="margin-top: 12px">
              <span class="field__label" id="channels-label">Notification channels</span>
              <div class="row" role="group" aria-labelledby="channels-label">
                ${CHANNELS.map(
                  (channel) => html`<label class="check" style="padding-right: 8px">
                    <input name="channel" type="checkbox" value="${channel}"${raw(selectedChannels.has(channel) ? " checked" : "")}>
                    <span class="check__label">${channel}</span>
                  </label>`,
                )}
              </div>
              <p class="field__hint">Webhook URLs and mail settings come from the server environment, never from this form.</p>
            </div>`,
        )}
      </div>
    </div>
    <div class="form-actions form-actions--end">
      <button class="button button--primary" type="submit">Save policy</button>
    </div>
  </form>`;
}

export function renderRules(input: RulesPageInput): ReturnType<typeof layout> {
  const { ctx, rules, policy, models } = input;
  const newRule: Rule = {
    id: "",
    teamId: policy.teamId,
    name: "New rule",
    enabled: true,
    condition: { kind: "budget_topup", maxUsd: 2, oncePerDays: 7 },
    createdAt: ctx.now.toISOString(),
  };

  return layout({
    ctx,
    title: "Rules",
    subtitle: "Auto-approvals, the off-hours window and the thresholds the watcher applies.",
    actions: html`<a class="button button--secondary" href="#new-rule">New rule</a>`,
    content: html`<div class="grid">
      <section class="card col-12" aria-labelledby="rules-title">
        <header class="card__header">
          <div class="card__titles">
            <h2 class="card__title" id="rules-title">Auto-approve rules</h2>
            <p class="card__subtitle">The first enabled matching rule decides; the decision is logged as coming from the rule.</p>
          </div>
        </header>
        <div class="card__body">${listBlock({
          mode: ctx.mode,
          isEmpty: rules.length === 0,
          ready: html`<div class="stack">${rules.map((rule) => ruleCard(rule, ctx, models))}</div>`,
          empty: emptyState({
            title: "No auto-approve rules",
            body: "Every request waits for a manager until a rule matches it.",
            actionHref: "#new-rule",
            actionLabel: "Create the first rule",
          }),
          retryHref: "/rules",
          loadingLabel: "Loading rules…",
        })}</div>
      </section>

      <section class="card col-12" id="new-rule" aria-labelledby="new-rule-title">
        <h2 class="card__title" id="new-rule-title">Add a rule</h2>
        <p class="card__subtitle">A budget top-up or a temporary model unlock.</p>
        <div class="card__body" style="margin-top: 12px">${ruleForm(newRule, ctx, models, true)}</div>
      </section>

      <section class="card col-12" aria-labelledby="policy-title">
        <header class="card__header">
          <div class="card__titles">
            <h2 class="card__title" id="policy-title">Team policy</h2>
            <p class="card__subtitle">Off-hours ${policy.offHours.enabled ? "on" : "off"} · ${weekdayList(policy.offHours.workingDays)} ${minutesOfDay(policy.offHours.startMinute)}–${minutesOfDay(policy.offHours.endMinute)} ${policy.offHours.timeZone} · cap ${money(policy.offHours.capUsd)}</p>
          </div>
        </header>
        <div class="card__body">${policyForm(input)}</div>
      </section>

      <div class="col-12">
        <p class="small muted">Changing a rule or the policy makes the reconciler recompute desired key state. Gateway limits are exact per request; the watcher's off-hours cap is near-real-time.</p>
      </div>
    </div>`,
  });
}
