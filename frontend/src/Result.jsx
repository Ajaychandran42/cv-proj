import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';

const API_URL = import.meta.env.VITE_API_URL;

export default function Result() {
  const { getToken } = useAuth();
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchResults = useCallback(async () => {
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/my-results`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load results');
      const { results } = await res.json();
      setResults(results || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  return (
    <div>
      <h2>Your Results</h2>
      {error && <div className="error-banner">{error}</div>}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <table className="logs-table">
          <thead>
            <tr>
              <th>Exam</th>
              <th>Score</th>
              <th>Status</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td>{r.exam_name}</td>
                <td>{r.score != null ? `${r.score}/${r.total_questions}` : '—'}</td>
                <td>
                  <span className={`status-pill status-${r.status}`}>{r.status}</span>
                </td>
                <td>
                  {r.ended_at
                    ? new Date(r.ended_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST'
                    : '—'}
                </td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center' }}>
                  No attempts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
