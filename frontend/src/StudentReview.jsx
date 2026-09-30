import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';

const API_URL = import.meta.env.VITE_API_URL;

const LABELS = {
  FACE_NOT_VISIBLE: 'Face Not Visible',
  MULTIPLE_FACES: 'Multiple Faces Detected',
  GAZE_DEVIATION: 'Looking Away From Screen',
  WEBCAM_TAMPERED: 'Webcam Feed Interrupted',
  TAB_SWITCH: 'Tab Switch Detected',
  FULLSCREEN_EXIT: 'Exited Full-Screen Mode',
  CELL_PHONE_DETECTED: 'Cell Phone Detected',
  PROHIBITED_OBJECT_DETECTED: 'Prohibited Object Detected',
  UNIDENTIFIED_OBJECT: 'Unidentified Object Detected',
  COPY_PASTE_ATTEMPT: 'Screen/Tab Modification Attempt',
  EXAM_TERMINATED: 'Exam Terminated',
};

export default function StudentReview() {
  const { examId, userId } = useParams();
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const authedFetch = useCallback(
    async (path, options = {}) => {
      const token = await getToken();
      return fetch(`${API_URL}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
      });
    },
    [getToken]
  );

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    authedFetch(`/api/exam-logs/${examId}/${userId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || 'Failed to load');
        return r.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [authedFetch, examId, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const reinstate = async () => {
    if (!data?.session?.id) return;
    setBusy(true);
    try {
      const res = await authedFetch(`/api/session/${data.session.id}/reinstate`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to reinstate');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="centered">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const { session, logs } = data;

  return (
    <div>
      <button className="muted-btn" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <h2>{session.candidate_name || session.clerk_user_id}</h2>
      <p className="muted">{session.candidate_email}</p>

      <div className="review-summary">
        <span className={`status-pill status-${session.status}`}>{session.status}</span>
        <span>Score: {session.score != null ? `${session.score}/${session.total_questions}` : '—'}</span>
        <span>Started: {new Date(session.started_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</span>
        {session.status === 'terminated' && (
          <button onClick={reinstate} disabled={busy}>
            {busy ? 'Reinstating…' : 'Reinstate'}
          </button>
        )}
      </div>

      <h3>Violation Timeline</h3>
      {logs.length === 0 ? (
        <p className="muted">No violations recorded.</p>
      ) : (
        <div className="timeline">
          {logs.map((log) => (
            <div key={log.id} className="timeline-item">
              <div className="timeline-meta">
                <strong>{LABELS[log.violation_type] || log.violation_type}</strong>
                <span className="muted">
                  {new Date(log.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} · warning #
                  {log.warning_count_at_log}
                </span>
              </div>
              {log.detail && <p className="muted">{log.detail}</p>}
              {log.evidence_base64 && (
                <img src={log.evidence_base64} alt={`Evidence for ${log.violation_type}`} className="evidence-thumb" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
