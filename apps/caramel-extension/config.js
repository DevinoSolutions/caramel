/**
 * Extension configuration
 * 
 * For local development, set BASE_URL to http://localhost:58000
 * For production, set BASE_URL to https://grabcaramel.com
 * 
 * You can override this by setting EXTENSION_BASE_URL environment variable during build
 */

// Default to production URL
// This will be replaced during build if EXTENSION_BASE_URL is set
// For local development, change this to: 'http://localhost:58000'
const BASE_URL = 'http://localhost:58000'

// Export configuration
if (typeof window !== 'undefined') {
    // Browser environment (popup, content scripts)
    window.EXTENSION_CONFIG = {
        BASE_URL: BASE_URL,
    }
} else if (typeof global !== 'undefined') {
    // Node/service worker environment
    global.EXTENSION_CONFIG = {
        BASE_URL: BASE_URL,
    }
}
