package handlers

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-contrib/sessions"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/maavadao/maava/microservices/auth/config"
	"github.com/maavadao/maava/microservices/auth/middleware"
)

type oidcSigner struct {
	privateKey *rsa.PrivateKey
	keyID      string
}

type oidcAuthCodeClaims struct {
	UserID              string `json:"userId"`
	Email               string `json:"email"`
	Subdomain           string `json:"subdomain,omitempty"`
	TenantID            string `json:"tenantId,omitempty"`
	ClientID            string `json:"client_id"`
	RedirectURI         string `json:"redirect_uri"`
	CodeChallenge       string `json:"code_challenge"`
	CodeChallengeMethod string `json:"code_challenge_method"`
	Nonce               string `json:"nonce,omitempty"`
	Scope               string `json:"scope,omitempty"`
	jwt.RegisteredClaims
}

func newOIDCSigner(cfg *config.Config) *oidcSigner {
	key := parseOIDCPrivateKey(cfg.OIDCPrivateKeyPEM)
	if key == nil {
		generated, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic(fmt.Sprintf("failed to generate OIDC RSA key: %v", err))
		}
		key = generated
		log.Printf("WARN: OIDC_PRIVATE_KEY_PEM is not set; generated an ephemeral OIDC signing key")
	}

	kid := strings.TrimSpace(cfg.OIDCKeyID)
	if kid == "" {
		pubDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
		if err == nil {
			sum := sha256.Sum256(pubDER)
			kid = base64.RawURLEncoding.EncodeToString(sum[:6])
		}
	}
	if kid == "" {
		kid = "maavadao-oidc"
	}

	return &oidcSigner{privateKey: key, keyID: kid}
}

func parseOIDCPrivateKey(raw string) *rsa.PrivateKey {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		return nil
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key
	}
	if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if key, ok := parsed.(*rsa.PrivateKey); ok {
			return key
		}
	}
	return nil
}

func base64URLEncode(input []byte) string {
	return base64.RawURLEncoding.EncodeToString(input)
}

func (s *oidcSigner) jwks() gin.H {
	pub := s.privateKey.PublicKey
	e := big.NewInt(int64(pub.E)).Bytes()
	return gin.H{
		"keys": []gin.H{{
			"kty": "RSA",
			"use": "sig",
			"alg": "RS256",
			"kid": s.keyID,
			"n":   base64URLEncode(pub.N.Bytes()),
			"e":   base64URLEncode(e),
		}},
	}
}

func (s *oidcSigner) createIDToken(issuer, clientID string, claims *middleware.Claims, nonce string) (string, error) {
	now := time.Now()
	idClaims := jwt.MapClaims{
		"iss":   issuer,
		"aud":   clientID,
		"sub":   claims.UserID,
		"exp":   now.Add(7 * 24 * time.Hour).Unix(),
		"iat":   now.Unix(),
		"email": claims.Email,
	}
	if claims.Subdomain != "" {
		idClaims["subdomain"] = claims.Subdomain
	}
	if claims.TenantID != "" {
		idClaims["tenantId"] = claims.TenantID
	}
	if nonce != "" {
		idClaims["nonce"] = nonce
	}

	token := jwt.NewWithClaims(jwt.SigningMethodRS256, idClaims)
	token.Header["kid"] = s.keyID
	return token.SignedString(s.privateKey)
}

func createOIDCAuthCode(secret, issuer string, claims oidcAuthCodeClaims) (string, error) {
	claims.RegisteredClaims = jwt.RegisteredClaims{
		Issuer:    issuer,
		Subject:   claims.UserID,
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(2 * time.Minute)),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

func parseOIDCAuthCode(secret, tokenStr string) (*oidcAuthCodeClaims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &oidcAuthCodeClaims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*oidcAuthCodeClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid authorization code")
	}
	return claims, nil
}

func verifyPKCE(verifier, challenge string) bool {
	sum := sha256.Sum256([]byte(verifier))
	return base64URLEncode(sum[:]) == challenge
}

func (h *AuthHandler) resolveOIDCIssuer(c *gin.Context) string {
	raw := strings.TrimSpace(h.config.OIDCIssuer)
	if raw != "" {
		return strings.TrimRight(raw, "/")
	}
	base := baseURLFromRequest(c)
	if !isAllowedRedirectDomain(base) {
		return "https://auth.maavadao.com"
	}
	return strings.TrimRight(base, "/")
}

func (h *AuthHandler) OIDCDiscovery(c *gin.Context) {
	issuer := h.resolveOIDCIssuer(c)
	c.JSON(http.StatusOK, gin.H{
		"issuer":                                issuer,
		"authorization_endpoint":                issuer + "/oauth2/authorize",
		"token_endpoint":                        issuer + "/oauth2/token",
		"userinfo_endpoint":                     issuer + "/oauth2/userinfo",
		"jwks_uri":                              issuer + "/oauth2/jwks",
		"response_types_supported":              []string{"code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"code_challenge_methods_supported":      []string{"S256"},
		"scopes_supported":                      []string{"openid", "email", "profile"},
		"token_endpoint_auth_methods_supported": []string{"none"},
	})
}

func (h *AuthHandler) OIDCJWKS(c *gin.Context) {
	c.JSON(http.StatusOK, h.oidcSigner.jwks())
}

func (h *AuthHandler) OIDCAuthorize(c *gin.Context) {
	provider := strings.TrimSpace(c.Query("provider"))
	clientID := strings.TrimSpace(c.Query("client_id"))
	redirectURI := strings.TrimSpace(c.Query("redirect_uri"))
	responseType := strings.TrimSpace(c.Query("response_type"))
	state := strings.TrimSpace(c.Query("state"))
	challenge := strings.TrimSpace(c.Query("code_challenge"))
	challengeMethod := strings.TrimSpace(c.Query("code_challenge_method"))
	scope := strings.TrimSpace(c.DefaultQuery("scope", "openid email profile"))
	nonce := strings.TrimSpace(c.Query("nonce"))

	if provider != "google" && provider != "microsoft" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported provider"})
		return
	}
	if clientID == "" || clientID != h.config.OIDCClientID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid client_id"})
		return
	}
	if responseType != "code" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported response_type"})
		return
	}
	if state == "" || redirectURI == "" || challenge == "" || challengeMethod != "S256" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing required OIDC parameters"})
		return
	}
	if !strings.Contains(" "+scope+" ", " openid ") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "scope must include openid"})
		return
	}
	if !isAllowedRedirectDomain(redirectURI) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid redirect_uri"})
		return
	}

	session := sessions.Default(c)
	session.Set("oidc_state", state)
	session.Set("oidc_client_id", clientID)
	session.Set("oidc_redirect_uri", redirectURI)
	session.Set("oidc_code_challenge", challenge)
	session.Set("oidc_code_challenge_method", challengeMethod)
	session.Set("oidc_scope", scope)
	session.Set("oidc_nonce", nonce)
	if err := session.Save(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save OIDC session"})
		return
	}

	if provider == "google" {
		h.Login(c)
		return
	}
	h.MicrosoftLogin(c)
}

func (h *AuthHandler) OIDCToken(c *gin.Context) {
	grantType := strings.TrimSpace(c.PostForm("grant_type"))
	code := strings.TrimSpace(c.PostForm("code"))
	clientID := strings.TrimSpace(c.PostForm("client_id"))
	redirectURI := strings.TrimSpace(c.PostForm("redirect_uri"))
	verifier := strings.TrimSpace(c.PostForm("code_verifier"))

	if grantType != "authorization_code" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unsupported_grant_type"})
		return
	}
	if clientID == "" || clientID != h.config.OIDCClientID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_client"})
		return
	}
	if code == "" || redirectURI == "" || verifier == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid_request"})
		return
	}

	claims, err := parseOIDCAuthCode(h.config.JWTSecret, code)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid_grant"})
		return
	}
	if claims.ClientID != clientID || claims.RedirectURI != redirectURI {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid_grant"})
		return
	}
	if claims.CodeChallengeMethod != "S256" || !verifyPKCE(verifier, claims.CodeChallenge) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid_grant"})
		return
	}

	accessToken, err := middleware.GenerateJWTWithTenant(h.config.JWTSecret, claims.UserID, claims.Email, claims.Subdomain, claims.TenantID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "server_error"})
		return
	}
	idToken, err := h.oidcSigner.createIDToken(h.resolveOIDCIssuer(c), clientID, &middleware.Claims{
		UserID:    claims.UserID,
		Email:     claims.Email,
		Subdomain: claims.Subdomain,
		TenantID:  claims.TenantID,
	}, claims.Nonce)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "server_error"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"access_token": accessToken,
		"id_token":     idToken,
		"token_type":   "Bearer",
		"expires_in":   604800,
		"scope":        claims.Scope,
	})
}

func (h *AuthHandler) finishOIDCLogin(c *gin.Context, userID, email, subdomain, tenantID string) bool {
	session := sessions.Default(c)
	state, okState := session.Get("oidc_state").(string)
	clientID, okClient := session.Get("oidc_client_id").(string)
	redirectURI, okRedirect := session.Get("oidc_redirect_uri").(string)
	challenge, okChallenge := session.Get("oidc_code_challenge").(string)
	challengeMethod, okMethod := session.Get("oidc_code_challenge_method").(string)
	nonce, _ := session.Get("oidc_nonce").(string)
	scope, _ := session.Get("oidc_scope").(string)
	if !okState || !okClient || !okRedirect || !okChallenge || !okMethod {
		return false
	}

	deleteKeys := []string{
		"oidc_state",
		"oidc_client_id",
		"oidc_redirect_uri",
		"oidc_code_challenge",
		"oidc_code_challenge_method",
		"oidc_nonce",
		"oidc_scope",
	}
	for _, key := range deleteKeys {
		session.Delete(key)
	}
	_ = session.Save()

	issuer := h.resolveOIDCIssuer(c)
	authCode, err := createOIDCAuthCode(h.config.JWTSecret, issuer, oidcAuthCodeClaims{
		UserID:              userID,
		Email:               email,
		Subdomain:           subdomain,
		TenantID:            tenantID,
		ClientID:            clientID,
		RedirectURI:         redirectURI,
		CodeChallenge:       challenge,
		CodeChallengeMethod: challengeMethod,
		Nonce:               nonce,
		Scope:               scope,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create authorization code"})
		return true
	}

	redirectTarget, err := url.Parse(redirectURI)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid redirect URI"})
		return true
	}
	query := redirectTarget.Query()
	query.Set("code", authCode)
	query.Set("state", state)
	redirectTarget.RawQuery = query.Encode()
	c.Redirect(http.StatusTemporaryRedirect, redirectTarget.String())
	return true
}

func init() {
	_ = json.Valid
}
