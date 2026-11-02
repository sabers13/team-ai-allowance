import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildPageData } from "../../src/report/page-data.ts";

const root = process.cwd();

test("page data is assembled only from committed evidence", () => {
  const data = buildPageData(root);

  assert.equal(data.live.clis.length, 3, "three CLIs, not the plugin entry");
  assert.equal(
    data.live.clis.every((cli) => cli.steps.every((step) => step.pass)),
    true,
  );
  assert.equal(data.summary.clisVerified, 3);
  assert.equal(data.summary.liveStepsPassed, data.summary.liveStepsTotal);
  assert.equal(data.teamTest.scenarioSummary.length, 4);
  assert.equal(data.teamTest.probes.length, 7);
  assert.equal(data.teamTest.probesPassed, 5);
  assert.equal(data.demo.steps.length, 11);
  assert.equal(data.simulation.label, "simulation");
  assert.equal(data.simulation.scenarios.length, 4);
  assert.equal(data.teamTest.decisions.length, 9);
  assert.equal(data.teamTest.shots.length, 4);
  assert.equal(
    data.teamTest.decisions.every(
      (decision, index) => index === 0 || decision.at >= data.teamTest.decisions[index - 1]!.at,
    ),
    true,
    "decisions keep the source order (oldest first)",
  );
});

test("every literal page fact still appears in its source file", () => {
  const data = buildPageData(root);
  for (const fact of data.facts) {
    assert.ok(!fact.source.startsWith("/"), `${fact.id} source is relative`);
    const source = readFileSync(join(root, fact.source), "utf8");
    if (fact.basis === "literal") {
      assert.ok(
        source.includes(String(fact.value)),
        `${fact.id}: ${String(fact.value)} is missing from ${fact.source}`,
      );
    }
  }
});

test("the page data records the streaming-cost finding", () => {
  const data = buildPageData(root);
  const finding = data.teamTest.whatWentWrong.find((item) => item.summary.includes("costUsd 0"));
  assert.ok(finding, "the streaming zero-cost finding is present");
  assert.match(finding.detail, /12,896,452/);
  assert.equal(data.summary.zeroCostRows, 317);
  assert.equal(data.summary.totalRows, 369);
});
