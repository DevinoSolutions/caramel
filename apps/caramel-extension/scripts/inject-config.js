#!/usr/bin/env node

/**
 * Build script to inject BASE_URL into config.js from environment variables
 * 
 * Usage:
 *   EXTENSION_BASE_URL=http://localhost:58000 node scripts/inject-config.js
 *   EXTENSION_BASE_URL=https://grabcaramel.com node scripts/inject-config.js
 */

const fs = require('fs')
const path = require('path')

const configPath = path.join(__dirname, '..', 'config.js')
const baseURL = process.env.EXTENSION_BASE_URL || 'https://grabcaramel.com'

// Read the config file
let configContent = fs.readFileSync(configPath, 'utf8')

// Replace the BASE_URL value
configContent = configContent.replace(
    /const BASE_URL = ['"].*?['"]/,
    `const BASE_URL = '${baseURL}'`
)

// Write back the config file
fs.writeFileSync(configPath, configContent, 'utf8')

console.log(`✓ Injected BASE_URL: ${baseURL}`)
