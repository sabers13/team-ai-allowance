import assert from "node:assert/strict";
import { test } from "node:test";
import { classes, escapeHtml, type Html, html, join, raw } from "../../src/console/html.ts";

test("interpolated text is escaped", () => {
  const name = '<script>alert("x")</script>';
  const page = html`<p>${name}</p>`;
  assert.equal(page.value, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
});

test("quotes in attributes are escaped", () => {
  const value = 'x" onmouseover="alert(1)';
  const page = html`<a title="${value}">link</a>`;
  assert.equal(page.value.includes('onmouseover="alert(1)"'), false);
  assert.equal(page.value.includes("&quot;"), true);
});

test("nested Html is not escaped twice", () => {
  const inner = html`<strong>Lena</strong>`;
  const outer = html`<p>${inner}</p>`;
  assert.equal(outer.value, "<p><strong>Lena</strong></p>");
});

test("raw marks trusted markup", () => {
  assert.equal(html`${raw("<b>safe</b>")}`.value, "<b>safe</b>");
});

test("arrays render in order and null, undefined and false render nothing", () => {
  const page = html`<ul>${[html`<li>a</li>`, null, undefined, false, html`<li>b</li>`]}</ul>`;
  assert.equal(page.value, "<ul><li>a</li><li>b</li></ul>");
});

test("numbers and undefined slots", () => {
  const values: Html[] = [html`${1}`, html``, html`${0}`];
  assert.equal(join(values).value, "10");
});

test("escapeHtml handles all five characters", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("classes drops empty values", () => {
  assert.equal(classes("a", "", null, undefined, false, "b"), "a b");
});
