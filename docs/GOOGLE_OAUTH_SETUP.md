# Google OAuth Setup Guide for mawaDao

This guide will walk you through setting up Google OAuth 2.0 authentication for your mawaDao application.

## Overview

Google OAuth allows users to sign in using their Google accounts. The authentication flow:
1. User clicks "Continue with Google" on the login page
2. Redirects to Google OAuth consent screen
3. User approves the application
4. Google redirects back to your backend with an authorization code
5. Backend exchanges code for user information
6. User is created/updated in database
7. Session token is generated and user is redirected to the frontend

## Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)

2. Click **Select a project** dropdown at the top
   - Click **NEW PROJECT**
   - Enter project name: `mawaDao` (or your app name)
   - Click **CREATE**

3. Wait for the project to be created, then select it from the dropdown

## Step 2: Enable Google+ API

1. In the left sidebar, go to **APIs & Services** > **Library**

2. Search for `Google+ API`

3. Click on **Google+ API**

4. Click **ENABLE**

## Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** > **OAuth consent screen**

2. Select **External** user type (unless you have a Google Workspace account)

3. Click **CREATE**

4. Fill in the App information:
   - **App name**: `mawaDao` (or your app name)
   - **User support email**: Your email address
   - **App logo**: (Optional) Upload your app logo
   - **Application home page**: `http://localhost:3000` (for development)
   - **Authorized domains**: (Leave empty for development)
   - **Developer contact information**: Your email address

5. Click **SAVE AND CONTINUE**

6. **Scopes**: Click **ADD OR REMOVE SCOPES**
   - Select:
     - `../auth/userinfo.email` (See your email address)
     - `../auth/userinfo.profile` (See your personal info)
     - `openid` (Authenticate using OpenID Connect)
   - Click **UPDATE**

7. Click **SAVE AND CONTINUE**

8. **Test users**: Add your email address as a test user while the app is in testing mode

9. Click **SAVE AND CONTINUE**

10. Review the summary and click **BACK TO DASHBOARD**

## Step 4: Create OAuth 2.0 Credentials

1. Go to **APIs & Services** > **Credentials**

2. Click **+ CREATE CREDENTIALS** at the top

3. Select **OAuth client ID**

4. Configure the OAuth client:
   - **Application type**: Select **Web application**
   - **Name**: `mawaDao Web Client` (or any name you prefer)
   
5. **Authorized JavaScript origins** (Optional for this flow):
   - Click **+ ADD URI**
   - Add: `http://localhost:3000`
   
6. **Authorized redirect URIs**:
   - Click **+ ADD URI**
   - Add: `http://localhost:3000/api/v1/auth/google/callback`
   - For production, also add: `https://yourdomain.com/api/v1/auth/google/callback`

7. Click **CREATE**

8. Copy the credentials:
   - **Client ID**: Looks like `123456789-abc.apps.googleusercontent.com`
   - **Client Secret**: Looks like `GOCSPX-abc123def456`
   
   ⚠️ **Keep these secure!** Don't commit them to git.

## Step 5: Configure Backend Environment Variables

1. Navigate to the platform directory:
   ```powershell
   cd mawadao/apps/platform
   ```

2. Create `.env` file (if it doesn't exist):
   ```powershell
   Copy-Item .env.example .env
   ```

3. Edit `.env` file and add your Google OAuth credentials:
   ```env
   # Google OAuth 2.0 (for user authentication)
   GOOGLE_CLIENT_ID=YOUR_CLIENT_ID_HERE.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=YOUR_CLIENT_SECRET_HERE
   GOOGLE_REDIRECT_URI=http://localhost:3000/api/v1/auth/google/callback
   
   # Frontend URL (for OAuth redirects)
   FRONTEND_URL=http://localhost:3000
   ```

4. Replace `YOUR_CLIENT_ID_HERE` and `YOUR_CLIENT_SECRET_HERE` with the values from Step 4

## Step 6: Configure Frontend Environment Variables

1. Navigate to the frontend directory:
   ```powershell
   cd mawadao/apps/frontend
   ```

2. Create `.env.local` file (if it doesn't exist):
   ```powershell
   Copy-Item .env.example .env.local
   ```

3. Edit `.env.local` and ensure this is set:
   ```env
   NEXT_PUBLIC_API_URL=http://localhost:3000
   ```

## Step 7: Restart Your Application

Stop and restart all services:

```powershell
# From the project root
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

# Terminal 3 - Frontend
cd mawadao/apps/frontend
npm run dev
```

## Step 8: Test the Authentication

1. Open your browser to `http://localhost:3000`

2. Click **Sign in** or go directly to `http://localhost:3000/auth/login`

3. Click **Continue with Google**

4. You should be redirected to Google's consent screen

5. Select your Google account and approve the permissions

6. You should be redirected back to your app and logged in!

## Database Location

User data is stored in the shared Supabase PostgreSQL database.
The Go auth service (`mawadao/apps/microservices/auth/`) handles Google OAuth and creates/links users in the `users` table.

## Production Deployment

For production, update:

1. **Google Cloud Console**:
   - Add production redirect URI: `https://yourdomain.com/api/v1/auth/google/callback`
   - Add authorized origin: `https://yourdomain.com`
   - Update OAuth consent screen home page
   - Consider publishing the app (move from Testing to Production)

2. **Backend `.env`**:
   ```env
   GOOGLE_REDIRECT_URI=https://api.yourdomain.com/api/v1/auth/google/callback
   FRONTEND_URL=https://yourdomain.com
   ```

3. **Frontend `.env`**:
   ```env
   NEXT_PUBLIC_API_URL=https://api.yourdomain.com
   ```

## Troubleshooting

### "Not found: GET /api/v1/auth/google"
- Ensure backend is running with `OPENCLAW_REST_API=1`
- Check backend logs for startup errors
- Verify `.env` is in `mawadao/apps/platform/` directory

### "redirect_uri_mismatch" error from Google
- Go to Google Cloud Console > Credentials
- Edit your OAuth client
- Ensure redirect URI exactly matches: `http://localhost:3000/api/v1/auth/google/callback`
- No trailing slash, must be exact match

### User not redirected after Google login
- Check backend terminal for errors
- Verify `FRONTEND_URL` in backend `.env`
- Check browser console for errors
- Verify callback page exists at `mawadao/apps/frontend/src/app/auth/callback/page.tsx`

### "Google OAuth not configured" error
- Ensure `GOOGLE_CLIENT_ID` is set in backend `.env`
- Restart the backend after adding environment variables
- Check for typos in variable names

### Database errors
- Ensure `DATABASE_URL` environment variable is set
- Verify PostgreSQL/Supabase connection is reachable
- Check the auth service logs for connection errors

## API Endpoints

The following auth endpoints are available:

**Go Auth Service** (port 8080):
- `GET /auth/google` - Initiates OAuth flow
- `GET /auth/google/callback` - OAuth callback
- `GET /auth/me` - Get current user (requires JWT)
- `GET /auth/logout` - Logout (clear session)
- `GET /users/me` - Get user profile (requires JWT)
- `PATCH /users/me` - Update user profile (requires JWT)
- `GET /users/check-username` - Check username availability

## Security Notes

1. **Never commit `.env` files** - They contain secrets
2. **Use HTTPS in production** - Don't send tokens over HTTP
3. **Rotate secrets regularly** - Change client secret periodically
4. **Monitor Google Cloud Console** - Check for suspicious activity
5. **Set session expiry** - JWT tokens expire after 7 days by default

## Need Help?

- [Google OAuth 2.0 Documentation](https://developers.google.com/identity/protocols/oauth2)
- [Google Cloud Console](https://console.cloud.google.com/)
- Check backend logs for detailed error messages
