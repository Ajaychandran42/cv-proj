import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';

const API_URL = import.meta.env.VITE_API_URL;
const emptyQuestion = () => ({ text: '', options: ['', '', '', ''], correctIndex: null });

export default function AddQuestions() {
  const { getToken } = useAuth();
  const [exams, setExams] = useState([]);
  const [examId, setExamId] = useState('');
  const [current, setCurrent] = useState(emptyQuestion());
  const [queued, setQueued] = useState([]);
  const [toast, setToast] = useState(null);

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

  useEffect(() => {
    authedFetch('/api/exams?owned=1')
      .then((r) => r.json())
      .then(({ exams }) => {
        setExams(exams || []);
        if (exams?.[0]) setExamId(exams[0].id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateOption = (i, value) => {
    setCurrent((c) => {
      const options = [...c.options];
      options[i] = value;
      return { ...c, options };
    });
  };

  const showToast = (type, message) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 2500);
  };

  const addQuestion = () => {
    if (!current.text.trim() || current.options.some((o) => !o.trim()) || current.correctIndex === null) {
      showToast('error', 'Fill every field and mark the correct option.');
      return;
    }
    setQueued((q) => [...q, current]);
    setCurrent(emptyQuestion());
  };

  const submitQuestions = async () => {
    const hasCurrent = current.text.trim() && current.options.every((o) => o.trim()) && current.correctIndex !== null;
    const toSend = hasCurrent ? [...queued, current] : queued;
    if (toSend.length === 0 || !examId) {
      showToast('error', 'Add at least one complete question first.');
      return;
    }
    try {
      const res = await authedFetch(`/api/exams/${examId}/questions`, {
        method: 'POST',
        body: JSON.stringify({ questions: toSend }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to submit questions');
      showToast('success', 'Questions submitted successfully');
      setQueued([]);
      setCurrent(emptyQuestion());
    } catch (err) {
      showToast('error', err.message);
    }
  };

  return (
    <div className="form-page">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}
      <h2>Add Questions Page</h2>
      <p className="muted">This is a Add Questions page</p>

      <select value={examId} onChange={(e) => setExamId(e.target.value)} className="select-input">
        {exams.map((exam) => (
          <option key={exam.id} value={exam.id}>
            {exam.name}
          </option>
        ))}
        {exams.length === 0 && <option value="">No exams yet — create one first</option>}
      </select>

      <label>
        New Question
        <input value={current.text} onChange={(e) => setCurrent((c) => ({ ...c, text: e.target.value }))} />
      </label>

      {current.options.map((opt, i) => (
        <div key={i} className="option-row">
          <label className="option-input">
            Option {i + 1}
            <input value={opt} onChange={(e) => updateOption(i, e.target.value)} />
          </label>
          <label className="option-checkbox">
            <input
              type="checkbox"
              checked={current.correctIndex === i}
              onChange={() => setCurrent((c) => ({ ...c, correctIndex: i }))}
            />
            Correct Option {i + 1}
          </label>
        </div>
      ))}

      <div className="button-row">
        <button onClick={addQuestion}>Add Question</button>
        <button onClick={submitQuestions} className="primary">
          Submit Questions
        </button>
      </div>

      {queued.length > 0 && <p className="muted">{queued.length} question(s) queued for submission.</p>}
    </div>
  );
}
