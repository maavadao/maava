from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # Required — set DATABASE_URL env var or Cloud Run secret
    database_url: str = ""

    # Scraper settings
    scrape_api_url: str = "https://skills.sh/api/search"
    scrape_request_limit: int = 70000
    scrape_delay: float = 0.5
    scrape_target: int = 62509

    # Security — set API_KEY env var to require auth on mutating endpoints
    api_key: Optional[str] = None

    # Built-in scheduler — triggers scrape every N hours
    scheduler_enabled: bool = True
    scheduler_interval_hours: float = 6.0

    # Server
    port: int = 8080

    class Config:
        env_file = ".env"


settings = Settings()
