/**
 * A request body as text, never read past `maxBytes`.
 *
 * `req.text()` reads the whole body before anything can measure it, and a
 * chunked body carries no Content-Length, so a size check after `req.text()`
 * comes too late: a burst of large chunked POSTs would sit in memory first.
 * This stops reading, and cancels the stream, the moment the cap is passed.
 * A declared Content-Length over the cap is refused before any read.
 */
export async function readBodyCapped(
    req: Request,
    maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
    const declared = Number(req.headers.get('content-length') || 0)
    if (declared > maxBytes) return { ok: false }
    if (!req.body) return { ok: true, text: '' }

    const reader = req.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
            await reader.cancel()
            return { ok: false }
        }
        chunks.push(value)
    }
    // TextDecoder drops a leading UTF-8 BOM like Request.json() does; a plain
    // Buffer.toString('utf8') keeps it and JSON.parse then throws on it.
    return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks)) }
}
