package main

import (
	"context"
	"crypto/subtle"
	"log"
	"net/http"
	"strings"

	"cloud.google.com/go/storage"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"

	"github.com/mawadao/mawadao-agent/microservices/storage/config"
	"github.com/mawadao/mawadao-agent/microservices/storage/handlers"
)

// requireAPISecret returns a middleware that enforces X-Storage-Secret.
// In development (no secret configured) all requests are allowed through.
func requireAPISecret(cfg *config.Config) gin.HandlerFunc {
	return func(c *gin.Context) {
		if cfg.APISecret == "" {
			if cfg.Environment == "production" {
				c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
					"error": "mawadao-agent-storage API secret not configured",
				})
				return
			}
			c.Next()
			return
		}
		provided := c.GetHeader("X-Storage-Secret")
		if subtle.ConstantTimeCompare([]byte(provided), []byte(cfg.APISecret)) != 1 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid mawadao-agent-storage API credentials"})
			return
		}
		c.Next()
	}
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	// GCS client for list/upload/delete (optional: service runs without it; list returns 503).
	ctx := context.Background()
	gcsClient, err := storage.NewClient(ctx)
	if err != nil {
		log.Printf("WARN: GCS client not available (set GOOGLE_APPLICATION_CREDENTIALS or gcloud auth): %v", err)
		gcsClient = nil
	} else {
		defer gcsClient.Close()
		log.Println("GCS client connected")
	}

	if cfg.Environment == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	r := gin.Default()

	origins := strings.Split(cfg.CORSOrigins, ",")
	r.Use(cors.New(cors.Config{
		AllowOrigins:     origins,
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Authorization"},
		ExposeHeaders:    []string{"Content-Length"},
		AllowCredentials: true,
	}))

	// Health + root endpoints
	r.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"service": "mawadao-agent-storage",
			"status":  "ok",
		})
	})

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"ok":             true,
			"environment":    cfg.Environment,
			"defaultBucket":  cfg.DefaultBucket,
			"gcs_configured": gcsClient != nil,
		})
	})

	// Bucket, folder, and file routes (no auth yet — can be wrapped with middleware later).
	bucketHandler := handlers.NewBucketHandler(cfg, gcsClient)
	api := r.Group("/api/v1")
	{
		api.GET("/buckets", bucketHandler.ListBuckets)
		api.GET("/buckets/:bucket", bucketHandler.GetBucket)

		// Folders (read is open; write requires API secret)
		api.GET("/buckets/:bucket/folders", bucketHandler.ListFolder)
		api.POST("/buckets/:bucket/folders", requireAPISecret(cfg), bucketHandler.CreateFolder)

		// Folders (delete requires API secret)
		api.DELETE("/buckets/:bucket/folders/*path", requireAPISecret(cfg), bucketHandler.DeleteFolder)

		// Files (read is open; write/delete require API secret)
		api.GET("/buckets/:bucket/files/*path", bucketHandler.GetFile)
		api.POST("/buckets/:bucket/files", requireAPISecret(cfg), bucketHandler.UploadFile)
		api.PUT("/buckets/:bucket/files/*path", requireAPISecret(cfg), bucketHandler.ModifyFile)
		api.DELETE("/buckets/:bucket/files/*path", requireAPISecret(cfg), bucketHandler.DeleteFile)
	}

	addr := ":" + cfg.Port
	log.Printf("mawadao-agent-storage listening on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatalf("failed to start mawadao-agent-storage: %v", err)
	}
}
