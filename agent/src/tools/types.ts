/**
 * The tool contract.
 *
 * Two rules shape everything here, both from the backlog's security note: the
 * microphone is an attack surface, so anything the television says can reach a
 * tool. Hence read-only tools first, and an explicit allowlist rather than an
 * open plugin surface — a tool exists only if it is in the registry.
 */

/** JSON Schema for a tool's arguments, as the model is shown it. */
export interface ToolParameters {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
}

export interface Tool {
	name: string;
	/** Shown to the model. It decides from this alone, so it must say when to
	 * use the tool, not just what the tool is. */
	description: string;
	parameters: ToolParameters;
	/**
	 * Whether this tool changes anything. Everything in phase 2 is read-only;
	 * the flag exists so that adding a tool that is not read-only has to be a
	 * deliberate act rather than an oversight.
	 */
	readOnly: true;
	/**
	 * Run it. Returns text destined for the model's context, not for a speaker
	 * — the model rewrites it into speech on the second round.
	 *
	 * Throwing is fine: the loop turns it into a message the model can talk
	 * about, which is better than a silent failure Barnaby cannot explain.
	 */
	run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}

/** The OpenAI-compatible shape sent in the request's `tools` array. */
export interface ToolSpec {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: ToolParameters;
	};
}

export function toSpec(tool: Tool): ToolSpec {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}
