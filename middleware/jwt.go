package middleware

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID    string `json:"userId"`
	Email     string `json:"email"`
	Subdomain string `json:"subdomain,omitempty"`
	TenantID  string `json:"tenantId,omitempty"`
	jwt.RegisteredClaims
}

// GenerateJWT creates a signed JWT for the given user ID and email.
func GenerateJWT(secret, userID, email string) (string, error) {
	return GenerateJWTWithTenant(secret, userID, email, "", "")
}

const jwtIssuer = "barrsa-auth"

// GenerateJWTWithTenant creates a JWT that includes tenant/subdomain claims.
func GenerateJWTWithTenant(secret, userID, email, subdomain, tenantID string) (string, error) {
	claims := Claims{
		UserID:    userID,
		Email:     email,
		Subdomain: subdomain,
		TenantID:  tenantID,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(7 * 24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Subject:   userID,
			Issuer:    jwtIssuer,
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

// ParseJWT validates and parses a JWT token string.
func ParseJWT(secret, tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	if claims, ok := token.Claims.(*Claims); ok && token.Valid {
		return claims, nil
	}
	return nil, jwt.ErrTokenNotValidYet
}

// JWTAuth is Gin middleware that extracts and validates the Bearer token.
// On success it sets "userId" and "email" in the context.
func JWTAuth(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.GetHeader("Authorization")
		if auth == "" || !strings.HasPrefix(auth, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing or invalid authorization header"})
			return
		}
		tokenStr := strings.TrimPrefix(auth, "Bearer ")
		claims, err := ParseJWT(secret, tokenStr)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}
		c.Set("userId", claims.UserID)
		c.Set("email", claims.Email)
		c.Set("subdomain", claims.Subdomain)
		c.Set("tenantId", claims.TenantID)
		c.Next()
	}
}
