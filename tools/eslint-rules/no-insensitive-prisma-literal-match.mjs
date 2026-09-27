// caramel/no-insensitive-prisma-literal-match — "rules become checks".
//
// 2026-09-27: Prisma compiles a string filter that pairs `mode: 'insensitive'`
// with `equals`, `startsWith`, `endsWith` or `not` to an UNESCAPED `ILIKE`, so
// an `_` or `%` in the value is a wildcard. An account registered as `j_hn@x`
// matched, and delete-my-data scrubbed, the rows `john@x` owned
// (src/lib/siteSuggestionIdentity.ts). Fold the value in JS, store it folded,
// and match it with a plain `equals`.
//
// Deliberately NOT reported:
// - `in` / `notIn`: they compile to `LOWER(col) IN (LOWER($1), ...)`, which is
//   plain equality with no pattern.
// - `contains`: a substring search is a pattern by intent (search boxes), not
//   an identity lookup.
//
// What the rule can see: the operator and `mode` keys written as identifiers
// or string literals (quoted, or computed `['equals']`), and a `mode` value
// that is `'insensitive'` (also as a template literal, or behind `as` /
// `satisfies` / `!`), any `X.insensitive` / `X['insensitive']` member (e.g.
// `Prisma.QueryMode.insensitive`), or an identifier (shorthand `{ mode }`
// included) bound by a single `const` to one of those. What it cannot see, and
// so never reports: spreads (`...caseInsensitive`), a `mode` that arrives as a
// parameter, a `let`, or an import, and raw SQL (`$queryRaw` ILIKE/LIKE).

const LITERAL_MATCH_OPERATORS = new Set([
    'equals',
    'startsWith',
    'endsWith',
    'not',
])

// Wrappers that change a value's TYPE, never the value itself.
const TYPE_ONLY_WRAPPERS = new Set([
    'TSAsExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
    'TSNonNullExpression',
])

/** The key's name when it is statically known, else null (spreads included). */
function staticKeyName(property) {
    if (property.type !== 'Property') return null
    const { key, computed } = property
    if (!computed && key.type === 'Identifier') return key.name
    if (key.type === 'Literal' && typeof key.value === 'string')
        return key.value
    return null
}

function findVariable(scope, name) {
    for (let current = scope; current; current = current.upper) {
        const variable = current.set.get(name)
        if (variable) return variable
    }
    return null
}

/** True only when `node` provably evaluates to Prisma's 'insensitive' mode. */
function isInsensitiveMode(node, scope, followed = new Set()) {
    let value = node
    while (TYPE_ONLY_WRAPPERS.has(value.type)) value = value.expression

    switch (value.type) {
        case 'Literal':
            return value.value === 'insensitive'
        case 'TemplateLiteral':
            return (
                value.expressions.length === 0 &&
                value.quasis[0].value.cooked === 'insensitive'
            )
        case 'MemberExpression':
            return value.computed
                ? value.property.type === 'Literal' &&
                      value.property.value === 'insensitive'
                : value.property.name === 'insensitive'
        case 'Identifier': {
            const variable = findVariable(scope, value.name)
            if (!variable || followed.has(variable)) return false
            if (variable.defs.length !== 1) return false
            const [definition] = variable.defs
            if (
                definition.type !== 'Variable' ||
                definition.parent.kind !== 'const' ||
                definition.node.id.type !== 'Identifier' ||
                !definition.node.init
            ) {
                return false
            }
            followed.add(variable)
            return isInsensitiveMode(
                definition.node.init,
                variable.scope,
                followed,
            )
        }
        default:
            return false
    }
}

/** @type {import('eslint').Rule.RuleModule} */
const noInsensitivePrismaLiteralMatch = {
    meta: {
        type: 'problem',
        docs: {
            description:
                "Disallow Prisma's `mode: 'insensitive'` beside equals/startsWith/endsWith/not, which compiles to an unescaped ILIKE",
        },
        schema: [],
        messages: {
            unescapedIlike:
                "Never `{ {{operator}}, mode: 'insensitive' }` — Prisma compiles it to an unescaped ILIKE, so `_`/`%` in the value become wildcards (a lookalike email matches someone else's rows). Store the value folded and match it exactly (see src/lib/siteSuggestionIdentity.ts foldRequesterEmail).",
        },
    },
    create(context) {
        return {
            ObjectExpression(node) {
                let modeProperty = null
                const literalMatches = []
                for (const property of node.properties) {
                    const name = staticKeyName(property)
                    if (name === 'mode') modeProperty = property
                    else if (LITERAL_MATCH_OPERATORS.has(name)) {
                        literalMatches.push({ property, operator: name })
                    }
                }
                if (!modeProperty || literalMatches.length === 0) return
                const scope = context.sourceCode.getScope(node)
                if (!isInsensitiveMode(modeProperty.value, scope)) return
                for (const { property, operator } of literalMatches) {
                    context.report({
                        node: property,
                        messageId: 'unescapedIlike',
                        data: { operator },
                    })
                }
            },
        }
    },
}

export default noInsensitivePrismaLiteralMatch
