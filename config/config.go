package config

import (
	"fmt"
	"os"

	"github.com/joho/godotenv"
)

type Config struct {
	Port                  string
	Environment           string
	GoogleClientID        string
	GoogleClientSecret    string
	GoogleRedirectURL     string
	MicrosoftClientID     string
	MicrosoftClientSecret string
	MicrosoftRedirectURL  string
	MicrosoftTenantID     string
	SessionSecret         string
	FrontendURL           string
	JWTSecret             string
	OIDCClientID          string
	OIDCIssuer            string
	OIDCPrivateKeyPEM     string
	OIDCKeyID             string
	DatabaseURL           string
	CORSOrigins           string
}

// insecureDefaults are placeholder values that must be overridden in production.
var insecureDefaults = map[string]string{
	"SESSION_SECRET": "change-this-secret-key",
	"JWT_SECRET":     "change-this-jwt-secret",
}

func Load() (*Config, error) {
	// Load .env file if it exists (ignore error if it doesn't)
	_ = godotenv.Load()

	env := getEnv("ENVIRONMENT", "development")

	// In production, refuse to start with insecure default secrets
	if env == "production" {
		for envVar, insecureVal := range insecureDefaults {
			val := os.Getenv(envVar)
			if val == "" || val == insecureVal {
				return nil, fmt.Errorf("FATAL: %s is not set or still has the insecure default value — set a strong random secret in production", envVar)
			}
		}
	}

	cfg := &Config{
		Port:                  getEnv("PORT", "8080"),
		Environment:           env,
		GoogleClientID:        getEnv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret:    getEnv("GOOGLE_CLIENT_SECRET", ""),
		GoogleRedirectURL:     getEnv("GOOGLE_REDIRECT_URL", "http://localhost:8080/auth/google/callback"),
		MicrosoftClientID:     getEnv("MICROSOFT_CLIENT_ID", ""),
		MicrosoftClientSecret: getEnv("MICROSOFT_CLIENT_SECRET", ""),
		MicrosoftRedirectURL:  getEnv("MICROSOFT_REDIRECT_URL", "http://localhost:8080/auth/microsoft/callback"),
		MicrosoftTenantID:     getEnv("MICROSOFT_TENANT_ID", "common"),
		SessionSecret:         getEnv("SESSION_SECRET", "change-this-secret-key"),
		FrontendURL:           getEnv("FRONTEND_URL", "http://localhost:3000"),
		JWTSecret:             getEnv("JWT_SECRET", "change-this-jwt-secret"),
		OIDCClientID:          getEnv("OIDC_CLIENT_ID", "mawadao-web"),
		OIDCIssuer:            getEnv("OIDC_ISSUER", ""),
		OIDCPrivateKeyPEM:     getEnv("OIDC_PRIVATE_KEY_PEM", ""),
		OIDCKeyID:             getEnv("OIDC_KEY_ID", ""),
		DatabaseURL:           getEnv("DATABASE_URL", ""),
		CORSOrigins:           getEnv("CORS_ORIGINS", "http://localhost:3000"),
	}

	return cfg, nil
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
