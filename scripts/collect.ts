import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

/**
 * Collect real labelled messages into a JSONL file, one at a time.
 * The scam half of the test set can only come from real phones; this makes
 * adding one take about fifteen seconds.
 *
 * Reads plain lines rather than prompt/answer pairs, so it behaves the same
 * in a terminal and when fed from a pipe or a file.
 */

const LABELS: Record<string, "scam" | "legit" | "ambiguous"> = {
  s: "scam",
  l: "legit",
  a: "ambiguous",
};

const file = process.argv[2] ?? "fixtures/messages.jsonl";

const existing = await readFile(file, "utf8").catch(() => "");
const seen = new Set<string>();
const counts = { scam: 0, legit: 0, ambiguous: 0 };

existing.split("\n").forEach((line, index) => {
  if (!line.trim()) return;
  let row: { text?: string; label?: keyof typeof counts };
  try {
    row = JSON.parse(line);
  } catch {
    console.warn(`  line ${index + 1} is not valid JSON, ignoring it`);
    return;
  }
  if (typeof row.text === "string") seen.add(row.text.trim());
  if (row.label && row.label in counts) counts[row.label] += 1;
});

// Without this, a file whose last line has no newline gets the next row
// concatenated onto it, destroying both.
let needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");

const tally = (): string => `${counts.scam} scam, ${counts.legit} legit, ${counts.ambiguous} ambiguous`;
const say = (text: string): void => void process.stdout.write(text);

console.log(`${file} holds ${tally()}`);
console.log("Paste a message, then a blank line. Ctrl-C to stop.\n");

let stage: "message" | "label" | "sender" = "message";
let lines: string[] = [];
let text = "";
let label: (typeof LABELS)[string] | undefined;

const restart = (): void => {
  stage = "message";
  lines = [];
  text = "";
  label = undefined;
  say("message > ");
};

say("message > ");

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (stage === "message") {
    if (line.trim()) {
      lines.push(line);
      say("        > ");
      continue;
    }

    text = lines.join("\n").trim();
    if (!text) {
      say("message > ");
      continue;
    }
    if (text.length < 10) {
      console.log("  too short, skipped\n");
      restart();
      continue;
    }
    if (seen.has(text)) {
      console.log("  already in the file, skipped\n");
      restart();
      continue;
    }

    stage = "label";
    say("label   > [s]cam / [l]egit / [a]mbiguous: ");
    continue;
  }

  if (stage === "label") {
    label = LABELS[line.trim().toLowerCase().at(0) ?? ""];
    if (!label) {
      console.log("  not one of s/l/a, message discarded\n");
      restart();
      continue;
    }
    stage = "sender";
    say("sender  > (optional, Enter to skip): ");
    continue;
  }

  const sender = line.trim();
  const row = sender ? { label, text, sender } : { label, text };
  await appendFile(file, `${needsLeadingNewline ? "\n" : ""}${JSON.stringify(row)}\n`);
  needsLeadingNewline = false;
  seen.add(text);
  counts[label as keyof typeof counts] += 1;
  console.log(`  saved. ${tally()}\n`);
  restart();
}

console.log(`\n${file} holds ${tally()}`);
