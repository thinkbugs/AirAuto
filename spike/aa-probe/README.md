# AA head-unit probe (M1 spike)

Android Auto receiver spike, isolated from the WinPlay engine. It exists to prove the
protocol链路 before any UI or engine refactor: AAP framing, TLS-over-frames, version
exchange, service discovery, channel open, media setup, codec config, a video frame and
teardown all round-trip against a bundled mock phone.

Not wired into WinPlay yet. Nothing outside `spike/` depends on it.

## What works

- AAP framing (channel/flags/length, first-fragment total-size field, encrypted frames
  carry raw TLS records with no inline message type)
- TLS 1.2 with every TLS record carried inside an AAP frame (flags `0x03`/type `3` while
  handshaking, then the frame header carries the message channel)
- One TLS record per AA message in both directions (Node merges writes issued in the same
  turn, so sends are serialized)
- Version request/response, AuthComplete, ServiceDiscoveryRequest/Response,
  ChannelOpenRequest/Response, media Setup/Config, Start, CodecConfig, Data + Ack,
  VideoFocus, Ping, ByeBye
- Head-unit role in both directions:
  - **listen mode** (wireless shape): PC listens on 5277, peer dials in
  - **connect mode** (developer-mode shape): PC dials the phone's head unit server; TLS
    roles do not follow who dials, the head unit still presents the certificate

## Run

```sh
# head unit listening (wireless shape)
node server.js            # or: node server.js 5277

# self-test: mock phone dials the head unit
node mock-phone.js

# developer-mode shape: mock phone listens, head unit dials out
node mock-phone.js --listen 15310
node server.js --connect 127.0.0.1 15310

# protocol tests
node --test
```

Environment: `AA_PORT`, `AA_DEBUG=1` (frame/record tracing), `AA_MOCK_TIMEOUT` (ms).

A throwaway self-signed certificate is generated into `certs/` with `openssl` on first run.
Android Auto does not validate the head unit against Google's CA for this path (DiAuto
ships the same self-signed setup), so no Google-issued credential is needed.

## Real phone (developer mode)

1. On the phone: Android Auto → 开发者选项 → 启动“head unit server”.
2. Put phone and PC on the same network (or use `adb forward tcp:5277 tcp:5277`).
3. `node server.js --connect <phone-ip>`

The first real-device run is unverified. Expect to adjust cipher suites, client
certificate policy (`requestCert`) and version payload if the phone rejects the handshake.
TLS is pinned to 1.2 for this spike to avoid TLS 1.3 post-handshake tickets.

## Known limitations (deliberately out of scope)

- Video is logged, not decoded (no fragment assembly, no WebCodecs hand-off)
- Audio packets are counted only; no playout
- Input (touch/keys) not sent; sensor channel only answers the start request
- No Bluetooth RFCOMM (WPP) credential handoff and no Wi-Fi AP provisioning, so wireless
  auto-connect with a stock phone is not implemented yet
- Service list is minimal (video 720p30 H.264, input touch, PCM audio sinks, mic)
- One TLS record == one AA message is assumed; a peer that coalesces messages would be
  misparsed

## License

The `.proto` definitions under `proto/` are adapted from
[DiAuto](https://github.com/shihabal3amri/DiAuto) (AGPL-3.0), which preserves
[Open Headunit](https://github.com/andreknieriem/open-headunit) and Michael Reid's original
headunit work. Everything else in this directory is original WinPlay code under
AGPL-3.0-or-later. See the repository `LICENSE` and `NOTICE`.
