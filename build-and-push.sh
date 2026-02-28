#!/bin/bash
set -e

# Build and push mosbot-api to GHCR with a version tag.
# Usage: ./build-and-push.sh <version>
# Example: ./build-and-push.sh 1.2.3

GITHUB_ORG="${GITHUB_ORG:?Set GITHUB_ORG to your GitHub organization or username}"
IMAGE_NAME="ghcr.io/${GITHUB_ORG}/mosbot-api"
VERSION="${1:?Usage: ./build-and-push.sh <version>   e.g. ./build-and-push.sh 1.2.3}"

echo "Building mosbot-api (multi-platform)..."
echo "Image: ${IMAGE_NAME}:${VERSION}"
echo "Platforms: linux/amd64, linux/arm64"

docker buildx create --name multiplatform --use 2>/dev/null || docker buildx use multiplatform

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "${IMAGE_NAME}:${VERSION}" \
  --push \
  .

echo ""
echo "Pushed ${IMAGE_NAME}:${VERSION}"
