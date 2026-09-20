import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MESSAGE_CHARS, extractHosts, hostOf, normalize } from "./extract.ts";

test("normalize collapses spaces but keeps paragraph breaks", () => {
  assert.equal(normalize("  hello   world \r\n\r\n\r\n next  "), "hello world\n\nnext");
});

test("normalize caps very long input", () => {
  assert.equal(normalize("a".repeat(MAX_MESSAGE_CHARS + 500)).length, MAX_MESSAGE_CHARS);
});

test("hostOf strips www and rejects hostnames with no dot", () => {
  assert.equal(hostOf("www.Amazon.in/orders"), "amazon.in");
  assert.equal(hostOf("http://localhost:3000"), null);
  assert.equal(hostOf("not a url"), null);
});

test("extractHosts finds schemed, www and bare-with-path links", () => {
  const text = "Verify at http://sbi-kyc.xyz/verify or www.amazon.in, shortlink bit.ly/3xz";
  assert.deepEqual(extractHosts(text), ["sbi-kyc.xyz", "amazon.in", "bit.ly"]);
});

test("extractHosts ignores prose that looks like a domain", () => {
  assert.deepEqual(extractHosts("Total is Rs.500 for 2 items etc.Thanks for your order."), []);
});

test("extractHosts keeps a bare domain only when the TLD is plausible", () => {
  assert.deepEqual(extractHosts("Go to sbi-verify.xyz today"), ["sbi-verify.xyz"]);
  assert.deepEqual(extractHosts("Go to sbi-verify.zzzz today"), []);
});

test("extractHosts drops trailing punctuation and duplicates", () => {
  assert.deepEqual(extractHosts("Open (http://pay.example.com/a), then http://pay.example.com/b."), [
    "pay.example.com",
  ]);
});

test("extractHosts stops at five hosts", () => {
  const text = ["a.com/1", "b.com/1", "c.com/1", "d.com/1", "e.com/1", "f.com/1"].join(" ");
  assert.equal(extractHosts(text).length, 5);
});
