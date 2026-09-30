import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL;

export default function ExamLogs() {
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [exams, setExams] = useState([]);
  const [examId, setExamId] = useState('');
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const authedFetch = useCallback(
    async (path) => {
      const token = await getToken();
      return fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    },
    [getToken]
  );

  useEffect(() => {
    authedFetch('/api/exams?owned=1')
      .then((r) => r.json())
      .then(({ exams }) => {
        setExams(exams || []);
        if (exams?.[0]) setExamId(exams[0].id);
      })
      .catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!examId) return;
    setLoading(true);
    setError(null);
    authedFetch(`/api/exam-logs?examId=${examId}`)
      .then((r) => r.json())
      .then(({ rows }) => setRows(rows || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [examId, authedFetch]);

  const visibleRows = rows.filter((r) => `${r.name} ${r.email}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div>
      <h2>Cheating Log</h2>

      <select value={examId} onChange={(e) => setExamId(e.target.value)} className="select-input">
        {exams.map((exam) => (
          <option key={exam.id} value={exam.id}>
            {exam.name}
          </option>
        ))}
      </select>

      <input
        placeholder="Filter by Name or Email"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="text-input"
      />

      {error && <div className="error-banner">{error}</div>}
      {loading ? (
        <p>Loading…</p>
      ) : (
        <table className="logs-table">
          <thead>
            <tr>
              <th>Sno</th>
              <th>Name</th>
              <th>Email</th>
              <th>No Face Count</th>
              <th>Multiple Face Count</th>
              <th>Cell Phone Count</th>
              <th>Prohibited Object Count</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r, i) => (
              <tr key={r.clerk_user_id}>
                <td>{i + 1}</td>
                <td>{r.name}</td>
                <td>{r.email}</td>
                <td>{r.no_face_count}</td>
                <td>{r.multiple_face_count}</td>
                <td>{r.cell_phone_count}</td>
                <td>{r.prohibited_object_count}</td>
                <td>
                  <button onClick={() => navigate(`/student-review/${examId}/${r.clerk_user_id}`)}>View</button>
                </td>
              </tr>
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center' }}>
                  No data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
