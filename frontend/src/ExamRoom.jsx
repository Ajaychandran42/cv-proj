import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth, useUser } from '@clerk/clerk-react';
import { FaceLandmarker, ObjectDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import Layout from './Layout.jsx';

const API_URL = import.meta.env.VITE_API_URL;
const TERMINATION_THRESHOLD = 10;
const COOLDOWN_MS = 4000; // per-violation-type cooldown so one issue doesn't spam strikes
const YAW_LIMIT_DEG = 28;
const PITCH_LIMIT_DEG = 22;
const OBJECT_DETECT_EVERY_N_FRAMES = 5; // object detection is heavier than face landmarks

const CELL_PHONE_LABELS = new Set(['cell phone']);
const PROHIBITED_LABELS = new Set(['book', 'laptop', 'keyboard', 'remote', 'tv', 'mouse']);

const V = {
  FACE_NOT_VISIBLE: 'FACE_NOT_VISIBLE',
  MULTIPLE_FACES: 'MULTIPLE_FACES',
  GAZE_DEVIATION: 'GAZE_DEVIATION',
  WEBCAM_TAMPERED: 'WEBCAM_TAMPERED',
  TAB_SWITCH: 'TAB_SWITCH',
  FULLSCREEN_EXIT: 'FULLSCREEN_EXIT',
  CELL_PHONE_DETECTED: 'CELL_PHONE_DETECTED',
  PROHIBITED_OBJECT_DETECTED: 'PROHIBITED_OBJECT_DETECTED',
};

const VIOLATION_LABEL = {
  [V.FACE_NOT_VISIBLE]: 'Face Not Visible',
  [V.MULTIPLE_FACES]: 'Multiple Faces Detected',
  [V.GAZE_DEVIATION]: 'Looking Away From Screen',
  [V.WEBCAM_TAMPERED]: 'Webcam Feed Interrupted',
  [V.TAB_SWITCH]: 'Tab Switch Detected',
  [V.FULLSCREEN_EXIT]: 'Exited Full-Screen Mode',
  [V.CELL_PHONE_DETECTED]: 'Cell Phone Detected',
  [V.PROHIBITED_OBJECT_DETECTED]: 'Prohibited Object Detected',
};

// Extracts yaw/pitch (degrees) from MediaPipe's 4x4 facial transformation matrix
// (column-major Float32Array, length 16 — we read the 3x3 rotation block).
function getYawPitchFromMatrix(m) {
  const r20 = m[2], r21 = m[6], r22 = m[10];
  const yaw = Math.atan2(-r20, Math.sqrt(r21 * r21 + r22 * r22)) * (180 / Math.PI);
  const pitch = Math.atan2(r21, r22) * (180 / Math.PI);
  return { yaw, pitch };
}

function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export default function ExamRoom() {
  const { examId } = useParams();
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const { user } = useUser();

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const faceLandmarkerRef = useRef(null);
  const objectDetectorRef = useRef(null);
  const rafRef = useRef(null);
  const frameCountRef = useRef(0);
  const sessionIdRef = useRef(null);
  const lastViolationAtRef = useRef({});
  const warningCountRef = useRef(0);
  const answersRef = useRef({}); // { [questionId]: selectedOption 1-4 }

  const [exam, setExam] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [warningCount, setWarningCount] = useState(0);
  const [modal, setModal] = useState(null); // { type }
  const [terminated, setTerminated] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [toast, setToast] = useState(null);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState(null);

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

  const sendStrike = useCallback(
    (violationType, detail) => {
      authedFetch('/api/strike', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          violationType,
          detail,
          warningCount: warningCountRef.current,
        }),
      }).catch((err) => console.error('Strike log failed:', err));
    },
    [authedFetch]
  );

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    videoRef.current?.srcObject?.getTracks()?.forEach((t) => t.stop());
    faceLandmarkerRef.current?.close?.();
    objectDetectorRef.current?.close?.();
  }, []);

  const terminateExam = useCallback(
    async (reason) => {
      setTerminated(true);
      stopCamera();
      try {
        await authedFetch(`/api/session/${sessionIdRef.current}/terminate`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      } catch (err) {
        console.error('Termination log failed:', err);
      }
    },
    [authedFetch, stopCamera]
  );

  const raiseViolation = useCallback(
    (type, detail) => {
      const now = performance.now();
      const last = lastViolationAtRef.current[type] || 0;
      if (now - last < COOLDOWN_MS) return;
      lastViolationAtRef.current[type] = now;

      warningCountRef.current += 1;
      const count = warningCountRef.current;
      setWarningCount(count);
      setModal({ type });
      sendStrike(type, detail);

      if (count >= TERMINATION_THRESHOLD) {
        terminateExam(`Warning threshold reached (${count}/${TERMINATION_THRESHOLD})`);
      }
    },
    [sendStrike, terminateExam]
  );

  const submitExam = useCallback(
    async (autoSubmitted = false) => {
      stopCamera();
      try {
        const res = await authedFetch(`/api/exams/${examId}/submit`, {
          method: 'POST',
          body: JSON.stringify({ sessionId: sessionIdRef.current, answers: answersRef.current }),
        });
        if (!res.ok) throw new Error('Submission failed');
        setSubmitted(true);
        setToast('User Logs Saved!!');
        setTimeout(() => setToast(null), 3000);
      } catch (err) {
        console.error('Submit failed:', err);
        setInitError(autoSubmitted ? 'Time expired, but submission failed — please contact your instructor.' : err.message);
      }
    },
    [authedFetch, examId, stopCamera]
  );

  // ---------- Init: fetch exam+questions, start session, camera, CV models, listeners ----------
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const qRes = await authedFetch(`/api/exams/${examId}/questions`);
        if (!qRes.ok) throw new Error('Failed to load exam');
        const { exam, questions } = await qRes.json();
        if (cancelled) return;
        setExam(exam);
        setQuestions(questions);
        setSecondsLeft(exam.duration_minutes * 60);

        const sRes = await authedFetch('/api/session/start', {
          method: 'POST',
          body: JSON.stringify({
            examId,
            candidateName: user?.fullName,
            candidateEmail: user?.primaryEmailAddress?.emailAddress,
          }),
        });
        if (!sRes.ok) throw new Error('Failed to start session');
        const { session } = await sRes.json();
        sessionIdRef.current = session.id;

        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 }, audio: false });
        if (cancelled) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        stream.getVideoTracks()[0].addEventListener('ended', () => {
          raiseViolation(V.WEBCAM_TAMPERED, 'Video track ended unexpectedly');
        });

        const filesetResolver = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm'
        );

        const [faceLandmarker, objectDetector] = await Promise.all([
          FaceLandmarker.createFromOptions(filesetResolver, {
            baseOptions: {
              modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
              delegate: 'GPU',
            },
            outputFacialTransformationMatrixes: true,
            runningMode: 'VIDEO',
            numFaces: 3,
          }),
          ObjectDetector.createFromOptions(filesetResolver, {
            baseOptions: {
              modelAssetPath:
                'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite',
              delegate: 'GPU',
            },
            scoreThreshold: 0.5,
            runningMode: 'VIDEO',
          }),
        ]);
        if (cancelled) return;
        faceLandmarkerRef.current = faceLandmarker;
        objectDetectorRef.current = objectDetector;
        setReady(true);

        let blackFrameStreak = 0;
        const loop = () => {
          const video = videoRef.current;
          if (!video || video.readyState < 2 || !faceLandmarkerRef.current) {
            rafRef.current = requestAnimationFrame(loop);
            return;
          }
          const now = performance.now();
          frameCountRef.current += 1;

          // --- Face presence / count / gaze ---
          const faceResult = faceLandmarkerRef.current.detectForVideo(video, now);
          const faceCount = faceResult.faceLandmarks?.length || 0;
          if (faceCount === 0) {
            raiseViolation(V.FACE_NOT_VISIBLE, 'No face in frame');
          } else if (faceCount >= 2) {
            raiseViolation(V.MULTIPLE_FACES, `${faceCount} faces in frame`);
          } else {
            const matrix = faceResult.facialTransformationMatrixes?.[0]?.data;
            if (matrix) {
              const { yaw, pitch } = getYawPitchFromMatrix(matrix);
              if (Math.abs(yaw) > YAW_LIMIT_DEG || Math.abs(pitch) > PITCH_LIMIT_DEG) {
                raiseViolation(V.GAZE_DEVIATION, `yaw=${yaw.toFixed(1)}° pitch=${pitch.toFixed(1)}°`);
              }
            }
          }

          // --- Object detection (cell phone / prohibited items), sampled every N frames ---
          if (objectDetectorRef.current && frameCountRef.current % OBJECT_DETECT_EVERY_N_FRAMES === 0) {
            const objResult = objectDetectorRef.current.detectForVideo(video, now);
            for (const det of objResult.detections || []) {
              const label = det.categories?.[0]?.categoryName?.toLowerCase();
              if (!label) continue;
              if (CELL_PHONE_LABELS.has(label)) {
                raiseViolation(V.CELL_PHONE_DETECTED, `detected: ${label}`);
              } else if (PROHIBITED_LABELS.has(label)) {
                raiseViolation(V.PROHIBITED_OBJECT_DETECTED, `detected: ${label}`);
              }
            }
          }

          // --- Cheap black-frame / covered-camera sample, ~once/sec ---
          if (frameCountRef.current % 30 === 0) {
            const canvas = canvasRef.current;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            canvas.width = 32;
            canvas.height = 24;
            ctx.drawImage(video, 0, 0, 32, 24);
            const { data } = ctx.getImageData(0, 0, 32, 24);
            let sum = 0;
            for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
            const avgBrightness = sum / (32 * 24 * 3);
            if (avgBrightness < 5) {
              blackFrameStreak += 1;
              if (blackFrameStreak > 30) {
                raiseViolation(V.WEBCAM_TAMPERED, 'Feed appears black/covered');
                blackFrameStreak = 0;
              }
            } else {
              blackFrameStreak = 0;
            }
          }

          rafRef.current = requestAnimationFrame(loop);
        };
        rafRef.current = requestAnimationFrame(loop);
      } catch (err) {
        console.error('ExamRoom init failed:', err);
        if (!cancelled) setInitError(err.message || 'Failed to initialize exam environment');
      }
    }

    init();

    const onBlur = () => raiseViolation(V.TAB_SWITCH, 'window blur');
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) raiseViolation(V.FULLSCREEN_EXIT, 'exited full-screen');
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.documentElement.requestFullscreen?.().catch(() => {});

    return () => {
      cancelled = true;
      stopCamera();
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  // ---------- Countdown timer ----------
  useEffect(() => {
    if (!exam || terminated || submitted) return;
    if (secondsLeft <= 0) {
      submitExam(true);
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [exam, secondsLeft, terminated, submitted, submitExam]);

  const selectOption = (questionId, optionNumber) => {
    answersRef.current = { ...answersRef.current, [questionId]: optionNumber };
    setAnswers(answersRef.current);
  };

  if (terminated) {
    return (
      <div className="centered termination-screen">
        <h1>Exam Terminated</h1>
        <p>Your exam was ended automatically after repeated integrity violations.</p>
        <p>Please contact your instructor.</p>
      </div>
    );
  }

  if (submitted) {
    return (
      <Layout>
        {toast && <div className="toast toast-success">{toast}</div>}
        <div className="centered submitted-screen">
          <h1>Test is Submitted Successfully!!!</h1>
          <p>You can safely close the window now.</p>
          <button onClick={() => navigate('/dashboard')}>Go Back To Home</button>
        </div>
      </Layout>
    );
  }

  if (initError) {
    return (
      <div className="centered">
        <div className="error-banner">{initError}</div>
      </div>
    );
  }

  if (!exam || questions.length === 0) {
    return <div className="centered">Loading exam…</div>;
  }

  const currentQuestion = questions[currentIndex];
  const options = [currentQuestion.option_1, currentQuestion.option_2, currentQuestion.option_3, currentQuestion.option_4];

  return (
    <div className="exam-room">
      {modal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-icon">✕</div>
            <h2>{VIOLATION_LABEL[modal.type]}</h2>
            <p>Action has been Recorded</p>
            <button className="modal-ok" onClick={() => setModal(null)}>
              OK
            </button>
          </div>
        </div>
      )}

      <div className="exam-topbar">
        <span className="bell">🔔</span>
        <div className="topbar-right">
          <span>Hello, Student</span>
        </div>
      </div>

      {!ready && <div className="centered">Loading proctoring engine…</div>}

      <div className="exam-content">
        <div className="exam-question-panel">
          <h3>Question {currentIndex + 1}:</h3>
          <p>{currentQuestion.question_text}</p>
          <div className="option-list">
            {options.map((opt, i) => (
              <label key={i} className="radio-row">
                <input
                  type="radio"
                  name={`q-${currentQuestion.id}`}
                  checked={answers[currentQuestion.id] === i + 1}
                  onChange={() => selectOption(currentQuestion.id, i + 1)}
                />
                {opt}
              </label>
            ))}
          </div>
        </div>

        <div className="exam-side-panel">
          <div className="exam-meta-bar">
            <span>
              Questions: {currentIndex + 1}/{questions.length}
            </span>
            <span>Time Left: {formatTime(secondsLeft)}</span>
            <button className="finish-btn" onClick={() => submitExam(false)}>
              Finish Test
            </button>
          </div>

          <div className="question-grid">
            {questions.map((q, i) => (
              <button
                key={q.id}
                className={`question-grid-btn${i === currentIndex ? ' current' : ''}${answers[q.id] ? ' answered' : ''}`}
                onClick={() => setCurrentIndex(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>

          <video ref={videoRef} className="webcam-mini" muted playsInline />
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
      </div>
    </div>
  );
}
