import {
    COMPARISON_SOURCES,
    type ComparisonSourceId,
} from '@/lib/seo/extensionComparison'

// Superscript footnote links ("[3]") into a page's numbered source list.
// `order` is that page's own first-citation order, so the same source can
// carry a different number on /compare/coupon-extensions and /honey-extension;
// the list it points at is rendered from the same order (#source-<n>).
export default function SourceRefList({
    ids,
    order,
}: {
    ids: ReadonlyArray<ComparisonSourceId>
    order: ReadonlyArray<ComparisonSourceId>
}) {
    return (
        <span>
            {ids.map(id => {
                const index = order.indexOf(id)
                if (index === -1) {
                    throw new Error(
                        `SourceRefList: "${id}" is cited but missing from this page's source order`,
                    )
                }
                const n = index + 1
                return (
                    <a
                        key={id}
                        href={`#source-${n}`}
                        aria-label={`Source ${n}: ${COMPARISON_SOURCES[id].title}`}
                        className="ml-0.5 align-super text-xs font-semibold text-caramel hover:underline"
                    >
                        [{n}]
                    </a>
                )
            })}
        </span>
    )
}

/** The numbered source list the footnotes point at, one `#source-<n>` per
 *  source in `order`. */
export function SourceList({
    order,
}: {
    order: ReadonlyArray<ComparisonSourceId>
}) {
    return (
        <ol className="list-decimal space-y-2 pl-6 text-sm text-gray-700 dark:text-gray-300">
            {order.map((id, index) => {
                const source = COMPARISON_SOURCES[id]
                return (
                    <li
                        key={id}
                        id={`source-${index + 1}`}
                        className="scroll-mt-28"
                    >
                        <a
                            href={source.url}
                            className="font-medium text-caramel hover:underline"
                        >
                            {source.title}
                        </a>
                        , {source.publisher}
                    </li>
                )
            })}
        </ol>
    )
}
