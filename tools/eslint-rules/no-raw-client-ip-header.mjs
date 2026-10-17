// caramel/no-raw-client-ip-header — "rules become checks".
//
// #256: Better Auth keyed its per-IP rate limit on one shared bucket because
// the client IP was read from the wrong header. grabcaramel.com sits behind
// Cloudflare and Traefik, and Traefik's X-Real-IP is the Cloudflare edge, not
// the visitor; the trustworthy header is CF-Connecting-IP. That ordering now
// lives in ONE place, src/lib/clientIp.ts (CLIENT_IP_HEADERS / readClientIp).
// Naming one of these headers anywhere else re-opens the same bug.
//
// Reports any string literal (or substitution-free template literal) equal to
// `cf-connecting-ip`, `x-real-ip` or `x-forwarded-for`, case-insensitive. A
// literal rather than a `.get('...')` call so that `for (const name of
// ['x-real-ip', ...]) headers.get(name)` and `headers['x-real-ip']` are caught
// too. Not reported: a header name assembled at runtime. Comments are not
// literals, so prose may name the headers.

const CLIENT_IP_HEADER_NAMES = new Set([
    'cf-connecting-ip',
    'x-real-ip',
    'x-forwarded-for',
])

/** @type {import('eslint').Rule.RuleModule} */
const noRawClientIpHeader = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Read the client IP only through src/lib/clientIp.ts, the one place that knows the trusted header order.',
        },
        schema: [],
        messages: {
            rawClientIpHeader:
                "Do not name the '{{header}}' header here. Use readClientIp()/CLIENT_IP_HEADERS from '@/lib/clientIp': behind Cloudflare + Traefik the header order is load-bearing (CF-Connecting-IP first) and a hand-rolled read re-opens the shared-rate-limit-bucket bug (#256).",
        },
    },
    create(context) {
        const report = (node, header) => {
            if (!CLIENT_IP_HEADER_NAMES.has(header.toLowerCase())) return
            context.report({
                node,
                messageId: 'rawClientIpHeader',
                data: { header },
            })
        }
        return {
            Literal(node) {
                if (typeof node.value === 'string') report(node, node.value)
            },
            TemplateLiteral(node) {
                if (node.expressions.length === 0) {
                    report(node, node.quasis[0].value.cooked ?? '')
                }
            },
        }
    },
}

export default noRawClientIpHeader
