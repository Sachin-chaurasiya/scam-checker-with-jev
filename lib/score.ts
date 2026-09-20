import { QUESTIONS } from "./questions.ts";
import type { Answers, Playbook } from "./questions.ts";

/**
 * Turns Jev's answers into a verdict. Pure, synchronous, no network: every
 * threshold and weight the product depends on lives here, so `scripts/eval.ts`
 * can tune this file and nothing else.
 */

export type Band = "cannot_judge" | "injection" | "scam" | "unsure" | "clear";

export interface Reason {
  id: string;
  text: string;
  /** The model's probability for this signal, 0 to 1. */
  strength: number;
}

export interface Verdict {
  band: Band;
  title: string;
  detail: string;
  advice: string[];
  reasons: Reason[];
  /** Combined risk, 0 to 1. Exposed for the eval harness and for debugging. */
  risk: number;
  playbook: Playbook;
  playbookConfidence: number;
}

export interface Context {
  hasSender: boolean;
  hasLinks: boolean;
}

/**
 * Seed weights. They are deliberately simple and additive so that a wrong
 * verdict can be explained by pointing at one number. Tune with `pnpm eval`.
 */
export const WEIGHTS = {
  hard: 0.7,
  soft: 0.45,
  link: 0.35,
  mismatch: 0.2,
  harm: 0.15,
  damp: 0.5,
} as const;

export const THRESHOLDS = {
  /**
   * At or above this, the verdict is "looks like a scam". Picked from the middle
   * of the flat region of a threshold sweep over fixtures/messages.jsonl, where
   * 0.22 to 0.30 all gave 93% recall at zero false alarms.
   */
  scam: 0.25,
  /**
   * At or below this, the verdict is "no scam signals found". Set below the
   * lowest-scoring scam in the labelled set, so a scam lands in "unsure" rather
   * than being cleared.
   */
  clear: 0.15,
  /** A signal has to reach this to be shown to the user as a reason. */
  signal: 0.55,
  /** Below this, the playbook label is too uncertain to put in the headline. */
  playbookConfidence: 0.5,
  /** Below this, the message is treated as not English. */
  english: 0.5,
  /** At or above this, the injection tripwire fires. */
  injection: 0.5,
} as const;

/** One yes is close to decisive; only the strongest counts, so they do not stack. */
const HARD_SIGNALS = [
  { id: "requests_credential", text: "Asks for a password, OTP, PIN or card details" },
  { id: "unusual_payment_method", text: "Wants payment by gift card, crypto, or a transfer to a personal account" },
  { id: "asks_to_install_or_screen_share", text: "Wants you to install something or let someone see your screen" },
  { id: "asks_to_keep_secret", text: "Tells you to keep it quiet, or not to check with anyone" },
] as const;

/** Weights within the soft term; they sum to 1 so the term stays in 0..1. */
const SOFT_SIGNALS = [
  { id: "creates_urgency", weight: 0.19, text: "Pushes you to act immediately" },
  { id: "threatens_consequence", weight: 0.16, text: "Threatens a penalty if you do not act" },
  { id: "offers_unexpected_reward", weight: 0.16, text: "Offers money or a prize you never asked for" },
  { id: "claims_authority", weight: 0.12, text: "Claims to be a bank, a government body, or a known company" },
  { id: "asks_to_call_number", weight: 0.12, text: "Tells you to ring a phone number it supplies" },
  { id: "implausible_return", weight: 0.11, text: "Promises returns that are too good to be true" },
  { id: "asks_to_move_channel", weight: 0.07, text: "Wants to move the conversation to WhatsApp or a private number" },
  { id: "claims_to_be_known_person", weight: 0.07, text: "Claims to be someone you know" },
] as const;

const PLAYBOOK_TITLE: Record<Playbook, string> = {
  bank_impersonation: "This looks like a fake message from a bank",
  delivery_fee: "This looks like a fake delivery or parcel-fee message",
  prize_or_lottery: "This looks like a fake prize or lottery win",
  job_offer: "This looks like a fake job or easy-earnings offer",
  investment_or_crypto: "This looks like an investment or crypto scam",
  tech_support: "This looks like a fake technical support message",
  family_emergency: "This looks like someone pretending to be family in trouble",
  romance: "This looks like a romance scam",
  subscription_renewal: "This looks like a fake subscription or renewal charge",
  government_penalty: "This looks like a fake fine or tax demand",
  looks_legitimate: "This looks like a scam",
  unclear: "This looks like a scam",
};

const PLAYBOOK_ADVICE: Record<Playbook, string> = {
  bank_impersonation:
    "Banks never ask for your OTP, PIN or full card number. Call your bank on the number printed on your card.",
  delivery_fee:
    "Check the parcel on the courier's own website or app using the tracking number you were given when you ordered.",
  prize_or_lottery: "You cannot win a lottery you never entered, and a real prize never needs a fee first.",
  job_offer: "A real employer does not ask you to pay a deposit, a registration fee, or for money to release earnings.",
  investment_or_crypto:
    "Guaranteed or unusually high returns are the oldest sign of an investment scam. Do not send money or install a trading app from a link.",
  tech_support:
    "Do not install anything or share your screen. If you think there is a real problem, contact the company yourself.",
  family_emergency:
    "Call the person on the number you already have saved for them before sending anything. A new number asking for money is the warning sign.",
  romance: "Someone you have not met in person asking for money is the clearest sign of a romance scam.",
  subscription_renewal:
    "Check your subscriptions directly in the app or on the company's website. Do not use the link or phone number in the message.",
  government_penalty:
    "Government bodies do not demand instant payment by message. Look the department up yourself and contact them directly.",
  looks_legitimate: "Verify anything about money or accounts through the company's own app or website.",
  unclear: "Verify anything about money or accounts through the company's own app or website.",
};

const GENERIC_ADVICE = [
  "If it is about money or an account, call the company on a number you already have. Never a number from the message.",
  "Never share an OTP, PIN or password with anyone, no matter who they say they are.",
];

/** Derived, so changing the rubric in questions.ts cannot silently rescale risk. */
const HARM_TOP_LEVEL = QUESTIONS.harm_if_complied.criteria.length - 1;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function scoreAnswers(answers: Answers, ctx: Context): Verdict {
  const playbook = answers.playbook.choice;
  const playbookConfidence = answers.playbook.confidence;

  const scored: Array<Reason & { contribution: number }> = [];

  let hard = 0;
  for (const signal of HARD_SIGNALS) {
    const strength = answers[signal.id].noul;
    hard = Math.max(hard, strength);
    if (strength >= THRESHOLDS.signal) {
      scored.push({ ...signal, strength, contribution: WEIGHTS.hard * strength });
    }
  }

  let soft = 0;
  for (const signal of SOFT_SIGNALS) {
    const strength = answers[signal.id].noul;
    soft += signal.weight * strength;
    if (strength >= THRESHOLDS.signal) {
      scored.push({
        id: signal.id,
        text: signal.text,
        strength,
        contribution: WEIGHTS.soft * signal.weight * strength,
      });
    }
  }

  // A link only counts against the message when the message tells you to open
  // it AND the host does not belong to whoever the message claims to be.
  const linkRisk = ctx.hasLinks
    ? answers.instructs_to_click_link.noul * (1 - answers.link_host_matches_claim.noul)
    : 0;
  if (linkRisk >= THRESHOLDS.signal) {
    scored.push({
      id: "link_host_mismatch",
      text: "The link does not go to the company the message claims to be from",
      strength: linkRisk,
      contribution: WEIGHTS.link * linkRisk,
    });
  }

  const mismatch = ctx.hasSender ? answers.sender_identity_mismatch.noul : 0;
  if (mismatch >= THRESHOLDS.signal) {
    scored.push({
      id: "sender_identity_mismatch",
      text: "The sender does not match the organisation the message claims to be from",
      strength: mismatch,
      contribution: WEIGHTS.mismatch * mismatch,
    });
  }

  const harm = answers.harm_if_complied.score / HARM_TOP_LEVEL;
  // Scam-shaped words are ordinary between people who know each other: real SMS
  // corpora are full of "send me your password" between friends.
  const damp = Math.max(
    answers.is_routine_notification.noul,
    answers.requests_no_action.noul,
    answers.is_personal_conversation.noul,
  );

  const risk = clamp01(
    WEIGHTS.hard * hard +
      WEIGHTS.soft * soft +
      WEIGHTS.link * linkRisk +
      WEIGHTS.mismatch * mismatch +
      WEIGHTS.harm * harm -
      WEIGHTS.damp * damp,
  );

  const reasons: Reason[] = scored
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 5)
    .map(({ id, text, strength }) => ({ id, text, strength }));

  const base = { reasons, risk, playbook, playbookConfidence };

  // Order matters. Both tripwires override the score rather than feeding it,
  // because a message that trips them is one the score cannot be trusted on.
  if (answers.message_is_english.noul < THRESHOLDS.english) {
    return {
      ...base,
      band: "cannot_judge",
      title: "I cannot check this message",
      detail: "This does not look like English, and I am only reliable in English. Ask someone you trust to read it.",
      advice: GENERIC_ADVICE,
    };
  }

  if (answers.contains_instruction_to_analyzer.noul >= THRESHOLDS.injection) {
    return {
      ...base,
      band: "injection",
      title: "Treat this message as suspicious",
      detail:
        "It contains text written to fool automatic checks rather than to be read by you. Genuine messages do not do that.",
      advice: GENERIC_ADVICE,
    };
  }

  if (risk >= THRESHOLDS.scam) {
    const named = playbookConfidence >= THRESHOLDS.playbookConfidence;
    return {
      ...base,
      band: "scam",
      title: named ? PLAYBOOK_TITLE[playbook] : "This looks like a scam",
      detail: "Do not reply, do not click anything in it, and do not send money or codes.",
      advice: [PLAYBOOK_ADVICE[named ? playbook : "unclear"], ...GENERIC_ADVICE],
    };
  }

  // Low score but the model recognises a known scam shape: a disagreement
  // worth surfacing rather than resolving in favour of the score.
  const recognisedAsScam =
    playbook !== "looks_legitimate" &&
    playbook !== "unclear" &&
    playbookConfidence >= THRESHOLDS.playbookConfidence;

  if (risk <= THRESHOLDS.clear && !recognisedAsScam) {
    return {
      ...base,
      band: "clear",
      title: "No scam signals found",
      detail:
        "Nothing here matches the usual scam patterns. That is not a guarantee, so still check anything about money or accounts yourself.",
      advice: GENERIC_ADVICE,
    };
  }

  return {
    ...base,
    band: "unsure",
    title: "I am not sure about this one",
    detail: "There is not enough here for me to call it either way. Do not act on it until you have checked another way.",
    advice: [PLAYBOOK_ADVICE[recognisedAsScam ? playbook : "unclear"], ...GENERIC_ADVICE],
  };
}
