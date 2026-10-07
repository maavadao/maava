package storage

import (
	"context"
	"fmt"
	"io"
	"strings"

	gcs "cloud.google.com/go/storage"
	"google.golang.org/api/iterator"
)

// CreateFolder creates a folder in the bucket by writing a placeholder object.
// GCS has no real folders; writing an object named "path/" makes the folder appear in the console.
func CreateFolder(ctx context.Context, client *gcs.Client, bucketName, folderPath string) error {
	if folderPath == "" {
		return nil // root always "exists"
	}
	prefix := strings.TrimSuffix(strings.Trim(folderPath, "/"), "/")
	if prefix == "" {
		return nil
	}
	objectName := prefix + "/"
	w := client.Bucket(bucketName).Object(objectName).NewWriter(ctx)
	w.ContentType = "application/x-www-form-urlencoded"
	// Empty body; the object key alone makes the folder appear.
	_, err := w.Write(nil)
	if err != nil {
		_ = w.Close()
		return err
	}
	return w.Close()
}

// ListFolderResult holds folders and files under a prefix.
type ListFolderResult struct {
	Folders []string
	Files   []FileInfo
}

// FileInfo is minimal file metadata for list response.
type FileInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// ListFolder lists direct children of the given path in the bucket.
// folderPath is the prefix (e.g. "agents" or "agents/main"); empty means root.
// Uses GCS list with prefix folderPath/ and derives unique subfolder names and file names.
func ListFolder(ctx context.Context, client *gcs.Client, bucketName, folderPath string) (*ListFolderResult, error) {
	prefix := folderPath
	if prefix != "" {
		prefix = strings.TrimSuffix(prefix, "/") + "/"
	}

	bucket := client.Bucket(bucketName)
	it := bucket.Objects(ctx, &gcs.Query{Prefix: prefix})

	out := &ListFolderResult{
		Folders: []string{},
		Files:   []FileInfo{},
	}

	// Prefixes (common prefixes) are the "folders" at this level when using Delimiter.
	for {
		attrs, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}
		// Object name relative to prefix (without the prefix part).
		rel := attrs.Name
		if prefix != "" {
			rel = strings.TrimPrefix(attrs.Name, prefix)
		}
		if rel == "" {
			continue
		}
		if strings.Contains(rel, "/") {
			// Subfolder: first segment only (we want direct children).
			parts := strings.SplitN(rel, "/", 2)
			folderName := parts[0]
			if !contains(out.Folders, folderName) {
				out.Folders = append(out.Folders, folderName)
			}
		} else {
			out.Files = append(out.Files, FileInfo{Name: rel, Size: attrs.Size})
		}
	}

	return out, nil
}

func contains(s []string, x string) bool {
	for _, v := range s {
		if v == x {
			return true
		}
	}
	return false
}

// DeleteObject deletes a single GCS object. Returns nil if the object does not exist.
func DeleteObject(ctx context.Context, client *gcs.Client, bucketName, objectPath string) error {
	if objectPath == "" {
		return fmt.Errorf("object path is required")
	}
	err := client.Bucket(bucketName).Object(objectPath).Delete(ctx)
	if err == gcs.ErrObjectNotExist {
		return nil // idempotent
	}
	return err
}

// DeleteAllByPrefix deletes every GCS object whose name starts with prefix.
// A trailing slash is appended if prefix does not already end with one, so that
// e.g. "abc123" does not accidentally match "abc123-other"/.
func DeleteAllByPrefix(ctx context.Context, client *gcs.Client, bucketName, prefix string) error {
	if prefix == "" {
		return fmt.Errorf("prefix must not be empty (refusing to delete entire bucket)")
	}
	// Normalise: ensure prefix ends with '/' so we only delete within the folder.
	normed := strings.TrimSuffix(prefix, "/") + "/"

	bkt := client.Bucket(bucketName)
	it := bkt.Objects(ctx, &gcs.Query{Prefix: normed})
	for {
		attrs, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return fmt.Errorf("listing objects with prefix %q: %w", normed, err)
		}
		if delErr := bkt.Object(attrs.Name).Delete(ctx); delErr != nil && delErr != gcs.ErrObjectNotExist {
			return fmt.Errorf("deleting %q: %w", attrs.Name, delErr)
		}
	}
	// Also delete the folder placeholder itself (e.g. "abc123/").
	_ = bkt.Object(normed).Delete(ctx) // best-effort, ignore NotExist
	return nil
}

// WriteFile writes content to a GCS object at the given path.
// contentType is applied to the object metadata; defaults to "application/octet-stream" when empty.
func WriteFile(ctx context.Context, client *gcs.Client, bucketName, objectPath string, content []byte, contentType string) error {
	if objectPath == "" {
		return fmt.Errorf("object path is required")
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w := client.Bucket(bucketName).Object(objectPath).NewWriter(ctx)
	w.ContentType = contentType
	if _, err := w.Write(content); err != nil {
		_ = w.Close()
		return err
	}
	return w.Close()
}

// ReadFile reads the content of a GCS object. Returns the content bytes and content-type.
func ReadFile(ctx context.Context, client *gcs.Client, bucketName, objectPath string) ([]byte, string, error) {
	if objectPath == "" {
		return nil, "", fmt.Errorf("object path is required")
	}
	obj := client.Bucket(bucketName).Object(objectPath)
	attrs, err := obj.Attrs(ctx)
	if err != nil {
		return nil, "", err
	}
	r, err := obj.NewReader(ctx)
	if err != nil {
		return nil, "", err
	}
	defer r.Close()
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, "", err
	}
	return data, attrs.ContentType, nil
}
