# Doodle Alive

Kids draw characters (or snap a photo of a paper drawing). In the Studio, a game-controller layout (walk and jump on the left, actions on the right, Record in the middle) lets them play their characters live, everything happens live and is recorded at the same time: talk into the mic and the character's mouth moves, make characters jump, flip, dance and wave, drag them around, switch places (including your own pictures), throw confetti, play star hunt. Press Stop and the movie is ready with a YouTube title, description, keywords and thumbnail filled in. One button posts it.

## Files
The whole app is **two files**: `index.html` and `app.js`. The rest is for building and setup.

| File | Purpose |
|---|---|
| `index.html` | Page and styles |
| `app.js` | All app code |
| `package.json`, `package-lock.json` | Tell Vercel what to install |
| `vite.config.js` | Build settings |
| `firestore.rules` | Paste into Firebase (saved drawings) |

## Deploy on Vercel
Framework preset **Vite**, build `npm run build`, output `dist`. No environment variables.

## One-time Firebase setup (project `drawfina-8af10`)
1. **Turn on sign-in** (fixes `auth/configuration-not-found`): Firebase console → **Build → Authentication** → **Get started** → **Sign-in method** → **Google** → Enable → support email → **Save**.
2. **Allow your website**: Authentication → **Settings** → **Authorized domains** → add your Vercel address (e.g. `drawian.vercel.app`, no `https://`).
3. **Saved drawings**: **Build → Firestore Database** → Create database → **Rules** → paste `firestore.rules` → **Publish**.

## One-time YouTube setup (Google Cloud console, same project)
4. **APIs & Services → Library** → **YouTube Data API v3** → **Enable**.
5. **Google Auth Platform / OAuth consent screen**: app name and support email.
   - **Data access** → add scope `https://www.googleapis.com/auth/youtube.upload`.
   - **Audience → Test users** → add the Google account that posts the videos.
6. That account needs a YouTube channel. For custom thumbnails, verify it at youtube.com/verify.
7. For the **series playlist** option, also add the scope `https://www.googleapis.com/auth/youtube` in Data access. "Go live later" schedules the video (it stays private until then).

Chapters are added to the description automatically when a wide movie has 3+ scenes of at least 10 seconds each.

Until Google verifies the app, YouTube keeps videos posted through the API **private** (you can switch them to Public in YouTube Studio). To post public videos directly, submit the app for Google verification and the YouTube API compliance audit.

## Notes on YouTube
- Videos aimed at kids must be marked "Made for kids" (US COPPA law). YouTube then turns off comments and personalized ads on them.
- **YouTube Shorts** format records a vertical video, which tends to get found more on phones.

## Studio controls
The stage never moves while you scroll: on a computer the settings panel scrolls by itself; on a phone the stage stays pinned at the top.

| Control | Where | Keyboard |
|---|---|---|
| Walk (hold) | ◀ ▶ | ← → |
| Jump (or fly up while flying) | big yellow button | Space or ↑ |
| **Moves:** Flip, Spin, Dance, Wave, Run, Fly, Stomp, Kick | right pad, Moves tab | F S D W X V B K |
| **Act:** Clap, Bow, Laugh, Sneeze, Sleep, Shiver, Hug, Poof! | right pad, Act tab | C O L N Y H U P |
| **More:** Grow, Turn, To front, Freeze, Zoom, Quake, All dance, Reset | right pad, More tab | G T J I Z Q A E |
| Feelings: happy, surprised, sad, angry | faces under the buttons | |
| Pick character | faces above the buttons | 1–9 |
| Record / Stop, Microphone | middle | R, M |

Tap a character to pick it, drag it anywhere, or tap an empty spot to make it walk there. Run, Fly, Sleep and Freeze stay on until you press them again; Reset puts the character back to normal.

## Making a movie
1. **Record scenes.** With "Scene" picked by the red button, every recording becomes a scene (saved on this device, even if the page is closed). Reorder, watch or delete scenes on the Movie tab.
2. **Act one character at a time (optional).** Pick "One part", choose a character and record just their moves and voice. Then pick another character and record again: the first one acts out its part at the same time. Parts are replayed in every scene you record until you delete them (Cast tab).
3. **Captions.** Turn on "Write captions" on the Movie tab (Chrome and Edge) and what you say becomes captions; you can fix or add captions on each scene.
4. **Make my movie.** Joins all scenes with a title card (title, episode number, cast), transitions (fade, slide, circle, star), burned-in captions and rolling credits ("Starring…", "Made by…"). Choose Wide or Shorts (a tall, under-1-minute version made from the start of each scene). It plays through once while it is made, so keep the page open. Finished movies are kept under My movies.

## Characters
- **Fix arms and legs** (Cast tab): color over each arm and leg; the app splits each into an upper and lower piece so elbows and knees bend.
- **My characters**: save any character and add it to future movies, even with a new drawing. Saved on this device, and in Firebase when a grown-up is signed in (publish the updated `firestore.rules`).

## Sound board
Sound tab: record up to 8-second sounds (voice effects apply) and tap them while filming.

## Voice effects
Normal, Chipmunk, Giant, Robot, Alien, Echo, Cave, Radio, Ghost, Underwater. They change the microphone live and are recorded into the movie. Each character keeps its own voice, so switching characters switches voices. "Hear my voice" plays it back while you talk (use headphones).

## Props and scene effects
Props tab: tree, house, castle, flower, rainbow, ball (characters push it, Kick sends it flying), balloon (pops when touched), car (tap to drive), rocket (tap to launch), cake, sign (type text, then tap it), smiley sun. Drag to move; tap to resize, flip or remove.
Scene tab on the action pad: Zoom, Slow-mo, Fast, Spotlight, Night, Rain, Snow, Thunder.

## Music
Five built-in tunes (Happy, Adventure, Space, Silly, Calm), your own song, or no music, with a volume slider. Switch any time, even while recording. The built-in tunes are generated by the app, so they are safe to use on YouTube; other people's songs can get a video blocked.
