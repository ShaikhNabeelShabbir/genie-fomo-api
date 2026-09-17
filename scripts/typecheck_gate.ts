// Typecheck gate for the Deno code.
//
// The gate is "no NEW errors": the set of `deno check` error messages must equal the recorded
// baseline (empty: keep it so), ignoring file names and line numbers (a split moves both).
//
//   deno task check             compare against scripts/typecheck_baseline.txt
//   deno task check --record    rewrite the baseline from the current tree

const ROOT = new URL("..", import.meta.url);
const BASELINE = "scripts/typecheck_baseline.txt";
const ENTRIES = [
  "supabase/functions/api/index.ts",
  "supabase/functions/aum-sample/index.ts",
  "supabase/functions/helius-webhook/index.ts",
  "scripts/smoke.ts",
  "scripts/acceptance_capture.ts",
  "scripts/typecheck_gate.ts",
];

const { stdout, stderr } = new Deno.Command(Deno.execPath(), {
  args: ["check", ...ENTRIES],
  cwd: ROOT,
  stdout: "piped",
  stderr: "piped",
}).outputSync();

const decoder = new TextDecoder();
const current = (decoder.decode(stdout) + decoder.decode(stderr))
  .replace(/\x1b\[[0-9;]*m/g, "")
  .split("\n")
  .filter((line) => /^TS[0-9]+ \[ERROR\]/.test(line))
  .sort();
const currentText = `${current.join("\n")}\n`;
const baselinePath = new URL(BASELINE, ROOT);

if (Deno.args[0] === "--record") {
  await Deno.writeTextFile(baselinePath, currentText);
  console.log(`recorded ${current.length} errors to ${BASELINE}`);
  Deno.exit(0);
}

const baselineText = await Deno.readTextFile(baselinePath);
const baseline = baselineText.split("\n").filter((line) => line !== "");

if (baselineText === currentText) {
  console.log(`typecheck gate: ok (${baseline.length} known errors, none new)`);
  Deno.exit(0);
}

console.log("typecheck gate: FAILED — error set differs from baseline:");
const known = new Set(baseline);
const seen = new Set(current);
const diff = [
  ...baseline.filter((line) => !seen.has(line)).map((line) => `< ${line}`),
  ...current.filter((line) => !known.has(line)).map((line) => `> ${line}`),
];
console.log(diff.slice(0, 40).join("\n"));
Deno.exit(1);
