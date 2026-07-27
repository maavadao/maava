.PHONY: db-up db-down migrate api test lint

db-up:
	docker compose up -d postgres --wait

db-down:
	docker compose down

migrate:
	python db/migrate.py

api:
	cd apps/api && uvicorn app.main:app --reload --port 8080

test:
	cd apps/api && python -m pytest -q

lint:
	cd apps/api && ruff check .
