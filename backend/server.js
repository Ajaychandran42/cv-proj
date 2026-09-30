// ============================================================
// Phoenix — AI Proctoring Platform — Backend (single-file, per spec)
// Express + @clerk/express (auth/RBAC) + Supabase (service key)
// ============================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { clerkMiddleware, requireAuth, getAuth, clerkClient } from '@clerk/express';
import { createClient } from '@supabase/supabase-js';

// ---------- Sanity-check required env vars ----------
const REQUIRED_ENV = ['CLERK_SECRET_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ---------- Supabase client (Service Role — server only) ----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ---------- App setup ----------
const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(clerkMiddleware());

// ---------- Helper: role check ----------
async function requireTeacher(req, res, next) {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ error: 'Unauthenticated' });
    const user = await clerkClient.users.getUser(userId);
    if (user.publicMetadata?.role !== 'teacher') {
      return res.status(403).json({ error: 'Forbidden: teacher role required' });
    }
    next();
  } catch (err) {
    console.error('requireTeacher error:', err);
    return res.status(500).json({ error: 'Role verification failed' });
  }
}

const VIOLATION_KEYS = {
  FACE_NOT_VISIBLE: 'no_face_count',
  MULTIPLE_FACES: 'multiple_face_count',
  CELL_PHONE_DETECTED: 'cell_phone_count',
  PROHIBITED_OBJECT_DETECTED: 'prohibited_object_count',
};

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ============================================================
// Exams
// ============================================================

app.post('/api/exams', requireAuth(), requireTeacher, async (req, res) => {
  const { userId } = getAuth(req);
  const { name, totalQuestions, durationMinutes, liveAt, deadAt } = req.body;

  if (!name || !totalQuestions || !durationMinutes || !liveAt || !deadAt) {
    return res.status(400).json({ error: 'All exam fields are required' });
  }

  try {
    const { data, error } = await supabase
      .from('exams')
      .insert({
        teacher_id: userId,
        name,
        total_questions: totalQuestions,
        duration_minutes: durationMinutes,
        live_at: new Date(liveAt).toISOString(),
        dead_at: new Date(deadAt).toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ exam: data });
  } catch (err) {
    console.error('POST /api/exams error:', err);
    res.status(500).json({ error: 'Failed to create exam' });
  }
});

app.get('/api/exams', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const owned = req.query.owned === '1';

  try {
    if (owned) {
      const user = await clerkClient.users.getUser(userId);
      if (user.publicMetadata?.role !== 'teacher') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const { data, error } = await supabase
        .from('exams')
        .select('*')
        .eq('teacher_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.json({ exams: data });
    }

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('exams')
      .select('*')
      .lte('live_at', nowIso)
      .gte('dead_at', nowIso)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ exams: data });
  } catch (err) {
    console.error('GET /api/exams error:', err);
    res.status(500).json({ error: 'Failed to fetch exams' });
  }
});

app.post('/api/exams/:examId/questions', requireAuth(), requireTeacher, async (req, res) => {
  const { userId } = getAuth(req);
  const { examId } = req.params;
  const { questions } = req.body;

  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'questions array is required' });
  }

  try {
    const { data: exam, error: examErr } = await supabase
      .from('exams')
      .select('id, teacher_id')
      .eq('id', examId)
      .single();
    if (examErr || !exam) return res.status(404).json({ error: 'Exam not found' });
    if (exam.teacher_id !== userId) return res.status(403).json({ error: 'Not your exam' });

    const rows = questions.map((q) => ({
      exam_id: examId,
      question_text: q.text,
      option_1: q.options[0],
      option_2: q.options[1],
      option_3: q.options[2],
      option_4: q.options[3],
      correct_option: q.correctIndex + 1,
    }));

    const { data, error } = await supabase.from('questions').insert(rows).select();
    if (error) throw error;
    res.status(201).json({ questions: data });
  } catch (err) {
    console.error('POST /api/exams/:examId/questions error:', err);
    res.status(500).json({ error: 'Failed to add questions' });
  }
});

app.get('/api/exams/:examId/questions', requireAuth(), async (req, res) => {
  const { examId } = req.params;
  try {
    const { data: exam, error: examErr } = await supabase
      .from('exams')
      .select('*')
      .eq('id', examId)
      .single();
    if (examErr || !exam) return res.status(404).json({ error: 'Exam not found' });

    const { data: questions, error } = await supabase
      .from('questions')
      .select('id, question_text, option_1, option_2, option_3, option_4')
      .eq('exam_id', examId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    res.json({ exam, questions });
  } catch (err) {
    console.error('GET /api/exams/:examId/questions error:', err);
    res.status(500).json({ error: 'Failed to fetch exam questions' });
  }
});

// ============================================================
// Candidate sessions
// ============================================================

// Starts a new attempt, or resumes an existing in_progress one for this
// student+exam so a page refresh doesn't wipe out progress or reset the
// clock. The live/dead window is only enforced when creating a brand-new
// attempt — a student already mid-exam is never locked out by the clock
// ticking past dead_at while they're still working.
app.post('/api/session/start', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const { examId, candidateName, candidateEmail } = req.body;
  if (!examId) return res.status(400).json({ error: 'examId is required' });

  try {
    const { data: exam, error: examErr } = await supabase
      .from('exams')
      .select('*')
      .eq('id', examId)
      .single();
    if (examErr || !exam) return res.status(404).json({ error: 'Exam not found' });

    const { data: existing, error: findErr } = await supabase
      .from('candidate_sessions')
      .select('*')
      .eq('exam_id', examId)
      .eq('clerk_user_id', userId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (findErr) throw findErr;

    if (existing) {
      return res.status(200).json({ session: existing, exam });
    }

    const now = new Date();
    if (now < new Date(exam.live_at) || now > new Date(exam.dead_at)) {
      return res.status(403).json({ error: 'This exam is not currently open' });
    }

    const { data, error } = await supabase
      .from('candidate_sessions')
      .insert({
        clerk_user_id: userId,
        exam_id: examId,
        candidate_name: candidateName || null,
        candidate_email: candidateEmail || null,
        status: 'in_progress',
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ session: data, exam });
  } catch (err) {
    console.error('POST /api/session/start error:', err);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Lightweight, best-effort rate limiter for /api/strike — defense in depth
// on top of the client-side cooldown, since a modified client could ignore
// that. Resets on server restart, which is fine for this scale.
const strikeHistory = new Map(); // sessionId -> recent insert timestamps (ms)
const STRIKE_WINDOW_MS = 2000;
const STRIKE_MAX_IN_WINDOW = 3;

function isStrikeRateLimited(sessionId) {
  const now = Date.now();
  const recent = (strikeHistory.get(sessionId) || []).filter((t) => now - t < STRIKE_WINDOW_MS);
  recent.push(now);
  strikeHistory.set(sessionId, recent);
  return recent.length > STRIKE_MAX_IN_WINDOW;
}

// Evidence snapshots are stored as base64 text directly on the row rather
// than in Supabase Storage, to avoid requiring a storage bucket to be
// configured before this works. Trade-off: this bloats anomaly_logs faster
// than a storage path would. Fine for a demo/small deployment; migrate to
// Storage (upload the data URI, store the path instead) if this is used
// at real scale. Capped here so a corrupted/huge payload can't blow up the row.
const MAX_EVIDENCE_BYTES = 200_000; // ~200KB, generous headroom over a 320x240 JPEG

app.post('/api/strike', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const { sessionId, violationType, detail, evidenceBase64, warningCount } = req.body;
  if (!sessionId || !violationType) {
    return res.status(400).json({ error: 'sessionId and violationType are required' });
  }

  try {
    const { data: session, error: sessErr } = await supabase
      .from('candidate_sessions')
      .select('id, clerk_user_id, status')
      .eq('id', sessionId)
      .single();
    if (sessErr || !session) return res.status(404).json({ error: 'Session not found' });
    if (session.clerk_user_id !== userId) return res.status(403).json({ error: 'Not your session' });
    if (session.status !== 'in_progress') {
      return res.status(409).json({ error: 'Session is no longer in progress' });
    }

    if (isStrikeRateLimited(sessionId)) {
      return res.status(429).json({ error: 'Too many strikes in a short window' });
    }

    const evidence =
      typeof evidenceBase64 === 'string' && evidenceBase64.length <= MAX_EVIDENCE_BYTES ? evidenceBase64 : null;

    const { data, error } = await supabase
      .from('anomaly_logs')
      .insert({
        session_id: sessionId,
        clerk_user_id: userId,
        violation_type: violationType,
        detail: detail || null,
        warning_count_at_log: warningCount ?? 0,
        evidence_base64: evidence,
      })
      .select('id, session_id, clerk_user_id, violation_type, detail, warning_count_at_log, created_at')
      .single();
    if (error) throw error;
    res.status(201).json({ log: data });
  } catch (err) {
    console.error('POST /api/strike error:', err);
    res.status(500).json({ error: 'Failed to log anomaly' });
  }
});

// Periodic autosave of in-progress answers, called from ExamRoom every ~10s
// so a crash/dropped connection doesn't lose progress. Silently no-ops if
// the session has already moved past in_progress (submitted/terminated).
app.patch('/api/session/:sessionId/autosave', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const { sessionId } = req.params;
  const { answers } = req.body;

  try {
    const { data, error } = await supabase
      .from('candidate_sessions')
      .update({ answers: answers || {} })
      .eq('id', sessionId)
      .eq('clerk_user_id', userId)
      .eq('status', 'in_progress')
      .select('id')
      .maybeSingle();
    if (error) throw error;
    res.json({ saved: !!data });
  } catch (err) {
    console.error('PATCH /api/session/:sessionId/autosave error:', err);
    res.status(500).json({ error: 'Failed to autosave answers' });
  }
});

app.post('/api/session/:sessionId/terminate', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const { sessionId } = req.params;
  const { reason } = req.body;

  try {
    const { data, error } = await supabase
      .from('candidate_sessions')
      .update({ status: 'terminated', ended_at: new Date().toISOString() })
      .eq('id', sessionId)
      .eq('clerk_user_id', userId)
      .select()
      .single();
    if (error) throw error;

    if (reason) {
      await supabase.from('anomaly_logs').insert({
        session_id: sessionId,
        clerk_user_id: userId,
        violation_type: 'EXAM_TERMINATED',
        detail: reason,
        warning_count_at_log: 10,
      });
    }
    res.json({ session: data });
  } catch (err) {
    console.error('POST /api/session/:id/terminate error:', err);
    res.status(500).json({ error: 'Failed to terminate session' });
  }
});

app.post('/api/exams/:examId/submit', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const { examId } = req.params;
  const { sessionId, answers } = req.body;

  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  try {
    const { data: questions, error: qErr } = await supabase
      .from('questions')
      .select('id, correct_option')
      .eq('exam_id', examId);
    if (qErr) throw qErr;

    let score = 0;
    for (const q of questions) {
      if (answers?.[q.id] === q.correct_option) score += 1;
    }

    const { data, error } = await supabase
      .from('candidate_sessions')
      .update({
        status: 'completed',
        answers: answers || {},
        score,
        total_questions: questions.length,
        ended_at: new Date().toISOString(),
      })
      .eq('id', sessionId)
      .eq('clerk_user_id', userId)
      .select()
      .single();
    if (error) throw error;

    res.json({ session: data, score, totalQuestions: questions.length });
  } catch (err) {
    console.error('POST /api/exams/:examId/submit error:', err);
    res.status(500).json({ error: 'Failed to submit exam' });
  }
});

app.get('/api/my-results', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  try {
    const { data, error } = await supabase
      .from('candidate_sessions')
      .select('id, status, score, total_questions, started_at, ended_at, exams ( name )')
      .eq('clerk_user_id', userId)
      .order('started_at', { ascending: false });
    if (error) throw error;

    const results = data.map((r) => ({
      id: r.id,
      exam_name: r.exams?.name,
      status: r.status,
      score: r.score,
      total_questions: r.total_questions,
      started_at: r.started_at,
      ended_at: r.ended_at,
    }));
    res.json({ results });
  } catch (err) {
    console.error('GET /api/my-results error:', err);
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

app.get('/api/exam-logs', requireAuth(), requireTeacher, async (req, res) => {
  const { examId } = req.query;
  if (!examId) return res.status(400).json({ error: 'examId query param is required' });

  try {
    const { data: sessions, error: sessErr } = await supabase
      .from('candidate_sessions')
      .select('id, clerk_user_id, candidate_name, candidate_email')
      .eq('exam_id', examId);
    if (sessErr) throw sessErr;
    if (sessions.length === 0) return res.json({ rows: [] });

    const sessionIds = sessions.map((s) => s.id);
    const { data: logs, error: logErr } = await supabase
      .from('anomaly_logs')
      .select('session_id, violation_type')
      .in('session_id', sessionIds);
    if (logErr) throw logErr;

    const bySession = new Map(sessions.map((s) => [s.id, s]));
    const counts = new Map();

    for (const s of sessions) {
      counts.set(s.clerk_user_id, {
        clerk_user_id: s.clerk_user_id,
        name: s.candidate_name || s.clerk_user_id,
        email: s.candidate_email || '—',
        no_face_count: 0,
        multiple_face_count: 0,
        cell_phone_count: 0,
        prohibited_object_count: 0,
      });
    }

    for (const log of logs) {
      const session = bySession.get(log.session_id);
      if (!session) continue;
      const row = counts.get(session.clerk_user_id);
      const key = VIOLATION_KEYS[log.violation_type];
      if (row && key) row[key] += 1;
    }

    res.json({ rows: Array.from(counts.values()) });
  } catch (err) {
    console.error('GET /api/exam-logs error:', err);
    res.status(500).json({ error: 'Failed to fetch exam logs' });
  }
});

// Per-student drill-down: full violation timeline (including any captured
// evidence snapshot) plus their session/score, for the teacher's review page.
app.get('/api/exam-logs/:examId/:clerkUserId', requireAuth(), requireTeacher, async (req, res) => {
  const { examId, clerkUserId } = req.params;

  try {
    const { data: session, error: sessErr } = await supabase
      .from('candidate_sessions')
      .select('*')
      .eq('exam_id', examId)
      .eq('clerk_user_id', clerkUserId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (sessErr) throw sessErr;
    if (!session) return res.status(404).json({ error: 'No session found for this student on this exam' });

    const { data: logs, error: logErr } = await supabase
      .from('anomaly_logs')
      .select('id, violation_type, detail, warning_count_at_log, evidence_base64, created_at')
      .eq('session_id', session.id)
      .order('created_at', { ascending: true });
    if (logErr) throw logErr;

    res.json({ session, logs });
  } catch (err) {
    console.error('GET /api/exam-logs/:examId/:clerkUserId error:', err);
    res.status(500).json({ error: 'Failed to fetch student detail' });
  }
});

// Lets a teacher reopen an attempt that was auto-terminated, e.g. after
// reviewing the evidence and deciding it was a false positive.
app.post('/api/session/:sessionId/reinstate', requireAuth(), requireTeacher, async (req, res) => {
  const { sessionId } = req.params;
  try {
    const { data, error } = await supabase
      .from('candidate_sessions')
      .update({ status: 'in_progress', ended_at: null })
      .eq('id', sessionId)
      .eq('status', 'terminated')
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'Session is not in a terminated state' });
    res.json({ session: data });
  } catch (err) {
    console.error('POST /api/session/:sessionId/reinstate error:', err);
    res.status(500).json({ error: 'Failed to reinstate session' });
  }
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Phoenix backend listening on :${PORT}`));
