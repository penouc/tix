# TiX Remote Desktop Relay (Cloudflare Workers + Durable Objects)

Zero-knowledge end-to-end encrypted WebSocket relay for TiX Remote Desktop, inspired by `yetone/alma-relay`.

## How it works

- **Zero-Knowledge**: The Host and Viewer derive an opaque `roomId` and `roomAuthHash` from their shared 256-bit `masterKey` using HKDF-SHA256. The relay never sees `masterKey`, screen pixels, or mouse/keyboard events.
- **Forward Secrecy**: Each remote desktop session runs an ephemeral X25519 + PSK key exchange inside the relay and encrypts every frame with AES-256-GCM.
- **WebSocket Hibernation**: SQLite-backed Durable Objects hibernate while idle, keeping costs near zero on Cloudflare's Free or Paid plans.
- **Custom Domain**: Bind any custom domain (for example `relay.example.com` or `relay.penglei.dev`) in `wrangler.jsonc`, then enter that URL in TiX Settings → Remote Desktop.

## Deploy your own relay

```bash
cd infra/relay-worker
npx wrangler@4 deploy
```

### Optional: Protect your relay with an access token

Prevent public abuse of your Cloudflare quota by setting a shared operator token:

```bash
cd infra/relay-worker
npx wrangler@4 secret put RELAY_ACCESS_TOKEN
```

Then enter the same token under **Relay Access Token** in TiX Settings → Remote Desktop.
