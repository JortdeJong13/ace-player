# Ace Player

A minimal browser player for an Ace Stream engine running on the same Docker network. It is designed for Safari on macOS, iPadOS and iOS, using native HLS playback and native video controls.

## Run with Docker Compose

The repository contains one [`docker-compose.yml`](docker-compose.yml). You can use it as the complete local stack, or copy just the `ace-player` service into your existing media-stack compose file. The player is available at:

```text
http://home-server:8082
```

Host port `8082` is intentional because port `8080` is already used by Country Guess on the server. Inside Docker, Ace Player connects to `http://acestream:6878` using the Compose service name.

Ace Stream's HTTP API port `6878` is internal to the Compose network and is not published on the host. The `8621` TCP/UDP ports remain published for Ace Stream peer connectivity; they are not used by the browser. The only browser-facing service is Ace Player on port `8082`.

The image is published by GitHub Actions as:

```text
ghcr.io/jortdejong13/ace-player:latest
```

## Local development

Run the complete local stack, including the Ace Stream engine:

```sh
docker compose up --detach --build
```

Open:

```text
http://localhost:8082
```

Stop it with:

```sh
docker compose down
```

To run only the Go server directly:

```sh
go run ./cmd/ace-player
```

The default engine URL is `http://acestream:6878`. To use an engine running elsewhere:

```sh
ACESTREAM_URL=http://127.0.0.1:6878 go run ./cmd/ace-player
```

## Playback flow

The backend starts an Ace Stream playback session with the engine's JSON middleware endpoint. It then rewrites and proxies the returned HLS manifest through the player origin. This keeps the browser from trying to resolve engine-generated `127.0.0.1` segment URLs on the client device and avoids a browser-side CORS dependency.

Audio transcoding is requested from AceServe for Safari compatibility. For example, streams carrying E-AC-3 audio are converted to stereo AAC while the H.264 video is passed through. This uses the existing engine rather than adding a separate FFmpeg service.

While a stream is playing, the browser monitors native media events and polls the session status endpoint. During startup and meaningful buffering it shows a small status overlay with peer and connection information, then gets out of the way once Safari receives video. Brief buffering events are deliberately debounced so the overlay does not flicker. If playback stalls for 10 seconds, stops progressing for 15 seconds, or the engine reports a stopped session, the player starts a fresh engine session with exponential backoff. Startup has a 60-second grace period, and automatic recovery is capped at five attempts; after that, the overlay offers a manual retry. User pauses and navigation never trigger recovery. Safari's native video controls remain unchanged.

The landing screen searches the public Ace Stream catalog at `search-ace.stream` through `GET /api/search?q=...`. The Go server keeps that external request and the AceStream engine private from the browser, and normalizes the catalog's content IDs into playable results. If the public catalog is unavailable, the app falls back to AceServe's built-in search module. Set `SEARCH_URL` to use another compatible catalog endpoint. Direct 40-character hexadecimal content IDs are still accepted. Search is intentionally transient and is not written to browser history.

The three most recent playback identifiers and display names are stored in the browser's local storage so they can be resumed from the landing screen. The active stream identifier is also stored in the URL hash as `#stream/content/<id>` or `#stream/infohash/<id>`. This lets Safari restore the player after a refresh and makes Back and Forward navigate between the search screen and the stream. The backend session itself remains disposable: refreshing creates a fresh engine session for the same identifier.

The active stream content ID is also stored in the URL hash as `#stream/<content-id>`. This lets Safari restore the player after a refresh and makes Back and Forward navigate between the landing screen and the stream. The backend session itself remains disposable: refreshing creates a fresh engine session for the same content ID.

Multiple streams are supported across Safari tabs and devices. Each tab gets its own Ace Stream playback session; the default limit is four active sessions. Set `MAX_SESSIONS` on the `ace-player` service to change that limit. Sessions without playlist or segment requests for 15 minutes are stopped automatically.

Use only streams you are authorized to access.
