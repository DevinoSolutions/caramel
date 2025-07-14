// Function to calculate Base64 encoding of a string
export function base64Encode(string) {
    // In a pure Node environment, replace with:
    // return Buffer.from(string, 'utf-8').toString('base64');
    return btoa(string)
}

// Function to decode a Base64-encoded string
export function base64Decode(string) {
    // In a pure Node environment, replace with:
    // return Buffer.from(string, 'base64').toString('utf-8');
    return atob(string)
}

// this is the chunk size for XOR operations to avoid stack overflow
const CHUNK_SIZE = 8192

export function xorWithBase64(text, key) {
    // Calculate the Base64 encoding of the key
    const base64Key = base64Encode(key)

    // Convert the Base64 key to a byte array
    const keyBytes = Array.from(base64Key, char => char.charCodeAt(0))

    // Convert the text to a byte array
    const textBytes = Array.from(text, char => char.charCodeAt(0))

    // XOR each byte of the text with the corresponding byte in the Base64 key
    const xorBytes = textBytes.map(
        (byte, index) => byte ^ keyBytes[index % keyBytes.length],
    )

    // Build result in chunks
    let result = ''
    for (let i = 0; i < xorBytes.length; i += CHUNK_SIZE) {
        const slice = xorBytes.slice(i, i + CHUNK_SIZE)
        result += String.fromCharCode(...slice)
    }

    return result
}

// Function to encrypt text and return a Base64-encoded result
export function encrypt(text, key) {
    const encryptedText = xorWithBase64(text, key)
    return base64Encode(encryptedText)
}

// Function to decrypt a Base64-encoded XOR'ed string
export function decrypt(base64Text, key) {
    const encryptedText = base64Decode(base64Text)
    return xorWithBase64(encryptedText, key)
}

/**
 * SERVER-SIDE HELPER:
 *  - Reads the 'host' header and removes any port (e.g. "localhost:3000" => "localhost")
 *  - Reads the 'user-agent'
 *  - Encrypts the entire JSON payload as one string
 */
export function encryptJsonServer(req, payload) {
    // Extract domain (strip any :port)
    const domain = (req.headers.host || '').replace(/:\d+$/, '')
    // Extract user agent
    const userAgent = req.headers['user-agent'] || ''

    // Combine them
    const key = domain + userAgent

    // Stringify and encrypt
    const jsonString = JSON.stringify(payload)
    return encrypt(jsonString, key)
}

/**
 * CLIENT-SIDE HELPER:
 *  - Uses window.location.hostname (no port) and navigator.userAgent
 *  - Decrypts the given base64Text to restore the original JSON object
 */
export function decryptJsonClient(base64Text) {
    // Domain (no port in the browser)
    const domain = window.location.hostname
    // User agent
    const userAgent = navigator.userAgent

    const key = domain + userAgent

    // Decrypt and parse
    const decryptedStr = decrypt(base64Text, key)
    return JSON.parse(decryptedStr)
}
