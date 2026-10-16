# Twitch WHIP output: verification status

**Status: implemented, not verified.** The integration has not been seen to
work against Twitch, and Twitch does not officially document it.

## What Twitch's official documentation says (checked 2026-10-16)

- Twitch's developer docs for broadcasting
  ([Video Broadcast guide](https://dev.twitch.tv/docs/video-broadcast/) and
  [reference](https://dev.twitch.tv/docs/video-broadcast/reference/)) describe
  **RTMP ingest only** (`rtmp://<ingest-server>/app/<stream-key>`, servers from
  `GET https://ingest.twitch.tv/ingests`). They do not mention WHIP or WebRTC.
- The Broadcasting Guidelines page on help.twitch.tv could not be loaded by the
  tools available here.

So there is no official Twitch specification for WHIP: no documented endpoint,
authentication scheme, codec profile, bitrate limit or HTTP behaviour.

## What is known from unofficial sources

- In April 2023 Twitch enabled WebRTC/WHIP ingest ("Tell HN: Twitch.tv now
  supports WebRTC ingestion"); OBS 30's WHIP output was built and tested
  against it.
- Endpoint: `https://g.webrtc.live-video.net:4443/v2/offer`, with the stream
  key sent as a Bearer token
  ([Dolby.io write-up](https://dev.to/dolbyio/how-to-broadcast-a-webrtc-stream-to-twitch-7fa)).
- "This server currently only supports H264 and Opus encoded streams" (same
  source).
- An OBS issue about this endpoint
  ([obs-studio#9459](https://github.com/obsproject/obs-studio/issues/9459))
  shows it once returned no `Location` header (fixed later), and users noting a
  bitrate ceiling around 7500 kb/s.
- An August 2026 article
  ([The Rig Wire](https://therigwire.com/whip-whep-rtmp/)) says Twitch "still
  take[s] RTMP from general creators" and has not announced WHIP plans, which
  suggests the WebRTC endpoint remained an unadvertised beta.

## What could not be checked from the build environment

Connections to `g.webrtc.live-video.net:4443` were refused by this sandbox's
network policy, so it was not possible to observe whether the endpoint is
still live, which HTTP status codes it returns, or, most importantly, whether
it sends **CORS headers** that let a web page call it. OBS is a native app and
never needed them.

## How the app accounts for the known requirements

| Requirement | Implementation |
| --- | --- |
| H.264 video only | `setCodecPreferences` with only H.264 (constrained baseline, packetization-mode 1 first, plus RTX). Refuses to start if the browser can't encode H.264 |
| Opus audio | Opus preferred; mixed programme audio at up to 128 kb/s |
| Auth | `Authorization: Bearer <stream key>` |
| WHIP exchange | `POST` `application/sdp` offer with all candidates (no trickle), expects `201` + SDP answer; follows redirects; `DELETE` on the `Location` resource when stopping; works without `Location` (then Stop can only close the connection) |
| Limits | Max 1920×1080, 60 fps; bitrate default 6000 kb/s, capped at 8500 kb/s; checked before starting |
| Stable output | Encoder set to keep resolution (lower frame rate first); switching never renegotiates |
| Failures | 401/403 shown as an authentication error; other HTTP errors shown with Twitch's response text. A connection that drops after going live, and 429/5xx responses, retry automatically with backoff (2 s … 30 s). Network/CORS failures are explained |

## How to verify it (5 minutes)

1. Open the studio in **Chrome or Edge** (they encode H.264), served over HTTPS.
2. Outputs tab → **+ Twitch**. Paste your stream key (Twitch dashboard →
   Settings → Stream). Programme at 1920×1080 or 1280×720, 30 fps.
3. Put something on Programme, then **Start broadcast**.
4. Read the result:

| What you see | Meaning | Next step |
| --- | --- | --- |
| State **Live**, stats show H264 bytes flowing, and your channel is live on twitch.tv | Works | Switch sources and run transitions while watching the channel |
| "could not complete the WHIP request … (CORS)" | Endpoint reachable only from native apps | Run `node signaling-server/server.mjs` somewhere, set its URL as the WHIP/WHEP CORS forwarder in Settings, retry. Only the SDP request goes through it |
| "Authentication failed (401/403)" | Key rejected, or endpoint no longer accepts this auth | Check the key; if correct, the endpoint's auth has changed |
| 404/410, DNS failure or no response | Endpoint withdrawn | Twitch no longer offers browser-reachable WebRTC ingest |
| Live in the studio but the channel stays offline | Ingest accepted media Twitch doesn't publish (seen in the OBS issue above) | Try 1280×720 30 fps and 4500 kb/s |

If the endpoint is gone, there is no browser-only way to reach Twitch: its
documented ingest is RTMP, which browsers cannot speak, and bridging WebRTC to
RTMP needs a server that repackages the stream. That would break the
no-server constraint, so the app doesn't do it.
