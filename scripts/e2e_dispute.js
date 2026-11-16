#!/usr/bin/env node
/**
 * The dispute path, on the live contract.
 *
 *   node scripts/e2e_dispute.js <contractAddress>
 *
 * A record that is false: the text was published in February 2024 on another
 * page, and the registrant republished it today and registered it as a first
 * publication. A second address challenges with the earlier page. One round
 * decides, the record is revoked, and the text is free again for its author to
 * register at the page where it really appeared first.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_dispute.js <contractAddress>");
  process.exit(1);
}

const keys = JSON.parse(fs.readFileSync(path.join(__dirname, ".deploy-keys.json"), "utf8"));
const owner = createAccount(keys.owner);
const rival = createAccount(keys.rival);
const ownerClient = createClient({ chain: studionet, account: owner });
const rivalClient = createClient({ chain: studionet, account: rival });
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 24; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const message = String(error && error.message);
      const throttled = /rate limit/i.test(message);
      if (!throttled && !/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i.test(message)) throw error;
      const wait = throttled ? 60000 : 5000;
      console.log(`  ${label}: ${throttled ? "rate limited" : "rpc hiccup"}, retry ${i + 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw last;
}

function refused(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function call(client, who, fn, args) {
  console.log(`\n[${who}] ${fn}(${args.map((a) => JSON.stringify(a).slice(0, 48)).join(", ")})`);
  const hash = await withRetry(() => client.writeContract({ address: ADDRESS, functionName: fn, args, value: 0n }), "send");
  console.log(`  tx ${hash}`);
  const receipt = await withRetry(
    () => client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 }),
    "receipt"
  );
  const isRefused = refused(receipt);
  console.log(`  ${receipt.status_name || receipt.status}  (${isRefused ? "refused by the contract" : "executed"})`);
  return { hash, refused: isRefused };
}

const view = (fn, args) => withRetry(() => reader.readContract({ address: ADDRESS, functionName: fn, args }), "read");

const TEXT = [
  "A machine that ships without a queue never tells you it is busy. It answers while it is still working, and the answer it gives you is the last thing it was sure about.",
  "The first time you notice is not a failure. The page loads, the numbers arrive, the confirmation appears, and behind them a process you cannot see is still deciding. It is only when two people read the same screen and disagree about what it says that the missing queue becomes visible.",
  "Every quiet machine is an argument about time. Someone decided that the user would rather have a probable answer now than a certain one later, and that decision is invisible at the moment it is made. It shows up weeks later, in a support thread, as a disagreement about history.",
  "The fix is not to slow the machine down. It is to make the waiting legible: say which part of the answer is already settled and which part is still being worked out, and give that second part a place on the screen instead of a spinner.",
].join("\n\n");

const CLAIM_URL = "https://attributor-demo.surge.sh/demo/quiet-claim.html";
const FIRST_URL = "https://attributor-demo.surge.sh/demo/quiet-first.html";

(async () => {
  console.log("contract", ADDRESS);
  console.log("owner   ", owner.address);
  console.log("rival   ", rival.address);

  console.log("\n[owner] register the text as published today, at their own page");
  let work;
  try {
    work = await view("get_work", ["quiet-machine"]);
    console.log("  already registered, continuing with the existing record");
  } catch (error) {
    const registered = await call(ownerClient, "owner", "register_work", [
      "quiet-machine", "The quiet machine", TEXT, CLAIM_URL,
    ]);
    if (registered.refused) throw new Error("the registration was refused");
    work = await view("get_work", ["quiet-machine"]);
  }
  console.log(`  verified ${work.verified} | proof ${work.proof_kind} | ${work.chars} chars`);

  console.log("\n[rival] challenge with the page where the text appeared first, in February 2024");
  const existing = await view("challenges_of", ["quiet-machine"]);
  if (existing.length > 0) {
    console.log("  a challenge is already on the record, reading it instead of filing another");
  } else {
  const challenge = await call(rivalClient, "rival", "challenge_work", [
    "quiet-machine",
    FIRST_URL,
    "This essay was first published on 8 February 2024 at another URL. The registrant republished it today and registered it as a first publication, so the recorded date is not the first publication.",
  ]);
  if (challenge.refused) throw new Error("the challenge was refused");
  }

  work = await view("get_work", ["quiet-machine"]);
  const challenges = await view("challenges_of", ["quiet-machine"]);
  const verdict = challenges[challenges.length - 1];
  console.log(`  verdict ${verdict.verdict} | revoked ${work.revoked} | by ${work.revoked_by.slice(0, 10)}…`);
  if (verdict.verdict !== "upheld") throw new Error(`the challenge was ${verdict.verdict}, not upheld`);
  if (!work.revoked) throw new Error("the record was not revoked");

  console.log("\n[guard] a revoked record cannot be attested");
  const blocked = await call(rivalClient, "rival", "attest_copy", ["quiet-machine", FIRST_URL]);
  if (!blocked.refused) throw new Error("a revoked record was attested");

  console.log("\n[rival] the text is free again: register it where it really appeared first");
  let realWork;
  try {
    realWork = await view("get_work", ["quiet-machine-2024"]);
    console.log("  already registered, continuing");
  } catch (error) {
    const real = await call(rivalClient, "rival", "register_work", [
      "quiet-machine-2024", "The quiet machine (first publication)", TEXT, FIRST_URL,
    ]);
    if (real.refused) throw new Error("the real author could not register the text");
    realWork = await view("get_work", ["quiet-machine-2024"]);
  }
  console.log(`  verified ${realWork.verified} | owner ${realWork.owner.slice(0, 10)}… | ${realWork.chars} chars`);

  console.log("\nhistory");
  for (const row of await view("challenges_of", ["quiet-machine"])) {
    console.log(`  #${row.seq} ${row.verdict} | ${row.evidence_url}`);
    console.log(`     ${row.note.slice(0, 150)}`);
  }

  console.log("\nstats");
  console.log(JSON.stringify(await view("stats", []), null, 2));

  console.log(
    "\nRESULT: a false first-publication record was challenged with an earlier page, the round upheld it, the record was revoked, attestation on it was refused, and the text went back to its author"
  );
})().catch((error) => {
  console.error("\nFAILED:", error.message);
  if (error.cause) console.error(String(error.cause).slice(0, 800));
  process.exit(1);
});
