import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
} from "@typesafe-ai/sdk";
import type { JsonValue, Usage } from "@typesafe-ai/sdk";
import { MAX_MESSAGE_CHARS, MAX_SENDER_CHARS, extractHosts, normalize } from "./extract.ts";
import { QUESTIONS } from "./questions.ts";
import { scoreAnswers } from "./score.ts";
import type { Context, Verdict } from "./score.ts";

/**
 * The one path from raw input to verdict. The server and the eval harness both
 * go through `check`, so what the harness measures is what a user gets.
 */

/** Pinned on purpose: `jev-latest` moves, and the weights in score.ts are tuned against this version. */
export const MODEL = "jev-1.13.0";

const TIMEOUT_MS = 10_000;
/** The SDK retries without an overall budget, so this caps the whole call. */
const TOTAL_TIMEOUT_MS = 25_000;

export interface CheckInput {
  message: string;
  sender?: string;
}

export interface CheckResult extends Verdict {
  /** The text actually sent to the model, after normalizing and the length cap. */
  checked: string;
  /** True when the message was longer than the cap and the tail was not judged. */
  truncated: boolean;
  /** The model version that actually answered, as reported by the API. */
  model: string;
  usage: Usage;
  latencyMs: number;
}

/** Thrown for input the user can fix. The server turns it into a 400. */
export class InvalidInput extends Error {}

let client: TypeSafeClient | undefined;

/** Built on first use so importing this module never throws when the key is absent. */
export function getClient(): TypeSafeClient {
  client ??= new TypeSafeClient({ defaultModel: MODEL, timeout: TIMEOUT_MS });
  return client;
}

/** Only fields a question actually reads are included: a bigger state costs accuracy. */
export function buildRequest(input: CheckInput): {
  state: Record<string, JsonValue>;
  ctx: Context;
  truncated: boolean;
} {
  const message = normalize(input.message);
  if (message.length === 0) throw new InvalidInput("Paste the message you want checked.");
  if (message.length < 10) throw new InvalidInput("That is too short to check. Paste the whole message.");

  const sender = input.sender === undefined ? "" : normalize(input.sender).slice(0, MAX_SENDER_CHARS);
  const hosts = extractHosts(message);

  const state: Record<string, JsonValue> = { message };
  if (sender) state["sender"] = sender;
  if (hosts.length > 0) state["extracted"] = { link_hosts: hosts };

  return {
    state,
    ctx: { hasSender: sender.length > 0, hasLinks: hosts.length > 0 },
    truncated: normalize(input.message).length < input.message.trim().length,
  };
}

export async function check(input: CheckInput): Promise<CheckResult> {
  const { state, ctx, truncated } = buildRequest(input);
  const startedAt = Date.now();

  const result = await getClient().systemOne(
    { state, questions: QUESTIONS },
    { signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS) },
  );

  return {
    ...scoreAnswers(result.answers, ctx),
    checked: String(state["message"]),
    truncated,
    model: result.model,
    usage: result.usage,
    latencyMs: Date.now() - startedAt,
  };
}

/** Raw errors are never forwarded to the user: they can carry request internals. */
export function toUserError(err: unknown): { status: number; message: string } {
  if (err instanceof InvalidInput) return { status: 400, message: err.message };

  if (err instanceof RateLimitError) {
    return { status: 429, message: "Too many checks at once. Wait a few seconds and try again." };
  }
  if (err instanceof AuthenticationError) {
    return { status: 500, message: "The checker is not set up correctly. The API key was rejected." };
  }
  if (err instanceof UnprocessableEntityError) {
    return { status: 500, message: "The checker sent a request the service could not read." };
  }
  if (err instanceof APITimeoutError || err instanceof APIConnectionError) {
    return { status: 504, message: "Could not reach the checking service. Check your connection and try again." };
  }
  if (err instanceof APIUserAbortError) {
    return { status: 504, message: "That check took too long. Try again in a moment." };
  }
  if (err instanceof APIError) {
    return { status: 502, message: "The checking service had a problem. Try again in a moment." };
  }
  return { status: 500, message: "Something went wrong while checking that message." };
}

export { MAX_MESSAGE_CHARS, MAX_SENDER_CHARS };
