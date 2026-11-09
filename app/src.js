import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet } from "genlayer-js/chains";

const CONTRACT = "0xeCC5d8c7cD8665A625C86B73b895b98225b12E24";
const EXPLORER = `https://explorer-studio.genlayer.com/address/${CONTRACT}`;
const KEY_SLOT = "attributor.keys";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "");

let logTimer;
function log(msg) {
  const box = $("log");
  box.textContent = msg;
  box.style.display = "block";
  clearTimeout(logTimer);
  logTimer = setTimeout(() => (box.style.display = "none"), 9000);
}

function loadKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY_SLOT) || "[]");
    return Array.isArray(raw) ? raw.filter((k) => typeof k === "string" && k) : [];
  } catch {
    return [];
  }
}

let keys = loadKeys();
if (!keys.length) {
  keys = [generatePrivateKey()];
  localStorage.setItem(KEY_SLOT, JSON.stringify(keys));
}
let active = 0;
let account = createAccount(keys[0]);
let me = String(account.address);
let client = createClient({ chain: studionet, account });
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

function useKey(i) {
  active = i;
  account = createAccount(keys[i]);
  me = String(account.address);
  client = createClient({ chain: studionet, account });
  paintKey();
  refresh();
}

function paintKey() {
  const sel = $("acting");
  sel.replaceChildren();
  keys.forEach((k, i) => {
    const o = el("option", "", `key ${i + 1} · ${short(String(createAccount(k).address))}`);
    o.value = String(i);
    sel.append(o);
  });
  sel.value = String(active);
  $("walletchip").textContent = `key ${active + 1} · ${short(me)}`;
}

$("contractlink").textContent = short(CONTRACT);
$("contractlink").href = EXPLORER;
paintKey();
$("acting").onchange = (e) => useKey(Number(e.target.value) || 0);
$("genkey").onclick = () => {
  keys.push(generatePrivateKey());
  localStorage.setItem(KEY_SLOT, JSON.stringify(keys));
  useKey(keys.length - 1);
  log("new key added");
};
$("importkey").onclick = () => {
  const k = prompt("Private key (0x…)");
  if (!k) return;
  keys.push(k.trim());
  localStorage.setItem(KEY_SLOT, JSON.stringify(keys));
  useKey(keys.length - 1);
};

const SAMPLE = {
  id: `essay-${Date.now().toString(36)}`,
  title: "Why glossaries fail at midnight",
  url: "https://attributor-demo.surge.sh/demo/work.html",
  text:
    "The quiet failure of every translation memory is that it remembers words and forgets decisions. " +
    "A glossary is a decision: this product is called a payment gateway, not a payment door, in every sentence, forever. " +
    "When the memory only keeps the sentence and drops the decision, the next translator writes a fluent page that the brand cannot ship, " +
    "and the review happens at midnight before launch.",
};

$("sample").onclick = () => {
  $("wid").value = SAMPLE.id;
  $("wtitle").value = SAMPLE.title;
  $("wurl").value = SAMPLE.url;
  $("wtext").value = SAMPLE.text;
  log("sample loaded: the demo pages are live, attest the near copy next");
};

async function read(functionName, args) {
  return reader.readContract({ address: CONTRACT, functionName, args });
}

async function send(functionName, args) {
  log(`${functionName}: signing`);
  const hash = await client.writeContract({ address: CONTRACT, functionName, args, value: 0n });
  log(`${functionName}: ${hash.slice(0, 12)}… waiting for the consensus round`);
  const receipt = await client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 240, interval: 3000 });
  const leader = (receipt && receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  if (String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR") {
    throw new Error("the contract refused this call");
  }
  log(`${functionName}: done`);
  await refresh();
  return hash;
}

$("register").onclick = async () => {
  const id = $("wid").value.trim();
  const title = $("wtitle").value.trim();
  const url = $("wurl").value.trim();
  const text = $("wtext").value.trim();
  if (!id || !title || !url || !text) return log("the four fields are required");
  try {
    await send("register_work", [id, title, text, url]);
  } catch (e) {
    log(String((e && e.message) || e).slice(0, 160));
  }
};

function statusPill(status) {
  if (!status) return el("span", "pill", "unchecked");
  return el("span", `pill ${status}`, status.replace("_", " "));
}

function scoreLine(work) {
  if (!work.checked) return "no reading yet";
  return `${work.category.replace("_", " ")} · overlap ${work.overlap} · score ${work.score}`;
}

async function history(card, workId) {
  const box = el("div", "");
  card.append(box);
  try {
    const rows = await read("attestations_of", [workId]);
    if (!rows.length) box.append(el("div", "kv", "no rounds yet"));
    for (const row of rows) {
      const line = el("div", "kv");
      line.append(
        document.createTextNode(
          `#${row.seq} · ${row.category.replace("_", " ")} · ${row.overlap} · score ${row.score} · ${short(row.caller)} · ${row.suspect_url}`
        )
      );
      box.append(line);
      if (row.excerpt) box.append(el("div", "excerpt", `“${row.excerpt}”`));
    }
  } catch (e) {
    box.append(el("div", "kv", String((e && e.message) || e).slice(0, 160)));
  }
}

function workCard(work) {
  const card = el("div", "work");
  const meta = el("div", "meta");
  meta.append(statusPill(work.status));
  meta.append(el("span", "pill", `${work.attestations} round${work.attestations === 1 ? "" : "s"}`));
  meta.append(el("span", "pill", `${work.chars} chars`));
  card.append(meta);
  card.append(el("h3", "", `${work.title}`));
  card.append(el("div", "kv", `id ${work.id} · by ${short(work.owner)} · registered ${new Date(work.created_at * 1000).toLocaleString()}`));
  card.append(el("div", "kv", `published at ${work.url}`));
  const text = el("div", "text", work.text);
  card.append(text);
  if (work.checked) {
    card.append(el("div", "kv", `${scoreLine(work)} · latest page ${work.suspect}`));
  }

  const actions = el("div", "actions");
  const input = el("input");
  input.placeholder = "https://page-to-check.example";
  input.value = work.url.replace(/work\.html$/, "copy.html");
  input.style.maxWidth = "330px";
  actions.append(input);
  actions.append(
    (() => {
      const b = el("button", "primary", "Attest this page");
      b.onclick = async () => {
        const url = input.value.trim();
        if (!url) return log("a URL to check is required");
        b.disabled = true;
        try {
          await send("attest_copy", [work.id, url]);
        } catch (e) {
          log(String((e && e.message) || e).slice(0, 160));
        } finally {
          b.disabled = false;
        }
      };
      return b;
    })()
  );
  actions.append(
    (() => {
      const b = el("button", "", "Rounds");
      b.onclick = () => history(card, work.id);
      return b;
    })()
  );
  card.append(actions);
  return card;
}

async function refresh() {
  try {
    const [stats, works] = await Promise.all([read("stats", []), read("list_works", [0, 30])]);
    $("s-works").textContent = stats.works;
    $("s-attest").textContent = stats.attestations;
    $("s-near").textContent = stats.statuses.near_copy + stats.statuses.verbatim;
    $("s-verbatim").textContent = stats.statuses.verbatim;
    const box = $("works");
    box.replaceChildren();
    if (!works.length) box.append(el("div", "kv", "no works registered yet"));
    works.forEach((work) => box.append(workCard(work)));
  } catch (e) {
    $("works").replaceChildren(el("div", "kv", String((e && e.message) || e).slice(0, 180)));
  }
}

refresh();
setInterval(refresh, 25000);
