/*
 * Content script for listening to postMessage from web app
 * This script runs on all pages to capture authentication messages
 */

const currentBrowser = (() => {
    if (typeof chrome !== 'undefined') return chrome
    if (typeof browser !== 'undefined') return browser
    throw new Error('Browser is not supported!')
})()

// Listen for postMessage from the web application
window.addEventListener('message', (event) => {
    // Verify the message is from the same origin
    if (event.source !== window) return
    
    if (event.data?.type === 'CARAMEL_EXTENSION_AUTH') {
        const { token, username, image } = event.data
        
        if (token && username) {
            // Store auth data in extension storage
            currentBrowser.storage.sync.set({
                token,
                user: { username, image }
            }, () => {
                // Notify background script that auth is complete
                currentBrowser.runtime.sendMessage({
                    action: 'authComplete',
                    data: { token, username, image }
                })
            })
        }
    }
})
