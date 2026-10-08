package main

import (
	"log"
	"net/http"
	"strings"

	"github.com/gin-contrib/cors"
	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
	"github.com/mawadao/mawa/microservices/auth/config"
	"github.com/mawadao/mawa/microservices/auth/database"
	"github.com/mawadao/mawa/microservices/auth/handlers"
	"github.com/mawadao/mawa/microservices/auth/middleware"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	oauthConfigured := cfg.GoogleClientID != "" && cfg.GoogleClientSecret != ""
	if !oauthConfigured {
		log.Println("WARN: Google OAuth not fully configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing). Google OAuth routes will return 503.")
	}

	msOauthConfigured := cfg.MicrosoftClientID != "" && cfg.MicrosoftClientSecret != ""
	if !msOauthConfigured {
		log.Println("WARN: Microsoft OAuth not configured (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET missing). Microsoft OAuth routes will return 503.")
	}

	var db *database.DB
	var dbError string
	if cfg.DatabaseURL == "" {
		dbError = "DATABASE_URL environment variable is not set"
		log.Println("WARN: DATABASE_URL is empty. Auth routes requiring DB will return 503.")
	} else {
		db, err = database.New(cfg.DatabaseURL)
		if err != nil {
			dbError = err.Error()
			log.Printf("ERROR: Failed to connect to database: %v", err)
			log.Println("WARN: Service will start in degraded mode; DB-backed routes return 503.")
		} else {
			defer db.Close()
			log.Println("Connected to PostgreSQL")
		}
	}

	if cfg.Environment == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.Default()
	origins := strings.Split(cfg.CORSOrigins, ",")
	r.Use(cors.New(cors.Config{
		AllowOrigins:     origins,
		AllowMethods:     []string{"GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	}))

	r.GET("/", func(c *gin.Context) {
		dbConnected := db != nil
		status := "ok"
		if !dbConnected || (!oauthConfigured && !msOauthConfigured) {
			status = "degraded"
		}
		c.JSON(http.StatusOK, gin.H{
			"service":           "mawaDao Auth",
			"status":            status,
			"dbConnected":       dbConnected,
			"oauthConfigured":   oauthConfigured,
			"msOauthConfigured": msOauthConfigured,
		})
	})

	r.GET("/health", func(c *gin.Context) {
		dbURLSet := cfg.DatabaseURL != ""
		dbConnected := db != nil
		resp := gin.H{
			"db_url_set":   dbURLSet,
			"db_connected": dbConnected,
		}
		if dbError != "" {
			resp["db_error"] = dbError
		}
		if dbConnected {
			c.JSON(http.StatusOK, resp)
		} else {
			c.JSON(http.StatusServiceUnavailable, resp)
		}
	})

	if db == nil {
		r.GET("/auth/google", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Auth service DB unavailable (check DATABASE_URL)"})
		})
		r.GET("/auth/google/callback", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Auth service DB unavailable (check DATABASE_URL)"})
		})
		r.GET("/auth/microsoft", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Auth service DB unavailable (check DATABASE_URL)"})
		})
		r.GET("/auth/microsoft/callback", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Auth service DB unavailable (check DATABASE_URL)"})
		})
		r.GET("/auth/logout", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Auth service DB unavailable (check DATABASE_URL)"})
		})
		r.GET("/auth/profile", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Auth service DB unavailable (check DATABASE_URL)"})
		})

		addr := ":" + cfg.Port
		log.Printf("mawaDao Auth server starting on %s (degraded: no DB)", addr)
		if err := r.Run(addr); err != nil {
			log.Fatalf("Failed to start server: %v", err)
		}
		return
	}

	authHandler := handlers.NewAuthHandler(cfg, db)
	r.Use(sessions.Sessions("googleauth_session", authHandler.GetStore()))
	r.GET("/.well-known/openid-configuration", authHandler.OIDCDiscovery)
	r.GET("/oauth2/jwks", authHandler.OIDCJWKS)
	r.GET("/oauth2/authorize", authHandler.OIDCAuthorize)
	r.POST("/oauth2/token", authHandler.OIDCToken)

	if oauthConfigured {
		r.GET("/auth/google", authHandler.Login)
		r.GET("/auth/google/callback", authHandler.Callback)
	} else {
		r.GET("/auth/google", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "OAuth is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)"})
		})
		r.GET("/auth/google/callback", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "OAuth is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)"})
		})
	}
	if msOauthConfigured {
		r.GET("/auth/microsoft", authHandler.MicrosoftLogin)
		r.GET("/auth/microsoft/callback", authHandler.MicrosoftCallback)
	} else {
		r.GET("/auth/microsoft", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Microsoft OAuth is not configured (set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET)"})
		})
		r.GET("/auth/microsoft/callback", func(c *gin.Context) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Microsoft OAuth is not configured (set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET)"})
		})
	}
	r.GET("/auth/logout", authHandler.Logout)

	protected := r.Group("/")
	protected.Use(middleware.JWTAuth(cfg.JWTSecret))
	{
		protected.GET("/auth/me", authHandler.AuthMe)
		protected.GET("/api/v1/auth/me", authHandler.AuthMe)
		protected.GET("/oauth2/userinfo", authHandler.AuthMe)
		protected.GET("/users/me", authHandler.GetMe)
		protected.PATCH("/users/me", authHandler.UpdateMe)
		protected.GET("/users/check-username", authHandler.CheckUsername)
	}

	r.GET("/auth/profile", authHandler.Profile)

	addr := ":" + cfg.Port
	log.Printf("mawaDao Auth server starting on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
