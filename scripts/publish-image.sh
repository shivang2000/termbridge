#!/usr/bin/env bash
# Build + push the self-contained termbridge server image to Docker Hub.
# Requires `docker login` first. Usage:
#   scripts/publish-image.sh <dockerhub-namespace> [version]
# Example:
#   docker login
#   scripts/publish-image.sh acme 1.0.0
#   # → pushes acme/termbridge:1.0.0 and acme/termbridge:latest
set -euo pipefail

NS="${1:?usage: publish-image.sh <dockerhub-namespace> [version]}"
VER="${2:-1.0.0}"
IMG="$NS/termbridge"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[publish] building $IMG:$VER (+ :latest) from docker/Dockerfile.server"
docker build -f "$ROOT/docker/Dockerfile.server" -t "$IMG:$VER" -t "$IMG:latest" "$ROOT"

echo "[publish] pushing $IMG:$VER"
docker push "$IMG:$VER"
echo "[publish] pushing $IMG:latest"
docker push "$IMG:latest"

echo "[publish] done. Users can now run:"
echo "  docker run --rm -p 127.0.0.1:8787:8787 -v ~/.termbridge/home:/home/tb/.termbridge/home -e TERMBRIDGE_TOKEN=secret $IMG:$VER"
