# Apple OAuth Local Testing Setup

## Problem

Apple Sign-In doesn't accept `localhost` as a redirect URI, so we need an HTTPS
tunnel to test locally.

## Solution Options

### Option 1: ngrok (Recommended for Quick Setup)

#### Setup

1. Install ngrok:

    ```bash
    brew install ngrok
    # or download from https://ngrok.com/download
    ```

2. Sign up for free account at https://ngrok.com (optional but recommended)

3. Authenticate (if signed up):

    ```bash
    ngrok config add-authtoken YOUR_AUTH_TOKEN
    ```

4. Start tunnel to local app:

    ```bash
    ngrok http 58000
    ```

5. Copy the HTTPS URL (e.g., `https://abc123.ngrok-free.app`)

#### Important Notes

- **Free tier**: Domain changes each time you restart ngrok
- **Solution**: Get the domain and register it on Apple Developer Console
- If domain changes, just register the new one on Apple Developer Console

#### ngrok Static Domain (Paid Option)

If you need a persistent domain:

- Upgrade to ngrok paid plan ($8/month)
- Configure a static domain in ngrok dashboard
- Use: `ngrok http 58000 --domain=your-static-domain.ngrok-free.app`

---

### Option 2: Cloudflare Tunnel (Free, Persistent Domain)

**Note**: Requires a domain you own and have added to Cloudflare.

#### Setup

1. Install cloudflared:

    ```bash
    brew install cloudflared
    # or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
    ```

2. Login to Cloudflare:

    ```bash
    cloudflared tunnel login
    ```

3. Create a named tunnel:

    ```bash
    cloudflared tunnel create caramel-local-dev
    ```

4. Create config file `~/.cloudflared/config.yml`:

    ```yaml
    tunnel: caramel-local-dev
    credentials-file: /Users/kd/.cloudflared/[TUNNEL-UUID].json

    ingress:
        - hostname: caramel-local.yourdomain.com
          service: http://localhost:58000
        - service: http_status:404
    ```

5. Route the subdomain (in Cloudflare dashboard or via CLI):

    ```bash
    cloudflared tunnel route dns caramel-local-dev caramel-local.yourdomain.com
    ```

6. Run the tunnel:
    ```bash
    cloudflared tunnel run caramel-local-dev
    ```

#### Result

- Persistent HTTPS URL: `https://caramel-local.yourdomain.com`
- Free and stable - perfect for ongoing development

---

## Apple Developer Console Configuration

Once you have your HTTPS domain, share it with your team lead. They need to add
**both** redirect URIs:

1. **Better-auth callback** (for web app):

    ```
    https://[your-domain]/api/auth/callback/apple
    ```

2. **Extension intermediate redirect** (for extension OAuth):
    ```
    https://[your-domain]/api/extension/oauth/redirect
    ```

For example:

- ngrok:
    - `https://abc123.ngrok-free.app/api/auth/callback/apple`
    - `https://abc123.ngrok-free.app/api/extension/oauth/redirect`
- Cloudflare:
    - `https://caramel-local.yourdomain.com/api/auth/callback/apple`
    - `https://caramel-local.yourdomain.com/api/extension/oauth/redirect`

**Note**: The extension uses `form_post` response mode (required by Apple when
requesting email scope), so the intermediate redirect endpoint handles the POST
from Apple and forwards the code to the extension.

---

## Recommended Approach

**For quick testing**: Use ngrok free tier

- Fastest setup
- Register domain on Apple Developer Console when it changes
- No domain ownership required

**For ongoing development**: Use Cloudflare Tunnel

- Persistent domain (no changes)
- Free
- Requires domain ownership

---

## Environment Variables

Your local app should use the tunnel URL. Set it in `apps/caramel-app/.env`:

```bash
# For ngrok/Cloudflare tunnel
BETTER_AUTH_URL=https://your-tunnel-domain.com
NEXT_PUBLIC_BASE_URL=https://your-tunnel-domain.com

# Apple credentials. There is NO static client secret (2026-10-03): the app signs
# its own ES256 client-secret JWT at runtime from the .p8 key, so all three of
# these are required whenever APPLE_CLIENT_ID is set.
APPLE_CLIENT_ID=com.your.services.id
APPLE_TEAM_ID=YOURTEAMID
APPLE_KEY_ID=YOURKEYID
# Contents of AuthKey_<KEY_ID>.p8, one line with literal \n (real newlines work too)
APPLE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----
```

Apple OAuth must reach your machine through the tunnel, so run the host-side dev
server (the `dev:next` escape hatch) rather than the container — a tunnel to
`localhost:58000` needs the app bound on the host:

```bash
docker compose up postgres -d
pnpm dev:next
```

Or set them inline for a one-off run:

```bash
BETTER_AUTH_URL=https://abc123.ngrok-free.app NEXT_PUBLIC_BASE_URL=https://abc123.ngrok-free.app pnpm dev:next
```
