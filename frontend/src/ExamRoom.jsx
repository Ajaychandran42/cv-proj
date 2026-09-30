import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth, useUser } from '@clerk/clerk-react';
import { FaceLandmarker, ObjectDetector, FilesetResolver } from '@mediapipe/tasks-vision';
import seedrandom from 'seedrandom';
import Layout from './Layout.jsx';

const API_URL = import.meta.env.VITE_API_URL;
const COOLDOWN_MS = 4000;
const OBJECT_DETECT_EVERY_N_FRAMES = 5;

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
  UNIDENTIFIED_OBJECT: 'UNIDENTIFIED_OBJECT',
  COPY_PASTE_ATTEMPT: 'COPY_PASTE_ATTEMPT'
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
  [V.UNIDENTIFIED_OBJECT]: 'Unidentified Object Detected',
  [V.COPY_PASTE_ATTEMPT]: 'Screen/Tab Modification Attempt',
};

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
  const debugCanvasRef = useRef(null);
  const faceLandmarkerRef = useRef(null);
  const objectDetectorRef = useRef(null);
  const rafRef = useRef(null);
  const frameCountRef = useRef(0);
  const sessionIdRef = useRef(null);
  const lastViolationAtRef = useRef({});
  const warningCountRef = useRef(0);
  const answersRef = useRef({});
  
  const bgSubtractorRef = useRef(null);
  const prevFrameMatRef = useRef(null);

  const [exam, setExam] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [originalQuestionsMap, setOriginalQuestionsMap] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [warningCount, setWarningCount] = useState(0);
  const [modal, setModal] = useState(null);
  const [terminated, setTerminated] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [toast, setToast] = useState(null);
  const [initError, setInitError] = useState(null);
  
  const [systemCheckPassed, setSystemCheckPassed] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [showDebug, setShowDebug] = useState(false);
  const [ready, setReady] = useState(false);
  
  const cvStateRef = useRef({ prevFrameData: null, baselineYaw: 0, baselinePitch: 0, calibrated: false, multiFaceStreak: 0, noFaceStreak: 0, staticFeedStreak: 0 });

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
      let evidenceBase64 = null;
      if (videoRef.current && canvasRef.current) {
         try {
            const canvas = canvasRef.current;
            canvas.width = 320;
            canvas.height = 240;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(videoRef.current, 0, 0, 320, 240);
            evidenceBase64 = canvas.toDataURL('image/jpeg', 0.8);
         } catch (e) {
            console.warn('Evidence capture failed', e);
         }
      }

      authedFetch('/api/strike', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          violationType,
          detail,
          evidenceBase64,
          warningCount: warningCountRef.current,
        }),
      }).catch((err) => console.error('Strike log failed:', err));
    },
    [authedFetch]
  );

  const autoSaveAnswers = useCallback(() => {
    if (!sessionIdRef.current || terminated || submitted) return;
    authedFetch(`/api/session/${sessionIdRef.current}/autosave`, {
      method: 'PATCH',
      body: JSON.stringify({ answers: answersRef.current }),
    }).catch(err => console.error('Autosave failed:', err));
  }, [authedFetch, terminated, submitted]);

  useEffect(() => {
    const interval = setInterval(() => autoSaveAnswers(), 10000);
    return () => clearInterval(interval);
  }, [autoSaveAnswers]);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    videoRef.current?.srcObject?.getTracks()?.forEach((t) => t.stop());
    faceLandmarkerRef.current?.close?.();
    objectDetectorRef.current?.close?.();
    if (bgSubtractorRef.current) bgSubtractorRef.current.delete();
    if (prevFrameMatRef.current) prevFrameMatRef.current.delete();
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

      if (exam && count >= (exam.termination_threshold || 10)) {
        terminateExam(`Warning threshold reached (${count}/${exam.termination_threshold || 10})`);
      }
    },
    [sendStrike, terminateExam, exam]
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

  useEffect(() => {
    const onContextMenu = (e) => {
      e.preventDefault();
      raiseViolation(V.COPY_PASTE_ATTEMPT, 'Right click attempt');
    };
    const onCopy = (e) => {
      e.preventDefault();
      raiseViolation(V.COPY_PASTE_ATTEMPT, 'Copy/Paste attempt');
    };
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && ['c', 'v', 'p'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        raiseViolation(V.COPY_PASTE_ATTEMPT, 'Copy/Paste shortcut attempt');
      }
    };
    
    if (systemCheckPassed) {
      document.addEventListener('contextmenu', onContextMenu);
      document.addEventListener('copy', onCopy);
      document.addEventListener('paste', onCopy);
      document.addEventListener('keydown', onKeyDown);
      
      const onBlur = () => raiseViolation(V.TAB_SWITCH, 'window blur');
      const onFullscreenChange = () => {
        if (!document.fullscreenElement) raiseViolation(V.FULLSCREEN_EXIT, 'exited full-screen');
      };
      
      const blurTimer = setTimeout(() => {
        window.addEventListener('blur', onBlur);
        document.addEventListener('fullscreenchange', onFullscreenChange);
      }, 1500);

      return () => {
        document.removeEventListener('contextmenu', onContextMenu);
        document.removeEventListener('copy', onCopy);
        document.removeEventListener('paste', onCopy);
        document.removeEventListener('keydown', onKeyDown);
        clearTimeout(blurTimer);
        window.removeEventListener('blur', onBlur);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
      };
    }
  }, [systemCheckPassed, raiseViolation]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const qRes = await authedFetch(`/api/exams/${examId}/questions`);
        if (!qRes.ok) throw new Error('Failed to load exam');
        const { exam, questions } = await qRes.json();
        if (cancelled) return;
        setExam(exam);
        
        const sRes = await authedFetch('/api/session/start', {
          method: 'POST',
          body: JSON.stringify({
            examId,
            candidateName: user?.fullName,
            candidateEmail: user?.primaryEmailAddress?.emailAddress,
          }),
        });
        if (!sRes.ok) throw new Error('Failed to start session');
        const { session, exam: examData } = await sRes.json();
        if (cancelled) return;
        
        let shuffledQuestions = [...questions];
        let originalMap = {};
        if (examData?.shuffle_questions) {
          const rng = seedrandom(session.id);
          shuffledQuestions.sort(() => 0.5 - rng());
          shuffledQuestions.forEach(q => {
            let opts = [q.option_1, q.option_2, q.option_3, q.option_4];
            let originalIndices = [1,2,3,4];
            for(let i=3; i>0; i--) {
              const j = Math.floor(rng() * (i + 1));
              [opts[i], opts[j]] = [opts[j], opts[i]];
              [originalIndices[i], originalIndices[j]] = [originalIndices[j], originalIndices[i]];
            }
            q.option_1 = opts[0]; q.option_2 = opts[1]; q.option_3 = opts[2]; q.option_4 = opts[3];
            originalMap[q.id] = originalIndices;
          });
        } else {
          shuffledQuestions.forEach(q => { originalMap[q.id] = [1,2,3,4]; });
        }
        setOriginalQuestionsMap(originalMap);
        setQuestions(shuffledQuestions);

        sessionIdRef.current = session.id;
        if (session.status !== 'in_progress') {
          setTerminated(true);
          return;
        }
        if (session.answers) {
          answersRef.current = session.answers;
          setAnswers(session.answers);
        }
        if (session.started_at) {
           const elapsedSecs = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000);
           setSecondsLeft(Math.max((exam.duration_minutes * 60) - elapsedSecs, 0));
        } else {
           setSecondsLeft(exam.duration_minutes * 60);
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720, facingMode: 'user' },
        });
        if (cancelled) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await new Promise((res) => (videoRef.current.onloadedmetadata = res));
          videoRef.current.play();
        }

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
        
        if (window.cv) {
           bgSubtractorRef.current = new window.cv.BackgroundSubtractorMOG2(500, 16, true);
           prevFrameMatRef.current = new window.cv.Mat(480, 640, window.cv.CV_8UC4);
        }

        setReady(true);
        
      } catch (err) {
        console.error('ExamRoom init failed:', err);
        if (!cancelled) setInitError(err.message || 'Failed to initialize exam environment');
      }
    }

    init();

    return () => {
      cancelled = true;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  useEffect(() => {
    if (!exam || terminated || submitted || !systemCheckPassed) return;
    if (secondsLeft <= 0) {
      submitExam(true);
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [exam, secondsLeft, terminated, submitted, submitExam, systemCheckPassed]);

  const startCVLoop = useCallback(() => {
    let blackFrameStreak = 0;
    let unidentifiedObjStreak = 0;
    
    const loop = () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !faceLandmarkerRef.current) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }
      const now = performance.now();
      frameCountRef.current += 1;
      
      const faceResult = faceLandmarkerRef.current.detectForVideo(video, now);
      const faceCount = faceResult.faceLandmarks?.length || 0;
      
      if (faceCount === 0) {
        cvStateRef.current.noFaceStreak++;
        cvStateRef.current.multiFaceStreak = 0;
        if (cvStateRef.current.noFaceStreak > 5) {
           raiseViolation(V.FACE_NOT_VISIBLE, 'No face in frame for 5 frames');
        }
      } else if (faceCount >= 2) {
        cvStateRef.current.multiFaceStreak++;
        cvStateRef.current.noFaceStreak = 0;
        if (cvStateRef.current.multiFaceStreak > 5) {
           raiseViolation(V.MULTIPLE_FACES, `${faceCount} faces in frame`);
        }
      } else {
        cvStateRef.current.noFaceStreak = 0;
        cvStateRef.current.multiFaceStreak = 0;
        
        const matrix = faceResult.facialTransformationMatrixes?.[0]?.data;
        if (matrix && cvStateRef.current.calibrated) {
          const { yaw, pitch } = getYawPitchFromMatrix(matrix);
          const diffYaw = Math.abs(yaw - cvStateRef.current.baselineYaw);
          const diffPitch = Math.abs(pitch - cvStateRef.current.baselinePitch);
          if (diffYaw > 20 || diffPitch > 20) {
            raiseViolation(V.GAZE_DEVIATION, `yaw diff=${diffYaw.toFixed(1)}° pitch diff=${diffPitch.toFixed(1)}°`);
          }
        }
        
        if (showDebug && debugCanvasRef.current) {
           const dctx = debugCanvasRef.current.getContext('2d');
           dctx.clearRect(0, 0, debugCanvasRef.current.width, debugCanvasRef.current.height);
           dctx.fillStyle = 'red';
           for(let i=468; i<=477; i++) {
              const pt = faceResult.faceLandmarks[0][i];
              if(pt) {
                 const x = pt.x * debugCanvasRef.current.width;
                 const y = pt.y * debugCanvasRef.current.height;
                 dctx.fillRect(debugCanvasRef.current.width - x - 2, y - 2, 4, 4);
              }
           }
        }
      }

      if (objectDetectorRef.current && frameCountRef.current % OBJECT_DETECT_EVERY_N_FRAMES === 0) {
        const objResult = objectDetectorRef.current.detectForVideo(video, now);
        for (const det of objResult.detections || []) {
          const label = det.categories?.[0]?.categoryName?.toLowerCase();
          const score = det.categories?.[0]?.score || 0;
          if (!label) continue;
          if (CELL_PHONE_LABELS.has(label)) {
            raiseViolation(V.CELL_PHONE_DETECTED, `detected: ${label} (conf: ${score.toFixed(2)})`);
          } else if (PROHIBITED_LABELS.has(label)) {
            raiseViolation(V.PROHIBITED_OBJECT_DETECTED, `detected: ${label} (conf: ${score.toFixed(2)})`);
          }
        }
      }

      if (frameCountRef.current % 15 === 0 && window.cv && bgSubtractorRef.current) {
         try {
           const canvas = canvasRef.current;
           const ctx = canvas.getContext('2d', { willReadFrequently: true });
           canvas.width = 640;
           canvas.height = 480;
           ctx.drawImage(video, 0, 0, 640, 480);
           
           let src = window.cv.imread(canvas);
           let fgmask = new window.cv.Mat();
           let gray = new window.cv.Mat();
           
           window.cv.cvtColor(src, gray, window.cv.COLOR_RGBA2GRAY);
           
           let lap = new window.cv.Mat();
           window.cv.Laplacian(gray, lap, window.cv.CV_64F);
           let mean = new window.cv.Mat();
           let stddev = new window.cv.Mat();
           window.cv.meanStdDev(lap, mean, stddev);
           let blurVariance = stddev.data64F[0] * stddev.data64F[0];
           if (blurVariance < 50) {
              raiseViolation(V.WEBCAM_TAMPERED, 'Webcam feed is extremely blurry or covered');
           }
           
           if (prevFrameMatRef.current && prevFrameMatRef.current.rows > 0) {
              let diff = new window.cv.Mat();
              window.cv.absdiff(gray, prevFrameMatRef.current, diff);
              let diffSum = window.cv.sumElements(diff);
              if (diffSum[0] < 1000) {
                 cvStateRef.current.staticFeedStreak++;
                 if (cvStateRef.current.staticFeedStreak > 5) {
                    raiseViolation(V.WEBCAM_TAMPERED, 'Frozen / Static webcam feed detected');
                 }
              } else {
                 cvStateRef.current.staticFeedStreak = 0;
              }
              diff.delete();
           }
           gray.copyTo(prevFrameMatRef.current);
           
           bgSubtractorRef.current.apply(src, fgmask);
           let nonZero = window.cv.countNonZero(fgmask);
           let thresholdObj = (640 * 480) * 0.2;
           if (nonZero > thresholdObj && faceCount >= 1) {
              unidentifiedObjStreak++;
              if (unidentifiedObjStreak > 3) {
                 raiseViolation(V.UNIDENTIFIED_OBJECT, 'Something large entered the frame');
              }
           } else {
              unidentifiedObjStreak = 0;
           }
           
           src.delete(); fgmask.delete(); gray.delete(); lap.delete(); mean.delete(); stddev.delete();
         } catch (e) {
            console.error('OpenCV pass failed', e);
         }
      }

      if (frameCountRef.current % 30 === 0 && !window.cv) {
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
          if (blackFrameStreak > 2) {
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
  }, [raiseViolation, showDebug]);
  
  useEffect(() => {
     if (systemCheckPassed && ready) {
        document.documentElement.requestFullscreen?.().catch(() => {});
        startCVLoop();
     }
  }, [systemCheckPassed, ready, startCVLoop]);

  const selectOption = (questionId, optionNumber) => {
    answersRef.current = { ...answersRef.current, [questionId]: optionNumber };
    setAnswers({ ...answersRef.current });
  };
  
  const runCalibration = useCallback(async () => {
    setCalibrating(true);
    setCalibrationProgress(0);
    
    let sumYaw = 0;
    let sumPitch = 0;
    let frames = 0;
    
    const sampleCount = 30;
    
    const calibrateLoop = () => {
       const video = videoRef.current;
       if (!video || !faceLandmarkerRef.current) return requestAnimationFrame(calibrateLoop);
       
       const faceResult = faceLandmarkerRef.current.detectForVideo(video, performance.now());
       const faceCount = faceResult.faceLandmarks?.length || 0;
       
       if (faceCount === 1) {
          const matrix = faceResult.facialTransformationMatrixes?.[0]?.data;
          if (matrix) {
            const { yaw, pitch } = getYawPitchFromMatrix(matrix);
            sumYaw += yaw;
            sumPitch += pitch;
            frames++;
            setCalibrationProgress(Math.floor((frames / sampleCount) * 100));
          }
       }
       
       if (frames < sampleCount) {
          requestAnimationFrame(calibrateLoop);
       } else {
          cvStateRef.current.baselineYaw = sumYaw / sampleCount;
          cvStateRef.current.baselinePitch = sumPitch / sampleCount;
          cvStateRef.current.calibrated = true;
          setCalibrating(false);
          setSystemCheckPassed(true);
       }
    };
    requestAnimationFrame(calibrateLoop);
  }, []);

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

  if (!systemCheckPassed) {
    return (
       <div className="centered" style={{ background: '#0f1115', color: '#fff', textAlign: 'center' }}>
          <h2>System Check & Calibration</h2>
          <p>Please sit straight and look at the screen normally.</p>
          {!ready && <p>Loading computer vision models... Please wait.</p>}
          {ready && !calibrating && (
             <button className="finish-btn" onClick={runCalibration}>Start Calibration</button>
          )}
          {calibrating && (
             <div>
               <p>Calibrating... {calibrationProgress}%</p>
               <progress value={calibrationProgress} max="100"></progress>
             </div>
          )}
          <div style={{ marginTop: '20px' }}>
            <video ref={videoRef} className="webcam-mini" style={{ width: '320px', maxWidth: '320px', transform: 'scaleX(-1)' }} muted playsInline />
          </div>
       </div>
    );
  }

  const currentQuestion = questions[currentIndex];
  const originalIndices = originalQuestionsMap[currentQuestion.id] || [1,2,3,4];

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
          <label style={{ marginRight: '10px', fontSize: '12px' }}>
             <input type="checkbox" checked={showDebug} onChange={e => setShowDebug(e.target.checked)} /> Show Dev/Debug View
          </label>
          <span>Hello, Student</span>
        </div>
      </div>

      <div className="exam-content">
        <div className="exam-question-panel">
          <h3>Question {currentIndex + 1}:</h3>
          <p>{currentQuestion.question_text}</p>
          <div className="option-list">
            {[currentQuestion.option_1, currentQuestion.option_2, currentQuestion.option_3, currentQuestion.option_4].map((opt, i) => (
              <label key={i} className="radio-row">
                <input
                  type="radio"
                  name={`q-${currentQuestion.id}`}
                  checked={answers[currentQuestion.id] === originalIndices[i]}
                  onChange={() => selectOption(currentQuestion.id, originalIndices[i])}
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
            {(!document.fullscreenElement) && (
               <button style={{marginTop: '10px'}} onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>Re-enter Full Screen</button>
            )}
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

          <div style={{ position: 'relative' }}>
            <video ref={videoRef} className="webcam-mini" muted playsInline />
            {showDebug && (
               <canvas ref={debugCanvasRef} width={640} height={480} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
            )}
          </div>
          <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
      </div>
    </div>
  );
}
