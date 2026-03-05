.PHONY: help setup up down reset logs ps

help:
	@echo "MosBot Full-Stack Test Harness"
	@echo ""
	@echo "  make setup    First-time setup (OpenClaw onboarding + .env generation)"
	@echo "  make up       Start the full 6-service stack"
	@echo "  make down     Stop all containers"
	@echo "  make reset    Nuke everything: containers, volumes, DB, OpenClaw config"
	@echo "  make logs     Follow all service logs"
	@echo "  make ps       Show container status"
	@echo ""
	@echo "First-time setup:"
	@echo "  1. make setup"
	@echo "  2. make up"
	@echo ""
	@echo "Prerequisites:"
	@echo "  Sibling repos must be cloned alongside mosbot-api:"
	@echo "    ../mosbot-dashboard/"
	@echo "    ../mosbot-workspace-service/"

setup:
	./docker-setup.sh

up:
	DOCKER_BUILDKIT=0 docker compose up -d

down:
	docker compose down

reset:
	./docker-setup.sh reset

logs:
	docker compose logs -f

ps:
	docker compose ps
