# Quick Start - Google OAuth Setup

## What Was Implemented

✅ **Auth Service** (`mawadao/apps/microservices/auth/`)
- Go-based Google OAuth 2.0 service with Gin framework
- Google OAuth login/callback → user creation in Supabase PostgreSQL
- JWT token issuance (HS256, 7-day expiry)
- User profile endpoints (get, update, username check)
- CORS middleware for frontend integration

✅ **Platform** (`mawadao/apps/platform/`)
- OpenClaw Gateway + REST API backend
- REST API at `/api/v1` with 76+ endpoints
- WebSocket Gateway for real-time agent sessions

✅ **Frontend** (`mawadao/apps/frontend/`)
- Created OAuth callback page (`src/app/auth/callback/page.tsx`)
- Auth store supports OAuth JWT tokens
- Login page redirects to auth service OAuth endpoint

✅ **Documentation**
- Comprehensive setup guide (`docs/GOOGLE_OAUTH_SETUP.md`)

## Next Steps

### 1. Get Google OAuth Credentials

Follow the detailed guide in `docs/GOOGLE_OAUTH_SETUP.md` (Steps 1-4) to:
1. Create a Google Cloud project
2. Enable Google+ API
3. Configure OAuth consent screen
4. Create OAuth 2.0 credentials

You'll get:
- **Client ID**: `123456789-abc.apps.googleusercontent.com`
- **Client Secret**: `GOCSPX-abc123def456`

### 2. Configure Auth Service Environment

```powershell
cd mawadao/apps/microservices/auth
Copy-Item .env.example .env
notepad .env
```

Add these lines to `.env`:
```env
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID_HERE.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET_HERE
GOOGLE_REDIRECT_URL=http://localhost:8080/auth/google/callback
DATABASE_URL=your_supabase_connection_string
JWT_SECRET=your-jwt-secret
FRONTEND_URL=http://localhost:3000
```

### 3. Configure Frontend Environment

```powershell
cd mawadao/apps/frontend
Copy-Item .env.example .env.local
notepad .env.local
```

Ensure these are set:
```env
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXT_PUBLIC_AUTH_URL=http://localhost:8080
```

### 4. Start All Services

```powershell
# From project root
node dev-start.mjs
```

Or manually:
```powershell
# Terminal 1 - Platform (Backend)
cd mawadao/apps/platform
$env:OPENCLAW_REST_API=1; pnpm run dev

# Terminal 2 - Auth (Go)
cd mawadao/apps/microservices/auth
go run ./cmd/

# Terminal 3 - Configuration API
cd mawadao/apps/microservices/configuration-api
node src/index.js

# Terminal 4 - Frontend
cd mawadao/apps/frontend
npm run dev
```

### 5. Test Authentication

1. Go to http://localhost:3000/auth/login
2. Click "Continue with Google"
3. Sign in with your Google account
4. You should be redirected back and logged in!

## Database

User data is stored in the shared Supabase PostgreSQL database.
The Go auth service creates/links users via the `users` table with `google_id` column.

## Troubleshooting

**Error: "redirect_uri_mismatch"**
- In Google Cloud Console, ensure redirect URI is exactly:
  `http://localhost:8080/auth/google/callback`

**Users not being saved**
- Check auth service logs for database connection errors
- Verify `DATABASE_URL` environment variable is set correctly

**Session not persisting**
- Check browser console for errors
- Verify JWT token is being stored in localStorage
- Check `/auth/me` endpoint returns user data

## Monorepo Structure

```
mawadao/
├── apps/
│   ├── frontend/                    # Next.js 14 web client
│   ├── microservices/
│   │   ├── auth/                    # Go Google OAuth service
│   │   ├── configuration-api/           # Express REST API for social features
│   │   └── cloud-run-deployer/      # GCP Cloud Run deployment service
│   └── platform/                    # OpenClaw Gateway + REST API
├── db/
│   └── migrations/                  # Centralized SQL schema & migrations
├── docs/                            # Project documentation
└── tests/                           # Integration/E2E tests
```

## API Testing

Test the auth service:
```powershell
curl http://localhost:8080/
```

Should return health check response.

## Production Checklist

When deploying to production:
- [ ] Add production redirect URI in Google Cloud Console
- [ ] Update `GOOGLE_REDIRECT_URL` in auth service `.env`
- [ ] Update `FRONTEND_URL` in auth service `.env`
- [ ] Update `NEXT_PUBLIC_API_URL` in frontend `.env`
- [ ] Update `NEXT_PUBLIC_AUTH_URL` in frontend `.env`
- [ ] Use HTTPS for all URLs
- [ ] Move OAuth app from Testing to Production in Google Cloud Console
- [ ] Set strong `JWT_SECRET` (random 64+ chars)
- [ ] Set strong `SESSION_SECRET`
- [ ] Enable database connection SSL

## Support

For detailed instructions, see: `docs/GOOGLE_OAUTH_SETUP.md`
