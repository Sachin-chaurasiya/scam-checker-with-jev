import { readFile, writeFile, mkdir } from "node:fs/promises";
import { check, toUserError } from "../lib/check.ts";
import type { Band } from "../lib/score.ts";

/**
 * Runs the labelled set through the same path the server uses and prints the
 * numbers that decide whether this is shippable. Exits non-zero when the
 * false-positive rate or the recall misses the bar.
 */

const MAX_FALSE_POSITIVE_RATE = 0.05;
const MIN_RECALL = 0.85;
const CONCURRENCY = 4;

type Label = "scam" | "legit" | "ambiguous";

interface Row {
  text: string;
  sender?: string;
  label: Label;
}

interface Outcome extends Row {
  band: Band | "error";
  risk: number;
  playbook: string;
  error?: string;
}

const LABELS: readonly Label[] = ["scam", "legit", "ambiguous"];
const BANDS: readonly (Band | "error")[] = ["scam", "unsure", "injection", "clear", "cannot_judge", "error"];

function parseRows(contents: string): Row[] {
  return contents.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1}: not valid JSON`);
    }
    const row = parsed as Partial<Row>;
    if (typeof row.text !== "string" || !row.text.trim()) throw new Error(`line ${index + 1}: missing "text"`);
    if (!LABELS.includes(row.label as Label)) {
      throw new Error(`line ${index + 1}: label must be one of ${LABELS.join(", ")}`);
    }
    return [
      typeof row.sender === "string" && row.sender
        ? { text: row.text, sender: row.sender, label: row.label as Label }
        : { text: row.text, label: row.label as Label },
    ];
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function printMatrix(outcomes: Outcome[]): void {
  const width = 14;
  console.log(`\n${"".padEnd(width)}${BANDS.map((b) => b.padStart(width)).join("")}`);
  for (const label of LABELS) {
    const cells = BANDS.map(
      (band) => String(outcomes.filter((o) => o.label === label && o.band === band).length).padStart(width),
    );
    console.log(`${label.padEnd(width)}${cells.join("")}`);
  }
}

function printCalibration(outcomes: Outcome[]): void {
  console.log("\nrisk bucket      n   share actually scam");
  const graded = outcomes.filter((o) => o.label !== "ambiguous" && o.band !== "error");
  for (let bucket = 0; bucket < 5; bucket++) {
    const low = bucket * 0.2;
    const high = low + 0.2;
    const inBucket = graded.filter((o) => o.risk >= low && (bucket === 4 ? o.risk <= 1 : o.risk < high));
    if (inBucket.length === 0) {
      console.log(`${low.toFixed(1)}-${high.toFixed(1)}        0   -`);
      continue;
    }
    const scams = inBucket.filter((o) => o.label === "scam").length;
    console.log(
      `${low.toFixed(1)}-${high.toFixed(1)}  ${String(inBucket.length).padStart(7)}   ${pct(scams / inBucket.length)}`,
    );
  }
}

const file = process.argv[2] ?? "fixtures/messages.jsonl";
const rows = parseRows(await readFile(file, "utf8"));
console.log(`${rows.length} messages from ${file}, ${CONCURRENCY} at a time ...`);

const outcomes = await mapLimit(rows, CONCURRENCY, async (row): Promise<Outcome> => {
  try {
    const verdict = await check(row.sender === undefined ? { message: row.text } : { message: row.text, sender: row.sender });
    process.stdout.write(".");
    return { ...row, band: verdict.band, risk: verdict.risk, playbook: verdict.playbook };
  } catch (err) {
    process.stdout.write("x");
    return { ...row, band: "error", risk: 0, playbook: "-", error: toUserError(err).message };
  }
});
console.log("");

printMatrix(outcomes);
printCalibration(outcomes);

const legit = outcomes.filter((o) => o.label === "legit" && o.band !== "error");
const scams = outcomes.filter((o) => o.label === "scam" && o.band !== "error");
const errors = outcomes.filter((o) => o.band === "error");

/** Both "scam" and "injection" put a warning in front of the user, so both count as flagged. */
const isFlagged = (outcome: Outcome): boolean => outcome.band === "scam" || outcome.band === "injection";

const falsePositives = legit.filter(isFlagged);
const missed = scams.filter((o) => o.band === "clear");
const caught = scams.filter(isFlagged);

const falsePositiveRate = legit.length ? falsePositives.length / legit.length : 0;
const recall = scams.length ? caught.length / scams.length : 0;

console.log("\n--- results ---");
if (legit.length > 0) console.log(`false alarms       ${falsePositives.length}/${legit.length} (${pct(falsePositiveRate)})  limit ${pct(MAX_FALSE_POSITIVE_RATE)}`);
if (scams.length > 0) console.log(`scams flagged     ${caught.length}/${scams.length} (${pct(recall)})  floor ${pct(MIN_RECALL)}`);
console.log(`scams called clear ${missed.length}  <- the dangerous ones`);
if (errors.length) console.log(`errors            ${errors.length} (${errors[0]?.error})`);

for (const outcome of missed) console.log(`  MISSED: ${outcome.text.slice(0, 90)}`);
for (const outcome of falsePositives) console.log(`  FALSE ALARM: ${outcome.text.slice(0, 90)}`);

await mkdir("out", { recursive: true });
const resultsPath = `out/${file.split("/").pop()?.replace(/\.jsonl$/, "") ?? "results"}.results.jsonl`;
await writeFile(resultsPath, outcomes.map((o) => JSON.stringify(o)).join("\n") + "\n");
console.log(`\nwrote ${resultsPath}`);

// A file of negatives only (or positives only) is a valid run; judge it on the
// metric it can actually support.
const failedFalsePositives = legit.length > 0 && falsePositiveRate > MAX_FALSE_POSITIVE_RATE;
const failedRecall = scams.length > 0 && recall < MIN_RECALL;

if (failedFalsePositives || failedRecall || errors.length > 0) {
  console.error("\nFAILED the bar. Tune the weights in lib/score.ts and run again.");
  process.exitCode = 1;
}
