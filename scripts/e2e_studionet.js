#!/usr/bin/env node
/**
 * End to end run of Attributor on GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js <contractAddress>
 *
 * One real record: a text is registered against the page where it was published,
 * then two pages are attested by a second account — a near copy of the text and
 * an unrelated page. The contract stores the reading and computes the score.
 *
 *   register    the author records the text, the title and the published URL
 *   attest      near copy: validators read the page against the registered text
 *   attest      unrelated: the same reading, on a page that shares nothing
 *   guards      own URL and a duplicate work id are refused by the contract
 *   history     both rounds, in order
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress>");
  process.exit(1);
}

const KEYFILE = process.env.QM_KEYS || path.join("/tmp", `attributor-keys-${Date.now().toString(36)}.json`);
function keys() {
  if (fs.existsSync(KEYFILE)) return JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const k = { owner: generatePrivateKey(), reviewer: generatePrivateKey() };
  fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}
const k = keys();
const owner = createAccount(k.owner);
const reviewer = createAccount(k.reviewer);
const ownerClient = createClient({ chain: studionet, account: owner });
const reviewerClient = createClient({ chain: studionet, account: reviewer });
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e && e.message);
      if (!/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i.test(msg)) throw e;
      console.log(`  ${label}: rpc hiccup, retry ${i + 1}`);
      await sleep(4000);
    }
  }
  throw last;
}

function refused(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function send(client, who, functionName, args) {
  console.log(`\n[${who}] ${functionName}(${args.map((a) => JSON.stringify(a).slice(0, 56)).join(", ")})`);
  const hash = await withRetry(
    () => client.writeContract({ address: ADDRESS, functionName, args, value: 0n }),
    "send"
  );
  console.log(`  tx ${hash}`);
  const receipt = await withRetry(
    () => client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 }),
    "receipt"
  );
  const verdict = refused(receipt) ? "refused by the contract" : "executed";
  console.log(`  ${receipt.status_name || receipt.status}  (${verdict})`);
  return { hash, refused: refused(receipt) };
}

async function write(client, who, functionName, args) {
  const { hash, refused: reverted } = await send(client, who, functionName, args);
  if (reverted) throw new Error(`${functionName} failed inside the contract`);
  return hash;
}

const read = (functionName, args) =>
  withRetry(() => reader.readContract({ address: ADDRESS, functionName, args }), "read");

const BASE = "https://attributor-demo.surge.sh/demo";
const ORIGIN = `${BASE}/work.html`;
const COPY = `${BASE}/copy.html`;
const OTHER = `${BASE}/unrelated.html`;
const TEXT = [
  "The quiet failure of every translation memory is that it remembers words and forgets decisions.",
  "A glossary is a decision: this product is called a payment gateway, not a payment door, in every sentence, forever.",
  "When the memory only keeps the sentence and drops the decision, the next translator writes a fluent page that the brand cannot ship, and the review happens at midnight before launch.",
].join(" ");

(async () => {
  const workId = process.argv[3] || `essay-${Date.now().toString(36)}`;
  console.log("contract", ADDRESS);
  console.log("work    ", workId);
  console.log("owner   ", owner.address);
  console.log("reviewer", reviewer.address);
  console.log("origin  ", ORIGIN);

  await write(ownerClient, "owner", "register_work", [
    workId,
    "Why glossaries fail at midnight",
    TEXT,
    ORIGIN,
  ]);

  let work = await read("get_work", [workId]);
  console.log(`\n  registered ${work.chars} chars | attestations ${work.attestations} | status ${JSON.stringify(work.status)}`);
  if (work.url !== ORIGIN) throw new Error("the registered URL does not match the page");

  console.log("\n[reviewer] attest_copy against a page that rewrites the same argument");
  const t0 = Date.now();
  await write(reviewerClient, "reviewer", "attest_copy", [workId, COPY]);
  console.log(`  round took ${Math.round((Date.now() - t0) / 1000)}s`);

  work = await read("get_work", [workId]);
  console.log(`  category ${work.category} | overlap ${work.overlap} | score ${work.score} | status ${work.status}`);
  const first = await read("attestations_of", [workId]);
  console.log(`  excerpt: ${first[0].excerpt ? `"${first[0].excerpt.slice(0, 120)}"` : "(none)"}`);
  if (!["near_copy", "verbatim"].includes(work.status)) {
    throw new Error(`the near copy was read as ${work.category}/${work.overlap} (${work.status})`);
  }

  console.log("\n[reviewer] attest_copy against an unrelated page");
  const t1 = Date.now();
  await write(reviewerClient, "reviewer", "attest_copy", [workId, OTHER]);
  console.log(`  round took ${Math.round((Date.now() - t1) / 1000)}s`);

  work = await read("get_work", [workId]);
  console.log(`  category ${work.category} | overlap ${work.overlap} | score ${work.score} | status ${work.status}`);
  if (work.status !== "clear") {
    throw new Error(`the unrelated page was read as ${work.category}/${work.overlap} (${work.status})`);
  }

  console.log("\n[guard] the work's own URL cannot be attested");
  const own = await send(ownerClient, "owner", "attest_copy", [workId, ORIGIN]);
  if (!own.refused) throw new Error("a work was attested against its own URL");

  console.log("\n[guard] the same work id again");
  const beforeDuplicate = await read("get_work", [workId]);
  const dup = await send(ownerClient, "owner", "register_work", [workId, "A title", TEXT, ORIGIN]);
  if (!dup.refused) throw new Error("a duplicate work id was accepted");
  const afterDuplicate = await read("get_work", [workId]);
  if (afterDuplicate.attestations !== beforeDuplicate.attestations) {
    throw new Error("a refused register moved the work");
  }

  console.log("\nhistory");
  for (const round of await read("attestations_of", [workId])) {
    console.log(
      `  #${round.seq} ${round.category} / ${round.overlap} -> score ${round.score} (${round.status}) by ${round.caller.slice(0, 10)}…`
    );
  }

  console.log("\nstats");
  console.log(JSON.stringify(await read("stats", []), null, 2));

  console.log(
    "\nRESULT: one text registered with its publication time, a near copy read and scored, an unrelated page read as clear, and both the own-URL and the duplicate id refused"
  );
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  if (e.cause) console.error(String(e.cause).slice(0, 900));
  process.exit(1);
});
