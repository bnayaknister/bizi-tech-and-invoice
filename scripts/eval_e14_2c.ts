/**
 * E14-2c — the 40-message set against the REAL model (owner decision 21.10, 7).
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/eval_e14_2c.ts          # dry: no network, the plan + a cost estimate
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/eval_e14_2c.ts --live   # ⚠️ calls the Anthropic API (costs cents)
 *   … --live --no-cache   # the same without prompt caching (the "before" of owner decision 21.10)
 *
 * --live needs WHATSAPP_ANTHROPIC_API_KEY — from the environment, or from
 * .env.local (that ONE line is read; nothing else in the file is). It never
 * reads ANTHROPIC_API_KEY (the assistant's key): the bot has its own.
 *
 * Every message runs the menu pipeline exactly as runFlow does: the rule
 * parser, shouldCallLlm, the live call (extractWithHaiku), interpretLlm. Each
 * message is called ONCE, one after another. Scored against the set's
 * `expect`: PASS = 0 wrong fields applied AND >= 90% fully understood.
 * The model's raw answers are saved to scripts/fixtures/e14_2c_recorded.json
 * (message ids and answers only), for the offline suite and for review.
 * No database, no WhatsApp, no booking — this script cannot book anything.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { PASS, appliedOf, loadFixtures, pipeline, score } from "./_e14_2c_eval";
import { LLM_KEY_ENV, LLM_MODEL, LLM_OUTPUT_SCHEMA, LLM_SYSTEM_PROMPT, extractWithHaiku, llmUserContent } from "../src/lib/whatsapp/flow/llm";

// Haiku 5.5, first-party API, prompts under 100K tokens (claude-api reference, cached 2026-10-06)
const PRICE_IN_PER_M = 0.1;
const PRICE_OUT_PER_M = 0.5;
// prompt caching: a 5-minute write is 1.25x input, a read 0.1x
const PRICE_CACHE_WRITE_PER_M = PRICE_IN_PER_M * 1.25;
const PRICE_CACHE_READ_PER_M = PRICE_IN_PER_M * 0.1;
const cache = !process.argv.includes("--no-cache");

const live = process.argv.includes("--live");
const { today, messages } = loadFixtures();
const toCall = messages.filter((f) => pipeline(f.text, today, null, f.step).called);

function estimate() {
  // rough: ~3 characters per token for this Hebrew/English mix, + the schema
  const fixed = Math.ceil((LLM_SYSTEM_PROMPT.length + JSON.stringify(LLM_OUTPUT_SCHEMA).length) / 3);
  const perMsg = toCall.map((f) => fixed + Math.ceil(llmUserContent(f.text, today).length / 3));
  const inTok = perMsg.reduce((a, b) => a + b, 0);
  const outTok = toCall.length * 220;
  const cost = (inTok * PRICE_IN_PER_M + outTok * PRICE_OUT_PER_M) / 1e6;
  return { fixed, inTok, outTok, cost };
}

function readKey(): string | null {
  if (process.env[LLM_KEY_ENV]) return process.env[LLM_KEY_ENV] as string;
  const p = join(__dirname, "..", ".env.local");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const m = new RegExp(`^\\s*${LLM_KEY_ENV}\\s*=\\s*"?([^"\\s]+)"?\\s*$`).exec(line);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  const est = estimate();
  console.log(`E14-2c eval — ${messages.length} messages, today ${today}, model ${LLM_MODEL}`);
  console.log(`  the model is called for ${toCall.length} of them (the rest the rule parser answers alone)`);
  console.log(`  estimate: ~${est.fixed} fixed input tokens per call · ~${est.inTok} in / ~${est.outTok} out in total · ~$${est.cost.toFixed(4)}`);
  if (!live) {
    console.log("\n  dry run — nothing was sent. Add --live to call the API.");
    return;
  }
  const key = readKey();
  if (!key) {
    console.error(`\n  ${LLM_KEY_ENV} is not set (environment or .env.local). Nothing was sent.`);
    process.exit(2);
  }
  process.env[LLM_KEY_ENV] = key;

  const recorded: { id: number; ok: boolean; raw?: unknown; outcome?: string; ms: number }[] = [];
  const ms: number[] = [];
  let inTok = 0;
  let outTok = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let full = 0;
  const wrong: string[] = [];
  const failures: string[] = [];
  for (const f of messages) {
    const rule = pipeline(f.text, today, null, f.step);
    let model: unknown | null = null;
    if (rule.called) {
      const call = await extractWithHaiku(f.text, today, { cache });
      ms.push(call.ms);
      if (call.ok) {
        model = call.raw;
        inTok += call.inputTokens;
        outTok += call.outputTokens;
        cacheWrite += call.cacheWriteTokens;
        cacheRead += call.cacheReadTokens;
        recorded.push({ id: f.id, ok: true, raw: call.raw, ms: call.ms });
      } else {
        failures.push(`#${f.id} ${call.outcome}${"status" in call && call.status ? ` ${call.status}` : ""}`);
        recorded.push({ id: f.id, ok: false, outcome: call.outcome, ms: call.ms });
      }
    }
    const p = pipeline(f.text, today, model, f.step);
    const a = appliedOf(p.event);
    const s = score(f, a, p.event);
    if (s.full) full++;
    for (const w of s.wrong) wrong.push(`#${f.id} ${w}`);
    const mark = s.wrong.length ? "❌ WRONG" : s.full ? "✅" : "· partial";
    console.log(`  ${mark} #${f.id} [${f.cat}${f.step ? ` @${f.step}` : ""}]${rule.called ? "" : " (rule parser only)"}${s.wrong.length ? ` wrong=${s.wrong.join(",")}` : ""}${s.missing.length ? ` missing=${s.missing.join(",")}` : ""}`);
    if (s.wrong.length || !s.full) console.log(`       text    ${f.text}\n       applied ${JSON.stringify(a)}\n       expect  ${JSON.stringify(f.expect)}`);
  }
  if (cache) {
    writeFileSync(join(__dirname, "fixtures", "e14_2c_recorded.json"), JSON.stringify({ model: LLM_MODEL, today, ranAt: new Date().toISOString(), answers: recorded }, null, 2) + "\n");
  }

  const sorted = [...ms].sort((a, b) => a - b);
  const pct = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  const cost = (inTok * PRICE_IN_PER_M + outTok * PRICE_OUT_PER_M + cacheWrite * PRICE_CACHE_WRITE_PER_M + cacheRead * PRICE_CACHE_READ_PER_M) / 1e6;
  const n = Math.max(1, ms.length - failures.length);
  const share = full / messages.length;
  const pass = wrong.length <= PASS.maxWrong && share >= PASS.minFullShare;
  console.log(`\n  wrong fields applied: ${wrong.length}${wrong.length ? ` (${wrong.join(", ")})` : ""}`);
  console.log(`  fully understood: ${full}/${messages.length} (${Math.round(share * 100)}%)`);
  console.log(`  calls: ${ms.length} · failed: ${failures.length}${failures.length ? ` (${failures.join(", ")})` : ""}`);
  console.log(`  time: p50 ${pct(0.5)} ms · p95 ${pct(0.95)} ms · max ${sorted[sorted.length - 1] ?? 0} ms`);
  console.log(`  prompt caching: ${cache ? "ON" : "OFF"} · tokens: ${inTok} uncached in / ${cacheWrite} cache-write / ${cacheRead} cache-read / ${outTok} out`);
  console.log(`  per call: ~${Math.round((inTok + cacheWrite + cacheRead) / n)} in (${Math.round(inTok / n)} uncached) / ~${Math.round(outTok / n)} out · $${(cost / n).toFixed(6)} · total $${cost.toFixed(4)}`);
  console.log(`\n  ${pass ? "✅ PASS" : "❌ FAIL"} (owner rule: 0 wrong, >= ${PASS.minFullShare * 100}% fully understood)`);
  if (cache) console.log("  answers saved: scripts/fixtures/e14_2c_recorded.json");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
