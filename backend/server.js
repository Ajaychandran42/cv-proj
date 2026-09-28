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

// Create an exam (teacher only)
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

// List exams — ?owned=1 (teacher's own, any window) or default (currently "active" exams for anyone)
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

// Add one or more MCQ questions to an exam (teacher only, must own the exam)
app.post('/api/exams/:examId/questions', requireAuth(), requireTeacher, async (req, res) => {
  const { userId } = getAuth(req);
  const { examId } = req.params;
  const { questions } = req.body; // [{ text, options: [4 strings], correctIndex: 0-3 }]

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

// Fetch an exam + its questions for the student taking the test (correct_option stripped)
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
// Candidate sessions (one exam attempt)
// ============================================================

app.post('/api/session/start', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const { examId, candidateName, candidateEmail } = req.body;
  if (!examId) return res.status(400).json({ error: 'examId is required' });

  try {
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
    res.status(201).json({ session: data });
  } catch (err) {
    console.error('POST /api/session/start error:', err);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Log a single anomaly (fire-and-forget from the client, cooldown enforced client-side)
app.post('/api/strike', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const { sessionId, violationType, detail, warningCount } = req.body;
  if (!sessionId || !violationType) {
    return res.status(400).json({ error: 'sessionId and violationType are required' });
  }

  try {
    const { data, error } = await supabase
      .from('anomaly_logs')
      .insert({
        session_id: sessionId,
        clerk_user_id: userId,
        violation_type: violationType,
        detail: detail || null,
        warning_count_at_log: warningCount ?? 0,
      })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ log: data });
  } catch (err) {
    console.error('POST /api/strike error:', err);
    res.status(500).json({ error: 'Failed to log anomaly' });
  }
});

// Terminate a session (warning threshold reached)
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

// Submit answers, score the attempt server-side, mark session completed
app.post('/api/exams/:examId/submit', requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const { examId } = req.params;
  const { sessionId, answers } = req.body; // answers: { [questionId]: selectedOption(1-4) }

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

// A student's own past attempts (for the Result page)
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

// ============================================================
// Teacher-only: aggregated cheat log for one exam
// ============================================================
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
    const counts = new Map(); // clerk_user_id -> { name, email, ...counts }

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

// ---------- Central error handler ----------
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Phoenix backend listening on :${PORT}`));
