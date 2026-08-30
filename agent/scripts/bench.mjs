/**
 * Benchmark a model as Barnaby actually uses it: the real system prompt,
 * kitchen-shaped questions, streaming, thinking off.
 *
 * Reports TTFT and tok/s, which is what the latency budget cares about, plus
 * whether markdown leaked into text destined for a speaker.
 *
 *   node bench.mjs                                     # through the gateway
 *   node bench.mjs <url> <model>                       # anything else
 */

const URL_ = process.argv[2] ?? "http://127.0.0.1:8100/v1/chat/completions";
const MODEL = process.argv[3] ?? "qwen3.6-35b-8bit";

// Kept in step with SYSTEM in orchestrator/barnaby/pipeline.py — a different
// prompt gives different answer lengths and makes the numbers incomparable.
const SYSTEM = `You are Barnaby, a companion robot on a kitchen counter in a shared home.

Answer in one or two short sentences. You are being spoken aloud, so never use markdown, lists, or symbols — write as you would speak. If you do not know something, say so plainly rather than guessing.`;

const QUESTIONS = [
	"How long should I boil an egg?",
	"What is the weather like on Mars?",
	"Tell me something about owls.",
	"What time do most people eat dinner?",
	"Is it going to rain tomorrow?",
];

async function ask(question) {
	const startedAt = Date.now();
	const response = await fetch(URL_, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: "system", content: SYSTEM },
				{ role: "user", content: question },
			],
			stream: true,
			max_tokens: 400,
			temperature: 0.4,
			chat_template_kwargs: { enable_thinking: false },
		}),
	});
	if (!response.ok)
		throw new Error(`${response.status}: ${await response.text()}`);

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let ttft = null;
	let text = "";
	let tokens = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		pending += decoder.decode(value, { stream: true });

		const lines = pending.split("\n");
		pending = lines.pop() ?? "";
		for (const line of lines) {
			const trimmed = line.trim();
			// rapid-mlx also emits `: keepalive` comments; skip anything that
			// is not a data frame.
			if (!trimmed.startsWith("data: ")) continue;
			const blob = trimmed.slice(6).trim();
			if (blob === "[DONE]") continue;
			try {
				const delta = JSON.parse(blob).choices[0]?.delta ?? {};
				if (!delta.content) continue;
				if (ttft === null) ttft = Date.now() - startedAt;
				text += delta.content;
				tokens += 1;
			} catch {
				// A partial or unexpected frame is not worth failing a benchmark over.
			}
		}
	}

	const total = Date.now() - startedAt;
	return {
		ttft: ttft ?? total,
		total,
		tokens,
		tps: tokens / Math.max((total - (ttft ?? 0)) / 1000, 0.001),
		text: text.trim(),
	};
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

console.log(`model=${MODEL}\nurl=${URL_}\n`);

// Discard a warmup turn: cold weights would otherwise land entirely in run one.
await ask("warmup");

const results = [];
for (const question of QUESTIONS) {
	const r = await ask(question);
	results.push(r);
	console.log(
		`  ttft=${String(r.ttft).padStart(4)}ms total=${String(r.total).padStart(5)}ms` +
			` tok=${String(r.tokens).padStart(3)} tok/s=${r.tps.toFixed(1).padStart(5)}  ${r.text.slice(0, 66)}`,
	);
}

const leaked = results.filter((r) => /[*#`]/.test(r.text)).length;
console.log(
	`\n  MEDIAN ttft=${median(results.map((r) => r.ttft))}ms` +
		`  tok/s=${median(results.map((r) => r.tps)).toFixed(1)}`,
);
console.log(`  markdown leaked into speech: ${leaked}/${results.length}`);
