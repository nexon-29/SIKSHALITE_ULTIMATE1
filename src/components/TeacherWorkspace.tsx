import React, { useMemo, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import {
  BarChart3,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  GraduationCap,
  ImagePlus,
  LogOut,
  Plus,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react';
import { auth, formatReadableFirestoreError } from '../lib/firebase';
import {
  generateAssignmentWithGemini,
  generateQuizWithGemini,
  generateReferenceDiagramWithGemini,
  generateStudyMaterialWithGemini,
} from '../lib/geminiClient';
import { compressImageFile, svgToCompressedDataUrl } from '../lib/imageUtils';
import {
  addStudentToInstitution,
  gradeStudentAssignment,
  removeTopic,
  saveTopic,
  updateSelfPhoto,
} from '../lib/sikshaliteService';
import {
  generateSafeId,
  type GrowthRecord,
  type Institution,
  type QuizQuestion,
  type ReferenceImage,
  type StudentRecord,
  type Subject,
  type Topic,
  type UserProfile,
} from '../types/sikshalite';
import { PrePostComparisonChart } from './GrowthCharts';
import { PhotoUploadField } from './PhotoUploadField';
import { PWAInstallButton } from './PWAInstallButton';
import { WebOtpCard } from './WebOtpCard';

type TeacherTab = 'studio' | 'students' | 'grading' | 'profile';

interface TeacherWorkspaceProps {
  profile: UserProfile;
  institution: Institution | null;
  subjects: Subject[];
  topics: Topic[];
  students: StudentRecord[];
  growthRecords: GrowthRecord[];
}

function emptyQuestion(prefix: string): QuizQuestion {
  return {
    id: generateSafeId(prefix),
    question: '',
    options: ['', '', '', ''],
    correctIndex: 0,
    explanation: '',
  };
}

export const TeacherWorkspace: React.FC<TeacherWorkspaceProps> = ({
  profile,
  institution,
  subjects,
  topics,
  students,
  growthRecords,
}) => {
  const [activeTab, setActiveTab] = useState<TeacherTab>('studio');
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('');
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  // Topic Editor Fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [studyContent, setStudyContent] = useState('');
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [visualPrompt, setVisualPrompt] = useState('');
  const [preQuestions, setPreQuestions] = useState<QuizQuestion[]>([]);
  const [postQuestions, setPostQuestions] = useState<QuizQuestion[]>([]);
  const [assignmentPrompt, setAssignmentPrompt] = useState('');
  const [assignmentMode, setAssignmentMode] = useState<'written' | 'file' | 'both'>('both');
  const [isPublished, setIsPublished] = useState(true);
  const [quizCount, setQuizCount] = useState(5);

  // Student Creation Form
  const [stuName, setStuName] = useState('');
  const [stuMobile, setStuMobile] = useState('');
  const [stuEmail, setStuEmail] = useState('');
  const [stuPhoto, setStuPhoto] = useState('');
  const [stuCustomId, setStuCustomId] = useState('');

  // Grading state
  const [gradeInputs, setGradeInputs] = useState<Record<string, { score: string; feedback: string }>>({});

  // Self Profile state
  const [selfName, setSelfName] = useState(profile.displayName);
  const [selfPhoto, setSelfPhoto] = useState(profile.photoUrl || '');

  // Async feedback
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const refImgInputRef = useRef<HTMLInputElement>(null);

  const activeSubject = useMemo(() => {
    if (subjects.length === 0) return null;
    return subjects.find((s) => s.id === selectedSubjectId) || subjects[0];
  }, [subjects, selectedSubjectId]);

  const subjectTopics = useMemo(
    () => (activeSubject ? topics.filter((t) => t.subjectId === activeSubject.id) : []),
    [topics, activeSubject]
  );

  const subjectStudents = useMemo(
    () =>
      activeSubject
        ? students.filter((s) => s.enrolledSubjectIds.includes(activeSubject.id))
        : students,
    [students, activeSubject]
  );

  const subjectGrowthRecords = useMemo(
    () =>
      activeSubject
        ? growthRecords.filter((g) => g.subjectId === activeSubject.id)
        : growthRecords,
    [growthRecords, activeSubject]
  );

  const topicChartItems = useMemo(() => {
    return subjectTopics
      .map((top) => {
        const recs = subjectGrowthRecords.filter(
          (r) => r.topicId === top.id && r.preTestCompleted && r.postTestCompleted
        );
        if (recs.length === 0) return null;
        const pre = Math.round(recs.reduce((a, b) => a + b.preTestPercent, 0) / recs.length);
        const post = Math.round(recs.reduce((a, b) => a + b.postTestPercent, 0) / recs.length);
        return {
          label: `${top.title} (${recs.length})`,
          prePercent: pre,
          postPercent: post,
          delta: Math.round((post - pre) * 10) / 10,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [subjectTopics, subjectGrowthRecords]);

  const openNewTopicEditor = () => {
    setEditingTopicId(null);
    setTitle('');
    setDescription('');
    setStudyContent('');
    setReferenceImages([]);
    setVisualPrompt('');
    setPreQuestions([emptyQuestion('pre')]);
    setPostQuestions([emptyQuestion('post')]);
    setAssignmentPrompt('');
    setAssignmentMode('both');
    setIsPublished(true);
    setErrorMsg('');
    setStatusMsg('');
    setShowEditor(true);
  };

  const openExistingTopicEditor = (t: Topic) => {
    setEditingTopicId(t.id);
    setTitle(t.title);
    setDescription(t.description || '');
    setStudyContent(t.studyContent);
    setReferenceImages(t.referenceImages || []);
    setVisualPrompt('');
    setPreQuestions(t.preTestQuestions || []);
    setPostQuestions(t.postTestQuestions || []);
    setAssignmentPrompt(t.assignmentPrompt || '');
    setAssignmentMode(t.assignmentMode || 'both');
    setIsPublished(t.isPublished);
    setErrorMsg('');
    setStatusMsg('');
    setShowEditor(true);
  };

  const handleGenerateMaterial = async () => {
    if (!activeSubject || !title.trim()) {
      setErrorMsg('Enter a Topic Title first before generating study material with Gemini.');
      return;
    }
    setErrorMsg('');
    setAiBusy('material');
    try {
      const res = await generateStudyMaterialWithGemini({
        subjectName: activeSubject.name,
        topicTitle: title,
        topicDescription: description,
      });
      setStudyContent(res.studyContent);
      setStatusMsg('Study material drafted by Gemini AI. Review or edit before saving.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to generate study material.');
    } finally {
      setAiBusy(null);
    }
  };

  const handleGenerateQuiz = async (quizType: 'pre' | 'post') => {
    if (!activeSubject || !title.trim()) {
      setErrorMsg('Enter a Topic Title first before generating a quiz with Gemini.');
      return;
    }
    setErrorMsg('');
    setAiBusy(quizType);
    try {
      const questions = await generateQuizWithGemini({
        subjectName: activeSubject.name,
        topicTitle: title,
        topicDescription: description,
        quizType,
        questionCount: quizCount,
        referenceContext: studyContent,
      });
      if (quizType === 'pre') {
        setPreQuestions(questions);
      } else {
        setPostQuestions(questions);
      }
      setStatusMsg(
        `${quizType === 'pre' ? 'Pre-Test' : 'Post-Test'} generated (${questions.length} questions).`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to generate quiz.');
    } finally {
      setAiBusy(null);
    }
  };

  const handleGenerateAssignment = async () => {
    if (!activeSubject || !title.trim()) {
      setErrorMsg('Enter a Topic Title first before generating an assignment with Gemini.');
      return;
    }
    setErrorMsg('');
    setAiBusy('assignment');
    try {
      const res = await generateAssignmentWithGemini({
        subjectName: activeSubject.name,
        topicTitle: title,
        topicDescription: description,
        assignmentMode,
      });
      setAssignmentPrompt(res.assignmentPrompt);
      setStatusMsg('Assignment prompt generated by Gemini AI.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to generate assignment.');
    } finally {
      setAiBusy(null);
    }
  };

  const handleGenerateReferenceImage = async () => {
    if (!activeSubject || !title.trim()) {
      setErrorMsg('Enter a Topic Title first before generating a visual diagram with Gemini.');
      return;
    }
    if (referenceImages.length >= 6) {
      setErrorMsg('Maximum 6 reference pictures per topic.');
      return;
    }
    setErrorMsg('');
    setAiBusy('diagram');
    try {
      const res = await generateReferenceDiagramWithGemini({
        subjectName: activeSubject.name,
        topicTitle: title,
        topicDescription: description,
        studyContext: studyContent,
        visualPrompt,
      });
      const dataUrl = await svgToCompressedDataUrl(res.svg, 120000);
      setReferenceImages((prev) => [
        ...prev,
        {
          id: generateSafeId('ref'),
          caption: res.caption || `${title.trim()} Diagram`.slice(0, 80),
          dataUrl,
        },
      ]);
      setVisualPrompt('');
      setStatusMsg('Visual diagram generated by Gemini AI and added to Reference Pictures.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to generate visual diagram.');
    } finally {
      setAiBusy(null);
    }
  };

  const handleAddReferenceImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (referenceImages.length >= 6) {
      setErrorMsg('Maximum 6 reference pictures per topic.');
      return;
    }
    setErrorMsg('');
    try {
      const dataUrl = await compressImageFile(file, 880, 120000);
      setReferenceImages((prev) => [
        ...prev,
        {
          id: generateSafeId('ref'),
          caption: file.name.replace(/\.[^/.]+$/, '').slice(0, 80),
          dataUrl,
        },
      ]);
      setStatusMsg('Manual reference picture added.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not add reference image.');
    } finally {
      if (refImgInputRef.current) refImgInputRef.current.value = '';
    }
  };

  const handleSaveTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeSubject) return;
    setErrorMsg('');
    setStatusMsg('');
    if (!title.trim()) {
      setErrorMsg('Topic title is required.');
      return;
    }

    const cleanPre = preQuestions.filter((q) => q.question.trim().length > 0);
    const cleanPost = postQuestions.filter((q) => q.question.trim().length > 0);

    setBusy(true);
    try {
      await saveTopic(activeSubject, profile.uid, {
        id: editingTopicId ?? undefined,
        title,
        description,
        studyContent,
        referenceImages,
        preTestQuestions: cleanPre,
        postTestQuestions: cleanPost,
        assignmentPrompt,
        assignmentMode,
        isPublished,
      });
      setShowEditor(false);
      setStatusMsg(`Topic "${title.trim()}" saved for ${activeSubject.name}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save topic.');
    } finally {
      setBusy(false);
    }
  };

  const handleEnrollStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!institution || !activeSubject) return;
    setErrorMsg('');
    setStatusMsg('');
    setBusy(true);
    try {
      const { uniqueStudentId } = await addStudentToInstitution(
        institution,
        profile.uid,
        {
          name: stuName,
          mobile: stuMobile,
          fallbackEmail: stuEmail,
          photoUrl: stuPhoto,
          enrolledSubjectIds: [activeSubject.id],
          customStudentId: stuCustomId,
        },
        subjects,
        students.length
      );
      setStuName('');
      setStuMobile('');
      setStuEmail('');
      setStuPhoto('');
      setStuCustomId('');
      setStatusMsg(
        `Student enrolled in ${activeSubject.name} with Unique ID ${uniqueStudentId}.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to enroll student.');
    } finally {
      setBusy(false);
    }
  };

  const handleGradeSubmit = async (rec: GrowthRecord) => {
    const entry = gradeInputs[rec.id] || {
      score: String(rec.assignmentScore ?? 85),
      feedback: rec.assignmentFeedback || '',
    };
    const numeric = Number(entry.score);
    if (Number.isNaN(numeric) || numeric < 0 || numeric > 100) {
      setErrorMsg('Score must be between 0 and 100.');
      return;
    }
    setErrorMsg('');
    setBusy(true);
    try {
      await gradeStudentAssignment(rec.id, numeric, entry.feedback);
      setStatusMsg(`Graded ${rec.studentName}'s assignment (${numeric}/100).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save grade.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTopic = async (topic: Topic) => {
    if (!activeSubject || busy) return;
    setErrorMsg('');
    setStatusMsg('');
    setBusy(true);
    try {
      await removeTopic(activeSubject, topic.id);
      setStatusMsg(`Topic "${topic.title}" deleted.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete topic.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveSelfProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setStatusMsg('');
    setBusy(true);
    try {
      await updateSelfPhoto(profile, selfName, selfPhoto);
      setStatusMsg('Your teacher profile and photo have been updated.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update profile.');
    } finally {
      setBusy(false);
    }
  };

  const navItems: { id: TeacherTab; label: string; icon: React.ReactNode }[] = [
    { id: 'studio', label: 'Subject Studio', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'students', label: 'Students', icon: <GraduationCap className="w-4 h-4" /> },
    { id: 'grading', label: 'Growth & Grading', icon: <ClipboardCheck className="w-4 h-4" /> },
    { id: 'profile', label: 'My Profile', icon: <User className="w-4 h-4" /> },
  ];

  const renderQuestionListEditor = (
    label: string,
    questions: QuizQuestion[],
    setQuestions: React.Dispatch<React.SetStateAction<QuizQuestion[]>>,
    quizType: 'pre' | 'post'
  ) => (
    <div className="border border-[#E7E5E0] rounded-2xl p-5 bg-[#FAF9F6] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-[#0F172A]">{label}</h3>
          <p className="text-xs text-[#64748B]">
            {questions.length} Questions · Generated via Gemini AI or authored manually
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={quizCount}
            onChange={(e) => setQuizCount(Number(e.target.value))}
            className="px-2.5 py-2 rounded-lg border border-[#E7E5E0] bg-white text-xs font-mono"
            aria-label="Number of questions"
          >
            {[3, 5, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n} Qs
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={aiBusy !== null}
            onClick={() => handleGenerateQuiz(quizType)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded-lg bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {aiBusy === quizType ? 'Generating...' : 'Generate with Gemini'}
          </button>
          <button
            type="button"
            onClick={() =>
              questions.length < 15 && setQuestions((prev) => [...prev, emptyQuestion(quizType)])
            }
            className="inline-flex items-center gap-1 px-3 py-2 min-h-[40px] rounded-lg border border-[#E7E5E0] bg-white text-xs font-medium text-[#0F172A] cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Manual
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {questions.map((q, qIdx) => (
          <div key={q.id} className="bg-white border border-[#E7E5E0] rounded-xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-xs font-semibold text-[#312E81] mt-1">
                Q{qIdx + 1}
              </span>
              <input
                type="text"
                value={q.question}
                onChange={(e) =>
                  setQuestions((prev) =>
                    prev.map((item, idx) =>
                      idx === qIdx ? { ...item, question: e.target.value } : item
                    )
                  )
                }
                placeholder="Enter question text..."
                className="flex-1 px-3 py-2 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
              />
              <button
                type="button"
                onClick={() => setQuestions((prev) => prev.filter((_, idx) => idx !== qIdx))}
                className="p-2 text-[#64748B] hover:text-[#DC2626] cursor-pointer"
                aria-label="Remove question"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {q.options.map((opt, oIdx) => (
                <div key={oIdx} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`correct_${quizType}_${q.id}`}
                    checked={q.correctIndex === oIdx}
                    onChange={() =>
                      setQuestions((prev) =>
                        prev.map((item, idx) =>
                          idx === qIdx ? { ...item, correctIndex: oIdx } : item
                        )
                      )
                    }
                    aria-label={`Mark option ${oIdx + 1} correct`}
                  />
                  <input
                    type="text"
                    value={opt}
                    onChange={(e) =>
                      setQuestions((prev) =>
                        prev.map((item, idx) =>
                          idx === qIdx
                            ? {
                                ...item,
                                options: item.options.map((o, i) =>
                                  i === oIdx ? e.target.value : o
                                ),
                              }
                            : item
                        )
                      )
                    }
                    placeholder={`Option ${oIdx + 1}`}
                    className="flex-1 px-3 py-1.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-xs"
                  />
                </div>
              ))}
            </div>

            <input
              type="text"
              value={q.explanation}
              onChange={(e) =>
                setQuestions((prev) =>
                  prev.map((item, idx) =>
                    idx === qIdx ? { ...item, explanation: e.target.value } : item
                  )
                )
              }
              placeholder="Brief answer explanation (shown after quiz submission)"
              className="w-full px-3 py-1.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-xs text-[#475569]"
            />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#FAF9F6] flex flex-col pb-20 md:pb-0">
      <header className="sticky top-0 z-30 bg-white border-b border-[#E7E5E0]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-6">
          <span className="font-display text-lg font-bold text-[#312E81] whitespace-nowrap shrink-0">
            Sikshalite
          </span>

          <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-[#475569]">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === item.id
                    ? 'border-[#312E81] text-[#0F172A] font-semibold'
                    : 'border-transparent hover:text-[#0F172A]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={() => signOut(auth)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded-lg border border-[#E7E5E0] text-xs font-medium text-[#334155] hover:text-[#DC2626] whitespace-nowrap shrink-0 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign Out
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start content-start">
        {/* Sidebar: Institution Branding + Subject Scope */}
        <aside className="lg:col-span-3 space-y-5">
          {institution && (
            <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4 space-y-3">
              {institution.institutionPhoto && (
                <div className="w-full h-28 rounded-xl overflow-hidden border border-[#E7E5E0] bg-[#FAF9F6] p-1.5">
                  <img
                    src={institution.institutionPhoto}
                    alt={institution.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-contain"
                  />
                </div>
              )}
              <div>
                <p className="text-xs text-[#64748B]">Institution</p>
                <p className="text-sm font-bold text-[#0F172A]">{institution.name}</p>
              </div>
              <div className="pt-2 border-t border-[#F1F0EA] flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-[#EEF2FF] overflow-hidden flex items-center justify-center shrink-0">
                  {institution.adminPhoto ? (
                    <img
                      src={institution.adminPhoto}
                      alt={institution.adminName}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-xs font-bold text-[#312E81]">
                      {institution.adminName.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-[#0F172A] truncate">
                    {institution.adminName}
                  </p>
                  <p className="text-[11px] text-[#64748B]">Institution Head</p>
                </div>
              </div>
            </div>
          )}

          {/* Teacher Identity + Assigned Subjects Only */}
          <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-full bg-[#EEF2FF] border border-[#E7E5E0] overflow-hidden flex items-center justify-center shrink-0">
                {profile.photoUrl ? (
                  <img
                    src={profile.photoUrl}
                    alt={profile.displayName}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-sm font-bold text-[#312E81]">
                    {profile.displayName.slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-[#0F172A] truncate">{profile.displayName}</p>
                <p className="text-xs text-[#64748B]">Subject Teacher</p>
              </div>
            </div>

            <div className="pt-3 border-t border-[#E7E5E0] space-y-1.5">
              <p className="text-xs font-medium text-[#64748B]">Your Assigned Subjects</p>
              {subjects.length === 0 ? (
                <p className="text-xs text-[#D97706]">No subjects assigned yet.</p>
              ) : (
                subjects.map((subj) => (
                  <button
                    key={subj.id}
                    type="button"
                    onClick={() => {
                      setSelectedSubjectId(subj.id);
                      setShowEditor(false);
                    }}
                    className={`w-full text-left px-3 py-2.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer ${
                      activeSubject?.id === subj.id
                        ? 'bg-[#312E81] text-white'
                        : 'bg-[#FAF9F6] text-[#334155] hover:bg-[#EFECE4]'
                    }`}
                  >
                    <div className="truncate">{subj.name}</div>
                    <div
                      className={`font-mono text-[11px] mt-0.5 ${
                        activeSubject?.id === subj.id ? 'text-white/80' : 'text-[#64748B]'
                      }`}
                    >
                      {subj.code} · {topics.filter((t) => t.subjectId === subj.id).length} Topics
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </aside>

        {/* Main Panel */}
        <main className="lg:col-span-9 space-y-6">
          {errorMsg && (
            <div className="p-3.5 rounded-xl bg-[#FEF2F2] border border-[#FECACA] text-xs text-[#DC2626] break-words">
              {formatReadableFirestoreError(errorMsg, errorMsg)}
            </div>
          )}
          {statusMsg && (
            <div className="p-3.5 rounded-xl bg-[#ECFDF5] border border-[#A7F3D0] text-xs text-[#059669]">
              {statusMsg}
            </div>
          )}

          {!activeSubject ? (
            <div className="bg-white border border-[#E7E5E0] rounded-2xl p-10 text-center space-y-2">
              <h2 className="text-lg font-bold text-[#0F172A]">No Subjects Assigned Yet</h2>
              <p className="text-sm text-[#64748B] max-w-md mx-auto">
                Ask your Institution Admin to assign at least one subject to your profile. Once assigned, only your subjects will appear here.
              </p>
            </div>
          ) : (
            <>
              {activeTab === 'studio' && (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <h1 className="text-2xl font-bold text-[#0F172A]">
                        {activeSubject.name} Studio
                      </h1>
                      <p className="text-xs font-mono text-[#64748B] mt-0.5">
                        {activeSubject.code} · {subjectTopics.length} Topics · Subject-Scoped Access
                      </p>
                    </div>

                    {!showEditor && (
                      <button
                        type="button"
                        onClick={openNewTopicEditor}
                        className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Plus className="w-4 h-4" />
                        Create New Topic
                      </button>
                    )}
                  </div>

                  {showEditor ? (
                    <form
                      onSubmit={handleSaveTopic}
                      className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-6"
                    >
                      <div className="flex items-center justify-between">
                        <h2 className="text-lg font-bold text-[#0F172A]">
                          {editingTopicId ? 'Edit Topic Module' : 'New Topic Module'}
                        </h2>
                        <button
                          type="button"
                          onClick={() => setShowEditor(false)}
                          className="text-xs font-medium text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-medium text-[#475569] mb-1">
                            Topic Title *
                          </label>
                          <input
                            type="text"
                            required
                            maxLength={140}
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="e.g. Electromagnetic Induction"
                            className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-[#475569] mb-1">
                            Short Scope / Objective
                          </label>
                          <input
                            type="text"
                            maxLength={600}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder="e.g. Faraday laws, Lenz law, and induced EMF problems"
                            className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                          />
                        </div>
                      </div>

                      {/* Study Material (AI + Manual) */}
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="text-xs font-semibold text-[#0F172A]">
                            Study Material (AI-Generated or Manual)
                          </label>
                          <button
                            type="button"
                            disabled={aiBusy !== null}
                            onClick={handleGenerateMaterial}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                          >
                            <Sparkles className="w-3.5 h-3.5" />
                            {aiBusy === 'material' ? 'Drafting Study Guide...' : 'Generate Study Material with Gemini'}
                          </button>
                        </div>
                        <textarea
                          rows={8}
                          maxLength={30000}
                          value={studyContent}
                          onChange={(e) => setStudyContent(e.target.value)}
                          placeholder="Write or Gemini-generate structured explanations, key formulas, and takeaways..."
                          className="w-full px-3.5 py-3 rounded-xl border border-[#E7E5E0] bg-[#FAF9F6] text-sm leading-relaxed"
                        />
                      </div>

                      {/* Reference Pictures (AI Diagram + Manual Upload) */}
                      <div className="border border-[#E7E5E0] rounded-2xl p-5 bg-[#FAF9F6] space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <h3 className="text-sm font-bold text-[#0F172A]">
                              Topic Reference Pictures ({referenceImages.length}/6)
                            </h3>
                            <p className="text-xs text-[#64748B]">
                              Generate visual diagrams with Gemini AI or manually upload photos, board notes, or experiment snapshots.
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            maxLength={220}
                            value={visualPrompt}
                            onChange={(e) => setVisualPrompt(e.target.value)}
                            placeholder="Optional AI visual prompt (e.g. labeled flowchart, SLA metrics chart, circuit diagram)"
                            className="flex-1 px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-white text-xs text-[#0F172A]"
                          />
                          <div className="flex flex-wrap items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={aiBusy !== null || referenceImages.length >= 6}
                              onClick={handleGenerateReferenceImage}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded-lg bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                            >
                              <Sparkles className="w-3.5 h-3.5" />
                              {aiBusy === 'diagram' ? 'Generating Visual...' : 'Generate with Gemini'}
                            </button>
                            <input
                              ref={refImgInputRef}
                              type="file"
                              accept="image/*"
                              onChange={handleAddReferenceImage}
                              className="hidden"
                            />
                            <button
                              type="button"
                              disabled={referenceImages.length >= 6}
                              onClick={() => refImgInputRef.current?.click()}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[40px] rounded-lg border border-[#E7E5E0] bg-white text-xs font-semibold text-[#0F172A] hover:border-[#312E81] cursor-pointer disabled:opacity-50"
                            >
                              <ImagePlus className="w-4 h-4" />
                              Upload Manual Photo
                            </button>
                          </div>
                        </div>

                        {referenceImages.length > 0 && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 pt-1">
                            {referenceImages.map((img, idx) => (
                              <div
                                key={img.id}
                                className="border border-[#E7E5E0] rounded-xl p-2.5 bg-white space-y-2"
                              >
                                <img
                                  src={img.dataUrl}
                                  alt={img.caption || 'Reference visual'}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-36 object-contain bg-[#FAF9F6] rounded-lg border border-[#E7E5E0]"
                                />
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    value={img.caption}
                                    onChange={(e) =>
                                      setReferenceImages((prev) =>
                                        prev.map((r, i) =>
                                          i === idx ? { ...r, caption: e.target.value } : r
                                        )
                                      )
                                    }
                                    placeholder="Diagram caption"
                                    className="flex-1 px-2 py-1 rounded border border-[#E7E5E0] bg-[#FAF9F6] text-xs"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setReferenceImages((prev) => prev.filter((_, i) => i !== idx))
                                    }
                                    className="p-1.5 text-[#64748B] hover:text-[#DC2626] cursor-pointer"
                                    aria-label="Remove reference picture"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Pre-Test Quiz */}
                      {renderQuestionListEditor(
                        'Pre-Test Quiz (Baseline Assessment)',
                        preQuestions,
                        setPreQuestions,
                        'pre'
                      )}

                      {/* Assignment */}
                      <div className="border border-[#E7E5E0] rounded-2xl p-5 bg-[#FAF9F6] space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-sm font-bold text-[#0F172A]">
                            Student Assignment (Written, File, or Both)
                          </h3>
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              value={assignmentMode}
                              onChange={(e) =>
                                setAssignmentMode(e.target.value as 'written' | 'file' | 'both')
                              }
                              className="px-3 py-2 rounded-lg border border-[#E7E5E0] bg-white text-xs font-medium"
                            >
                              <option value="both">Written or File Upload</option>
                              <option value="written">Written Response Only</option>
                              <option value="file">File / Photo Upload Only</option>
                            </select>
                            <button
                              type="button"
                              disabled={aiBusy !== null}
                              onClick={handleGenerateAssignment}
                              className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                            >
                              <Sparkles className="w-3.5 h-3.5" />
                              {aiBusy === 'assignment' ? 'Drafting...' : 'Generate Assignment with Gemini'}
                            </button>
                          </div>
                        </div>
                        <textarea
                          rows={4}
                          maxLength={4000}
                          value={assignmentPrompt}
                          onChange={(e) => setAssignmentPrompt(e.target.value)}
                          placeholder="Describe the assignment prompt, questions, or worksheet instructions..."
                          className="w-full px-3.5 py-2.5 rounded-xl border border-[#E7E5E0] bg-white text-sm"
                        />
                      </div>

                      {/* Post-Test Quiz */}
                      {renderQuestionListEditor(
                        'Post-Test Quiz (Mastery & Growth Assessment)',
                        postQuestions,
                        setPostQuestions,
                        'post'
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-[#E7E5E0]">
                        <label className="inline-flex items-center gap-2 text-sm text-[#0F172A] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isPublished}
                            onChange={(e) => setIsPublished(e.target.checked)}
                          />
                          Publish immediately to enrolled students
                        </label>

                        <button
                          type="submit"
                          disabled={busy}
                          className="inline-flex items-center gap-2 px-6 py-3 min-h-[44px] rounded-xl bg-[#059669] text-white text-sm font-semibold hover:bg-[#047857] cursor-pointer disabled:opacity-50"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          {busy ? 'Saving Topic...' : 'Save Topic Module'}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="space-y-4">
                      {subjectTopics.map((t) => (
                        <div
                          key={t.id}
                          className="bg-white border border-[#E7E5E0] rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2.5">
                              <h3 className="text-base font-bold text-[#0F172A]">{t.title}</h3>
                              <span className="text-xs font-medium text-[#64748B]">
                                · {t.isPublished ? 'Published' : 'Draft'}
                              </span>
                            </div>
                            <p className="text-xs text-[#64748B] font-mono">
                              Pre-Test: {t.preTestQuestions.length} Qs · Post-Test:{' '}
                              {t.postTestQuestions.length} Qs · Ref Pictures:{' '}
                              {t.referenceImages.length} · Mode: {t.assignmentMode}
                            </p>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => openExistingTopicEditor(t)}
                              className="px-4 py-2 min-h-[40px] rounded-lg border border-[#E7E5E0] text-xs font-semibold text-[#0F172A] hover:border-[#312E81] cursor-pointer"
                            >
                              Edit Topic
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleDeleteTopic(t)}
                              className="p-2 min-h-[40px] min-w-[40px] rounded-lg border border-[#E7E5E0] text-[#64748B] hover:text-[#DC2626] flex items-center justify-center cursor-pointer disabled:opacity-50"
                              aria-label={`Delete ${t.title}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}

                      {subjectTopics.length === 0 && (
                        <div className="bg-white border border-[#E7E5E0] rounded-2xl p-10 text-center space-y-3">
                          <FileText className="w-8 h-8 text-[#94A3B8] mx-auto" />
                          <h3 className="text-base font-bold text-[#0F172A]">
                            No Topics in {activeSubject.name} Yet
                          </h3>
                          <p className="text-sm text-[#64748B]">
                            Create your first topic with Gemini-generated Pre/Post quizzes, study material, reference pictures, and an assignment.
                          </p>
                          <button
                            type="button"
                            onClick={openNewTopicEditor}
                            className="inline-flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer"
                          >
                            <Plus className="w-4 h-4" />
                            Create First Topic
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'students' && (
                <div className="space-y-6">
                  <form
                    onSubmit={handleEnrollStudent}
                    className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4"
                  >
                    <h2 className="text-base font-bold text-[#0F172A]">
                      Add Student to {activeSubject.name}
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">
                          Student Full Name *
                        </label>
                        <input
                          type="text"
                          required
                          maxLength={100}
                          value={stuName}
                          onChange={(e) => setStuName(e.target.value)}
                          placeholder="e.g. Priya Nair"
                          className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">
                          Mobile Number (SMS OTP Login) *
                        </label>
                        <input
                          type="tel"
                          required
                          maxLength={24}
                          value={stuMobile}
                          onChange={(e) => setStuMobile(e.target.value)}
                          placeholder="+919876543210"
                          className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">
                          Email (Optional Google Fallback)
                        </label>
                        <input
                          type="email"
                          maxLength={160}
                          value={stuEmail}
                          onChange={(e) => setStuEmail(e.target.value)}
                          placeholder="student@example.com"
                          className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">
                          Custom Student ID (Optional)
                        </label>
                        <input
                          type="text"
                          maxLength={32}
                          value={stuCustomId}
                          onChange={(e) => setStuCustomId(e.target.value)}
                          placeholder="Auto-generated if blank"
                          className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm"
                        />
                      </div>
                    </div>

                    <PhotoUploadField label="Student Photo" value={stuPhoto} onChange={setStuPhoto} />

                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                    >
                      <Plus className="w-4 h-4" />
                      {busy ? 'Adding Student...' : 'Add Student & Issue Unique ID'}
                    </button>
                  </form>

                  <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
                    <h2 className="text-base font-bold text-[#0F172A]">
                      Students in {activeSubject.name} ({subjectStudents.length})
                    </h2>
                    <div className="divide-y divide-[#F1F0EA]">
                      {subjectStudents.map((stu) => (
                        <div key={stu.id} className="py-3 flex items-center justify-between gap-4">
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-full bg-[#EEF2FF] border border-[#E7E5E0] overflow-hidden flex items-center justify-center shrink-0">
                              {stu.photoUrl ? (
                                <img
                                  src={stu.photoUrl}
                                  alt={stu.name}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <span className="text-xs font-bold text-[#312E81]">
                                  {stu.name.slice(0, 1).toUpperCase()}
                                </span>
                              )}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-[#0F172A] truncate">
                                {stu.name}
                              </p>
                              <p className="text-xs font-mono text-[#64748B]">
                                {stu.uniqueStudentId} · {stu.phoneE164}
                              </p>
                            </div>
                          </div>
                          <span className="text-xs font-medium text-[#64748B]">
                            {stu.claimedUid ? 'OTP Active' : 'Pending Login'}
                          </span>
                        </div>
                      ))}
                      {subjectStudents.length === 0 && (
                        <p className="py-4 text-sm text-[#64748B]">
                          No students enrolled in {activeSubject.name} yet.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'grading' && (
                <div className="space-y-6">
                  <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="w-5 h-5 text-[#312E81]" />
                      <h2 className="text-base font-bold text-[#0F172A]">
                        {activeSubject.name} Topic Growth Overview
                      </h2>
                    </div>
                    <PrePostComparisonChart items={topicChartItems} />
                  </div>

                  <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
                    <h2 className="text-base font-bold text-[#0F172A]">
                      Assignment Submissions & Student Progress
                    </h2>
                    {subjectGrowthRecords.length === 0 ? (
                      <p className="text-sm text-[#64748B]">
                        No student submissions or test attempts recorded for this subject yet.
                      </p>
                    ) : (
                      <div className="space-y-4">
                        {subjectGrowthRecords.map((rec) => {
                          const topic = subjectTopics.find((t) => t.id === rec.topicId);
                          const currentInput = gradeInputs[rec.id] || {
                            score: String(rec.assignmentScore ?? 85),
                            feedback: rec.assignmentFeedback || '',
                          };

                          return (
                            <div
                              key={rec.id}
                              className="border border-[#E7E5E0] rounded-xl p-4 bg-[#FAF9F6] space-y-3"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div>
                                  <p className="text-sm font-bold text-[#0F172A]">
                                    {rec.studentName}{' '}
                                    <span className="font-mono text-xs font-normal text-[#312E81]">
                                      ({rec.uniqueStudentId})
                                    </span>
                                  </p>
                                  <p className="text-xs text-[#64748B]">
                                    Topic: {topic?.title || 'Topic'} · Pre:{' '}
                                    <span className="font-mono">
                                      {rec.preTestCompleted ? `${rec.preTestPercent}%` : 'Pending'}
                                    </span>{' '}
                                    · Post:{' '}
                                    <span className="font-mono">
                                      {rec.postTestCompleted ? `${rec.postTestPercent}%` : 'Pending'}
                                    </span>
                                    {rec.postTestCompleted && (
                                      <span
                                        className={`ml-2 font-mono font-semibold ${
                                          rec.growthDelta >= 0 ? 'text-[#059669]' : 'text-[#DC2626]'
                                        }`}
                                      >
                                        ({rec.growthDelta >= 0 ? '+' : ''}
                                        {rec.growthDelta}% Growth)
                                      </span>
                                    )}
                                  </p>
                                </div>
                                <span className="text-xs font-semibold text-[#312E81] capitalize">
                                  Assignment: {rec.assignmentStatus}
                                </span>
                              </div>

                              {rec.assignmentType === 'written' && rec.assignmentText && (
                                <div className="p-3 rounded-lg bg-white border border-[#E7E5E0] text-sm text-[#334155] whitespace-pre-wrap">
                                  {rec.assignmentText}
                                </div>
                              )}

                              {rec.assignmentType === 'file' && rec.assignmentFileData && (
                                <div className="p-3 rounded-lg bg-white border border-[#E7E5E0] space-y-2">
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="font-medium text-[#0F172A]">
                                      Uploaded File: {rec.assignmentFileName}
                                    </span>
                                    <a
                                      href={rec.assignmentFileData}
                                      download={rec.assignmentFileName || 'submission'}
                                      className="text-[#312E81] font-semibold hover:underline"
                                    >
                                      Download File
                                    </a>
                                  </div>
                                  {rec.assignmentFileType?.startsWith('image/') && (
                                    <img
                                      src={rec.assignmentFileData}
                                      alt={rec.assignmentFileName || 'Student upload'}
                                      className="max-h-56 rounded-lg border border-[#E7E5E0]"
                                    />
                                  )}
                                </div>
                              )}

                              {rec.assignmentStatus !== 'pending' && (
                                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 pt-1">
                                  <input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={currentInput.score}
                                    onChange={(e) =>
                                      setGradeInputs((prev) => ({
                                        ...prev,
                                        [rec.id]: { ...currentInput, score: e.target.value },
                                      }))
                                    }
                                    placeholder="Score / 100"
                                    className="px-3 py-2 rounded-lg border border-[#E7E5E0] bg-white font-mono text-xs"
                                  />
                                  <input
                                    type="text"
                                    value={currentInput.feedback}
                                    onChange={(e) =>
                                      setGradeInputs((prev) => ({
                                        ...prev,
                                        [rec.id]: { ...currentInput, feedback: e.target.value },
                                      }))
                                    }
                                    placeholder="Feedback for student..."
                                    className="sm:col-span-2 px-3 py-2 rounded-lg border border-[#E7E5E0] bg-white text-xs"
                                  />
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => handleGradeSubmit(rec)}
                                    className="px-4 py-2 rounded-lg bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                                  >
                                    {rec.assignmentStatus === 'graded' ? 'Update Grade' : 'Save Grade'}
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'profile' && (
                <div className="space-y-6">
                  <form
                    onSubmit={handleSaveSelfProfile}
                    className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-5"
                  >
                    <h2 className="text-lg font-bold text-[#0F172A]">Your Teacher Profile & Photo</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">
                          Display Name
                        </label>
                        <input
                          type="text"
                          required
                          maxLength={100}
                          value={selfName}
                          onChange={(e) => setSelfName(e.target.value)}
                          className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">
                          Linked Mobile Number
                        </label>
                        <input
                          type="text"
                          disabled
                          value={profile.phoneE164 || profile.email || ''}
                          className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#F4F2EC] font-mono text-sm text-[#64748B]"
                        />
                      </div>
                    </div>
                    <PhotoUploadField
                      label="Teacher Profile Photo"
                      value={selfPhoto}
                      onChange={setSelfPhoto}
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                    >
                      {busy ? 'Updating...' : 'Save Teacher Profile'}
                    </button>
                  </form>
                  <WebOtpCard profile={profile} />
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* Mobile Bottom Nav */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-[#E7E5E0] pb-safe">
        <div className="grid grid-cols-4 h-16 items-center">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`flex flex-col items-center justify-center min-h-[44px] text-[10px] font-medium ${
                activeTab === item.id ? 'text-[#312E81] font-semibold' : 'text-[#64748B]'
              }`}
            >
              {item.icon}
              <span className="mt-1 truncate max-w-[72px]">{item.label.split(' ')[0]}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
};
