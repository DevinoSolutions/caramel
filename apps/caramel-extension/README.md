# Caramel Extension

Browser extension for Caramel coupon application.

## Configuration

The extension uses a configurable base URL that can be set for local development or production.

### Setting Base URL

The base URL is configured in `config.js` and can be set in two ways:

1. **Manual Edit**: Edit `config.js` and change the `BASE_URL` constant
2. **Build Script**: Use environment variable `EXTENSION_BASE_URL` during build

### Build Commands

- **Development (localhost)**: `pnpm run build:dev`
  - Sets BASE_URL to `http://localhost:58000`
  
- **Production**: `pnpm run build:prod`
  - Sets BASE_URL to `https://grabcaramel.com`
  
- **Default**: `pnpm run build`
  - Uses `EXTENSION_BASE_URL` environment variable if set, otherwise defaults to production URL

### Manual Configuration

For local development, you can manually edit `config.js`:

```javascript
const BASE_URL = 'http://localhost:58000'  // For local dev
// or
const BASE_URL = 'https://grabcaramel.com'  // For production
```

### Environment Variable

You can also set the `EXTENSION_BASE_URL` environment variable:

```bash
EXTENSION_BASE_URL=http://localhost:58000 pnpm run build
```

## Development

Run the extension in development mode:

```bash
pnpm run dev
```

This will watch for file changes and reload the extension automatically.

## Building

Build the extension for distribution:

```bash
# For local development
pnpm run build:dev

# For production
pnpm run build:prod
```

The built files will be in the `dist/` directory.

## Packaging

Create a zip file for distribution:

```bash
pnpm run package
```

This creates `extension.zip` from the `dist/` directory.
