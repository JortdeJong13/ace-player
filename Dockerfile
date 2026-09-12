FROM golang:1.27.1-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ace-player ./cmd/ace-player

FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out/ace-player /app/ace-player
COPY --chown=nonroot:nonroot web /app/web

ENV PORT=8080
ENV WEB_ROOT=/app/web
EXPOSE 8080

USER nonroot:nonroot
ENTRYPOINT ["/app/ace-player"]
