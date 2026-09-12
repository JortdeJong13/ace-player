(() => {
  "use strict";

  const stallRecoveryDelay = 10_000;
  const startupRecoveryDelay = 60_000;
  const progressTimeout = 15_000;
  const statusPollInterval = 5_000;
  const reconnectBaseDelay = 2_000;
  const reconnectMaxDelay = 30_000;
  const maxReconnectAttempts = 5;

  const latestStorageKey = "ace-player.latest-playback";
  const homeScreen = document.querySelector("#home-screen");
  const playerScreen = document.querySelector("#player-screen");
  const searchForm = document.querySelector("#search-form");
  const searchInput = document.querySelector("#search-input");
  const formMessage = document.querySelector("#form-message");
  const searchResults = document.querySelector("#search-results");
  const resultCount = document.querySelector("#result-count");
  const resultsList = document.querySelector("#results-list");
  const emptyMessage = document.querySelector("#empty-message");
  const latestButton = document.querySelector("#latest-button");
  const latestName = document.querySelector("#latest-name");
  const video = document.querySelector("#video");
  const playbackStatus = document.querySelector("#playback-status");
  const playbackStatusTitle = document.querySelector("#playback-status-title");
  const playbackStatusDetail = document.querySelector("#playback-status-detail");
  const retryButton = document.querySelector("#retry-button");

  const streamRoutePrefix = "#stream/";
  const legacyLatestStorageKey = "ace-player.latest-content-id";
  const contentIDPattern = /^[a-fA-F0-9]{40}$/;
  let currentSessionID = "";
  let currentContentID = "";
  let currentSource = "content_id";
  let currentStreamName = "";
  let playbackWanted = false;
  let recoveryInProgress = false;
  let starting = false;
  let startAbortController = null;
  let startPromise = null;
  let searchAbortController = null;
  let searchPromise = null;
  let activeSearchQuery = "";
  let reconnectTimer = null;
  let reconnectPromise = null;
  let reconnectAttempts = 0;
  let monitorTimer = null;
  let monitorSessionID = "";
  let statusPollInFlight = false;
  let streamStartedAt = 0;
  let firstFrameAt = 0;
  let lastProgressAt = 0;
  let lastCurrentTime = 0;
  let stallSince = 0;
  let stablePlaybackTimer = null;

  function homeURL() {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.delete("q");
    return url.pathname + url.search;
  }

  function playbackFromLocation() {
    if (!window.location.hash.startsWith(streamRoutePrefix)) return null;
    const route = window.location.hash.slice(streamRoutePrefix.length);
    const parts = route.split("/");
    if (parts.length === 2 && contentIDPattern.test(parts[1])) {
      if (parts[0] === "infohash") return { identifier: parts[1], source: "infohash" };
      if (parts[0] === "content") return { identifier: parts[1], source: "content_id" };
    }
    if (contentIDPattern.test(route)) {
      return { identifier: route, source: "content_id" };
    }
    return null;
  }

  function replaceWithHomeRoute() {
    window.history.replaceState({ screen: "home" }, "", homeURL());
  }

  function pushStreamRoute(identifier, source) {
    const routeSource = source === "infohash" ? "infohash" : "content";
    window.history.pushState(
      { screen: "player", identifier, source },
      "",
      `${homeURL()}${streamRoutePrefix}${routeSource}/${identifier}`,
    );
  }

  function storedLatest() {
    try {
      const raw = window.localStorage.getItem(latestStorageKey) || "";
      if (!raw) {
        const legacy = window.localStorage.getItem(legacyLatestStorageKey) || "";
        if (!contentIDPattern.test(legacy)) return null;
        return { identifier: legacy, source: "content_id", name: "Direct stream" };
      }
      const parsed = JSON.parse(raw);
      if (!parsed || !contentIDPattern.test(parsed.identifier)) return null;
      return {
        identifier: parsed.identifier,
        source: parsed.source === "infohash" ? "infohash" : "content_id",
        name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Direct stream",
      };
    } catch (_) {
      return null;
    }
  }

  function saveLatest(identifier, source, name = "") {
    const existing = storedLatest();
    const displayName = name.trim() || (
      existing && existing.identifier.toLowerCase() === identifier.toLowerCase() && existing.source === source
        ? existing.name
        : "Direct stream"
    );
    try {
      window.localStorage.setItem(latestStorageKey, JSON.stringify({ identifier, source, name: displayName }));
    } catch (_) {
      // Private browsing may deny local storage. Playback still works.
    }
    renderLatest({ identifier, source, name: displayName });
  }

  function renderLatest(playback = storedLatest()) {
    if (!playback) {
      latestButton.hidden = true;
      return;
    }
    latestName.textContent = playback.name || "Direct stream";
    latestButton.hidden = false;
  }

  function showHome(message = "") {
    hidePlaybackStatus();
    playerScreen.hidden = true;
    homeScreen.hidden = false;
    formMessage.textContent = message;
    formMessage.hidden = !message;
    searchInput.focus({ preventScroll: true });
  }

  function showPlayer() {
    homeScreen.hidden = true;
    playerScreen.hidden = false;
  }

  function setPlaybackStatus(title, detail = "", { error = false, retry = false } = {}) {
    playbackStatusTitle.textContent = title;
    playbackStatusDetail.textContent = detail;
    playbackStatusDetail.hidden = !detail;
    retryButton.hidden = !retry;
    playbackStatus.classList.toggle("error", error);
    playbackStatus.hidden = false;
  }

  function hidePlaybackStatus() {
    playbackStatus.hidden = true;
    playbackStatus.classList.remove("error");
    retryButton.hidden = true;
  }

  function statusPeerDetail(data) {
    const peers = Number(data.peers);
    if (!Number.isFinite(peers) || peers <= 0) return "Waiting for a source to become available";
    return `${peers} peer${peers === 1 ? "" : "s"} connected`;
  }

  function updateStatusFromEngine(data) {
    if (firstFrameAt || !playbackWanted) return;
    const status = String(data.status || "").toLowerCase();
    if (status === "error" || status === "stopped") {
      setPlaybackStatus("Stream unavailable", "The source stopped before Safari received video.", { error: true });
      return;
    }
    const detail = statusPeerDetail(data);
    if (detail.startsWith("Waiting")) {
      setPlaybackStatus("Finding peers…", detail);
      return;
    }
    setPlaybackStatus("Buffering stream…", detail);
  }

  function mediaErrorMessage() {
    switch (video.error?.code) {
      case MediaError.MEDIA_ERR_NETWORK:
        return "The stream connection was interrupted";
      case MediaError.MEDIA_ERR_DECODE:
        return "Safari could not decode this stream";
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        return "Safari does not support this stream format";
      default:
        return "The stream stopped unexpectedly";
    }
  }

  function stopPlaybackMonitoring() {
    if (monitorTimer) {
      window.clearInterval(monitorTimer);
      monitorTimer = null;
    }
    if (stablePlaybackTimer) {
      window.clearTimeout(stablePlaybackTimer);
      stablePlaybackTimer = null;
    }
    monitorSessionID = "";
    stallSince = 0;
  }

  function startPlaybackMonitoring(sessionID, { preserveReconnectAttempts = false } = {}) {
    stopPlaybackMonitoring();
    monitorSessionID = sessionID;
    streamStartedAt = Date.now();
    firstFrameAt = 0;
    lastProgressAt = streamStartedAt;
    lastCurrentTime = video.currentTime;
    stallSince = 0;
    if (!preserveReconnectAttempts) reconnectAttempts = 0;
    monitorTimer = window.setInterval(monitorPlayback, statusPollInterval);
  }

  function notePlaybackProgress() {
    const currentTime = video.currentTime;
    if (!Number.isFinite(currentTime) || currentTime === lastCurrentTime) return;
    lastCurrentTime = currentTime;
    lastProgressAt = Date.now();
    stallSince = 0;
  }

  function notePlaybackStarted() {
    if (!currentSessionID) return;
    const now = Date.now();
    firstFrameAt ||= now;
    lastProgressAt = now;
    stallSince = 0;
    hidePlaybackStatus();
    if (stablePlaybackTimer) window.clearTimeout(stablePlaybackTimer);
    const sessionID = currentSessionID;
    stablePlaybackTimer = window.setTimeout(() => {
      if (sessionID === currentSessionID && !video.paused) reconnectAttempts = 0;
    }, 30_000);
  }

  function notePlaybackStall() {
    if (playbackWanted && !video.paused) {
      if (!stallSince) {
        stallSince = Date.now();
        setPlaybackStatus("Buffering…", "Waiting for the stream to catch up");
      }
    }
  }

  async function pollPlaybackStatus() {
    const sessionID = monitorSessionID;
    if (
      statusPollInFlight ||
      !sessionID ||
      sessionID !== currentSessionID ||
      !playbackWanted ||
      video.paused ||
      video.ended
    ) return;

    statusPollInFlight = true;
    try {
      const response = await fetch(`/api/session/${encodeURIComponent(sessionID)}/status`, {
        cache: "no-store",
      });
      if (sessionID !== currentSessionID) return;
      if (response.status === 404) {
        scheduleReconnect("engine session disappeared", true);
        return;
      }
      if (!response.ok) return;
      const data = await response.json().catch(() => ({}));
      if (sessionID !== currentSessionID) return;
      if (data.status === "error" || data.status === "stopped") {
        scheduleReconnect(`engine status: ${data.status}`, true);
        return;
      }
      updateStatusFromEngine(data);
    } catch (_) {
      // The playback watchdog handles media stalls if the status request fails.
    } finally {
      statusPollInFlight = false;
    }
  }

  function monitorPlayback() {
    if (!monitorSessionID || monitorSessionID !== currentSessionID) {
      stopPlaybackMonitoring();
      return;
    }
    if (!playbackWanted || video.paused || video.ended) return;

    const now = Date.now();
    if (stallSince && now - stallSince >= stallRecoveryDelay) {
      scheduleReconnect("playback stalled");
      return;
    }
    if (!firstFrameAt && now - streamStartedAt >= startupRecoveryDelay) {
      scheduleReconnect("stream did not start");
      return;
    }
    if (firstFrameAt && now - lastProgressAt >= progressTimeout) {
      scheduleReconnect("playback stopped progressing");
      return;
    }
    void pollPlaybackStatus();
  }

  function cancelReconnect() {
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempts = 0;
  }

  function scheduleReconnect(reason, immediate = false) {
    if (
      !playbackWanted ||
      recoveryInProgress ||
      !currentContentID ||
      reconnectTimer ||
      reconnectPromise
    ) return;
    if (!immediate && video.paused) return;
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.warn(`Ace Player: automatic reconnect limit reached (${reason})`);
      setPlaybackStatus(
        "Could not start this stream",
        "Safari did not receive playable video after several attempts.",
        { error: true, retry: true },
      );
      return;
    }

    const delay = immediate
      ? 0
      : Math.min(reconnectMaxDelay, reconnectBaseDelay * (2 ** reconnectAttempts));
    const attempt = reconnectAttempts + 1;
    reconnectAttempts = attempt;
    setPlaybackStatus(
      immediate ? "Reconnecting…" : "Connection interrupted",
      immediate
        ? `Trying again (${attempt}/${maxReconnectAttempts})`
        : `Trying again in ${Math.ceil(delay / 1000)} seconds (${attempt}/${maxReconnectAttempts})`,
    );
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      reconnectPromise = reconnectStream(reason).finally(() => {
        reconnectPromise = null;
      });
    }, delay);
  }

  async function reconnectStream(reason) {
    const target = {
      identifier: currentContentID,
      source: currentSource,
      name: currentStreamName,
    };
    if (!playbackWanted || !target.identifier) return;

    console.info(`Ace Player: reconnecting (${reason})`);
    recoveryInProgress = true;
    try {
      await stopStream({ userInitiated: false });
      if (!playbackWanted) return;
      const started = await startStream(target.identifier, {
        source: target.source,
        name: target.name,
        pushHistory: false,
        reconnecting: true,
      });
      if (started || !playbackWanted) return;
      currentContentID = target.identifier;
      currentSource = target.source;
      currentStreamName = target.name;
      showPlayer();
      scheduleReconnect("reconnect attempt failed");
    } finally {
      recoveryInProgress = false;
    }
  }

  async function retryPlayback() {
    if (!playbackWanted || recoveryInProgress || !currentContentID) return;
    cancelReconnect();
    await reconnectStream("manual retry");
  }

  function clearSearchResults() {
    activeSearchQuery = "";
    searchResults.hidden = true;
    resultCount.textContent = "";
    resultsList.replaceChildren();
    emptyMessage.hidden = true;
  }

  function formatBitrate(bitrate) {
    if (!Number.isFinite(bitrate) || bitrate <= 0) return "";
    const megabits = (bitrate * 8) / 1000000;
    return `${megabits >= 10 ? megabits.toFixed(0) : megabits.toFixed(1)} Mbps`;
  }

  function resultMetadata(result) {
    if (result.source === "public") return "Live index";
    const parts = [result.status === 2 ? "Available" : "Uncertain"];
    const language = result.languages?.[0];
    const country = result.countries?.[0];
    const bitrate = formatBitrate(result.bitrate);
    if (language) parts.push(language.toUpperCase());
    if (country) parts.push(country.toUpperCase());
    if (bitrate) parts.push(bitrate);
    return parts.join(" · ");
  }

  function renderSearchResults(results) {
    resultsList.replaceChildren();
    searchResults.hidden = false;
    resultCount.textContent = results.length === 1 ? "1 stream" : `${results.length} streams`;
    emptyMessage.hidden = results.length > 0;

    for (const result of results) {
      const button = document.createElement("button");
      button.className = "result-item";
      button.type = "button";
      button.setAttribute("aria-label", `Play ${result.name}`);

      const copy = document.createElement("span");
      copy.className = "result-copy";
      const name = document.createElement("strong");
      name.className = "result-name";
      name.textContent = result.name;
      const metadata = document.createElement("span");
      metadata.className = "result-meta";
      metadata.textContent = resultMetadata(result);
      copy.append(name, metadata);

      const action = document.createElement("span");
      action.className = "result-action";
      action.setAttribute("aria-hidden", "true");
      action.textContent = "▶";
      button.append(copy, action);
      button.addEventListener("click", () => {
        const identifier = result.contentId || result.infohash;
        const source = result.contentId ? "content_id" : "infohash";
        void startStream(identifier, { source, name: result.name });
      });
      resultsList.append(button);
    }
  }

  function searchStreams(query, options = {}) {
    if (searchPromise) searchAbortController?.abort();
    const promise = searchStreamsInternal(query, options);
    searchPromise = promise;
    promise.then(
      () => {
        if (searchPromise === promise) searchPromise = null;
      },
      () => {
        if (searchPromise === promise) searchPromise = null;
      },
    );
    return promise;
  }

  async function searchStreamsInternal(query) {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) {
      clearSearchResults();
      showHome("Enter at least 2 characters to search.");
      return;
    }
    activeSearchQuery = normalizedQuery;
    searchInput.value = normalizedQuery;
    searchResults.hidden = false;
    resultCount.textContent = "Searching…";
    resultsList.replaceChildren();
    emptyMessage.hidden = true;
    formMessage.hidden = true;

    const abortController = new AbortController();
    searchAbortController = abortController;
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(normalizedQuery)}`, {
        signal: abortController.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (abortController.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || "Could not search the Ace Stream network.");
      renderSearchResults(data.results || []);
    } catch (error) {
      if (error.name === "AbortError") return;
      resultCount.textContent = "";
      resultsList.replaceChildren();
      emptyMessage.hidden = true;
      showHome(error.message || "Could not search the Ace Stream network.");
    } finally {
      if (searchAbortController === abortController) {
        searchAbortController = null;
      }
    }
  }

  function startStream(identifier, options = {}) {
    if (starting) return startPromise || Promise.resolve();
    const promise = startStreamInternal(identifier, options);
    startPromise = promise;
    promise.then(
      () => {
        if (startPromise === promise) startPromise = null;
      },
      () => {
        if (startPromise === promise) startPromise = null;
      },
    );
    return promise;
  }

  async function startStreamInternal(
    identifier,
    { source = "content_id", name = "", pushHistory = true, reconnecting = false } = {},
  ) {
    starting = true;
    const requestedIdentifier = identifier.trim();
    currentContentID = requestedIdentifier;
    currentSource = source;
    currentStreamName = name.trim();
    playbackWanted = true;
    if (!reconnecting) cancelReconnect();
    showPlayer();
    setPlaybackStatus(
      reconnecting ? "Reconnecting…" : "Starting stream…",
      reconnecting ? "Creating a fresh AceStream session" : "Connecting to the AceStream engine",
    );
    const abortController = new AbortController();
    startAbortController = abortController;
    formMessage.hidden = true;

    try {
      const body = source === "infohash"
        ? { infohash: requestedIdentifier }
        : { contentId: requestedIdentifier };
      const response = await fetch("/api/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (abortController.signal.aborted) return false;
      if (!response.ok) throw new Error(data.error || "Could not start this stream.");

      currentSessionID = data.sessionId;
      currentContentID = data.contentId;
      saveLatest(currentContentID, source, name);
      if (pushHistory) pushStreamRoute(currentContentID, source);
      showPlayer();
      setPlaybackStatus("Connecting…", "Waiting for Safari to receive the stream");
      video.src = data.manifestUrl;
      video.load();
      startPlaybackMonitoring(currentSessionID, { preserveReconnectAttempts: reconnecting });
      void video.play().catch((error) => {
        if (error.name === "NotAllowedError" && playbackWanted && currentSessionID === data.sessionId) {
          setPlaybackStatus("Ready to play", "Use Safari’s native play control to start the stream");
        }
      });
      return true;
    } catch (error) {
      if (error.name === "AbortError") return false;
      currentSessionID = "";
      if (reconnecting) {
        currentContentID = requestedIdentifier;
        currentSource = source;
        showPlayer();
      } else {
        currentContentID = "";
        currentSource = "content_id";
        playbackWanted = false;
        showHome(error.message || "Could not start this stream.");
      }
      return false;
    } finally {
      if (startAbortController === abortController) startAbortController = null;
      starting = false;
    }
  }

  async function stopStream({ userInitiated = true } = {}) {
    if (userInitiated) {
      playbackWanted = false;
      cancelReconnect();
      hidePlaybackStatus();
    }
    const sessionID = currentSessionID;
    currentSessionID = "";
    currentContentID = "";
    currentSource = "content_id";
    currentStreamName = "";
    stopPlaybackMonitoring();
    if (document.pictureInPictureElement === video && document.exitPictureInPicture) {
      await document.exitPictureInPicture().catch(() => {});
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    if (!sessionID) return;
    try {
      await fetch("/api/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionID }),
        keepalive: true,
      });
    } catch (_) {
      // The engine also cleans up abandoned playback sessions.
    }
  }

  video.addEventListener("play", () => {
    playbackWanted = true;
  });
  video.addEventListener("playing", notePlaybackStarted);
  video.addEventListener("timeupdate", notePlaybackProgress);
  video.addEventListener("waiting", notePlaybackStall);
  video.addEventListener("stalled", notePlaybackStall);
  video.addEventListener("error", () => {
    if (playbackWanted) {
      setPlaybackStatus(mediaErrorMessage(), "Trying to restore the connection");
      scheduleReconnect("media error", true);
    }
  });
  video.addEventListener("pause", () => {
    if (!recoveryInProgress && !starting && currentSessionID) {
      playbackWanted = false;
      hidePlaybackStatus();
    }
  });

  retryButton.addEventListener("click", () => {
    void retryPlayback();
  });

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    const directIdentifier = query.replace(/^acestream:\/\//i, "");
    if (contentIDPattern.test(directIdentifier)) {
      void startStream(query);
      return;
    }
    void searchStreams(query);
  });

  latestButton.addEventListener("click", () => {
    const latest = storedLatest();
    if (!latest) return;
    searchInput.value = latest.identifier;
    void startStream(latest.identifier, { source: latest.source, name: latest.name });
  });

  async function applyLocation() {
    const playback = playbackFromLocation();
    if (playback) {
      if (
        currentSessionID &&
        currentContentID.toLowerCase() === playback.identifier.toLowerCase() &&
        currentSource === playback.source
      ) {
        showPlayer();
        return;
      }
      if (startAbortController) {
        startAbortController.abort();
        await startPromise;
      }
      if (searchAbortController) {
        searchAbortController.abort();
        await searchPromise;
      }
      await stopStream();
      await startStream(playback.identifier, { source: playback.source, pushHistory: false });
      return;
    }

    if (startAbortController) {
      startAbortController.abort();
      await startPromise;
    }
    if (searchAbortController) {
      searchAbortController.abort();
      await searchPromise;
    }
    await stopStream();
    showHome();

    searchInput.value = "";
    clearSearchResults();
    replaceWithHomeRoute();
  }

  window.addEventListener("popstate", () => {
    void applyLocation();
  });

  window.addEventListener("pagehide", () => {
    if (!currentSessionID) return;
    fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionID }),
      keepalive: true,
    }).catch(() => {});
  });

  renderLatest();
  if (window.location.hash && !playbackFromLocation()) replaceWithHomeRoute();
  void applyLocation();
})();
