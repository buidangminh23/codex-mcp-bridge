import test from "node:test";
import assert from "node:assert/strict";
import { renderAnalytics } from "../scripts/render-repo-analytics.mjs";

test("report escapes external strings and keeps missing metrics unavailable", () => {
  const html = renderAnalytics({ repo: '<script>alert("x")</script>', snapshots: [], daily: {} });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('Unavailable'));
  assert.ok(html.includes("script-src 'none'"));
});

test("partial collection displays previous values with original collection age", () => {
  const html = renderAnalytics({ repo: "owner/repo", snapshots: [
    { collectedAt: "2026-09-13T09:00:00Z", sourceCollectedAt: { views: "2026-09-13T08:00:00Z" }, views: { count: 41, uniques: 7, views: [] } },
    { collectedAt: "2026-09-14T09:00:00Z", errors: [{ source: "views", message: "<failed>" }] },
  ], daily: {} });
  assert.ok(html.includes('<strong>41</strong>'));
  assert.ok(html.includes('views: 2026-09-13T08:00:00Z'));
  assert.ok(html.includes('Partial collection'));
  assert.ok(html.includes('&lt;failed&gt;'));
  assert.ok(html.includes('Daily unique counts must not be added'));
});
