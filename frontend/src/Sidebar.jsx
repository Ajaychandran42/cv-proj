import { NavLink } from 'react-router-dom';

export default function Sidebar({ role }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">◆</span> Phoenix
      </div>

      <div className="nav-section">
        <div className="nav-label">HOME</div>
        <NavLink to="/dashboard" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          Dashboard
        </NavLink>
      </div>

      <div className="nav-section">
        <div className="nav-label">STUDENT</div>
        <NavLink to="/dashboard" className="nav-link">Exams</NavLink>
        <NavLink to="/result" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          Result
        </NavLink>
      </div>

      {role === 'teacher' && (
        <div className="nav-section">
          <div className="nav-label">TEACHER</div>
          <NavLink to="/create-exam" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Create Exam
          </NavLink>
          <NavLink to="/add-questions" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Add Questions
          </NavLink>
          <NavLink to="/exam-logs" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Exam Logs
          </NavLink>
        </div>
      )}
    </aside>
  );
}
