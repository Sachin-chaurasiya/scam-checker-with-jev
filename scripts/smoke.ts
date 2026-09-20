import { noul } from "@typesafe-ai/sdk";
import { MODEL, check, getClient, toUserError } from "../lib/check.ts";

/**
 * Two steps, so a failure says which half is broken:
 * 1. one trivial question  -> the key and the network work
 * 2. the real pipeline     -> the question catalogue is accepted and scores
 */

const SAMPLE =
  "SBI ALERT: Your account will be BLOCKED today as your KYC is incomplete. " +
  "Update at http://sbi-kyc-verify.top/update and share the OTP sent to your phone with our agent.";

try {
  console.log(`1. single question against ${MODEL} ...`);
  const probe = await getClient().systemOne({
    state: "My card was charged twice.",
    questions: { about_billing: noul("Is this about billing?") },
  });
  console.log(`   ok: noul=${probe.answers.about_billing.noul} model=${probe.model}`);

  console.log("2. full pipeline on a sample scam ...");
  const verdict = await check({ message: SAMPLE, sender: "VM-SBIBNK" });
  console.log(`   band:     ${verdict.band}  (risk ${verdict.risk.toFixed(2)})`);
  console.log(`   title:    ${verdict.title}`);
  console.log(`   playbook: ${verdict.playbook} (confidence ${verdict.playbookConfidence.toFixed(2)})`);
  for (const reason of verdict.reasons) console.log(`   - ${reason.text} (${reason.strength.toFixed(2)})`);
  console.log(`   ${verdict.usage.input_tokens} input tokens, ${verdict.latencyMs} ms, model ${verdict.model}`);
} catch (err) {
  const { status, message } = toUserError(err);
  console.error(`failed (${status}): ${message}`);
  console.error(err);
  process.exitCode = 1;
}
