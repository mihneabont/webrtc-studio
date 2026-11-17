# Limits of a browser-only studio

The app meets the "no media server, no backend, no helper app, static hosting"
constraint. Media is captured, decoded, composited, mixed and encoded only in
browsers, and travels browser-to-browser (or browser-to-ingest) over WebRTC.
This page lists what that constraint costs. The only mandatory infrastructure
is a static file host; STUN and TURN servers are optional and only help
connections across hard networks.

## Infrastructure summary

| Component | Required? | Carries media? | Purpose |
| --- | --- | --- | --- |
| Static file host (HTTPS) | **Yes** | No | Serves the HTML/JS/CSS |
| STUN server | Optional (default: Google's public STUN) | No | Lets a browser learn its public address. Without it only same-network connections work |
| TURN server | Optional | Relays encrypted packets, never decodes or mixes | Needed when a direct path is impossible (symmetric NAT, strict firewalls, some mobile and corporate networks) |
| [Mailbox](../mailbox/README.md) (Cloudflare Worker) | Optional | No | Passes connection details for WHIP encoders and reusable guest links; hands out TURN credentials |

## 1. Signaling without a server

WebRTC needs both sides to exchange an offer and an answer before media can
flow. A static page cannot receive messages, so with no server at all the app
uses **copy-paste signaling**: the invite link carries the studio's offer
(with every ICE candidate already gathered, compressed to about 2 KB), and the
remote page shows a reply code the operator pastes back. This works on any
network where a direct path exists, but:

- each connection needs one message each way through some channel the people
  already use (chat, email);
- an invite works once; after a connection **fails** (not just a brief
  interruption, which ICE recovers by itself), reconnecting needs a new invite;
- the studio cannot reconnect contributors automatically after it reloads.

The contributor page remembers which invites this browser already answered
and warns when a used link is opened again.

With the optional **mailbox**, both pages keep a WebSocket to it and swap
offers and answers through it instead. The link is then reusable, and guests
reconnect by themselves after a refresh, a failed connection or a studio
reload. The mailbox sees the connection details (including IP addresses) for
the moment it passes them on, never the media.

## 2. Network topology (NAT and firewalls)

The app does **not** claim every pair of peers can connect directly. Whether a
direct path exists depends on both networks. When ICE fails, the source or
output card explains what was gathered (for example "no public address was
discovered" or "a direct peer-to-peer path could not be found") and recommends
TURN. TURN is the standard answer; it relays encrypted packets and cannot see
or mix the media, so it doesn't violate the no-media-server rule, but it is
infrastructure someone must run or rent (coturn, Cloudflare, Twilio, Metered).

Notes:
- STUN/TURN settings are sent inside invite links so the
  remote side uses the same servers. Long-lived TURN passwords would therefore
  reach contributors: use short-lived TURN credentials.
- Invite codes contain the studio's network candidates (IP addresses), like
  any WebRTC offer.
- Chrome hides local IPs behind mDNS names unless the page has camera access.
  The studio never asks for camera access, so same-LAN connections rely on
  mDNS or STUN.

## 3. CORS on WHIP and WHEP endpoints

A web page can only POST to an ingest URL if that server answers with CORS
headers allowing it (and exposes the `Location` header). Many WHIP servers do;
some don't. When the browser blocks the request, the output or source says
so; such an endpoint can't be used from a web page.

## 4. What a browser can't do

- **RTMP and SRT.** Browsers can only send and receive live media over WebRTC,
  so RTMP outputs and SRT inputs aren't offered. Use a platform's WHIP ingest
  (Twitch has one) or a WHIP/WHEP-capable media server in between.
- **Encoders that publish with WHIP (OBS, Larix).** A web page can't accept
  incoming HTTP requests, so this needs the mailbox: the encoder posts to it
  and the studio answers through it. The studio page must be open while the
  encoder connects. The encoder must send something the browser can decode
  (Chrome and Edge take H.264 High; Firefox only Constrained Baseline).
- **YouTube** sources need Chrome or Edge 132 or later (Element Capture) and a
  pop-up window per video.

## 5. Codecs and encoder control

- Twitch and many WHIP servers require **H.264**. Chrome, Edge and Safari can
  encode it; Firefox needs its OpenH264 plugin; open-source Chromium builds
  (including the one used for the automated tests here) cannot. The Twitch
  output refuses to start and says why when H.264 is missing.
- Browsers don't let pages set the keyframe interval, B-frames (WebRTC never
  uses them), encoder presets or rate-control mode. Keyframes are produced
  when the receiver asks for them (PLI/FIR). Max bitrate and frame rate are
  controllable, and applied live.
- Each output encodes the programme separately, so every additional output
  adds a full encode's worth of CPU (or hardware encoder) load.

## 6. Performance

Decoding several 1080p feeds and compositing at 1080p depends heavily on the
GPU, which the browser uses for video decode and canvas drawing. The app
measures itself and warns when the programme render rate falls behind, when an
encoder reports it is CPU-limited, when decoded frame rates collapse, or when
the number of 1080p feeds exceeds a rough budget for the CPU. Under overload the
Preview monitor drops frames first and rendering drops frames rather than
queueing them, so the controls stay usable.

Measured in the build environment (4 CPU threads, **no GPU**, contributors and
studio all on the same machine): one 1080p full-frame `drawImage` took about
25 ms, and four 1080p inputs composited at about 3 fps. That machine is far
below a production setup and the number says little about real hardware; the
four-feed 1080p target has **not** been verified on capable hardware yet.
`tests/four-sources.mjs` repeats the measurement on any machine.

## 7. The browser must stay in the foreground

Browsers throttle hidden tabs. The render loop uses a Web Worker timer, which
browsers don't throttle like page timers, but some browsers may still slow
video decoding in a background tab. The studio shows a warning when its tab is
hidden. Use a dedicated window and keep it visible. If the browser closes, the
production stops (as the requirements allow).

## 8. Audio

- Browsers start audio only after a user gesture; until the operator clicks
  anywhere, the programme audio is silent and the studio says so.
- Remote audio is routed only through the Web Audio mixer; media elements stay
  muted, so audio can't be routed twice. Local monitoring is off by default to
  avoid feedback.
- Contributor microphones use the browser's echo cancellation and noise
  suppression.

## 9. Persistence and credentials

Settings live in this browser's localStorage (images in IndexedDB), per
browser profile and origin. Export/Import moves a workspace between machines
(stream keys are never exported). Browsers offer web pages no OS keychain, so
stream keys are by default kept only for the session; they can be saved
encrypted with a passphrase (PBKDF2 + AES-GCM, passphrase never stored) or, if
the operator chooses, unencrypted. TURN credentials are saved unencrypted.

## 10. Programme format changes

Changing the programme resolution while outputs are live changes the encoded
resolution mid-stream. Browser receivers adapt; ingest platforms may not. The
studio asks for confirmation when outputs are live. For WHIP/Twitch outputs the
encoder is told to keep resolution and lower frame rate under pressure.

## 11. What was and wasn't tested

Tested automatically in Chromium 141 (headless, Linux) with genuine WebRTC
connections between separate pages: every acceptance criterion except Twitch.
Not tested: Firefox and Safari as the studio browser, real cameras and real
networks across NATs, TURN, H.264 output, and Twitch (see `TWITCH.md`).
