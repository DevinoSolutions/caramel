/* Builds assets/coupon-box-finder.js, the promo-box finder the content script
 * loads on demand (coupon-box-finder-loader.js). The build (wxt.config.ts) and
 * the size budget (scripts/measure-size.mjs) both call this, so the file that
 * ships is the file that is measured.
 *
 * The finder imports a few functions from caramel-base.js, dom-utils.js and
 * the loader. A copy of those modules inside this file would be a second
 * logger, a second set of last-read prices and a second flag answer, all
 * apart from the content script's. So those imports are not bundled: they
 * resolve to one small host module whose bindings the loader fills with the
 * content script's own functions (caramelProvideFinderHost) before anything
 * in the finder runs. Any other local import fails the build.
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
    FINDER_ASSET,
    FINDER_SOURCE,
    finderHostNames,
    HOST_MODULES,
} from './finder-files.mjs'

export { FINDER_ASSET, FINDER_SOURCE }
const HOST = 'caramel-finder-host'

export async function buildFinderModule(root) {
    const source = await readFile(join(root, FINDER_SOURCE), 'utf8')
    const names = finderHostNames(source)
    const host =
        `export let ${names.join(', ')}\n` +
        `export function caramelProvideFinderHost(h) {\n` +
        names.map(n => `    ${n} = h.${n}\n`).join('') +
        `}\n`
    const result = await build({
        stdin: {
            contents:
                `export * from './${FINDER_SOURCE}'\n` +
                `export { caramelProvideFinderHost } from '${HOST}'\n`,
            resolveDir: root,
            loader: 'js',
        },
        bundle: true,
        format: 'esm',
        minify: true,
        target: 'es2022',
        platform: 'browser',
        write: false,
        metafile: true,
        plugins: [
            {
                name: 'finder-host',
                setup(b) {
                    b.onResolve({ filter: /.*/ }, args => {
                        if (args.path === HOST || HOST_MODULES.has(args.path))
                            return { path: HOST, namespace: HOST }
                        return undefined
                    })
                    b.onLoad({ filter: /.*/, namespace: HOST }, () => ({
                        contents: host,
                        loader: 'js',
                    }))
                },
            },
        ],
    })
    const bundled = Object.keys(result.metafile.inputs).filter(
        f => !f.startsWith(HOST + ':') && f !== '<stdin>',
    )
    if (bundled.length !== 1 || !bundled[0].endsWith(FINDER_SOURCE))
        throw new Error(
            `the finder bundle may hold only ${FINDER_SOURCE}, got: ${bundled.join(', ')}`,
        )
    return result.outputFiles[0].text
}
