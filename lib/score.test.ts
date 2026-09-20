import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { QUESTIONS } from "./questions.ts";
import type { Answers, Playbook } from "./questions.ts";
import { THRESHOLDS, WEIGHTS, scoreAnswers } from "./score.ts";
import type { Context } from "./score.ts";

type NoulId = { [K in keyof Answers]: Answers[K] extends { type: "noul" } ? K : never }[keyof Answers];

const NO_CONTEXT: Context = { hasSender: false, hasLinks: false };

/**
 * A benign answer set, with the named signals raised. Built from the real
 * catalogue so a new question cannot silently fall out of these tests.
 */
function makeAnswers(
  nouls: Partial<Record<NoulId, number>> = {},
  opts: { harm?: number; playbook?: Playbook; playbookConfidence?: number } = {},
): Answers {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(QUESTIONS)) {
    if (question.type === "noul") answers[id] = { type: "noul", noul: 0.02 };
  }
  answers["message_is_english"] = { type: "noul", noul: 0.99 };
  for (const [id, value] of Object.entries(nouls)) answers[id] = { type: "noul", noul: value };
  answers["harm_if_complied"] = {
    type: "score",
    score: opts.harm ?? 0,
    confidence: 0.9,
    legend: {},
    probabilities: {},
  };
  answers["playbook"] = {
    type: "choice",
    choice: opts.playbook ?? "looks_legitimate",
    confidence: opts.playbookConfidence ?? 0.9,
    probabilities: {},
  };
  return answers as unknown as Answers;
}

const reasonIds = (verdict: { reasons: Array<{ id: string }> }): string[] => verdict.reasons.map((r) => r.id);

test("a single hard signal is enough to call it a scam", () => {
  const verdict = scoreAnswers(makeAnswers({ requests_credential: 0.95 }), NO_CONTEXT);
  assert.equal(verdict.band, "scam");
  assert.ok(verdict.risk >= THRESHOLDS.scam);
  assert.equal(reasonIds(verdict)[0], "requests_credential");
  assert.ok(verdict.advice.length > 0);
});

test("urgency plus an authority claim is not enough on its own", () => {
  const verdict = scoreAnswers(makeAnswers({ creates_urgency: 0.9, claims_authority: 0.9 }), NO_CONTEXT);
  assert.equal(verdict.band, "clear");
  assert.ok(verdict.risk < THRESHOLDS.clear);
});

test("a genuine one-time-code message stays clear", () => {
  const verdict = scoreAnswers(
    makeAnswers(
      { requests_credential: 0.05, claims_authority: 0.95, creates_urgency: 0.3, is_routine_notification: 0.95 },
      { harm: 0.5 },
    ),
    NO_CONTEXT,
  );
  assert.equal(verdict.band, "clear");
  assert.equal(verdict.risk, 0);
});

test("a mismatched link only counts when the message actually had a link", () => {
  const answers = makeAnswers(
    { instructs_to_click_link: 0.95, link_host_matches_claim: 0.05, claims_authority: 0.9, creates_urgency: 0.8 },
    { harm: 1 },
  );

  const withLink = scoreAnswers(answers, { hasSender: false, hasLinks: true });
  const withoutLink = scoreAnswers(answers, NO_CONTEXT);

  assert.ok(withLink.risk > withoutLink.risk);
  assert.ok(reasonIds(withLink).includes("link_host_mismatch"));
  assert.ok(!reasonIds(withoutLink).includes("link_host_mismatch"));
  assert.equal(withLink.band, "scam");
  assert.equal(withoutLink.band, "unsure");
});

test("a sender mismatch is ignored when no sender was supplied", () => {
  const answers = makeAnswers({ sender_identity_mismatch: 0.9 });
  assert.ok(!reasonIds(scoreAnswers(answers, NO_CONTEXT)).includes("sender_identity_mismatch"));
  assert.ok(
    reasonIds(scoreAnswers(answers, { hasSender: true, hasLinks: false })).includes("sender_identity_mismatch"),
  );
});

test("the injection tripwire overrides a low score", () => {
  const verdict = scoreAnswers(makeAnswers({ contains_instruction_to_analyzer: 0.9 }), NO_CONTEXT);
  assert.equal(verdict.band, "injection");
  assert.ok(verdict.risk < THRESHOLDS.clear);
});

test("a message that is not English is refused before anything else", () => {
  const verdict = scoreAnswers(
    makeAnswers({ message_is_english: 0.2, contains_instruction_to_analyzer: 0.9, requests_credential: 0.99 }),
    NO_CONTEXT,
  );
  assert.equal(verdict.band, "cannot_judge");
});

test("a recognised scam shape blocks a clear verdict", () => {
  const verdict = scoreAnswers(makeAnswers({}, { playbook: "delivery_fee", playbookConfidence: 0.9 }), NO_CONTEXT);
  assert.equal(verdict.band, "unsure");
  assert.ok(verdict.advice[0]?.includes("courier"));
});

test("a confident legitimate reading is allowed to be clear", () => {
  const verdict = scoreAnswers(makeAnswers({}, { playbook: "looks_legitimate", playbookConfidence: 0.95 }), NO_CONTEXT);
  assert.equal(verdict.band, "clear");
});

test("at most five reasons are shown, strongest first", () => {
  const verdict = scoreAnswers(
    makeAnswers({
      requests_credential: 0.9,
      unusual_payment_method: 0.9,
      asks_to_install_or_screen_share: 0.9,
      asks_to_keep_secret: 0.9,
      creates_urgency: 0.9,
      threatens_consequence: 0.9,
      offers_unexpected_reward: 0.9,
    }),
    NO_CONTEXT,
  );
  assert.equal(verdict.reasons.length, 5);
  assert.deepEqual(reasonIds(verdict).slice(0, 4).sort(), [
    "asks_to_install_or_screen_share",
    "asks_to_keep_secret",
    "requests_credential",
    "unusual_payment_method",
  ]);
});

test("the soft weights still sum to one", () => {
  // If they drift, the soft term leaves 0..1 and every verdict shifts silently.
  const source = readFileSync(new URL("./score.ts", import.meta.url), "utf8");
  const weights = [...source.matchAll(/weight: ([0-9.]+)/g)].map((match) => Number(match[1]));

  assert.ok(weights.length >= 8);
  assert.equal(Number(weights.reduce((total, weight) => total + weight, 0).toFixed(6)), 1);
});

test("the harm term is scaled by the rubric, not by a hardcoded number", () => {
  const top = QUESTIONS.harm_if_complied.criteria.length - 1;

  // Top of the rubric must contribute exactly the harm weight, whatever the rubric length.
  const worst = scoreAnswers(makeAnswers({}, { harm: top }), NO_CONTEXT);
  const none = scoreAnswers(makeAnswers({}, { harm: 0 }), NO_CONTEXT);

  assert.equal(Number((worst.risk - none.risk).toFixed(6)), WEIGHTS.harm);
});

test("risk never leaves the 0 to 1 range", () => {
  const everything: Partial<Record<NoulId, number>> = {};
  for (const [id, question] of Object.entries(QUESTIONS)) {
    if (question.type === "noul") everything[id as NoulId] = 1;
  }
  everything.link_host_matches_claim = 0;
  everything.is_routine_notification = 0;
  everything.requests_no_action = 0;
  everything.is_personal_conversation = 0;

  const worst = scoreAnswers(makeAnswers(everything, { harm: 3 }), { hasSender: true, hasLinks: true });
  assert.equal(worst.risk, 1);

  const calm = scoreAnswers(makeAnswers({ is_routine_notification: 1 }), NO_CONTEXT);
  assert.equal(calm.risk, 0);
});
