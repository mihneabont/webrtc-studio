# Limits of a browser-only studio

The app meets the "no media server, no backend, no helper app, static hosting"
constraint. Media is captured, decoded, composited, mixed and encoded only in
browsers, and travels browser-to-browser (or browser-to-ingest) over WebRTC.
This page lists what that constraint costs, and separates **mandatory
application infrastructure** (only a static file host) from **optional
connection infrastructure** that makes connections easier or possible on hard
networks.

## Infrastructure summary

| Component | Required? | Carries media? | Purpose |
| --- | --- | --- | --- |
| Static file host (HTTPS) | **Yes** | No | Serves the HTML/JS/CSS |
| STUN server | Optional (default: Google's public STUN) | No | Lets a browser learn its public address. Without it only same-network connections work |
| TURN server | Optional | Relays encrypted packets, never decodes or mixes | Needed when a direct path is impossible (symmetric NAT, strict firewalls, some mobile and corporate networks) |
| Signaling relay (`signaling-server/`) | Optional | No, only SDP text | Reusable links and automatic reconnection instead of copy-paste codes |
| WHIP ingest for OBS (same helper) | Optional, needed only for OBS/WHIP encoder inputs | No, only the SDP text | OBS publishes with an HTTP POST, which a web page cannot receive. The helper hands the offer to the studio page and returns its answer; media then flows OBS → studio browser directly |
| WHIP/WHEP CORS forwarder (same helper) | Optional | No, only the SDP HTTP request | For ingest endpoints that reject requests from web pages |
| RTMP output (same helper + ffmpeg) | Optional, needed only for RTMP outputs | **Yes**, the programme, on the studio computer | Browsers can't speak RTMP. The page records the programme and the helper's ffmpeg pushes it to the RTMP server |

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

**Smallest compromise:** the optional relay in `signaling-server/server.mjs`
(about 200 lines of Node with no dependencies). It forwards only small JSON
messages over Server-Sent Events. With it, contributor and receiver links are
reusable and both sides reconnect automatically, including after a studio
reload (tested in `tests/relay.mjs`). Media still never touches it. It is open
by design: deploy it privately; room IDs are random 64-bit values.

## 2. Network topology (NAT and firewalls)

The app does **not** claim every pair of peers can connect directly. Whether a
direct path exists depends on both networks. When ICE fails, the source or
output card explains what was gathered (for example "no public address was
discovered" or "a direct peer-to-peer path could not be found") and recommends
TURN. TURN is the standard answer; it relays encrypted packets and cannot see
or mix the media, so it doesn't violate the no-media-server rule, but it is
infrastructure someone must run or rent (coturn, Cloudflare, Twilio, Metered).

Notes:
- STUN/TURN settings are sent inside invite links and relay offers so the
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
some don't. When the browser blocks the request, the output says so. The
smallest compromise is the forwarder in the same optional helper: it forwards
only the SDP POST/DELETE, and the media connection still goes directly from the
browser to the ingest server. It only forwards to hosts listed in
`FORWARD_ALLOW` (default: Twitch's WebRTC ingest host).

## 3b. OBS and other WHIP encoders as inputs

A browser page can't accept incoming HTTP requests, so OBS can't publish to
the studio directly. The helper's `/whip-in/<room>/<source>` route accepts
OBS's WHIP POST, relays the SDP offer to the studio page, and returns the
studio's answer (201 + Location; DELETE ends the session). The studio checks
the bearer token. The helper never sees media. Trickle ICE (PATCH) isn't
supported; OBS sends all candidates in its offer, so this doesn't matter for
OBS. OBS must use a codec the studio browser can decode in WebRTC: H.264 is
safe; HEVC and AV1 depend on the browser and hardware. Tested with a browser
acting as the WHIP encoder (`tests/obs.mjs`), not with OBS itself.

## 3c. RTMP output

Browsers can only send live media over WebRTC, so RTMP (YouTube, Twitch,
Facebook and most platforms) needs something outside the page. The RTMP
output records the programme with `MediaRecorder` in 250 ms pieces and posts
them to the helper on the same computer (`/rtmp`), which feeds them to ffmpeg.
H.264 from the browser is passed through unchanged; audio is converted from
Opus to AAC. Browsers that can't record H.264 (Firefox, open-source Chromium)
get the video re-encoded by ffmpeg, which costs CPU. This is the one place
where the helper handles media, and it only does so on the studio computer.

- Expect 1 to 3 s more delay than the WebRTC outputs.
- The keyframe interval is requested as 2 s (`videoKeyFrameIntervalDuration`),
  which recent Chrome honours; older browsers may produce longer intervals.
- Bitrate changes apply on the next start, not live.
- If the upload or the RTMP server can't keep up, the card shows how far
  behind the stream is; pieces are queued in the page, not dropped.
- Tested (`tests/rtmp.mjs`) against a local ffmpeg RTMP listener with the
  re-encode path, and the pass-through path with an H.264 file; not yet
  against a real platform.

## 4. Codecs and encoder control

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

## 5. Performance

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

## 6. The browser must stay in the foreground

Browsers throttle hidden tabs. The render loop uses a Web Worker timer, which
browsers don't throttle like page timers, but some browsers may still slow
video decoding in a background tab. The studio shows a warning when its tab is
hidden. Use a dedicated window and keep it visible. If the browser closes, the
production stops (as the requirements allow).

## 7. Audio

- Browsers start audio only after a user gesture; until the operator clicks
  anywhere, the programme audio is silent and the studio says so.
- Remote audio is routed only through the Web Audio mixer; media elements stay
  muted, so audio can't be routed twice. Local monitoring is off by default to
  avoid feedback.
- Contributor microphones use the browser's echo cancellation and noise
  suppression.

## 8. Persistence and credentials

Settings live in this browser's localStorage (images in IndexedDB), per
browser profile and origin. Export/Import moves a workspace between machines
(stream keys are never exported). Browsers offer web pages no OS keychain, so
stream keys are by default kept only for the session; they can be saved
encrypted with a passphrase (PBKDF2 + AES-GCM, passphrase never stored) or, if
the operator chooses, unencrypted. TURN credentials are saved unencrypted.

## 9. Programme format changes

Changing the programme resolution while outputs are live changes the encoded
resolution mid-stream. Browser receivers adapt; ingest platforms may not. The
studio asks for confirmation when outputs are live. For WHIP/Twitch outputs the
encoder is told to keep resolution and lower frame rate under pressure.

## 10. What was and wasn't tested

Tested automatically in Chromium 141 (headless, Linux) with genuine WebRTC
connections between separate pages: every acceptance criterion except Twitch.
Not tested: Firefox and Safari as the studio browser, real cameras and real
networks across NATs, TURN, H.264 output, and Twitch (see `TWITCH.md`).
