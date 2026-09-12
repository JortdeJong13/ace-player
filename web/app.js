(() => {
  "use strict";

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

  const streamRoutePrefix = "#stream/";
  const legacyLatestStorageKey = "ace-player.latest-content-id";
  const contentIDPattern = /^[a-fA-F0-9]{40}$/;
  let currentSessionID = "";
  let currentContentID = "";
  let currentSource = "content_id";
  let starting = false;
  let startAbortController = null;
  let startPromise = null;
  let searchAbortController = null;
  let searchPromise = null;
  let activeSearchQuery = "";

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
        void startStream(result.infohash, { source: "infohash", name: result.name });
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

  async function startStreamInternal(identifier, { source = "content_id", name = "", pushHistory = true } = {}) {
    starting = true;
    const requestedIdentifier = identifier.trim();
    currentContentID = requestedIdentifier;
    currentSource = source;
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
      if (abortController.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || "Could not start this stream.");

      currentSessionID = data.sessionId;
      currentContentID = data.contentId;
      saveLatest(currentContentID, source, name);
      if (pushHistory) pushStreamRoute(currentContentID, source);
      showPlayer();
      video.src = data.manifestUrl;
      video.load();
      void video.play().catch(() => {});
    } catch (error) {
      if (error.name === "AbortError") return;
      currentContentID = "";
      currentSource = "content_id";
      showHome(error.message || "Could not start this stream.");
    } finally {
      if (startAbortController === abortController) startAbortController = null;
      starting = false;
    }
  }

  async function stopStream() {
    const sessionID = currentSessionID;
    currentSessionID = "";
    currentContentID = "";
    currentSource = "content_id";
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
