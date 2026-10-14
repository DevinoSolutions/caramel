// src/lib/llmJson.ts
//
// Reading the JSON answer out of a model reply. Shared by the app's LLM
// surfaces (the cart classifier and the coupon-box pick) so there is one
// parser, not one per surface.

// End index (exclusive) of the balanced `{...}` that opens at `start`, or
// -1 when the braces never close (a truncated reply). Braces inside JSON
// strings are skipped, including escaped quotes, so `{"a":"}"}` is one
// object and not a premature close.
function balancedObjectEnd(text: string, start: number): number {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
            if (ch === '\\') i++
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) return i + 1
        }
    }
    return -1
}

// CARAMEL-G (2026-09-24/25) — the FIRST complete JSON object in the reply.
// `response_format: json_object` is a request, not a guarantee: for the
// default model (anthropic/claude-haiku-4.5) OpenRouter can route to an
// endpoint that does not support `response_format` at all, and the model
// then answered with a pretty-printed object followed by a line of
// commentary. The previous fallback, a GREEDY `/\{[\s\S]*\}/`, ran from the
// first `{` to the LAST `}` in the whole reply, so any brace in that
// trailing text dragged it into the slice and the unguarded JSON.parse threw
// a raw SyntaxError ("Unexpected non-whitespace character after JSON at
// position 77 (line 6 column 1)"). Each `{` is tried in order and the first
// balanced slice that parses wins; one that does not parse (a brace in prose
// before the answer) is skipped, never repaired or guessed at.
export function firstJsonObject(raw: string): unknown {
    for (
        let start = raw.indexOf('{');
        start !== -1;
        start = raw.indexOf('{', start + 1)
    ) {
        const end = balancedObjectEnd(raw, start)
        if (end === -1) continue
        try {
            return JSON.parse(raw.slice(start, end))
        } catch {
            // Balanced but not JSON (e.g. "{the} answer") — try the next `{`.
        }
    }
    throw new Error('llm returned non-json')
}
