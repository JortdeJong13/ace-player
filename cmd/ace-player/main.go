package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultPort            = "8080"
	defaultEngine          = "http://acestream:6878"
	defaultMaxSessions     = 4
	sessionIdleTimeout     = 15 * time.Minute
	sessionCleanupInterval = time.Minute
	maxRequestBytes        = 4096
)

var contentIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{40}$`)

type app struct {
	engineURL   *url.URL
	client      *http.Client
	webRoot     string
	sessionsMu  sync.RWMutex
	sessions    map[string]*session
	maxSessions int
}

type session struct {
	id          string
	contentID   string
	playbackURL *url.URL
	commandURL  *url.URL
	createdAt   time.Time
	lastAccess  time.Time
}

type playRequest struct {
	ContentID string `json:"contentId"`
	Infohash  string `json:"infohash"`
}

type playResponse struct {
	SessionID string `json:"sessionId"`
	ContentID string `json:"contentId"`
	Manifest  string `json:"manifestUrl"`
}

type enginePlaybackResponse struct {
	Response *struct {
		PlaybackURL string `json:"playback_url"`
		CommandURL  string `json:"command_url"`
	} `json:"response"`
	Error json.RawMessage `json:"error"`
}

type stopRequest struct {
	SessionID string `json:"sessionId"`
}

type engineSearchResponse struct {
	Result *engineSearchResult `json:"result"`
	Error  json.RawMessage     `json:"error"`
}

type engineSearchResult struct {
	Total   int                 `json:"total"`
	Results []engineSearchGroup `json:"results"`
}

type engineSearchGroup struct {
	Name         string             `json:"name"`
	Items        []engineSearchItem `json:"items"`
	Infohash     string             `json:"infohash"`
	Bitrate      int                `json:"bitrate"`
	Availability float64            `json:"availability"`
	Status       int                `json:"status"`
	Categories   []string           `json:"categories"`
	Countries    []string           `json:"countries"`
	Languages    []string           `json:"languages"`
}

type engineSearchItem struct {
	Infohash     string   `json:"infohash"`
	Name         string   `json:"name"`
	Bitrate      int      `json:"bitrate"`
	Availability float64  `json:"availability"`
	Status       int      `json:"status"`
	Disabled     bool     `json:"disabled"`
	Categories   []string `json:"categories"`
	Countries    []string `json:"countries"`
	Languages    []string `json:"languages"`
}

type searchResult struct {
	Infohash     string   `json:"infohash"`
	Name         string   `json:"name"`
	Bitrate      int      `json:"bitrate"`
	Availability float64  `json:"availability"`
	Status       int      `json:"status"`
	Categories   []string `json:"categories,omitempty"`
	Countries    []string `json:"countries,omitempty"`
	Languages    []string `json:"languages,omitempty"`
}

type searchResponse struct {
	Query   string         `json:"query"`
	Total   int            `json:"total"`
	Results []searchResult `json:"results"`
}

func main() {
	engineURL, err := parseBaseURL(envOr("ACESTREAM_URL", defaultEngine))
	if err != nil {
		log.Fatalf("invalid ACESTREAM_URL: %v", err)
	}

	server := &app{
		engineURL: engineURL,
		client: &http.Client{Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ResponseHeaderTimeout: 30 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
		}},
		webRoot:     envOr("WEB_ROOT", "web"),
		sessions:    make(map[string]*session),
		maxSessions: positiveIntEnv("MAX_SESSIONS", defaultMaxSessions),
	}
	go server.cleanupLoop()

	port := envOr("PORT", defaultPort)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", server.health)
	mux.HandleFunc("GET /readyz", server.ready)
	mux.HandleFunc("GET /api/search", server.search)
	mux.HandleFunc("POST /api/play", server.play)
	mux.HandleFunc("POST /api/stop", server.stop)
	mux.HandleFunc("GET /stream/{sessionID}/manifest.m3u8", server.manifest)
	mux.HandleFunc("GET /stream/{sessionID}/resource", server.resource)
	mux.Handle("/", http.FileServer(http.Dir(server.webRoot)))

	address := ":" + port
	log.Printf("ace-player listening on %s (engine: %s)", address, engineURL.String())
	if err := http.ListenAndServe(address, securityHeaders(mux)); err != nil {
		log.Fatal(err)
	}
}

func (a *app) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (a *app) ready(w http.ResponseWriter, r *http.Request) {
	requestURL := a.engineEndpoint("/webui/api/service", url.Values{"method": {"get_version"}})
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Ace Stream engine is unavailable")
		return
	}
	response, err := a.client.Do(request)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "Ace Stream engine is unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		writeError(w, http.StatusServiceUnavailable, "Ace Stream engine is not ready")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (a *app) search(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) < 2 {
		writeError(w, http.StatusBadRequest, "enter at least 2 characters to search")
		return
	}
	if len(query) > 200 {
		writeError(w, http.StatusBadRequest, "search query is too long")
		return
	}

	engineRequestURL := a.engineEndpoint("/search", url.Values{
		"query":     {query},
		"page":      {"0"},
		"page_size": {"50"},
	})
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, engineRequestURL.String(), nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "could not contact Ace Stream engine")
		return
	}
	response, err := a.client.Do(request)
	if err != nil {
		writeError(w, http.StatusBadGateway, "could not contact Ace Stream engine")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		writeError(w, http.StatusBadGateway, "Ace Stream engine rejected the search")
		return
	}

	var engineResponse engineSearchResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&engineResponse); err != nil {
		writeError(w, http.StatusBadGateway, "Ace Stream engine returned an invalid search response")
		return
	}
	if message := engineErrorMessage(engineResponse.Error); message != "" {
		writeError(w, http.StatusBadGateway, message)
		return
	}
	if engineResponse.Result == nil {
		writeError(w, http.StatusBadGateway, "Ace Stream engine returned no search results")
		return
	}

	results := flattenSearchResults(engineResponse.Result.Results)
	writeJSON(w, http.StatusOK, searchResponse{
		Query:   query,
		Total:   len(results),
		Results: results,
	})
}

func flattenSearchResults(groups []engineSearchGroup) []searchResult {
	results := make([]searchResult, 0, len(groups))
	seen := make(map[string]struct{})
	add := func(result searchResult) {
		if !contentIDPattern.MatchString(result.Infohash) || result.Name == "" {
			return
		}
		result.Infohash = strings.ToLower(result.Infohash)
		if _, ok := seen[result.Infohash]; ok {
			return
		}
		seen[result.Infohash] = struct{}{}
		results = append(results, result)
	}

	for _, group := range groups {
		if len(group.Items) == 0 {
			add(searchResult{
				Infohash:     group.Infohash,
				Name:         group.Name,
				Bitrate:      group.Bitrate,
				Availability: group.Availability,
				Status:       group.Status,
				Categories:   group.Categories,
				Countries:    group.Countries,
				Languages:    group.Languages,
			})
			continue
		}

		for _, item := range group.Items {
			if item.Disabled {
				continue
			}
			name := item.Name
			if name == "" {
				name = group.Name
			}
			add(searchResult{
				Infohash:     item.Infohash,
				Name:         name,
				Bitrate:      item.Bitrate,
				Availability: item.Availability,
				Status:       item.Status,
				Categories:   item.Categories,
				Countries:    item.Countries,
				Languages:    item.Languages,
			})
		}
	}
	return results
}

func (a *app) play(w http.ResponseWriter, r *http.Request) {
	var input playRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxRequestBytes))
	if err := decoder.Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request")
		return
	}

	identifier, engineIdentifier, err := normalizePlaybackRequest(input)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	query := url.Values{}
	query.Set("format", "json")
	query.Set(engineIdentifier, identifier)
	// Safari compatibility: AceServe converts codecs such as E-AC-3 to AAC.
	query.Set("transcode_audio", "1")
	engineRequestURL := a.engineEndpoint("/ace/manifest.m3u8", query)
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, engineRequestURL.String(), nil)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Could not contact Ace Stream engine")
		return
	}

	response, err := a.client.Do(request)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Could not contact Ace Stream engine")
		return
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		writeError(w, http.StatusBadGateway, "Ace Stream engine rejected the stream")
		return
	}

	var engineResponse enginePlaybackResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&engineResponse); err != nil {
		writeError(w, http.StatusBadGateway, "Ace Stream engine returned an invalid response")
		return
	}
	if message := engineErrorMessage(engineResponse.Error); message != "" {
		writeError(w, http.StatusBadGateway, message)
		return
	}
	if engineResponse.Response == nil || engineResponse.Response.PlaybackURL == "" {
		writeError(w, http.StatusBadGateway, "Ace Stream engine did not return a playback URL")
		return
	}

	playbackURL, err := url.Parse(engineResponse.Response.PlaybackURL)
	if err != nil || playbackURL.Path == "" {
		writeError(w, http.StatusBadGateway, "Ace Stream engine returned an invalid playback URL")
		return
	}
	var commandURL *url.URL
	if engineResponse.Response.CommandURL != "" {
		commandURL, err = url.Parse(engineResponse.Response.CommandURL)
		if err != nil || commandURL.Path == "" {
			commandURL = nil
		}
	}

	sessionID, err := randomID(16)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create playback session")
		return
	}
	newSession := &session{
		id:          sessionID,
		contentID:   identifier,
		playbackURL: playbackURL,
		commandURL:  commandURL,
		createdAt:   time.Now(),
		lastAccess:  time.Now(),
	}

	if !a.addSession(newSession) {
		a.stopEngineSession(newSession)
		writeError(w, http.StatusTooManyRequests, "Too many streams are active")
		return
	}

	writeJSON(w, http.StatusOK, playResponse{
		SessionID: sessionID,
		ContentID: identifier,
		Manifest:  "/stream/" + sessionID + "/manifest.m3u8",
	})
}

func engineErrorMessage(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var message string
	if json.Unmarshal(raw, &message) == nil && message != "" {
		return message
	}
	var structured struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &structured) == nil && structured.Message != "" {
		return structured.Message
	}
	return "Ace Stream engine could not start the stream"
}

func (a *app) stop(w http.ResponseWriter, r *http.Request) {
	var input stopRequest
	if r.Body != nil {
		_ = json.NewDecoder(io.LimitReader(r.Body, maxRequestBytes)).Decode(&input)
	}

	a.sessionsMu.Lock()
	sessionID := input.SessionID
	if sessionID == "" {
		a.sessionsMu.Unlock()
		writeError(w, http.StatusBadRequest, "Missing session ID")
		return
	}
	current := a.sessions[sessionID]
	if current != nil {
		delete(a.sessions, sessionID)
	}
	a.sessionsMu.Unlock()

	if current != nil {
		a.stopEngineSession(current)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "stopped"})
}

func (a *app) manifest(w http.ResponseWriter, r *http.Request) {
	session := a.getSession(r.PathValue("sessionID"))
	if session == nil {
		writeError(w, http.StatusNotFound, "Playback session not found")
		return
	}

	engineURL := a.engineURLFor(session.playbackURL)
	response, status, err := a.openResource(r.Context(), engineURL)
	if err != nil {
		writeError(w, status, err.Error())
		return
	}
	defer response.Body.Close()
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if !isPlaylist(contentType, engineURL.Path) {
		writeError(w, http.StatusBadGateway, "Ace Stream did not return an HLS playlist")
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		writeError(w, http.StatusBadGateway, "Could not read Ace Stream playlist")
		return
	}
	rewritten := a.rewriteManifest(string(body), r.PathValue("sessionID"), engineURL)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, rewritten)
}

func (a *app) resource(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionID")
	if a.getSession(sessionID) == nil {
		writeError(w, http.StatusNotFound, "Playback session not found")
		return
	}

	encodedPath := r.URL.Query().Get("u")
	if encodedPath == "" {
		writeError(w, http.StatusBadRequest, "Missing stream resource")
		return
	}
	pathQuery, err := base64.RawURLEncoding.DecodeString(encodedPath)
	if err != nil || len(pathQuery) == 0 || pathQuery[0] != '/' {
		writeError(w, http.StatusBadRequest, "Invalid stream resource")
		return
	}

	resourceURL, err := url.Parse(string(pathQuery))
	if err != nil || resourceURL.Path == "" || resourceURL.IsAbs() || resourceURL.Host != "" {
		writeError(w, http.StatusBadRequest, "Invalid stream resource")
		return
	}
	engineURL := a.engineEndpoint(resourceURL.Path, resourceURL.Query())
	response, status, err := a.openResource(r.Context(), engineURL)
	if err != nil {
		writeError(w, status, err.Error())
		return
	}
	defer response.Body.Close()
	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	if isPlaylist(contentType, engineURL.Path) {
		body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
		if err != nil {
			writeError(w, http.StatusBadGateway, "Could not read Ace Stream playlist")
			return
		}
		rewritten := a.rewriteManifest(string(body), sessionID, engineURL)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, rewritten)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, response.Body)
}

func (a *app) openResource(ctx context.Context, resourceURL *url.URL) (*http.Response, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, resourceURL.String(), nil)
	if err != nil {
		return nil, http.StatusBadGateway, errors.New("could not contact Ace Stream engine")
	}
	response, err := a.client.Do(request)
	if err != nil {
		return nil, http.StatusBadGateway, errors.New("could not contact Ace Stream engine")
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		_ = response.Body.Close()
		return nil, http.StatusBadGateway, fmt.Errorf("Ace Stream engine returned HTTP %d", response.StatusCode)
	}
	return response, http.StatusOK, nil
}

func (a *app) rewriteManifest(manifest, sessionID string, baseURL *url.URL) string {
	lines := strings.SplitAfter(manifest, "\n")
	for index, line := range lines {
		lineEnding := ""
		content := strings.TrimSuffix(line, "\n")
		if strings.HasSuffix(content, "\r") {
			content = strings.TrimSuffix(content, "\r")
			lineEnding = "\r\n"
		} else if strings.HasSuffix(line, "\n") {
			lineEnding = "\n"
		}
		trimmed := strings.TrimSpace(content)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			lines[index] = rewriteURIAttribute(content, sessionID, baseURL) + lineEnding
			continue
		}
		if rewritten, ok := localResourceURL(trimmed, sessionID, baseURL); ok {
			leading := content[:len(content)-len(strings.TrimLeft(content, " \t"))]
			lines[index] = leading + rewritten + lineEnding
		}
	}
	return strings.Join(lines, "")
}

func rewriteURIAttribute(line, sessionID string, baseURL *url.URL) string {
	searchFrom := 0
	for {
		upper := strings.ToUpper(line)
		relativeStart := strings.Index(upper[searchFrom:], `URI="`)
		if relativeStart < 0 {
			return line
		}
		start := searchFrom + relativeStart
		valueStart := start + len(`URI="`)
		valueEnd := strings.Index(line[valueStart:], `"`)
		if valueEnd < 0 {
			return line
		}
		valueEnd += valueStart
		original := line[valueStart:valueEnd]
		if rewritten, ok := localResourceURL(original, sessionID, baseURL); ok {
			line = line[:valueStart] + rewritten + line[valueEnd:]
			searchFrom = valueStart + len(rewritten) + 1
		} else {
			searchFrom = valueEnd + 1
		}
	}
}

func localResourceURL(reference, sessionID string, baseURL *url.URL) (string, bool) {
	parsed, err := url.Parse(reference)
	if err != nil || parsed.Scheme != "" && parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	resolved := baseURL.ResolveReference(parsed)
	if resolved.Path == "" {
		return "", false
	}
	pathQuery := resolved.EscapedPath()
	if pathQuery == "" {
		pathQuery = "/"
	}
	if resolved.RawQuery != "" {
		pathQuery += "?" + resolved.RawQuery
	}
	token := base64.RawURLEncoding.EncodeToString([]byte(pathQuery))
	return "/stream/" + sessionID + "/resource?u=" + url.QueryEscape(token), true
}

func (a *app) stopEngineSession(current *session) {
	if current == nil || current.commandURL == nil {
		return
	}
	query := current.commandURL.Query()
	query.Set("method", "stop")
	stopURL := a.engineEndpoint(current.commandURL.Path, query)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, stopURL.String(), nil)
	if err != nil {
		return
	}
	response, err := a.client.Do(request)
	if err == nil {
		_ = response.Body.Close()
	}
}

func (a *app) addSession(current *session) bool {
	a.sessionsMu.Lock()
	defer a.sessionsMu.Unlock()
	if len(a.sessions) >= a.maxSessions {
		return false
	}
	a.sessions[current.id] = current
	return true
}

func (a *app) getSession(id string) *session {
	a.sessionsMu.Lock()
	defer a.sessionsMu.Unlock()
	current := a.sessions[id]
	if current != nil {
		current.lastAccess = time.Now()
	}
	return current
}

func (a *app) cleanupLoop() {
	ticker := time.NewTicker(sessionCleanupInterval)
	defer ticker.Stop()
	for range ticker.C {
		a.cleanupIdleSessions()
	}
}

func (a *app) cleanupIdleSessions() {
	cutoff := time.Now().Add(-sessionIdleTimeout)
	var expired []*session

	a.sessionsMu.Lock()
	for id, current := range a.sessions {
		if current.lastAccess.Before(cutoff) {
			delete(a.sessions, id)
			expired = append(expired, current)
		}
	}
	a.sessionsMu.Unlock()

	for _, current := range expired {
		a.stopEngineSession(current)
	}
}

func (a *app) engineEndpoint(requestPath string, query url.Values) *url.URL {
	result := *a.engineURL
	result.Path = path.Join(a.engineURL.Path, requestPath)
	if !strings.HasPrefix(result.Path, "/") {
		result.Path = "/" + result.Path
	}
	result.RawQuery = query.Encode()
	return &result
}

func (a *app) engineURLFor(original *url.URL) *url.URL {
	query := original.Query()
	return a.engineEndpoint(original.Path, query)
}

func parseBaseURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("must be an absolute HTTP URL")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, errors.New("must use http or https")
	}
	return parsed, nil
}

func normalizeContentID(raw string) (string, error) {
	contentID := strings.TrimSpace(raw)
	contentID = strings.TrimPrefix(strings.TrimPrefix(contentID, "acestream://"), "ACESTREAM://")
	contentID = strings.TrimSpace(contentID)
	if !contentIDPattern.MatchString(contentID) {
		return "", errors.New("enter a 40-character Acestream content ID")
	}
	return strings.ToLower(contentID), nil
}

func normalizePlaybackRequest(input playRequest) (string, string, error) {
	if strings.TrimSpace(input.ContentID) != "" && strings.TrimSpace(input.Infohash) != "" {
		return "", "", errors.New("provide either a content ID or an infohash")
	}
	if strings.TrimSpace(input.Infohash) != "" {
		infohash := strings.TrimSpace(input.Infohash)
		if !contentIDPattern.MatchString(infohash) {
			return "", "", errors.New("invalid Ace Stream infohash")
		}
		return strings.ToLower(infohash), "infohash", nil
	}
	contentID, err := normalizeContentID(input.ContentID)
	return contentID, "content_id", err
}

func randomID(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func isPlaylist(contentType, resourcePath string) bool {
	contentType = strings.ToLower(contentType)
	return strings.Contains(contentType, "mpegurl") || strings.HasSuffix(strings.ToLower(resourcePath), ".m3u8")
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		w.Header().Set("Permissions-Policy", "picture-in-picture=*")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func positiveIntEnv(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}

	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return fallback
	}
	return parsed
}
