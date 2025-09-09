# VibeCraft Backend Deployment Guide

## Option 1: Render (Recommended - Easiest)

1. **Push to GitHub first:**
   - Go to https://github.com and create a new repository called "vibecraft-backend"
   - Follow the instructions to push your local code:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/vibecraft-backend.git
   git branch -M main
   git push -u origin main
   ```

2. **Deploy to Render:**
   - Go to https://render.com
   - Sign up with GitHub
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Use these settings:
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
     - **Environment**: Add these variables:
       - `OPENAI_API_KEY` = your OpenAI key
       - `APPLE_TEAM_ID` = your Apple team ID
       - `APPLE_KEY_ID` = your Apple key ID  
       - `APPLE_PRIVATE_KEY` = your Apple private key (multiline)

3. **Get your URL:**
   - Render will give you a URL like `https://vibecraft-backend-xyz.onrender.com`
   - Update your iOS app to use this URL instead of `http://192.168.1.74:3001`

## Option 2: Railway

1. Follow same GitHub steps above
2. Go to https://railway.app
3. Sign up with GitHub
4. Create new project from GitHub repo
5. Add same environment variables
6. Deploy

## Environment Variables Needed:
- `OPENAI_API_KEY` (from your .env file)
- `APPLE_TEAM_ID` (from your .env file)  
- `APPLE_KEY_ID` (from your .env file)
- `APPLE_PRIVATE_KEY` (from your .env file)

## After Deployment:
1. Test your backend URL in browser: `https://your-url.com/health`
2. Update iOS app with new backend URL
3. Test playlist generation from iPhone

Your backend will then be accessible worldwide for testing!