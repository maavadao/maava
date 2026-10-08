package handlers

import (
	"io"
	"log"
	"net/http"
	"path"
	"strings"

	gcs "cloud.google.com/go/storage"
	"github.com/gin-gonic/gin"

	"github.com/mawadao/mawa/microservices/storage/config"
	"github.com/mawadao/mawa/microservices/storage/storage"
)

// BucketHandler defines HTTP handlers for bucket, folder, and file operations.
type BucketHandler struct {
	cfg    *config.Config
	client *gcs.Client
}

// NewBucketHandler constructs a new BucketHandler instance.
func NewBucketHandler(cfg *config.Config, client *gcs.Client) *BucketHandler {
	return &BucketHandler{cfg: cfg, client: client}
}

// ListBuckets returns a list of buckets visible to this service / tenant.
func (h *BucketHandler) ListBuckets(c *gin.Context) {
	buckets := []gin.H{}
	if h.cfg.DefaultBucket != "" {
		buckets = append(buckets, gin.H{
			"name":       h.cfg.DefaultBucket,
			"is_default": true,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"service": "mawa-storage",
		"buckets": buckets,
	})
}

// GetBucket returns metadata for a single bucket.
func (h *BucketHandler) GetBucket(c *gin.Context) {
	bucket := c.Param("bucket")
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bucket name is required"})
		return
	}

	isDefault := h.cfg.DefaultBucket != "" && bucket == h.cfg.DefaultBucket

	c.JSON(http.StatusOK, gin.H{
		"name":       bucket,
		"is_default": isDefault,
	})
}

// CreateFolderRequest is the JSON body for creating a folder.
type CreateFolderRequest struct {
	Path string `json:"path" binding:"required"`
}

// CreateFolder creates a folder in GCS by writing a placeholder object so it appears in the console.
func (h *BucketHandler) CreateFolder(c *gin.Context) {
	bucket := c.Param("bucket")
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bucket name is required"})
		return
	}

	var req CreateFolderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is required", "details": err.Error()})
		return
	}

	cleanPath := path.Clean("/" + strings.Trim(req.Path, "/"))
	if cleanPath == "/" {
		cleanPath = ""
	} else {
		cleanPath = strings.TrimPrefix(cleanPath, "/")
	}

	if h.client == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "storage client not configured"})
		return
	}

	ctx := c.Request.Context()
	if err := storage.CreateFolder(ctx, h.client, bucket, cleanPath); err != nil {
		log.Printf("[CreateFolder] bucket=%s path=%s err=%v", bucket, cleanPath, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create folder", "details": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"bucket":  bucket,
		"path":    cleanPath,
		"message": "folder created",
	})
}

// ListFolder lists contents (subfolders and files) under the given path from GCS.
func (h *BucketHandler) ListFolder(c *gin.Context) {
	bucket := c.Param("bucket")
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bucket name is required"})
		return
	}

	folderPath := strings.Trim(c.Query("path"), "/")
	if folderPath != "" {
		folderPath = strings.Trim(path.Clean("/"+folderPath), "/")
	}

	if h.client == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "storage client not configured"})
		return
	}

	ctx := c.Request.Context()
	result, err := storage.ListFolder(ctx, h.client, bucket, folderPath)
	if err != nil {
		log.Printf("[ListFolder] bucket=%s path=%s err=%v", bucket, folderPath, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list folder", "details": err.Error()})
		return
	}

	filesJSON := make([]gin.H, 0, len(result.Files))
	for _, f := range result.Files {
		filesJSON = append(filesJSON, gin.H{"name": f.Name, "size": f.Size})
	}

	c.JSON(http.StatusOK, gin.H{
		"bucket":  bucket,
		"path":    folderPath,
		"folders": result.Folders,
		"files":   filesJSON,
	})
}

// UploadFile handles multipart file upload. Form fields: "path" (object key), "file" (the file). Stub: returns success; wire to storage later.
func (h *BucketHandler) UploadFile(c *gin.Context) {
	bucket := c.Param("bucket")
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bucket name is required"})
		return
	}

	objectPath := strings.Trim(c.PostForm("path"), "/")
	if objectPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path form field is required"})
		return
	}
	objectPath = strings.Trim(path.Clean("/"+objectPath), "/")

	file, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file is required", "details": err.Error()})
		return
	}

	// TODO: open file and upload to storage (e.g. GCS/S3)
	_ = file

	c.JSON(http.StatusCreated, gin.H{
		"bucket":  bucket,
		"path":    objectPath,
		"name":    file.Filename,
		"size":    file.Size,
		"message": "file uploaded",
	})
}

// GetFile reads a single file and returns its contents with the original content-type.
func (h *BucketHandler) GetFile(c *gin.Context) {
	bucket := c.Param("bucket")
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bucket name is required"})
		return
	}

	objectPath := c.Param("path")
	objectPath = strings.TrimPrefix(objectPath, "/")
	objectPath = strings.Trim(path.Clean("/"+objectPath), "/")
	if objectPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file path is required"})
		return
	}

	if h.client == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "storage client not configured"})
		return
	}

	ctx := c.Request.Context()
	data, contentType, err := storage.ReadFile(ctx, h.client, bucket, objectPath)
	if err != nil {
		if err == gcs.ErrObjectNotExist {
			c.JSON(http.StatusNotFound, gin.H{"error": "file not found"})
			return
		}
		log.Printf("[GetFile] bucket=%s path=%s err=%v", bucket, objectPath, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read file", "details": err.Error()})
		return
	}

	c.Data(http.StatusOK, contentType, data)
}

// ModifyFile updates an existing file (full replace by default). Body = new content; path from URL.
func (h *BucketHandler) ModifyFile(c *gin.Context) {
	bucket := c.Param("bucket")
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bucket name is required"})
		return
	}

	objectPath := c.Param("path")
	objectPath = strings.TrimPrefix(objectPath, "/")
	objectPath = strings.Trim(path.Clean("/"+objectPath), "/")
	if objectPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file path is required"})
		return
	}

	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read body", "details": err.Error()})
		return
	}

	if h.client == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "storage client not configured"})
		return
	}

	contentType := c.GetHeader("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	ctx := c.Request.Context()
	if err := storage.WriteFile(ctx, h.client, bucket, objectPath, body, contentType); err != nil {
		log.Printf("[ModifyFile] bucket=%s path=%s err=%v", bucket, objectPath, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file", "details": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"bucket":  bucket,
		"path":    objectPath,
		"size":    len(body),
		"message": "file modified",
	})
}

// DeleteFile deletes a single file at the given path.
func (h *BucketHandler) DeleteFile(c *gin.Context) {
	bucket := c.Param("bucket")
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bucket name is required"})
		return
	}

	objectPath := c.Param("path")
	objectPath = strings.TrimPrefix(objectPath, "/")
	objectPath = strings.Trim(path.Clean("/"+objectPath), "/")
	if objectPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file path is required"})
		return
	}

	if h.client == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "GCS client not configured"})
		return
	}

	if err := storage.DeleteObject(c.Request.Context(), h.client, bucket, objectPath); err != nil {
		log.Printf("[mawa-storage] DeleteFile %s/%s error: %v", bucket, objectPath, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete file", "details": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"bucket":  bucket,
		"path":    objectPath,
		"message": "file deleted",
	})
}

// DeleteFolder deletes all objects under a given folder prefix (recursive).
// This is used to clean up a tenant's entire folder on account deletion.
func (h *BucketHandler) DeleteFolder(c *gin.Context) {
	bucket := c.Param("bucket")
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bucket name is required"})
		return
	}

	folderPath := c.Param("path")
	folderPath = strings.TrimPrefix(folderPath, "/")
	folderPath = strings.Trim(path.Clean("/"+folderPath), "/")
	if folderPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "folder path is required"})
		return
	}

	if h.client == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "GCS client not configured"})
		return
	}

	if err := storage.DeleteAllByPrefix(c.Request.Context(), h.client, bucket, folderPath); err != nil {
		log.Printf("[mawa-storage] DeleteFolder %s/%s error: %v", bucket, folderPath, err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete folder", "details": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"bucket":  bucket,
		"path":    folderPath,
		"message": "folder deleted",
	})
}
