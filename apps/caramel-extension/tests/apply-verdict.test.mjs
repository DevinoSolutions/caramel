import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Characterization of applyCoupon()'s snapshot -> verdict path.
 *
 * Pinned 2026-10-02, BEFORE the snapshot/verdict logic was extracted into
 * caramelSnapshotCart / caramelAwaitCouponVerdict (shared with
 * code-capture.js, which judges a shopper-typed code by the same rule). The
 * suites around it (apply-multi-price-total, false-success,
 * pre-existing-discount, ...) pin the price arithmetic and the runner's
 * reaction to a verdict; none of them pins the SUCCESS RULE itself:
 *
 *     priceDropped || (committed && stuck) || (committed && !errorMsg)
 *
 * These drive the REAL applyCoupon against a real (jsdom) checkout and assert
 * the verdict triple for each branch, so the extraction cannot move it.
 */

let applyCoupon

const BASE = {
    domain: 'example.com',
    couponInput: '#promo',
    couponSubmit: '#apply',
}

/** jsdom has no layout: innerText is undefined and nothing is "visible".
 *  textContent is set too, because the price watcher observes DOM mutations
 *  and a bare property definition mutates nothing. */
function setText(el, text) {
    el.textContent = text
    Object.defineProperty(el, 'innerText', {
        value: text,
        configurable: true,
    })
}

/** The store answers one tick AFTER the click, like a real round-trip (the
 *  verdict waiter baselines the page right after the submit is dispatched). */
function respond(fn) {
    document.getElementById('apply').addEventListener('click', () => {
        setTimeout(fn, 150)
    })
}

function mountAppliedRow() {
    const row = document.createElement('div')
    row.id = 'applied-row'
    setText(row, 'SAVE10 applied')
    document.body.appendChild(row)
}

function showError(text) {
    const err = document.getElementById('err')
    setText(err, text)
}

beforeAll(() => {
    const { Element } = globalThis.window ?? globalThis
    Element.prototype.checkVisibility = () => true
})

beforeEach(async () => {
    document.body.innerHTML =
        '<input id="promo" /><button id="apply">Apply</button>' +
        '<div id="total"></div><div id="err"></div>'
    setText(document.getElementById('total'), '$100.00')
    vi.resetModules()
    ;({ applyCoupon } = await import('../coupon-apply.js'))
})

describe('applyCoupon verdict — success rule', () => {
    it('a price drop alone is a success, with the moved total', async () => {
        const rec = { ...BASE, priceContainer: '#total' }
        respond(() => setText(document.getElementById('total'), '$90.00'))

        const res = await applyCoupon('SAVE10', rec)

        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(90)
        expect(res.committed).toBe(false)
        expect(res.errorMsg).toBeNull()
    })

    it('error text with no applied row and no price move is a failure', async () => {
        const rec = { ...BASE, errorIndicator: '#err' }
        respond(() => showError('This code is invalid'))

        const res = await applyCoupon('NOPE', rec)

        expect(res.success).toBe(false)
        expect(res.committed).toBe(false)
        expect(res.errorMsg).toBe('This code is invalid')
        expect(res.errorIsNew).toBe(true)
    })

    it('an applied row that stays, with no error, is a success', async () => {
        const rec = { ...BASE, successIndicator: '#applied-row' }
        respond(mountAppliedRow)

        const res = await applyCoupon('SAVE10', rec)

        expect(res.success).toBe(true)
        expect(res.committed).toBe(true)
        expect(res.errorMsg).toBeNull()
    })

    it('a row that sticks beats a noisy error region (rule 2)', async () => {
        const rec = {
            ...BASE,
            successIndicator: '#applied-row',
            errorIndicator: '#err',
        }
        respond(() => {
            mountAppliedRow()
            showError('Your code is invalid for some items')
        })

        const res = await applyCoupon('SAVE10', rec)

        expect(res.committed).toBe(true)
        expect(res.errorMsg).toBeTruthy()
        expect(res.success).toBe(true)
    })

    // A box the finder picked (coupon-box-discovery.js) has no store-written
    // success selector behind it, so the money rule alone decides.
    it('a finder-picked box: an applied row that stays is NOT a success without a price drop', async () => {
        const rec = {
            ...BASE,
            successIndicator: '#applied-row',
            priceContainer: '#total',
            caramelFound: true,
        }
        respond(mountAppliedRow)

        const res = await applyCoupon('SAVE10', rec)

        expect(res.committed).toBe(true)
        expect(res.success).toBe(false)
    })

    it('a finder-picked box: a price drop is a success', async () => {
        const rec = { ...BASE, priceContainer: '#total', caramelFound: true }
        respond(() => setText(document.getElementById('total'), '$90.00'))

        const res = await applyCoupon('SAVE10', rec)

        expect(res.success).toBe(true)
        expect(res.newTotal).toBe(90)
    })

    it('a finder-picked box: the store answering in the box ends the wait early', async () => {
        document.body.insertAdjacentHTML('beforeend', '<div id="ans"></div>')
        const rec = {
            ...BASE,
            priceContainer: '#total',
            caramelFound: true,
            caramelAnswer: '#ans',
        }
        respond(() =>
            setText(document.getElementById('ans'), 'Sorry, NOPE is not valid'),
        )

        const started = performance.now()
        const res = await applyCoupon('NOPE', rec)

        expect(res.success).toBe(false)
        // The answer window is 10s; the store answered after 150ms.
        expect(performance.now() - started).toBeLessThan(4000)
    })

    /** jsdom has no innerText; the finder's readers walk containers by it. */
    async function withInnerText(fn) {
        const proto = globalThis.HTMLElement.prototype
        const prior = Object.getOwnPropertyDescriptor(proto, 'innerText')
        Object.defineProperty(proto, 'innerText', {
            configurable: true,
            get() {
                return this.textContent
            },
        })
        try {
            await fn()
        } finally {
            if (prior) Object.defineProperty(proto, 'innerText', prior)
            else delete proto.innerText
        }
    }
    const FINDER_REC = {
        ...BASE,
        priceContainer: '#total',
        caramelFound: true,
        caramelAnswer: '.promo',
    }

    it("a finder-picked box: the store's own sentence is quoted, not the field's label or a static hint", async () => {
        document.body.innerHTML =
            '<div class="promo"><label for="promo">Promo code</label>' +
            '<input id="promo" /><button id="apply">Apply</button>' +
            '<div id="msg"></div>' +
            '<p class="hint">Enter a valid promo code to see your savings</p></div>' +
            '<div id="total">$100.00</div>'
        await withInnerText(async () => {
            respond(() => {
                document.getElementById('msg').textContent =
                    'Sorry, the code NOPE is not valid.'
            })

            const res = await applyCoupon('NOPE', FINDER_REC)

            expect(res.success).toBe(false)
            expect(res.errorMsg).toBe('Sorry, the code NOPE is not valid.')
            expect(res.errorIsNew).toBe(true)
        })
    })

    it('a finder-picked box: a second refusal that only changes the code named still ends the wait', async () => {
        document.body.innerHTML =
            '<div class="promo"><input id="promo" /><button id="apply">Apply</button>' +
            '<div id="msg">Sorry, the code FIRST is not valid.</div></div>' +
            '<div id="total">$100.00</div>'
        await withInnerText(async () => {
            respond(() => {
                document.getElementById('msg').textContent =
                    'Sorry, the code SECOND is not valid.'
            })

            const started = performance.now()
            const res = await applyCoupon('SECOND', FINDER_REC)

            expect(res.success).toBe(false)
            expect(performance.now() - started).toBeLessThan(4000)
        })
    }, 15000)

    it('a finder-picked box: the button reading "Applying…" is not the store answering', async () => {
        // A slow cart: the button changes at once, the total 2.5s later.
        document.body.innerHTML =
            '<div class="promo"><label for="promo">Promo code</label>' +
            '<input id="promo" /><button id="apply">Apply</button></div>' +
            '<div id="total">$100.00</div>'
        await withInnerText(async () => {
            document.getElementById('apply').addEventListener('click', () => {
                setTimeout(() => {
                    document.getElementById('apply').textContent = 'Applying…'
                }, 50)
                setTimeout(() => {
                    document.getElementById('total').textContent = '$90.00'
                }, 2500)
            })

            const res = await applyCoupon('SAVE10', FINDER_REC)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(90)
        })
    }, 15000)

    it('a finder-picked box: a summary that re-renders its total row is still read', async () => {
        document.body.innerHTML =
            '<div class="promo"><input id="promo" name="promo_code" />' +
            '<button id="apply">Apply</button></div>' +
            '<div id="sum"><div data-caramel-found="total"><span>Order total</span> <span>$100.00</span></div></div>'
        await withInnerText(async () => {
            respond(() => {
                document.getElementById('sum').innerHTML =
                    '<div><span>Order total</span> <span>$90.00</span></div>'
            })
            const rec = {
                ...FINDER_REC,
                priceContainer: '[data-caramel-found="total"]',
                caramelTotalKind: 'total',
                caramelTotalLabel: 'order total',
                caramelTotalRows: 1,
            }

            const res = await applyCoupon('SAVE10', rec)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(90)
        })
    }, 15000)

    it("a finder-picked box: a line item's own total is never read while the summary is mid-render", async () => {
        // The baseline saw two total rows: the line item's and the order's.
        // While the store re-renders its summary (a skeleton), the line
        // item's "Total $19.99" is the only one left on the page.
        document.body.innerHTML =
            '<div class="promo"><input id="promo" /><button id="apply">Apply</button>' +
            '<div id="msg"></div></div>' +
            '<div class="line"><span>Total</span> <span>$19.99</span></div>' +
            '<div id="sum"><div data-caramel-found="total"><span>Order total</span> <span>$100.00</span></div></div>'
        await withInnerText(async () => {
            document.getElementById('apply').addEventListener('click', () => {
                setTimeout(() => {
                    document.getElementById('sum').innerHTML =
                        '<div class="skeleton"></div>'
                }, 50)
                setTimeout(() => {
                    document.getElementById('sum').innerHTML =
                        '<div><span>Order total</span> <span>$100.00</span></div>'
                    document.getElementById('msg').textContent =
                        'Sorry, the code NOPE is not valid.'
                }, 1500)
            })
            const rec = {
                ...FINDER_REC,
                priceContainer: '[data-caramel-found="total"]',
                caramelTotalKind: 'total',
                caramelTotalLabel: 'order total',
                caramelTotalRows: 2,
            }

            const res = await applyCoupon('NOPE', rec)

            expect(res.success).toBe(false)
        })
    }, 15000)

    it('a finder-picked box: a total row that becomes two (a sticky bar appears) is still read', async () => {
        document.body.innerHTML =
            '<div class="promo"><input id="promo" /><button id="apply">Apply</button></div>' +
            '<div id="sum"><div data-caramel-found="total"><span>Order total</span> <span>$100.00</span></div></div>'
        await withInnerText(async () => {
            respond(() => {
                document.getElementById('sum').innerHTML =
                    '<div><span>Order total</span> <span>$90.00</span></div>' +
                    '<div class="sticky"><span>Order total</span> <span>$90.00</span></div>'
            })
            const rec = {
                ...FINDER_REC,
                priceContainer: '[data-caramel-found="total"]',
                caramelTotalKind: 'total',
                caramelTotalLabel: 'order total',
                caramelTotalRows: 1,
            }

            const res = await applyCoupon('SAVE10', rec)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(90)
        })
    }, 15000)

    it('a finder-picked box: a summary that hides its old row and shows a new one is read on the new one', async () => {
        document.body.innerHTML =
            '<div class="promo"><input id="promo" /><button id="apply">Apply</button></div>' +
            '<div id="old" data-caramel-found="total"><span>Order total</span> <span>$100.00</span></div>'
        const prior = Element.prototype.checkVisibility
        Element.prototype.checkVisibility = function () {
            return !this.closest('[hidden]')
        }
        try {
            await withInnerText(async () => {
                respond(() => {
                    document.getElementById('old').hidden = true
                    document.body.insertAdjacentHTML(
                        'beforeend',
                        '<div><span>Order total</span> <span>$90.00</span></div>',
                    )
                })
                const rec = {
                    ...FINDER_REC,
                    priceContainer: '[data-caramel-found="total"]',
                    caramelTotalKind: 'total',
                    caramelTotalLabel: 'order total',
                    caramelTotalRows: 1,
                }

                const res = await applyCoupon('SAVE10', rec)

                expect(res.success).toBe(true)
                expect(res.newTotal).toBe(90)
            })
        } finally {
            Element.prototype.checkVisibility = prior
        }
    }, 15000)

    it('a finder-picked box: a refusal split across bold text beside a link is still read', async () => {
        document.body.innerHTML =
            '<div class="promo"><input id="promo" /><button id="apply">Apply</button>' +
            '<p id="msg"></p></div>' +
            '<div id="total">$100.00</div>'
        await withInnerText(async () => {
            respond(() => {
                document.getElementById('msg').innerHTML =
                    'Code <b>NOPE</b> is not <i>valid</i>. <a href="#">Learn more</a>'
            })

            const started = performance.now()
            const res = await applyCoupon('NOPE', FINDER_REC)

            expect(res.success).toBe(false)
            expect(res.errorMsg).toBe('Code NOPE is not valid.')
            expect(performance.now() - started).toBeLessThan(4000)
        })
    }, 15000)

    it('a finder-picked box: a refusal in words the generic list lacks still ends the wait', async () => {
        // A live store's own words: "not an active offer" is a refusal the
        // narrow config vocabulary does not know.
        document.body.innerHTML =
            '<div class="promo"><input id="promo" /><button id="apply">Apply</button>' +
            '<p id="msg"></p></div>' +
            '<div id="total">$100.00</div>'
        await withInnerText(async () => {
            respond(() => {
                document.getElementById('msg').textContent =
                    'The discount code you entered is not an active offer.'
            })

            const started = performance.now()
            const res = await applyCoupon('LOUNGE', FINDER_REC)

            expect(res.success).toBe(false)
            expect(res.errorMsg).toBe(
                'The discount code you entered is not an active offer.',
            )
            expect(performance.now() - started).toBeLessThan(4000)
        })
    }, 15000)

    it("a finder-picked box: a form field's own error is not the store answering", async () => {
        document.body.innerHTML =
            '<div class="promo"><input id="promo" /><button id="apply">Apply</button>' +
            '<p id="msg"></p></div>' +
            '<div id="total">$100.00</div>'
        await withInnerText(async () => {
            document.getElementById('apply').addEventListener('click', () => {
                setTimeout(() => {
                    document.getElementById('msg').textContent =
                        'Enter a valid email address'
                }, 50)
                setTimeout(() => {
                    document.getElementById('total').textContent = '$90.00'
                }, 2500)
            })

            const res = await applyCoupon('SAVE10', FINDER_REC)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(90)
        })
    }, 15000)

    it('a finder-picked box: a $0.00 placeholder caught mid-render is not a saving', async () => {
        document.body.innerHTML =
            '<div class="promo"><input id="promo" /><button id="apply">Apply</button>' +
            '<div id="msg"></div></div>' +
            '<div id="total">$100.00</div>'
        await withInnerText(async () => {
            document.getElementById('apply').addEventListener('click', () => {
                setTimeout(() => {
                    document.getElementById('total').textContent = '$0.00'
                }, 50)
                setTimeout(() => {
                    document.getElementById('total').textContent = '$100.00'
                    document.getElementById('msg').textContent =
                        'Sorry, the code NOPE is not valid.'
                }, 1500)
            })

            const res = await applyCoupon('NOPE', FINDER_REC)

            expect(res.success).toBe(false)
        })
    }, 15000)

    it('a finder-picked box: a hint written beside the button is not an answer when the button relabels', async () => {
        // "Enter a valid code" sits as bare text in the same box as the
        // button, so the box's own text changes when the button does.
        document.body.innerHTML =
            '<div class="promo">Enter a valid code <input id="promo" />' +
            '<button id="apply">Apply</button></div>' +
            '<div id="total">$100.00</div>'
        await withInnerText(async () => {
            document.getElementById('apply').addEventListener('click', () => {
                setTimeout(() => {
                    document.getElementById('apply').textContent = 'Applying…'
                }, 50)
                setTimeout(() => {
                    document.getElementById('total').textContent = '$90.00'
                }, 2500)
            })

            const res = await applyCoupon('SAVE10', FINDER_REC)

            expect(res.success).toBe(true)
            expect(res.newTotal).toBe(90)
        })
    }, 15000)

    it('a finder-picked box: text the shopper cannot see is not the store answering', async () => {
        document.body.innerHTML =
            '<div class="promo"><input id="promo" /><button id="apply">Apply</button>' +
            '<div id="tpl" hidden>The code is not valid.</div></div>' +
            '<div id="total">$100.00</div>'
        const prior = Element.prototype.checkVisibility
        Element.prototype.checkVisibility = function () {
            return !this.closest('[hidden]')
        }
        try {
            await withInnerText(async () => {
                document
                    .getElementById('apply')
                    .addEventListener('click', () => {
                        setTimeout(() => {
                            document.getElementById('tpl').textContent =
                                'The code SAVE10 is not valid.'
                        }, 50)
                        setTimeout(() => {
                            document.getElementById('total').textContent =
                                '$90.00'
                        }, 2500)
                    })

                const res = await applyCoupon('SAVE10', FINDER_REC)

                expect(res.success).toBe(true)
                expect(res.newTotal).toBe(90)
            })
        } finally {
            Element.prototype.checkVisibility = prior
        }
    }, 15000)

    it('returns exactly the documented verdict keys', async () => {
        const rec = { ...BASE, successIndicator: '#applied-row' }
        respond(mountAppliedRow)

        const res = await applyCoupon('SAVE10', rec)

        expect(Object.keys(res).sort()).toEqual([
            'committed',
            'errorIsNew',
            'errorMsg',
            'newTotal',
            'success',
        ])
    })
})

describe('caramelAwaitCouponVerdict — logging of the code', () => {
    // The store's own furniture quotes the code before we submit anything, so
    // the verdict helper logs AUTO_INSERT_ERROR_NOT_ATTRIBUTABLE.
    async function runWith(opts) {
        const logged = []
        vi.resetModules()
        vi.doMock('../caramel-base.js', async importOriginal => ({
            ...(await importOriginal()),
            log: (...args) => logged.push(args),
        }))
        const mod = await import('../coupon-apply.js')
        const rec = { ...BASE, errorIndicator: '#err' }
        setText(document.getElementById('err'), 'Code SAVE10 is invalid')
        const snapshot = mod.caramelSnapshotCart(rec)
        await mod.caramelAwaitCouponVerdict(rec, snapshot, {
            code: 'SAVE10',
            timeoutMs: 300,
            ...opts,
        })
        vi.doUnmock('../caramel-base.js')
        return logged.filter(
            args => args[0] === 'AUTO_INSERT_ERROR_NOT_ATTRIBUTABLE',
        )
    }

    it('the runner keeps its full diagnostics (code and text)', async () => {
        const lines = await runWith({})

        expect(lines).toHaveLength(1)
        expect(JSON.stringify(lines[0])).toContain('SAVE10')
    })

    it('a redacted (shopper-code) verdict never logs the code or the page text', async () => {
        const lines = await runWith({ redact: true })

        expect(lines).toHaveLength(1)
        expect(JSON.stringify(lines)).not.toContain('SAVE10')
        expect(JSON.stringify(lines)).not.toContain('invalid')
    })
})
