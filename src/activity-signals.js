/**
 * Shared, pure Activity signal predicates -- the single source of truth for
 * "is this transfer within window" / "what is this parcel's delinquency
 * kind right now" / "when did we actually observe this change".
 *
 * Before this module existed, computeCurrentSignalsByParcel() (ranked-list
 * badge + parcel-detail headline), computeMapActiveParcels() (map), and
 * renderActivityList() (feed) each reimplemented these rules independently
 * in main.js. That's exactly how the map/feed drifted out of sync earlier
 * (delinquency gated by a recency cutoff in one place but not another) and
 * how the amber "amount changed" indicator ended up keyed off the wrong
 * date field in only one of the two computations. Every caller -- current
 * (fixed 90-day) and interactive (pill-driven) alike -- must go through
 * these functions instead of inlining the date math again.
 *
 * No DOM/browser dependency here on purpose: this file is imported by
 * main.js as an ES module and also unit-tested directly under Node via
 * `node:test` (see web/tests/activity-signals.test.js), with no bundler
 * or browser environment required.
 */

export const TYPE_BUCKET = {
  TRANSFER_RECORDED: "transfer",
  TAX_DELINQUENT: "delinquent",
  TAX_DELINQUENCY_INCREASED: "delinquent",
  TAX_DELINQUENCY_DECREASED: "delinquent",
  TAX_DELINQUENCY_CLEARED: "delinquent",
};

export const DAY_MS = 86400000;

/**
 * Is this a transfer/sale event, and does it fall inside a `days`-wide
 * recency window ending now?
 *
 * `days === null` means "no cutoff" (the pill's "All" option) -- always
 * passes, historical date included, WITH NO upper-bound check either: "All"
 * is deliberately left as-is here (an undated or future-stamped record
 * showing up under "All" is a data-quality question for that record, not
 * something this function should silently filter). That's a conscious
 * choice, not an oversight -- revisit it only as an intentional decision to
 * also suppress those records under "All", not as an incidental side
 * effect of the upper-bound check below. Otherwise the event's
 * `event_date` MUST parse to a valid date and fall within the window: a
 * missing or malformed date is excluded from ANY finite window rather than
 * silently passing through, so the map and the feed can't disagree on
 * malformed data the way they used to when the feed's guard
 * (`if (cutoff && e.event_date)`) let an undated event through that the
 * map's `Date.parse` check would have dropped. Likewise a future-dated
 * event (`t > now`) is excluded from any finite window -- a transfer dated
 * tomorrow is not "within the last N days" no matter how small N is.
 */
export function transferIsWithinWindow(event, days, now = Date.now()) {
  if (days == null) return true;
  const t = Date.parse(event?.event_date);
  if (Number.isNaN(t)) return false;
  if (t > now) return false;
  return t >= now - days * DAY_MS;
}

/**
 * When did Timber Radar actually observe this event/change, as a
 * millisecond epoch? Tries `changed_at` first (a future, more explicit
 * field for sources that support it), then `detected_at` (the pipeline
 * run's own timestamp -- what today's sources actually populate), then
 * `last_seen_at`. Returns null if none of those parse, rather than ever
 * falling back to `event_date` -- for a delinquency diff event,
 * `event_date` is the underlying tax-year date (e.g. "2025-01-01"), not
 * when the change was detected, and using it here was the exact bug this
 * function exists to prevent from recurring.
 */
export function activityChangeObservedAt(event) {
  for (const candidate of [event?.changed_at, event?.detected_at, event?.last_seen_at]) {
    if (!candidate) continue;
    const t = Date.parse(candidate);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/**
 * Did we observe this event/change within the last `days` days? A
 * future-dated observation (`t > now`) is excluded -- clock skew or a bad
 * timestamp in the source data must not manifest as "changed recently".
 */
export function changeObservedWithinWindow(event, days, now = Date.now()) {
  if (days == null) return false;
  const t = activityChangeObservedAt(event);
  if (t == null) return false;
  if (t > now) return false;
  return t >= now - days * DAY_MS;
}

/**
 * Build the set of parcel_ids whose delinquency AMOUNT changed
 * (increased/decreased) within `days`, using the observation time -- not
 * the tax-year event_date -- so a parcel's amber "changed recently"
 * treatment tracks when Timber Radar actually saw the change.
 */
export function buildRecentlyChangedDelinquentSet(events, days, now = Date.now()) {
  const out = new Set();
  for (const e of events) {
    if (e.event_type !== "TAX_DELINQUENCY_INCREASED" && e.event_type !== "TAX_DELINQUENCY_DECREASED") continue;
    if (changeObservedWithinWindow(e, days, now)) out.add(e.parcel_id);
  }
  return out;
}

/**
 * A parcel's current delinquency kind: null (not currently delinquent),
 * "delinquent" (steady/unresolved), or "delinquent_changed" (amount moved
 * within the recently-changed window). This is the one place that priority
 * decision is made -- callers must not re-derive it from raw event lists.
 */
export function delinquencyKind(parcelId, delinquentActiveByParcel, recentlyChangedDelinquentParcels) {
  if (!delinquentActiveByParcel.has(parcelId)) return null;
  return recentlyChangedDelinquentParcels.has(parcelId) ? "delinquent_changed" : "delinquent";
}
