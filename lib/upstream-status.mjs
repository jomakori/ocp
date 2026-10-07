// The latest REAL upstream outcome, published on /health.upstream and /status.proxy.upstream.
// Pure classification plus a single-slot recorder: no I/O, and no provider call of any kind.
//
// WHY THIS EXISTS. /health already answers two questions and neither is this one. `auth`
// answers "does the credential work" (ADR 0010 / ADR 0014), and `stats.errors` answers "did
// something fail". Neither says WHICH upstream condition the last real request ended on — and
// the one condition an operator must NOT answer by renewing OAuth, and that a fallback-capable
// client must fail over on, is the subscription wall. That distinction lived only in free text:
// #481's review recorded a live `rate_limit_event` (`five_hour`, `overageStatus: "rejected"`,
// `overageDisabledReason: "out_of_credits"`) that the proxy reported as `upstreamRateLimits: 0`
// and `recentErrors: []` — the wall was invisible to every status OCP published.
//
// NO SYNTHETIC REQUEST, deliberately. An inference probe would spend the very quota it reports
// on, and a scheduled one would keep billing through the outage it exists to detect. So the
// signal is a side effect of traffic that already happened, and `unobserved` is a first-class
// answer rather than an error.
//
// TWO SOURCES, in authority order.
//  1. The CLI's structured `rate_limit_event` — the upstream's own ratelimit headers carried
//     as DATA (`status` / `rateLimitType` / `overageStatus` / `overageDisabledReason`). This is
//     the only place a quota rejection is stated structurally, and it is what this module
//     trusts for usage/quota. Only a REJECTED status counts: the CLI emits the same frame on
//     ordinary allowed traffic.
//  2. The request's own terminal outcome — a completed success, or the message it failed with.
//     Prose is a fallback, never the authority: an unmatched message lands in `other` rather
//     than being guessed into a category.
//
// WHAT IS NOT RECORDED: no error body, no token, no request or response text. The snapshot
// carries a category, an ISO timestamp and a stale flag — nothing an operator could not read
// off a dashboard.

import { isUpstreamRateLimit } from "./upstream-errors.mjs";

// How long a recorded outcome stays fresh. A completed request is evidence about the upstream
// at the moment it settled; past this age the field says `stale: true` rather than pretending
// the reading is current. Fifteen minutes is longer than the CLI's own retry bursts (three
// retries every five, observed during the wall) and shorter than any operator's shift.
export const UPSTREAM_STATUS_TTL_MS = 15 * 60 * 1000;

// The categories a completed request can report. `unobserved` is the state before any real
// request settles, published as an outcome VALUE so a consumer never has to read a missing
// field as a fact about the upstream.
export const UPSTREAM_OUTCOMES = ["success", "auth_rejected", "usage_limited", "other"];

// A CONCLUSIVE auth rejection only — the credential is the problem, so OAuth renewal is the
// remedy and only here. These are the shapes the auth probe and its consumers already key on.
const AUTH_REJECTION_PATTERNS = [
  /\bauthentication_error\b/i,
  /\bAPI Error:\s*401\b/i,
  /\b(?:failed to authenticate|authentication failed|invalid authentication credentials|invalid api key|token (?:has )?expired|expired oauth token)\b/i,
  /\b401\b[^\n]{0,40}\b(?:unauthorized|credential|token|auth)/i,
];

// A POSITIVE usage/quota signal, as the vendor and the CLI actually spell it. The first three
// entries are the OBSERVED wall strings that `upstream-errors`' generated set does not yet
// carry (`You've hit your session limit · resets 5am (UTC)`, `Out of credits…`), recorded here
// so this classifier does not inherit that gap — they name a qualified quota noun, which is the
// house rule that list enforces. Everything else is delegated to `isUpstreamRateLimit` rather
// than copied, so its set stays the one place "429 or not" is decided.
const USAGE_LIMIT_PATTERNS = [
  /\bsession limit\b/i,
  /\bout[ _-]?of[ _-]?credits\b/i,
  /\binsufficient credits\b/i,
  /\bno credits remaining\b/i,
  /\boverage\b/i,
];

// The CLI's `rate_limit_event`, read STRUCTURALLY. Returns the category it proves, or null when
// the frame is informational (an `allowed` status is the CLI's ordinary per-window report and
// must record nothing).
//
// The two spellings are accepted because the frame is produced by the CLI rather than by this
// repo: `rate_limit_info` is the outer key on the wire, and `rateLimitInfo` is accepted as
// belt-and-braces for a camelCase serializer.
export function classifyRateLimitEvent(event) {
  const info = event?.rate_limit_info ?? event?.rateLimitInfo;
  if (!info || typeof info !== "object") return null;
  const status = String(info.status ?? "").toLowerCase();
  const overageStatus = String(info.overageStatus ?? "").toLowerCase();
  const disabledReason = String(info.overageDisabledReason ?? "").toLowerCase();
  const rejected =
    status === "rejected" || overageStatus === "rejected" || disabledReason === "out_of_credits";
  return rejected ? "usage_limited" : null;
}

// Classify a terminal failure message. Usage is checked before auth because a subscription wall
// can arrive as a conclusive-looking rejection whose text names the real cause first; neither
// branch fires without a positive signal, so an unrecognised message is `other`, never a guess.
export function classifyUpstreamOutcome(message) {
  if (typeof message !== "string" || message === "") return "other";
  if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message)) || isUpstreamRateLimit(message)) {
    return "usage_limited";
  }
  if (AUTH_REJECTION_PATTERNS.some((pattern) => pattern.test(message))) return "auth_rejected";
  return "other";
}

// Record one completed request's outcome. Last write wins by design — the field reports the
// MOST RECENT outcome, and a caller must call this at most once per request (server.mjs resolves
// a single terminal outcome per lane and records there, not at every intermediate arm).
export function recordUpstreamOutcome(state, outcome, now = Date.now()) {
  if (!UPSTREAM_OUTCOMES.includes(outcome)) {
    throw new TypeError(`invalid upstream outcome: ${outcome}`);
  }
  state.outcome = outcome;
  state.observedAt = new Date(now).toISOString();
}

// The read-time view. A clock that has moved BEHIND the evidence is treated as stale too: an
// age it cannot trust is not evidence of freshness, and the alternative is a field whose `stale`
// flag depends on which way an NTP correction went.
export function upstreamStatusSnapshot(state, now = Date.now()) {
  if (!state.observedAt) return { outcome: "unobserved", observedAt: null, stale: false };
  const observedMs = Date.parse(state.observedAt);
  const ageMs = now - observedMs;
  const stale = !Number.isFinite(observedMs) || ageMs < 0 || ageMs > UPSTREAM_STATUS_TTL_MS;
  return { outcome: state.outcome, observedAt: state.observedAt, stale };
}
