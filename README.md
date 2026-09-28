# Phoenix — AI Proctoring Platform

## What's built (functional core)

**RBAC**
Clerk on both ends. `TeacherRoute` in `App.jsx` bounces students away from `/create-exam`, `/add-questions`, `/exam-logs`; the backend's `requireTeacher` checks `publicMetadata.role` via `clerkClient.users.getUser()` before serving any teacher-only route.

**Exam authoring (teacher)**
- `Create Exam` — name, question count, duration, live/dead window → `POST /api/exams`.
- `Add Questions` — pick one of your exams, add MCQs one at a time (queued client-side) or in a batch → `POST /api/exams/:examId/questions`. Correct option is tracked server-side and never sent back to students.
- `Exam Logs` (the cheat-log dashboard) — per-exam dropdown + name/email filter, aggregated counts (No Face / Multiple Face / Cell Phone / Prohibited Object) computed server-side in `GET /api/exam-logs` by joining `anomaly_logs` → `candidate_sessions`.

**Exam taking (student)**
- `Dashboard` lists exams currently inside their live/dead window as clickable cards (shared component for both roles).
- `ExamRoom` fetches the question set (`GET /api/exams/:examId/questions`, correct answers stripped), starts a `candidate_sessions` row, and renders a question panel + numbered navigator grid + countdown timer + small mirrored webcam preview, matching the reference layout.
- **Client-side CV**, entirely in `ExamRoom.jsx`, two MediaPipe Tasks Vision models running side by side:
  - `FaceLandmarker` (GPU/WASM) — 0 faces → *Face Not Visible*, 2+ faces → *Multiple Faces Detected*, and gaze deviation from the model's `facialTransformationMatrixes` (yaw/pitch pulled from the rotation block, see `getYawPitchFromMatrix` — more stable than manual landmark trig).
  - `ObjectDetector` (EfficientDet-Lite0, COCO labels), sampled every 5th frame since it's heavier: `cell phone` → *Cell Phone Detected*; `book` / `laptop` / `keyboard` / `remote` / `tv` / `mouse` → *Prohibited Object Detected*.
  - Webcam tamper detection: the video track's `ended` event, plus a cheap 32×24 downsampled brightness check for a sustained black/covered frame.
  - Browser signals: `window.onblur` (tab switch) and `document.onfullscreenchange`.
- **Violation modal**: matches the reference exactly — a centered card with an ✕ icon, the violation name, "Action has been Recorded", and an OK button. A per-violation-type cooldown (`COOLDOWN_MS`) stops one ongoing issue from spamming the warning counter; `warningCountRef` (a ref, not state) is read inside the animation-frame loop so the video feed doesn't stutter.
- **Termination**: at 10 warnings, the camera stops, `/api/session/:id/terminate` fires, and the view locks to "Exam Terminated".
- **Submission**: "Finish Test" (or the timer hitting zero) calls `/api/exams/:examId/submit`, which scores the attempt server-side against the stored correct answers, then shows "Test is Submitted Successfully!!!" with a "User Logs Saved!!" toast and a "Go Back To Home" button — this state is the one place `ExamRoom` renders inside the normal sidebar `Layout`, matching the reference.
- `Result` — a student's own past attempts and scores.

**Backend**
Single `server.js`. CORS allow-list, `@clerk/express` (`clerkMiddleware` + `requireAuth`), Supabase via the **service role key only** (never exposed to the client). Scoring happens server-side so the answer key never reaches the browser.

**Schema**
`exams`, `questions`, `candidate_sessions` (now with `answers`/`score`/`total_questions`), `anomaly_logs` — relational, no RLS (per spec — the backend is the only writer).

## What's intentionally left for you

This is a demo-ready scaffold, not a hardened production system.

1. **Session resumption** — refreshing `/exam/:examId` starts a brand-new `candidate_sessions` row rather than resuming an in-progress one; add a check for an existing `in_progress` session for that student+exam first.
2. **Object-detection accuracy** — EfficientDet-Lite0 is a general COCO model, not phone/paper-specific; expect false positives/negatives, and tune `scoreThreshold` and the label sets in `ExamRoom.jsx`.
3. **Server-side rate limiting on `/api/strike`** — the cooldown is client-side only; a modified client could spam strikes.
4. **Evidence capture** — no snapshot/clip is stored at the moment of a violation (would need Supabase Storage + a canvas snapshot upload alongside the strike).
5. **Exam window enforcement in `ExamRoom`** — the dashboard only lists exams inside their live/dead window, but `ExamRoom` itself doesn't re-check that window before letting a direct URL hit start a session.
6. **Fullscreen re-entry UX** — browsers block silent re-entry after an exit triggered by user action elsewhere; there's no explicit "re-enter full screen" button inside `ExamRoom` right now.
7. **Pagination / CSV export** on the cheat-log dashboard and results table.
8. **Automated tests** — none included.
9. **Clerk webhook** to sync user metadata into your own table if you need to query by name/email without calling the Clerk API per request.

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

Run `schema.sql` in the Supabase SQL editor before starting the backend.

In the Clerk Dashboard, set a teacher account's **Public metadata** to:
```json
{ "role": "teacher" }
```
All other signups are treated as students by default.

**Typical flow to try it end to end:** sign in as the teacher → Create Exam (set the live window to include "now") → Add Questions for that exam → sign in as a student → the exam card appears on the Dashboard → click it, allow camera/fullscreen, answer questions, click Finish Test (or let the timer run out) → sign back in as the teacher → Exam Logs shows the aggregated violation counts for that exam.

## Render deployment

**Backend (Web Service)**
- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Env vars: everything in `backend/.env`, plus set `CORS_ORIGIN` to your deployed frontend URL.

**Frontend (Static Site)**
- Root directory: `frontend`
- Build command: `npm install && npm run build`
- Publish directory: `dist`
- Env vars: `VITE_CLERK_PUBLISHABLE_KEY`, and `VITE_API_URL` pointing at the backend's Render URL.
- Add a rewrite rule `/* -> /index.html` (Render static site "Redirects/Rewrites") so client-side routing (`react-router-dom`) works on refresh.
