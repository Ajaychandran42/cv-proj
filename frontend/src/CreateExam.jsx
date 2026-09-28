import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';

const API_URL = import.meta.env.VITE_API_URL;
const emptyForm = { name: '', totalQuestions: '', durationMinutes: '', liveAt: '', deadAt: '' };

export default function CreateExam() {
  const { getToken } = useAuth();
  const [form, setForm] = useState(emptyForm);
  const [toast, setToast] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const token = await getToken();
      const res = await fetch(`${API_URL}/api/exams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: form.name,
          totalQuestions: Number(form.totalQuestions),
          durationMinutes: Number(form.durationMinutes),
          liveAt: form.liveAt,
          deadAt: form.deadAt,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create exam');
      setToast({ type: 'success', message: 'Exam Created successfully' });
      setForm(emptyForm);
    } catch (err) {
      setToast({ type: 'error', message: err.message });
    } finally {
      setSubmitting(false);
      setTimeout(() => setToast(null), 3000);
    }
  };

  return (
    <div className="form-page">
      {toast && <div className={`toast toast-${toast.type}`}>{toast.message}</div>}
      <h2>Create Exam</h2>
      <form onSubmit={submit} className="stacked-form">
        <label>
          Exam Name *
          <input required value={form.name} onChange={update('name')} />
        </label>
        <label>
          Total Number of Questions *
          <input required type="number" min="1" value={form.totalQuestions} onChange={update('totalQuestions')} />
        </label>
        <label>
          Exam Duration (minutes) *
          <input required type="number" min="1" value={form.durationMinutes} onChange={update('durationMinutes')} />
        </label>
        <label>
          Live Date and Time *
          <input required type="datetime-local" value={form.liveAt} onChange={update('liveAt')} />
        </label>
        <label>
          Dead Date and Time *
          <input required type="datetime-local" value={form.deadAt} onChange={update('deadAt')} />
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create Exam'}
        </button>
      </form>
    </div>
  );
}
