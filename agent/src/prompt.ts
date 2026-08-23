/**
 * Barnaby's system prompt. It lives here, not on the Pi.
 *
 * The Pi is a client of an agent: it sends what was said and plays what comes
 * back. Who Barnaby is, which model answers, and what tools exist are all
 * decisions of the intelligence layer, and this is the intelligence layer.
 *
 * Practical consequence: editing his personality no longer means an rsync and
 * a service restart on the robot.
 */

import type { PersonalContext } from "./context.ts";
import type { Message } from "./agent.ts";

/**
 * The base prompt.
 *
 * Every line is about being SPOKEN. He has no screen to put a list on, and
 * markdown read aloud is gibberish.
 */
const BASE = `You are Barnaby, a companion robot on a kitchen counter in a shared home.

Answer in one or two short sentences. You are being spoken aloud, so never use markdown, lists, or symbols — write as you would speak. Say "degrees" rather than a degree sign, and write numbers as you would say them. If you do not know something, say so plainly rather than guessing.

Never read out personal information unless you have been told who is asking.`;

/**
 * Assemble the system message.
 *
 * Personal context goes after the base so it can qualify it, and under a
 * heading so the model can tell "who I am" from "what I know about them".
 */
export function systemPrompt(context: PersonalContext): string {
	if (context.prose === "") return BASE;
	return `${BASE}\n\nAbout the household you live with:\n\n${context.prose}`;
}

/**
 * Put our system message at the front, dropping any the caller sent.
 *
 * The Pi still sends one today, and this ignores it rather than breaking it —
 * the Pi keeps working untouched while the prompt it sends stops mattering.
 * Same shape as the model override: the agent decides, the client need not
 * change.
 */
export function withSystemPrompt(
	messages: Message[],
	context: PersonalContext,
): Message[] {
	const rest = messages.filter((m) => m.role !== "system");
	return [{ role: "system", content: systemPrompt(context) }, ...rest];
}
