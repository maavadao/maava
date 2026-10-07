.PHONY: db-up db-down migrate api test lint demo-seed demo-frontend

db-up:
	docker compose up -d postgres --wait

db-down:
	docker compose down

migrate:
	python db/migrate.py

api:
	uvicorn app.main:app --reload --port 8080

test:
	python -m pytest -q

lint:
	ruff check .

demo-seed:
	python examples/demo-frontend/seed_demo.py

demo-frontend:
	cd examples/demo-frontend && npm install && npm run dev
