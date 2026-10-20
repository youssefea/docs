/**
 * Review history: what this reviewer already said on earlier commits of the
 * same pull request.
 *
 * Without it, every push got a fresh review of the whole PR. Once the author
 * applied round 1's suggestions, the next round reviewed that same text again
 * (text the reviewer had written itself), found new wording to change, and
 * sometimes reversed its own advice. Authors saw a reviewer that "flags new
 * issues every time I push".
 *
 * Follow-up rounds now get:
 *   - the previous findings and suggested text (so accepted suggestions are
 *     recognized and not re-flagged),
 *   - only the diff since the last reviewed commit (so earlier lines are not
 *     reviewed again), and
 *   - a code-enforced scope (applyFollowUpScope) so non-blocking findings
 *     outside that diff, and all non-blocking writing findings, are dropped
 *     even if the model ignores the prompt.
 *
 * State is stored as a hidden marker in the sticky summary comment. Anyone
 * with write access can edit that comment, so it is parsed as untrusted data:
 * every field is validated and the content is only ever placed inside
 * <untrusted_*> tags in the prompt.
 */

import { isWorkflowBot } from "./github.mjs";

export const STATE_PREFIX = "<!-- docs-pr-review:state ";
const STATE_SUFFIX = " -->";
const SHA_RE = /^[0-9a-f]{40}$/;
const REVIEW_SHA_RE = /<!-- docs-pr-review:sha=([0-9a-f]{40}) -->/;
const SEVERITIES = new Set(["blocking", "suggestion"]);
const CATEGORIES = new Set(["placement", "duplication", "consistency", "accuracy", "writing"]);

/** Previous findings kept across rounds; oldest are dropped first. */
export const MAX_STATE_FINDINGS = 30;
const MAX_TITLE = 120;
const MAX_REPLACEMENT = 600;
/** The compare API returns at most 300 files; a full page may be truncated. */
const COMPARE_FILE_LIMIT = 300;

const asLine = (v) => (Number.isInteger(v) && v > 0 && v < 100000 ? v : null);
const clip = (s, n) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

/** Shape a finding for storage and for the prompt. Returns null if unusable. */
export function normalizeFinding(f) {
  if (!f || typeof f !== "object") return null;
  if (typeof f.file !== "string" || !/^docs\/\S+$/.test(f.file)) return null;
  const title = clip(f.title, MAX_TITLE);
  if (!title) return null;
  return {
    file: f.file,
    line: asLine(f.line),
    severity: SEVERITIES.has(f.severity) ? f.severity : null,
    category: CATEGORIES.has(f.category) ? f.category : null,
    title,
    replacement: clip(f.replacement, MAX_REPLACEMENT),
  };
}

/** Hidden marker carrying the review state. `<` and `>` are escaped so the JSON can never end the HTML comment early. */
export function renderState({ sha, round, findings }) {
  const json = JSON.stringify({
    v: 1,
    sha,
    round,
    findings: findings.map(normalizeFinding).filter(Boolean).slice(-MAX_STATE_FINDINGS),
  })
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  return `${STATE_PREFIX}${json}${STATE_SUFFIX}`;
}

/** Parse and validate the state marker from a summary comment body. Null when absent or invalid. */
export function parseState(body) {
  if (typeof body !== "string") return null;
  const start = body.indexOf(STATE_PREFIX);
  if (start < 0) return null;
  const end = body.indexOf(STATE_SUFFIX, start + STATE_PREFIX.length);
  if (end < 0) return null;
  let raw;
  try {
    raw = JSON.parse(body.slice(start + STATE_PREFIX.length, end));
  } catch {
    return null;
  }
  if (!raw || raw.v !== 1 || !SHA_RE.test(raw.sha) || !Number.isInteger(raw.round) || raw.round < 1 || raw.round > 1000) {
    return null;
  }
  const findings = (Array.isArray(raw.findings) ? raw.findings : [])
    .map(normalizeFinding)
    .filter(Boolean)
    .slice(-MAX_STATE_FINDINGS);
  return { sha: raw.sha, round: raw.round, findings };
}

/**
 * History for PRs reviewed before the state marker existed: the last reviewed
 * SHA comes from the inline review marker, and previous suggestions from the
 * bot's inline comments ("**Title**" ... "```suggestion" block).
 */
export function historyFromReviews(reviews = [], reviewComments = []) {
  const ours = reviews
    .filter((r) => isWorkflowBot(r.user) && REVIEW_SHA_RE.test(r.body || ""))
    .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
  if (!ours.length) return null;
  const ids = new Set(ours.map((r) => r.id));
  const findings = reviewComments
    .filter((c) => isWorkflowBot(c.user) && ids.has(c.pull_request_review_id))
    .map((c) => {
      const body = c.body || "";
      const suggestion = body.match(/(`{3,})suggestion\n([\s\S]*?)\n\1/);
      return normalizeFinding({
        file: c.path,
        line: c.line ?? c.original_line,
        title: body.match(/^\*\*(.+?)\*\*/)?.[1],
        replacement: suggestion ? suggestion[2] : null,
      });
    })
    .filter(Boolean)
    .slice(-MAX_STATE_FINDINGS);
  return { sha: ours.at(-1).body.match(REVIEW_SHA_RE)[1], round: ours.length, findings };
}

/**
 * Load what the previous review said. Returns null for a first review.
 * @returns {Promise<null | {previousSha: string, round: number, findings: Array, source: "state"|"reviews"}>}
 */
export async function loadHistory({ gh, prNumber, comments, stickyMarker }) {
  const sticky = comments.find((c) => isWorkflowBot(c.user) && c.body?.startsWith(stickyMarker));
  const state = sticky ? parseState(sticky.body) : null;
  if (state) return { previousSha: state.sha, round: state.round + 1, findings: state.findings, source: "state" };

  const [reviews, reviewComments] = await Promise.all([gh.listReviews(prNumber), gh.listReviewComments(prNumber)]);
  const legacy = historyFromReviews(reviews, reviewComments);
  if (!legacy) return null;
  return { previousSha: legacy.sha, round: legacy.round + 1, findings: legacy.findings, source: "reviews" };
}

/**
 * Per-file patches for what changed between the previous review and the head,
 * limited to `files`. Returns null when that cannot be computed reliably
 * (history rewritten by a force-push, a truncated file list, or an API error);
 * the caller then reviews the full PR diff under the follow-up rules.
 */
export async function changesSince({ gh, previousSha, headSha, files }) {
  try {
    const cmp = await gh.compareCommits(previousSha, headSha);
    if (cmp.status !== "ahead" && cmp.status !== "identical") return null;
    const list = Array.isArray(cmp.files) ? cmp.files : [];
    if (list.length >= COMPARE_FILE_LIMIT) return null;
    const out = new Map();
    for (const f of list) if (files.has(f.filename)) out.set(f.filename, f.patch || "");
    return out;
  } catch (err) {
    console.warn(`::warning title=Changes since previous review unavailable::${err.message}`);
    return null;
  }
}

/** Head-side line numbers of lines a patch adds. */
export function addedLines(patch = "") {
  const lines = new Set();
  let newLine = 0;
  for (const row of patch.split("\n")) {
    const h = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      newLine = Number(h[1]);
      continue;
    }
    if (!newLine || row.startsWith("-") || row.startsWith("\\")) continue;
    if (row.startsWith("+")) lines.add(newLine);
    if (row.startsWith("+") || row.startsWith(" ")) newLine++;
  }
  return lines;
}

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * True when the head lines a finding points at are text from one of the
 * reviewer's previous suggestions (applied word for word, or the suggestion
 * is a part of those lines). Very short lines are ignored so that a common
 * phrase is not mistaken for an applied suggestion.
 */
export function isAcceptedSuggestion(f, previous, head) {
  if (!f.line || typeof head !== "string") return false;
  const lines = head.split("\n").slice(f.line - 1, f.endLine ?? f.line);
  const target = squash(lines.join(" "));
  if (target.length < 20) return false;
  return previous.some((p) => {
    if (p.file !== f.file || !p.replacement) return false;
    const suggested = squash(p.replacement.replace(/…$/, "")); // stored suggestions may be clipped
    return suggested.length >= 20 && (suggested.includes(target) || target.includes(suggested));
  });
}

/**
 * Code-enforced follow-up scope. Blocking findings always stay. In a follow-up
 * round, a non-blocking finding is dropped when it:
 *   - is about wording (category "writing"),
 *   - points at text the author took from a previous suggestion, or
 *   - does not touch a line added since the previous review (when known).
 *
 * @param {Array} findings
 * @param {object|null} history  loadHistory() result plus `since`
 * @param {Map<string,string|null>} heads  file -> PR head content
 * @returns {{kept: Array, suppressed: Array}}
 */
export function applyFollowUpScope(findings, history, heads = new Map()) {
  if (!history) return { kept: findings, suppressed: [] };
  const kept = [];
  const suppressed = [];
  for (const f of findings) {
    if (f.severity === "blocking") {
      kept.push(f);
      continue;
    }
    let inScope = f.category !== "writing" && !isAcceptedSuggestion(f, history.findings ?? [], heads.get(f.file));
    if (inScope && history.since) {
      const patch = history.since.get(f.file);
      if (!patch || !f.line) {
        inScope = false;
      } else {
        const added = addedLines(patch);
        const end = f.endLine ?? f.line;
        inScope = false;
        for (let n = f.line; n <= end; n++) if (added.has(n)) inScope = true;
      }
    }
    (inScope ? kept : suppressed).push(f);
  }
  return { kept, suppressed };
}

/** State to store after this round: earlier findings plus this round's. */
export function nextState({ history, headSha, findings }) {
  return {
    sha: headSha,
    round: history ? history.round : 1,
    findings: [...(history?.findings ?? []), ...findings],
  };
}
