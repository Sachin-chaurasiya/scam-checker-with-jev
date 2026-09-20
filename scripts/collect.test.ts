import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./collect.ts", import.meta.url));

/** Drive the real script the way a person would, and hand back what it printed. */
function collect(fileContents: string, keystrokes: string): { file: string; output: string } {
  const file = join(mkdtempSync(join(tmpdir(), "collect-")), "messages.jsonl");
  writeFileSync(file, fileContents);

  const run = spawnSync(process.execPath, [SCRIPT, file], { input: keystrokes, encoding: "utf8" });
  assert.equal(run.status, 0, `collect.ts exited ${run.status}: ${run.stderr}`);

  return { file, output: run.stdout + run.stderr };
}

const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((l) => l.trim());

test("a file whose last line has no newline is not corrupted", () => {
  const { file } = collect(
    '{"label":"legit","text":"an existing row with no newline at the end"}',
    "Pay the customs fee of Rs.40 now to release your parcel.\n\ns\n\n",
  );

  const rows = lines(file).map((line) => JSON.parse(line) as { label: string });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["legit", "scam"],
  );
});

test("one unreadable line does not stop the tool or lose the good rows", () => {
  const { file, output } = collect(
    'not json at all\n{"label":"scam","text":"a valid row that should still be counted"}\n',
    "Your OTP for logging in is 481920. Do not share it with anyone.\n\nl\nHDFCBK\n",
  );

  assert.match(output, /line 1 is not valid JSON/);
  assert.equal(lines(file).length, 3);

  const added = JSON.parse(lines(file).at(-1) as string) as { label: string; sender: string };
  assert.equal(added.label, "legit");
  assert.equal(added.sender, "HDFCBK");
});

test("a duplicate message is not appended twice", () => {
  const existing = '{"label":"scam","text":"Pay the customs fee of Rs.40 to release your parcel."}\n';
  const { file, output } = collect(existing, "Pay the customs fee of Rs.40 to release your parcel.\n\n");

  assert.match(output, /already in the file/);
  assert.equal(lines(file).length, 1);
});
