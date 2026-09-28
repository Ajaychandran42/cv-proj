import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL;

export default function HomeDashboard() {
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [exams, setExams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchExams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/exams`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load exams');
      const { exams } = await res.json();
      setExams(exams);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    fetchExams();
  }, [fetchExams]);

  return (
    <div>
      <h2>All Active Exams</h2>
      {loading && <p>Loading…</p>}
      {error && <div className="error-banner">{error}</div>}

      <div className="exam-grid">
        {exams.map((exam) => (
          <button key={exam.id} className="exam-card" onClick={() => navigate(`/exam/${exam.id}`)}>
            <div className="exam-card-thumb" />
            <div className="exam-card-body">
              <h3>{exam.name}</h3>
              <span className="exam-tag">MCQ</span>
              <div className="exam-card-meta">
                <span>{exam.total_questions}ques</span>
                <span>{exam.duration_minutes} min</span>
              </div>
            </div>
          </button>
        ))}
        {!loading && exams.length === 0 && <p>No active exams right now.</p>}
      </div>
    </div>
  );
}
