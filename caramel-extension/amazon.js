;(() => {
    window.getAmazonOrderTotal = async () => {
        const totalEl = document.querySelector(
            '#sc-subtotal-amount-buybox .a-size-medium.a-color-base',
        )
        if (!totalEl) {
            // Another fallback or return 0
            return '0.00'
        }
        const text = totalEl.innerText.replace(/[^0-9.]/g, '')
        return text || '0.00'
    }
})()
