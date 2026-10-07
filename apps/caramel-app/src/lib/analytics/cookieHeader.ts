// src/lib/analytics/cookieHeader.ts
//
// Pure `name=value; name2=value2` parsing, shared by the browser (the
// `document.cookie` string) and the server (the `Cookie` request header) —
// both are the same wire format, so there is one reader, not two.

/**
 * Every raw (still URL-encoded) value of the cookie `name`, in header order.
 * More than one is possible when a host-only and a Domain=apex cookie of the
 * same name coexist; callers pick the first that validates.
 */
export function readCookieValues(
    cookieString: string | null | undefined,
    name: string,
): string[] {
    if (!cookieString) return []
    const prefix = `${name}=`
    const values: string[] = []
    for (const part of cookieString.split(';')) {
        const trimmed = part.trim()
        if (trimmed.startsWith(prefix))
            values.push(trimmed.slice(prefix.length))
    }
    return values
}
