# Phoenix — AI Proctoring Platform

## What's in this build

**RBAC** — Clerk on both ends. `TeacherRoute` in `App.jsx` bounces students away
from `/create-exam`, `/add-questions`, `/exam-logs`, `/student-review/...`; the
backend's `requireTeacher` checks `publicMetadata.role` before serving any
teacher-only route. No sign-up/domain restriction in this build.

**Exam authoring (teacher)**
- Create Exam, Add Questions (unchanged from earlier builds).
- Cheat Log dashboard (`ExamLogs.jsx`) — per-exam dropdown, name/email filter,
  aggregated counts, and now a **View** button per row linking to a full
  per-student review page.
- **Student Review page** (`StudentReview.jsx`, new): the complete violation
  timeline for one student's attempt — timestamps, detail strings, and the
  captured evidence snapshot for each flag, plus a **Reinstate** button for
  attempts that were auto-terminated.

**Exam taking (student) — `ExamRoom.jsx`**
This is the significantly rewritten core of this build:
- **Pre-exam system check + calibration**: camera preview, then a ~1-second
  "Start Calibration" step that samples 30 frames of the student looking
  straight at the screen to compute a baseline yaw/pitch. Gaze deviation
  during the actual exam is measured as *deviation from this baseline*,
  not a fixed absolute angle — this is what makes gaze detection tolerant of
  off-center camera placement. Nothing is logged as a violation until this
  screen is complete, which is also what keeps the earlier
  permission-prompt-blur bug from recurring: the real timer and the blur/
  fullscreen listeners are only attached ~1.5s after `systemCheckPassed`
  becomes true.
- **Face detection**: `FaceLandmarker`, with streak-based persistence (needs
  5+ consecutive frames of "no face" or "2+ faces" before it counts) rather
  than single-frame triggers.
- **Gaze deviation**: measured against the calibrated baseline (see above).
- **Object detection**: `ObjectDetector` (EfficientDet-Lite0) sampled every
  5th frame — `cell phone` → Cell Phone Detected; `book`/`laptop`/`keyboard`/
  `remote`/`tv`/`mouse` → Prohibited Object Detected. Confidence score is
  logged in the detail string.
- **OpenCV.js supplement** (`window.cv`, sampled every 15th frame, only runs
  if OpenCV.js finished loading — see the `index.html` note below):
  - Laplacian-variance blur check for a covered/defocused camera.
  - Frame-differencing to catch a frozen/static feed (webcam swapped for a
    still image), distinct from the plain black-frame check.
  - `BackgroundSubtractorMOG2` foreground-mask area to flag **Unidentified
    Object Detected** — something large entered the frame that isn't a
    recognized COCO class (e.g. printed notes, a second screen held up).
- **Evidence capture**: every strike grabs a 320×240 JPEG snapshot from the
  live video and sends it to the backend alongside the violation.
- **Copy/paste, right-click, and Ctrl+C/V/P blocking**, logged as
  `COPY_PASTE_ATTEMPT`.
- **Autosave**: answers PATCHed to the backend every 10 seconds.
- **Session resume**: reloading `/exam/:examId` returns the same in-progress
  session (with saved answers and correctly reduced remaining time) instead
  of starting a new attempt.
- **Shuffled questions and options**, seeded by session id (`seedrandom`) so
  a reload doesn't reshuffle mid-attempt, with a mapping back to original
  option numbers so scoring is unaffected.
- **Dev/Debug view**: an in-exam checkbox overlays the 10 iris landmark
  points on the video feed, for visually verifying detection quality.

**Backend (`server.js`)**
- `POST /api/session/start` now enforces the exam's live/dead window on a
  *new* attempt only, and resumes an existing `in_progress` session instead
  of creating a duplicate.
- `PATCH /api/session/:sessionId/autosave` — new, for the answer autosave.
- `POST /api/strike` — now validates the session belongs to the caller and
  is still `in_progress`, applies a simple in-memory rate limit (max 3 per
  2 seconds per session, defense-in-depth on top of the client cooldown),
  and stores the evidence snapshot.
- `GET /api/exam-logs/:examId/:clerkUserId` — new, backs the Student Review
  page.
- `POST /api/session/:sessionId/reinstate` — new, backs the Reinstate button.

**Dark mode** — `theme.js` + a `data-theme` attribute + CSS variables
throughout `index.css`; toggle lives in the sidebar topbar (`Layout.jsx`).

**Schema** — added `anomaly_logs.evidence_base64` (additive; the migration
line in `schema.sql` is safe to re-run on an existing database).

## Known trade-offs in this build

- **Evidence storage**: snapshots are stored as base64 text directly on the
  `anomaly_logs` row, not in Supabase Storage. This is simpler to set up
  (no bucket/policy configuration needed) but bloats the table faster than a
  storage path would. Fine for a demo or small class; migrate to Storage
  (upload the data URI, store the path instead) before using this at real
  scale or over a long term.
- **OpenCV.js loading**: `opencv.js` attaches its API to `Module` as soon as
  the script tag executes, but the WASM runtime isn't actually ready until
  `onRuntimeInitialized` fires — calling e.g. `new cv.BackgroundSubtractorMOG2()`
  before then throws. `index.html` pre-defines `window.Module` so that
  `window.cv` is only ever set *after* that callback fires; every `if
  (window.cv)` check in `ExamRoom.jsx` is therefore safe. If OpenCV.js is
  slow to load or blocked by a network policy, the app still works — it
  falls back to the plain black-frame brightness check.
- **Rate limiting** on `/api/strike` is in-memory and resets on server
  restart/redeploy. Fine for a single-instance deployment; would need a
  shared store (Redis, or a Postgres-backed counter) behind a load balancer.
- **`session.status !== 'in_progress'`** on load always shows the
  "Exam Terminated" screen, even for a `completed` session (e.g. a student
  who already submitted and revisits the URL). This is a minor UX quirk
  worth a small follow-up fix (`ExamRoom.jsx` should branch on the specific
  status rather than treating anything non-in-progress as terminated).
- **Identity check, multi-monitor detection, per-exam detection toggles,
  classes/enrollment, admin role, and analytics dashboards** are not built
  in this pass — flagged here so the gap stays visible.

## Local setup

```bash
# Backend
cd backend
npm install
cp .env .env.local   # fill in real keys
npm run dev

# Frontend
cd frontend
npm install
cp .env .env.local   # fill in real keys
npm run dev
```

Run `schema.sql` in the Supabase SQL editor before starting the backend (the
`alter table ... add column if not exists` line is safe to run even if you've
already applied an earlier version of this schema).

In the Clerk Dashboard, set a teacher account's **Public metadata** to:
```json
{ "role": "teacher" }
```

## Render deployment

**Backend (Web Service)** — root `backend`, build `npm install`, start
`npm start`. Env vars: everything in `backend/.env`, plus `CORS_ORIGIN` set to
your deployed frontend URL.

**Frontend (Static Site)** — root `frontend`, build
`npm install && npm run build`, publish directory `dist`. Env vars:
`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_API_URL`. Add a rewrite rule `/* ->
/index.html` so client-side routing survives a page refresh.
