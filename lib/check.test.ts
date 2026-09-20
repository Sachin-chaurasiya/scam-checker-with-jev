import assert from "node:assert/strict";
import test from "node:test";
import { APIError, AuthenticationError, RateLimitError } from "@typesafe-ai/sdk";
import { MAX_MESSAGE_CHARS, InvalidInput, buildRequest, toUserError } from "./check.ts";

test("buildRequest rejects input the user can fix", () => {
  assert.throws(() => buildRequest({ message: "   " }), InvalidInput);
  assert.throws(() => buildRequest({ message: "too short" }), InvalidInput);
});

test("buildRequest sends only the fields a question can use", () => {
  const plain = buildRequest({ message: "Your parcel is waiting for collection at the depot." });
  assert.deepEqual(Object.keys(plain.state), ["message"]);
  assert.deepEqual(plain.ctx, { hasSender: false, hasLinks: false });

  const full = buildRequest({
    message: "Pay the fee at http://fake-courier.top/pay today.",
    sender: "  IN-POSTAL  ",
  });
  assert.deepEqual(Object.keys(full.state).sort(), ["extracted", "message", "sender"]);
  assert.equal(full.state["sender"], "IN-POSTAL");
  assert.deepEqual(full.state["extracted"], { link_hosts: ["fake-courier.top"] });
  assert.deepEqual(full.ctx, { hasSender: true, hasLinks: true });
});

test("buildRequest treats a blank sender as no sender", () => {
  const { state, ctx } = buildRequest({ message: "Your order has been delivered today.", sender: "   " });
  assert.equal("sender" in state, false);
  assert.equal(ctx.hasSender, false);
});

test("buildRequest caps a long message and says that it did", () => {
  const long = "Pay the fee at http://fake.top/pay today. ".repeat(200);
  const { state, truncated } = buildRequest({ message: long });

  assert.equal(truncated, true);
  assert.equal(String(state["message"]).length, MAX_MESSAGE_CHARS);
  // The UI shows state.message, so it must be what the model actually judged.
  assert.ok(long.startsWith(String(state["message"]).slice(0, 40)));
});

test("buildRequest does not claim truncation for a message that fits", () => {
  const { state, truncated } = buildRequest({ message: "Your parcel is held at the depot." });
  assert.equal(truncated, false);
  assert.equal(String(state["message"]), "Your parcel is held at the depot.");
});

test("toUserError maps failures to a status and a sentence with no internals", () => {
  const headers = new Headers();

  assert.deepEqual(toUserError(new InvalidInput("Paste the message you want checked.")), {
    status: 400,
    message: "Paste the message you want checked.",
  });
  assert.equal(toUserError(new RateLimitError(429, {}, headers)).status, 429);
  assert.equal(toUserError(new AuthenticationError(401, { key: "secret-ish" }, headers)).status, 500);
  assert.equal(toUserError(new APIError(503, {}, headers)).status, 502);
  assert.equal(toUserError(new Error("socket hang up")).status, 500);

  // Nothing from the underlying error reaches the user.
  const leaked = toUserError(new AuthenticationError(401, { key: "secret-ish" }, headers));
  assert.equal(leaked.message.includes("secret-ish"), false);
});
