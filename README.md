# VibeCraft Backend

AI-powered playlist generation backend for the VibeCraft iOS app. Uses OpenAI to generate contextual playlists and integrates with Apple Music API for song search and playlist creation.

## Features

- 🤖 **AI Playlist Generation**: OpenAI creates playlists based on natural language prompts
- 🎵 **Apple Music Integration**: Search and create playlists in Apple Music
- 🎯 **Smart Energy Matching**: Songs are ordered to match the described vibe and energy
- 🔄 **Fallback Systems**: Multiple strategies to find songs when primary search fails
- ⚡ **Fast & Reliable**: Optimized for mobile app usage

## API Endpoints

- `GET /` - Health check
- `GET /health` - Detailed health status
- `POST /mix/plan-search` - Generate AI playlist
- `GET /apple/devtoken` - Get Apple Music developer token
- `POST /apple/create-playlist` - Create playlist in Apple Music

## Tech Stack

- **Node.js** + **Express** - Backend framework
- **OpenAI API** - AI playlist generation
- **Apple Music API** - Music search and playlist creation
- **JWT** - Apple Music token authentication

## Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/vibecraft-backend.git
   cd vibecraft-backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment variables**
   Create a `.env` file:
   ```env
   OPENAI_API_KEY=sk-your-openai-key
   APPLE_TEAM_ID=your-apple-team-id
   APPLE_KEY_ID=your-apple-key-id
   APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour Apple private key\n-----END PRIVATE KEY-----"
   PORT=3001
   ```

4. **Run the server**
   ```bash
   npm start
   ```

## Deployment

See [DEPLOY.md](DEPLOY.md) for detailed deployment instructions to Render or Railway.

## API Usage

### Generate Playlist
```bash
curl -X POST https://your-backend-url.com/mix/plan-search \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "workout music with warm up and cool down",
    "minutes": 60,
    "explicit": true
  }'
```

### Response
```json
{
  "title": "High-Energy Workout Flow",
  "description": "Perfect workout playlist with warm-up and cool-down",
  "tracks": [
    {
      "title": "Song Title",
      "artist": "Artist Name",
      "durationMs": 180000
    }
  ],
  "minutesActual": 60
}
```

## iOS App Integration

This backend powers the VibeCraft iOS app. Update the backend URL in your iOS app:

```swift
private let backendURL = "https://your-deployed-url.com"
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes  
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Related

- [VibeCraft iOS App](https://github.com/YOUR_USERNAME/vibecraft-ios) - The companion iOS app