/**
 * Barnaby's system prompt, assembled from two halves.
 *
 * The agent knows WHO he is: his name, the household he lives with, what he
 * must not say. That is the same whoever is asking.
 *
 * The client knows HOW its answers will be consumed. The Pi speaks them aloud
 * through a speaker with no screen, so it wants no markdown, short answers, and
 * numbers rounded the way people say them. A web chat would want the opposite —
 * markdown renders, and length is cheap. **The agent cannot know which it is
 * talking to**, so it must not decide: a caller's system message is presentation
 * guidance, and it is appended rather than dropped.
 *
 * The split is worth stating precisely, because it is easy to get backwards:
 *
 *   agent  — identity, household context, safety. Facts about Barnaby.
 *   client — medium, length, formatting. Facts about the channel.
 */

import type { Message } from "./agent.ts";

/**
 * Who Barnaby is. Nothing here assumes anything about how the answer is
 * delivered — no mention of speaking, markdown, or length, because a caller
 * that renders markdown is just as valid as one that speaks.
 */
const IDENTITY = `You are Barnaby, a companion robot in a shared home.

If you do not know something, say so plainly rather than guessing.

Never read out personal information unless you have been told who is asking.`;

/**
 * Assemble the system message.
 *
 * Order is identity, then household, then the caller's presentation guidance.
 * The caller comes last so it can qualify what came before — a client saying
 * "one or two short sentences" should win over any general inclination.
 */
export function systemPrompt(context: string, clientPrompt = ""): string {
	const parts = [IDENTITY];
	if (context !== "")
		parts.push(`About the household you live with:\n\n${context}`);
	if (clientPrompt !== "") parts.push(clientPrompt);
	return parts.join("\n\n");
}

/**
 * Put the assembled system message at the front, folding in whatever the
 * caller sent.
 *
 * Multiple system messages are concatenated in order rather than the last one
 * winning, since a caller that sends several means all of them.
 */
export function withSystemPrompt(
	messages: Message[],
	context: string,
): Message[] {
	const clientPrompt = messages
		.filter((m) => m.role === "system")
		.map((m) => (typeof m.content === "string" ? m.content.trim() : ""))
		.filter((text) => text !== "")
		.join("\n\n");

	const rest = messages.filter((m) => m.role !== "system");
	return [
		{ role: "system", content: systemPrompt(context, clientPrompt) },
		...rest,
	];
}
