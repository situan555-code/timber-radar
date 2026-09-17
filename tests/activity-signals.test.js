// Regression tests for web/src/activity-signals.js.
// Run with: node --test web/tests/activity-signals.test.js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityChangeObservedAt,
  buildRecentlyChangedDelinquentSet,
  changeObservedWithinWindow,
  delinquencyKind,
  transferIsWithinWindow,
} from "../src/activity-signals.js";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const days = (n) => NOW - n * 86400000;

test("transferIsWithinWindow: recent transfer passes a finite window", () => {
  const e = { event_date: new Date(days(10)).toISOString().slice(0, 10) };
  assert.equal(transferIsWithinWindow(e, 90, NOW), true);
});

test("transferIsWithinWindow: old transfer fails a finite window", () => {
  const e = { event_date: "2018-01-01" };
  assert.equal(transferIsWithinWindow(e, 90, NOW), false);
});

test("transferIsWithinWindow: days=null (\"All\") always passes, even far in the past", () => {
  const e = { event_date: "1990-01-01" };
  assert.equal(transferIsWithinWindow(e, null, NOW), true);
});

// The specific bug flagged in review: a transfer with a missing or
// malformed event_date must be excluded from ANY finite window in both the
// map and the feed -- not silently pass one and not the other.
test("transferIsWithinWindow: missing event_date is excluded under a finite window", () => {
  const e = { event_date: null };
  assert.equal(transferIsWithinWindow(e, 90, NOW), false);
  assert.equal(transferIsWithinWindow({}, 7, NOW), false);
});

test("transferIsWithinWindow: malformed event_date is excluded under a finite window", () => {
  const e = { event_date: "not-a-date" };
  assert.equal(transferIsWithinWindow(e, 90, NOW), false);
});

test("transferIsWithinWindow: missing event_date still passes when days=null", () => {
  assert.equal(transferIsWithinWindow({ event_date: null }, null, NOW), true);
});

test("activityChangeObservedAt: prefers changed_at, then detected_at, then last_seen_at", () => {
  assert.equal(
    activityChangeObservedAt({ changed_at: "2026-09-01T00:00:00Z", detected_at: "2026-08-01T00:00:00Z" }),
    Date.parse("2026-09-01T00:00:00Z")
  );
  assert.equal(
    activityChangeObservedAt({ detected_at: "2026-08-01T00:00:00Z", last_seen_at: "2026-01-01T00:00:00Z" }),
    Date.parse("2026-08-01T00:00:00Z")
  );
  assert.equal(
    activityChangeObservedAt({ last_seen_at: "2026-01-01T00:00:00Z" }),
    Date.parse("2026-01-01T00:00:00Z")
  );
});

// The specific bug flagged in review: this must never fall back to
// event_date (the tax-year date), and must return null rather than throw
// or silently succeed when none of the observation fields are usable.
test("activityChangeObservedAt: never falls back to event_date, returns null when nothing parses", () => {
  assert.equal(activityChangeObservedAt({ event_date: "2025-01-01" }), null);
  assert.equal(activityChangeObservedAt({}), null);
  assert.equal(activityChangeObservedAt({ changed_at: "garbage", detected_at: "also-garbage" }), null);
});

test("changeObservedWithinWindow: a delinquency-change event lacking detected_at falls through safely", () => {
  // No changed_at, no detected_at, no last_seen_at at all.
  const e = { event_type: "TAX_DELINQUENCY_INCREASED", event_date: "2025-01-01" };
  assert.equal(changeObservedWithinWindow(e, 30, NOW), false);
});

test("changeObservedWithinWindow: uses last_seen_at when detected_at is absent", () => {
  const e = { last_seen_at: new Date(days(5)).toISOString() };
  assert.equal(changeObservedWithinWindow(e, 30, NOW), true);
});

test("buildRecentlyChangedDelinquentSet: only includes parcels with a recent, resolvable observation time", () => {
  const events = [
    { parcel_id: "A", event_type: "TAX_DELINQUENCY_INCREASED", detected_at: new Date(days(5)).toISOString() },
    { parcel_id: "B", event_type: "TAX_DELINQUENCY_DECREASED", detected_at: new Date(days(60)).toISOString() },
    { parcel_id: "C", event_type: "TAX_DELINQUENCY_INCREASED", event_date: "2025-01-01" }, // no detected_at at all
    { parcel_id: "D", event_type: "TAX_DELINQUENT", detected_at: new Date(days(1)).toISOString() }, // wrong type
  ];
  const set = buildRecentlyChangedDelinquentSet(events, 30, NOW);
  assert.deepEqual([...set].sort(), ["A"]);
});

test("delinquencyKind: null when not currently delinquent", () => {
  const active = new Map();
  const changed = new Set();
  assert.equal(delinquencyKind("P1", active, changed), null);
});

test("delinquencyKind: 'delinquent' when active but not recently changed", () => {
  const active = new Map([["P1", { amount: 100 }]]);
  const changed = new Set();
  assert.equal(delinquencyKind("P1", active, changed), "delinquent");
});

test("delinquencyKind: 'delinquent_changed' when active and recently changed", () => {
  const active = new Map([["P1", { amount: 100 }]]);
  const changed = new Set(["P1"]);
  assert.equal(delinquencyKind("P1", active, changed), "delinquent_changed");
});
