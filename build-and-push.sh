#!/bin/bash
set -e

# Mosbot API - Build and push to GHCR with a version tag.
# Use a versioned tag so Kubernetes (imagePullPolicy: IfNotPresent) pulls the new image
# when you update the tag in homelab-gitops.

IMAGE_NAME="ghcr.io/mosufy/mosbot-api"
VERSION="${1:?Usage: ./build-and-push.sh <version>   e.g. ./build-and-push.sh 2026.2.6}"

echo "Building mosbot-api (multi-platform)..."
echo "Image: ${IMAGE_NAME}:${VERSION}"
echo "Platforms: linux/amd64, linux/arm64"

docker buildx create --name multiplatform --use 2>/dev/null || docker buildx use multiplatform

docker buildx build \
	--platform linux/amd64,linux/arm64 \
	-t "${IMAGE_NAME}:${VERSION}" \
	--push \
	.

echo "Pushed ${IMAGE_NAME}:${VERSION}"
echo ""
echo "Next: update homelab-gitops so the deployment uses this tag:"
echo "  In apps/homelab/mosbot/overlays/homelab/kustomization.yaml set:"
echo "    newTag: \"${VERSION}\""
echo "  Then sync (e.g. Argo CD) and: kubectl rollout restart deployment/mosbot-api -n mosbot"
