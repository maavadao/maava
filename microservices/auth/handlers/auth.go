package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-contrib/sessions/cookie"
	"github.com/gin-gonic/gin"
	"github.com/mawadao/mawadao-agent/microservices/auth/config"
	"github.com/mawadao/mawadao-agent/microservices/auth/database"
	"github.com/mawadao/mawadao-agent/microservices/auth/middleware"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	microsoftEndpoint "golang.org/x/oauth2/microsoft"
)

type AuthHandler struct {
	config       *config.Config
	oauth2Conf   *oauth2.Config
	msOAuth2Conf *oauth2.Config
	store        cookie.Store
	db           *database.DB
	oidcSigner   *oidcSigner
}

type GoogleUserInfo struct {
	ID            string `json:"id"`
	Email         string `json:"email"`
	VerifiedEmail bool   `json:"verified_email"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
	GivenName     string `json:"given_name"`
	FamilyName    string `json:"family_name"`
	Locale        string `json:"locale"`
}

type MicrosoftUserInfo struct {
	ID                string `json:"id"`
	DisplayName       string `json:"displayName"`
	Mail              string `json:"mail"`
	UserPrincipalName string `json:"userPrincipalName"`
}

func NewAuthHandler(cfg *config.Config, db *database.DB) *AuthHandler {
	oauth2Conf := &oauth2.Config{
		ClientID:     cfg.GoogleClientID,
		ClientSecret: cfg.GoogleClientSecret,
		RedirectURL:  cfg.GoogleRedirectURL,
		Scopes: []string{
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
		},
		Endpoint: google.Endpoint,
	}

	tenantID := cfg.MicrosoftTenantID
	if tenantID == "" {
		tenantID = "common"
	}
	msOAuth2Conf := &oauth2.Config{
		ClientID:     cfg.MicrosoftClientID,
		ClientSecret: cfg.MicrosoftClientSecret,
		RedirectURL:  cfg.MicrosoftRedirectURL,
		Scopes:       []string{"openid", "email", "profile", "User.Read"},
		Endpoint:     microsoftEndpoint.AzureADEndpoint(tenantID),
	}

	store := cookie.NewStore([]byte(cfg.SessionSecret))
	store.Options(sessions.Options{
		Path:     "/",
		MaxAge:   3600 * 24 * 7, // 7 days
		HttpOnly: true,
		Secure:   cfg.Environment == "production",
		SameSite: http.SameSiteLaxMode,
	})

	return &AuthHandler{
		config:       cfg,
		oauth2Conf:   oauth2Conf,
		msOAuth2Conf: msOAuth2Conf,
		store:        store,
		db:           db,
		oidcSigner:   newOIDCSigner(cfg),
	}
}

// GetStore returns the session store for middleware setup
func (h *AuthHandler) GetStore() cookie.Store {
	return h.store
}

// Login initiates the Google OAuth flow
func (h *AuthHandler) Login(c *gin.Context) {
	// Generate state token for CSRF protection
	state := generateStateToken()

	// Save state in session
	session := sessions.Default(c)
	session.Set("oauth_state", state)
	if err := session.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save session"})
		return
	}

	// Redirect to Google OAuth consent page
	conf := *h.oauth2Conf
	conf.RedirectURL = h.resolveGoogleRedirectURL(c)
	authURL := conf.AuthCodeURL(state, oauth2.AccessTypeOffline)
	c.Redirect(http.StatusTemporaryRedirect, authURL)
}

// Callback handles the OAuth callback from Google — persists user to DB, issues JWT, and redirects.
func (h *AuthHandler) Callback(c *gin.Context) {
	// Verify state token
	session := sessions.Default(c)
	storedState := session.Get("oauth_state")
	if storedState == nil || storedState.(string) != c.Query("state") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid state parameter"})
		return
	}

	// Clear state from session
	session.Delete("oauth_state")
	_ = session.Save()

	// Exchange authorization code for token
	code := c.Query("code")
	if code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Authorization code not provided"})
		return
	}

	conf := *h.oauth2Conf
	conf.RedirectURL = h.resolveGoogleRedirectURL(c)
	token, err := conf.Exchange(context.Background(), code)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to exchange token: %v", err)})
		return
	}

	// Get user info from Google
	gUser, err := h.getUserInfo(token.AccessToken)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to get user info: %v", err)})
		return
	}

	// Persist to database
	user, created, err := h.db.FindOrCreateByGoogle(gUser.ID, gUser.Email, gUser.Name, gUser.Picture)
	if err != nil {
		log.Printf("Database error during callback: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save user"})
		return
	}
	if created {
		log.Printf("New user created: %s (%s)", user.Email, user.ID)
	}

	// Look up tenant/subdomain for this user (may be nil if not yet onboarded)
	var subdomain, tenantID string
	tenant, _ := h.db.FindTenantByUserID(user.ID)
	if tenant != nil {
		subdomain = tenant.Subdomain
		tenantID = tenant.TenantID
	}

	// Generate JWT with tenant claims
	jwt, err := middleware.GenerateJWTWithTenant(h.config.JWTSecret, user.ID, user.Email, subdomain, tenantID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate token"})
		return
	}
	if h.finishOIDCLogin(c, user.ID, user.Email, subdomain, tenantID) {
		return
	}

	// Redirect to frontend with token
	frontendBase := h.resolveFrontendURL(c)
	c.Redirect(http.StatusTemporaryRedirect, frontendBase+"/auth/callback?token="+jwt)
}

func isLocalHostName(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if strings.Contains(h, ":") {
		h = strings.Split(h, ":")[0]
	}
	return h == "localhost" || h == "127.0.0.1"
}

// allowedRedirectDomains restricts OAuth redirects to trusted origins only.
var allowedRedirectDomains = []string{
	"mawadao.com",
	"openclaw.ai",
}

// isAllowedRedirectDomain validates a URL targets an allowed domain (or localhost in dev).
func isAllowedRedirectDomain(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if isLocalHostName(host) {
		return true
	}
	for _, d := range allowedRedirectDomains {
		if host == d || strings.HasSuffix(host, "."+d) {
			return true
		}
	}
	return false
}

func baseURLFromRequest(c *gin.Context) string {
	proto := strings.TrimSpace(c.GetHeader("X-Forwarded-Proto"))
	if proto == "" {
		if c.Request.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	host := strings.TrimSpace(c.GetHeader("X-Forwarded-Host"))
	if host == "" {
		host = strings.TrimSpace(c.Request.Host)
	}
	return fmt.Sprintf("%s://%s", proto, host)
}

func (h *AuthHandler) resolveGoogleRedirectURL(c *gin.Context) string {
	raw := strings.TrimSpace(h.config.GoogleRedirectURL)
	if raw == "" {
		base := baseURLFromRequest(c)
		if !isAllowedRedirectDomain(base) {
			base = "https://auth.mawadao.com"
		}
		return base + "/auth/google/callback"
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		base := baseURLFromRequest(c)
		if !isAllowedRedirectDomain(base) {
			base = "https://auth.mawadao.com"
		}
		return base + "/auth/google/callback"
	}

	requestHost := strings.TrimSpace(c.GetHeader("X-Forwarded-Host"))
	if requestHost == "" {
		requestHost = c.Request.Host
	}
	if !isLocalHostName(requestHost) && isLocalHostName(parsed.Hostname()) {
		base := baseURLFromRequest(c)
		if !isAllowedRedirectDomain(base) {
			base = "https://auth.mawadao.com"
		}
		return base + "/auth/google/callback"
	}
	return raw
}

func (h *AuthHandler) resolveFrontendURL(c *gin.Context) string {
	raw := strings.TrimSpace(h.config.FrontendURL)
	if raw != "" {
		if parsed, err := url.Parse(raw); err == nil && parsed.Host != "" {
			requestHost := strings.TrimSpace(c.GetHeader("X-Forwarded-Host"))
			if requestHost == "" {
				requestHost = c.Request.Host
			}
			// Use the configured FRONTEND_URL unless we're in production (non-localhost request)
			// but the configured URL still points to localhost (stale dev config).
			if isLocalHostName(requestHost) || !isLocalHostName(parsed.Hostname()) {
				return strings.TrimRight(raw, "/")
			}
		}
	}

	base := baseURLFromRequest(c)
	if u, err := url.Parse(base); err == nil {
		host := u.Hostname()
		if strings.HasPrefix(strings.ToLower(host), "auth.") {
			host = strings.TrimPrefix(host, "auth.")
			if port := u.Port(); port != "" {
				u.Host = host + ":" + port
			} else {
				u.Host = host
			}
			base = strings.TrimRight(u.String(), "/")
		}
	}

	// Prevent open redirect: validate the computed URL against allowed domains
	if !isAllowedRedirectDomain(base) {
		log.Printf("WARNING: blocked redirect to untrusted domain: %s", base)
		if raw != "" {
			return strings.TrimRight(raw, "/")
		}
		return "https://mawadao.com"
	}

	return strings.TrimRight(base, "/")
}

// AuthMe returns the current user from a JWT Bearer token (used by frontend callback).
func (h *AuthHandler) AuthMe(c *gin.Context) {
	userID, _ := c.Get("userId")
	subdomain, _ := c.Get("subdomain")
	user, err := h.db.FindByID(userID.(string))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "User not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"data": gin.H{
			"id":          user.ID,
			"email":       user.Email,
			"username":    user.Username,
			"displayName": user.DisplayName,
			"avatarUrl":   user.AvatarURL,
			"isVerified":  user.IsVerified,
			"createdAt":   user.CreatedAt,
			"subdomain":   subdomain,
		},
	})
}

// GetMe returns the authenticated user's profile (JWT protected).
func (h *AuthHandler) GetMe(c *gin.Context) {
	userID, _ := c.Get("userId")
	user, err := h.db.FindByID(userID.(string))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "User not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"user": gin.H{
			"id":          user.ID,
			"email":       user.Email,
			"username":    user.Username,
			"displayName": user.DisplayName,
			"avatarUrl":   user.AvatarURL,
			"isVerified":  user.IsVerified,
			"createdAt":   user.CreatedAt,
		},
	})
}

// UpdateMe updates the authenticated user's profile.
func (h *AuthHandler) UpdateMe(c *gin.Context) {
	userID, _ := c.Get("userId")

	var body struct {
		Username    *string `json:"username"`
		DisplayName *string `json:"displayName"`
		AvatarURL   *string `json:"avatarUrl"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// If username is being set, check availability first
	if body.Username != nil {
		available, err := h.db.CheckUsername(*body.Username)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check username"})
			return
		}
		if !available {
			// Check if the user already owns this username
			existing, _ := h.db.FindByID(userID.(string))
			if existing == nil || existing.Username != *body.Username {
				c.JSON(http.StatusConflict, gin.H{"error": "Username already taken"})
				return
			}
		}
	}

	user, err := h.db.UpdateUser(userID.(string), body.Username, body.DisplayName, body.AvatarURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update profile"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"user": gin.H{
			"id":          user.ID,
			"email":       user.Email,
			"username":    user.Username,
			"displayName": user.DisplayName,
			"avatarUrl":   user.AvatarURL,
			"isVerified":  user.IsVerified,
			"createdAt":   user.CreatedAt,
		},
	})
}

// CheckUsername checks if a username is available.
func (h *AuthHandler) CheckUsername(c *gin.Context) {
	username := c.Query("username")
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username query parameter required"})
		return
	}

	available, err := h.db.CheckUsername(username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check username"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"available": available, "username": username})
}

// Profile returns the current user's profile from session (legacy).
func (h *AuthHandler) Profile(c *gin.Context) {
	session := sessions.Default(c)
	user := session.Get("user")

	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Not authenticated"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"user": user})
}

// Logout clears the session
func (h *AuthHandler) Logout(c *gin.Context) {
	session := sessions.Default(c)
	session.Clear()
	if err := session.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to clear session"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "Logged out successfully"})
}

// MicrosoftLogin initiates the Microsoft OAuth flow
func (h *AuthHandler) MicrosoftLogin(c *gin.Context) {
	state := generateStateToken()

	session := sessions.Default(c)
	session.Set("oauth_state", state)
	if err := session.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save session"})
		return
	}

	conf := *h.msOAuth2Conf
	conf.RedirectURL = h.resolveMicrosoftRedirectURL(c)
	authURL := conf.AuthCodeURL(state, oauth2.AccessTypeOffline)
	c.Redirect(http.StatusTemporaryRedirect, authURL)
}

// MicrosoftCallback handles the OAuth callback from Microsoft — persists user to DB, issues JWT, and redirects.
func (h *AuthHandler) MicrosoftCallback(c *gin.Context) {
	session := sessions.Default(c)
	storedState := session.Get("oauth_state")
	if storedState == nil || storedState.(string) != c.Query("state") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid state parameter"})
		return
	}

	session.Delete("oauth_state")
	_ = session.Save()

	code := c.Query("code")
	if code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Authorization code not provided"})
		return
	}

	conf := *h.msOAuth2Conf
	conf.RedirectURL = h.resolveMicrosoftRedirectURL(c)
	token, err := conf.Exchange(context.Background(), code)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to exchange token: %v", err)})
		return
	}

	msUser, err := h.getMicrosoftUserInfo(token.AccessToken)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to get user info: %v", err)})
		return
	}

	email := msUser.Mail
	if email == "" {
		email = msUser.UserPrincipalName
	}

	user, created, err := h.db.FindOrCreateByMicrosoft(msUser.ID, email, msUser.DisplayName, "")
	if err != nil {
		log.Printf("Database error during Microsoft callback: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save user"})
		return
	}
	if created {
		log.Printf("New user created via Microsoft: %s (%s)", email, user.ID)
	}

	var subdomain, tenantID string
	tenant, _ := h.db.FindTenantByUserID(user.ID)
	if tenant != nil {
		subdomain = tenant.Subdomain
		tenantID = tenant.TenantID
	}

	jwt, err := middleware.GenerateJWTWithTenant(h.config.JWTSecret, user.ID, email, subdomain, tenantID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate token"})
		return
	}
	if h.finishOIDCLogin(c, user.ID, email, subdomain, tenantID) {
		return
	}

	frontendBase := h.resolveFrontendURL(c)
	c.Redirect(http.StatusTemporaryRedirect, frontendBase+"/auth/callback?token="+jwt)
}

// getMicrosoftUserInfo fetches user info from the Microsoft Graph API
func (h *AuthHandler) getMicrosoftUserInfo(accessToken string) (*MicrosoftUserInfo, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("GET", "https://graph.microsoft.com/v1.0/me", nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to get Microsoft user info: %s", string(body))
	}

	var userInfo MicrosoftUserInfo
	if err := json.NewDecoder(resp.Body).Decode(&userInfo); err != nil {
		return nil, err
	}

	return &userInfo, nil
}

func (h *AuthHandler) resolveMicrosoftRedirectURL(c *gin.Context) string {
	raw := strings.TrimSpace(h.config.MicrosoftRedirectURL)
	if raw == "" {
		base := baseURLFromRequest(c)
		if !isAllowedRedirectDomain(base) {
			base = "https://auth.mawadao.com"
		}
		return base + "/auth/microsoft/callback"
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		base := baseURLFromRequest(c)
		if !isAllowedRedirectDomain(base) {
			base = "https://auth.mawadao.com"
		}
		return base + "/auth/microsoft/callback"
	}

	requestHost := strings.TrimSpace(c.GetHeader("X-Forwarded-Host"))
	if requestHost == "" {
		requestHost = c.Request.Host
	}
	if !isLocalHostName(requestHost) && isLocalHostName(parsed.Hostname()) {
		base := baseURLFromRequest(c)
		if !isAllowedRedirectDomain(base) {
			base = "https://auth.mawadao.com"
		}
		return base + "/auth/microsoft/callback"
	}
	return raw
}

// getUserInfo fetches user information from Google API
func (h *AuthHandler) getUserInfo(accessToken string) (*GoogleUserInfo, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("GET", "https://www.googleapis.com/oauth2/v2/userinfo", nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to get user info: %s", string(body))
	}

	var userInfo GoogleUserInfo
	if err := json.NewDecoder(resp.Body).Decode(&userInfo); err != nil {
		return nil, err
	}

	return &userInfo, nil
}

// generateStateToken generates a cryptographically random state token for CSRF protection
func generateStateToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// Fallback should never happen with crypto/rand, but log if it does
		log.Printf("WARN: crypto/rand failed, using time-based fallback: %v", err)
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
