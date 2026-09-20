import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Builds fixtures/public-ham.jsonl from the SMS Spam Collection by Tiago A. Almeida,
 * José María Gómez Hidalgo and Akebo Yamakami, published through the UCI Machine
 * Learning Repository.
 *
 * These are real people's private messages, so the repo holds this script rather than
 * a copy of them. The sample is chosen by hashing each message, so everyone who runs
 * this gets the same 300 and results stay comparable.
 */

const SOURCE = "https://raw.githubusercontent.com/justmarkham/pycon-2016-tutorial/master/data/sms.tsv";
const OUT = "fixtures/public-ham.jsonl";
const SAMPLE_SIZE = 300;
const MIN_CHARS = 25;

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`Could not download the corpus: ${response.status} ${response.statusText}`);

const seen = new Set<string>();
const candidates: string[] = [];

for (const line of (await response.text()).split("\n")) {
  const [label, ...rest] = line.split("\t");
  const text = rest.join("\t").trim();
  // "ham" is the corpus's word for a genuine, non-spam message.
  if (label?.trim().toLowerCase() !== "ham" || text.length < MIN_CHARS || seen.has(text)) continue;
  seen.add(text);
  candidates.push(text);
}

if (candidates.length < SAMPLE_SIZE) {
  throw new Error(`Only ${candidates.length} usable messages, expected at least ${SAMPLE_SIZE}`);
}

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const sample = candidates.sort((a, b) => digest(a).localeCompare(digest(b))).slice(0, SAMPLE_SIZE);

await mkdir("fixtures", { recursive: true });
await writeFile(OUT, `${sample.map((text) => JSON.stringify({ label: "legit", text })).join("\n")}\n`);

console.log(`${candidates.length} genuine messages in the corpus, wrote ${sample.length} to ${OUT}`);
console.log("Run `pnpm eval fixtures/public-ham.jsonl` to measure false alarms on real text.");
