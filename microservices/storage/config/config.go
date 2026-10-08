package config

import (
	"log"
	"os"

	"github.com/joho/godotenv"
)

// Config holds runtime configuration for the mawa-storage service.
type Config struct {
	Port        string
	Environment string
	CORSOrigins string

	// Storage backend configuration (e.g. GCS / S3). These are intentionally
	// generic so the implementation can evolve without changing callers.
	DefaultBucket string
	ProjectID     string

	// APISecret is the shared secret callers must supply in X-Storage-Secret.
	// When empty in development, write operations are allowed without auth.
	APISecret string
}

// Load reads configuration from environment variables (optionally .env file).
func Load() (*Config, error) {
	// Load .env if present; ignore errors so the service still starts when
	// environment variables are provided by the runtime.
	_ = godotenv.Load()

	cfg := &Config{
		Port:        getEnv("PORT", "8090"),
		Environment: getEnv("ENVIRONMENT", "development"),
		CORSOrigins: getEnv("CORS_ORIGINS", "http://localhost:3000,http://localhost:3001"),

		DefaultBucket: getEnv("STORAGE_DEFAULT_BUCKET", ""),
		ProjectID:     getEnv("STORAGE_PROJECT_ID", ""),
		APISecret:     getEnv("STORAGE_API_SECRET", ""),
	}

	log.Printf("mawa-storage starting with ENVIRONMENT=%s PORT=%s", cfg.Environment, cfg.Port)
	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
