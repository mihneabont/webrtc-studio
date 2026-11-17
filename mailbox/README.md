# Mailbox

A small Cloudflare Worker that lets the studio do two things a web page can't
do alone:

- **WHIP input.** OBS, Larix, vMix or a hardware encoder publishes to a WHIP
  link like `https://webrtc-studio-mailbox.<you>.workers.dev/whip/<box>`. The
  worker hands the encoder's offer to the open studio page and returns its
  answer.
- **Reusable guest links.** The guest page and the studio swap connection
  details through the worker, so one link keeps working, and guests reconnect
  by themselves after a refresh or a studio reload.

It can also hand out short-lived **TURN** credentials from Cloudflare, so
connections also work between strict networks such as two mobile networks.

Only a few kilobytes of connection details pass through the mailbox. The video
goes directly from the encoder or guest to the studio's browser, or through
TURN when it has to. Nothing is logged or stored except each box's key (as a
hash), which is forgotten 60 days after its studio last connected. Encoders and
guests need no port forwarding: every side only makes outgoing connections.

## Set it up (once)

1. Create a free account at https://dash.cloudflare.com. Open **Workers &
   Pages** once and choose your `workers.dev` subdomain.
2. Make an API token: **My Profile → API Tokens → Create Token**, use the
   **Edit Cloudflare Workers** template, and create it. Copy the token.
3. Copy your **Account ID**. It is shown on the Workers & Pages overview page,
   in the right-hand column.
4. In GitHub, open the repository's **Settings → Secrets and variables →
   Actions** and add two repository secrets:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 3
5. Push a change to `mailbox/` on `browser-only` (merging it counts), which
   runs **Actions → Deploy mailbox**. When it finishes, its summary shows the
   mailbox address.
6. Put that address in `js/mailbox.js` as `MAILBOX_URL`, so every studio uses
   it. (Settings → Network → Mailbox overrides it in one browser.) This
   repository's mailbox is https://webrtc-studio-mailbox.mihneabont.workers.dev.

From then on, every change to `mailbox/` on `browser-only` is published by
itself.

## TURN (optional)

1. In the Cloudflare dashboard, open **Realtime → TURN Server** and create a
   TURN key. Copy its **Key ID** and **API token**.
2. Add them as repository secrets `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`.
3. Run **Deploy mailbox** again.

The studio's **Settings → Network** then says "TURN relay on". TURN carries the
video of the connections that need it, so it is the one part that uses real
bandwidth. Cloudflare bills it per GB; check their current free allowance.

Only the pages listed in `ALLOWED_ORIGINS` (in `wrangler.toml`) get TURN
credentials, so other sites can't use your TURN allowance. Encoders get them
with each WHIP connection the studio accepts.

## Limits

- The studio page must be open when the encoder or guest connects.
- Anyone who has a WHIP or guest link can send video to that source. Use
  **New link** on the source card to stop an old link working.
- Cloudflare's free Workers plan covers about 100,000 requests a day; one
  connection uses only a handful.

## Run it locally

```sh
cd mailbox && npx wrangler dev --port 8790
```

`tests/mailbox.mjs` tests WHIP input and reusable guest links against it.
