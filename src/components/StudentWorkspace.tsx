import React, { useEffect, useMemo, useRef, useState } from 'react';
import { signOut } from 'firebase/auth';
import {
  ArrowLeft,
  Award,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  FileUp,
  LogOut,
  TrendingUp,
  User,
} from 'lucide-react';
import { auth, formatReadableFirestoreError } from '../lib/firebase';
import { readAssignmentFile } from '../lib/imageUtils';
import {
  ensureGrowthRecord,
  markStudyMaterialComplete,
  submitQuizAttempt,
  submitStudentAssignment,
  updateSelfPhoto,
} from '../lib/sikshaliteService';
import type {
  GrowthRecord,
  Institution,
  PublicProfile,
  QuizQuestion,
  StudentRecord,
  Subject,
  Topic,
  UserProfile,
} from '../types/sikshalite';
import { GrowthRing, PrePostComparisonChart } from './GrowthCharts';
import { PhotoUploadField } from './PhotoUploadField';
import { PWAInstallButton } from './PWAInstallButton';
import { WebOtpCard } from './WebOtpCard';

type StudentTab = 'overview' | 'learn' | 'profile';
type TopicStage = 'pretest' | 'study' | 'assignment' | 'posttest';

interface StudentWorkspaceProps {
  profile: UserProfile;
  institution: Institution | null;
  studentRecord: StudentRecord | null;
  subjects: Subject[];
  topics: Topic[];
  teacherProfiles: PublicProfile[];
  growthRecords: GrowthRecord[];
}

export const StudentWorkspace: React.FC<StudentWorkspaceProps> = ({
  profile,
  institution,
  studentRecord,
  subjects,
  topics,
  teacherProfiles,
  growthRecords,
}) => {
  const [activeTab, setActiveTab] = useState<StudentTab>('overview');
  const [selectedSubjectId, setSelectedSubjectId] = useState<string>('');
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [topicStage, setTopicStage] = useState<TopicStage>('pretest');
  const [activeRecord, setActiveRecord] = useState<GrowthRecord | null>(null);
  const [zoomImage, setZoomImage] = useState<string | null>(null);

  // Quiz state
  const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});

  // Assignment state
  const [assignType, setAssignType] = useState<'written' | 'file'>('written');
  const [assignText, setAssignText] = useState('');
  const [assignFileName, setAssignFileName] = useState('');
  const [assignFileType, setAssignFileType] = useState('');
  const [assignFileData, setAssignFileData] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Self profile
  const [selfName, setSelfName] = useState(profile.displayName);
  const [selfPhoto, setSelfPhoto] = useState(profile.photoUrl || '');

  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  const activeSubject = useMemo(() => {
    if (subjects.length === 0) return null;
    return subjects.find((s) => s.id === selectedSubjectId) || subjects[0];
  }, [subjects, selectedSubjectId]);

  const publishedSubjectTopics = useMemo(
    () =>
      activeSubject
        ? topics.filter((t) => t.subjectId === activeSubject.id && t.isPublished)
        : [],
    [topics, activeSubject]
  );

  const selectedTopic = useMemo(
    () => publishedSubjectTopics.find((t) => t.id === selectedTopicId) || null,
    [publishedSubjectTopics, selectedTopicId]
  );

  useEffect(() => {
    if (!selectedTopic) return;
    const match = growthRecords.find((g) => g.topicId === selectedTopic.id);
    if (match) {
      setActiveRecord(match);
    }
  }, [growthRecords, selectedTopic]);

  const completedTopics = useMemo(
    () => growthRecords.filter((g) => g.preTestCompleted && g.postTestCompleted),
    [growthRecords]
  );

  const avgStats = useMemo(() => {
    if (completedTopics.length === 0) {
      return { avgPre: 0, avgPost: 0, avgDelta: 0 };
    }
    const avgPre = Math.round(
      completedTopics.reduce((a, b) => a + b.preTestPercent, 0) / completedTopics.length
    );
    const avgPost = Math.round(
      completedTopics.reduce((a, b) => a + b.postTestPercent, 0) / completedTopics.length
    );
    return {
      avgPre,
      avgPost,
      avgDelta: Math.round((avgPost - avgPre) * 10) / 10,
    };
  }, [completedTopics]);

  const chartItems = useMemo(() => {
    return completedTopics.map((rec) => {
      const top = topics.find((t) => t.id === rec.topicId);
      const subj = subjects.find((s) => s.id === rec.subjectId);
      return {
        label: `${subj?.code || ''} · ${top?.title || 'Topic'}`,
        prePercent: rec.preTestPercent,
        postPercent: rec.postTestPercent,
        delta: rec.growthDelta,
      };
    });
  }, [completedTopics, topics, subjects]);

  const handleOpenTopic = async (topic: Topic) => {
    if (!studentRecord) return;
    setErrorMsg('');
    setStatusMsg('');
    setQuizAnswers({});
    setSelectedTopicId(topic.id);

    const existing = growthRecords.find((g) => g.topicId === topic.id);
    if (existing) {
      setActiveRecord(existing);
      setAssignText(existing.assignmentText || '');
      setAssignFileName(existing.assignmentFileName || '');
      setAssignFileType(existing.assignmentFileType || '');
      setAssignFileData(existing.assignmentFileData || '');
      if (!existing.preTestCompleted) setTopicStage('pretest');
      else if (!existing.studyCompleted) setTopicStage('study');
      else if (existing.assignmentStatus === 'pending') setTopicStage('assignment');
      else setTopicStage('posttest');
      return;
    }

    setBusy(true);
    try {
      const created = await ensureGrowthRecord(topic, studentRecord, profile.uid);
      setActiveRecord(created);
      setTopicStage('pretest');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to initialize topic tracker.');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitQuiz = async (quizType: 'pre' | 'post', questions: QuizQuestion[]) => {
    if (!activeRecord || !selectedTopic || busy) return;
    const alreadyDone =
      quizType === 'pre' ? activeRecord.preTestCompleted : activeRecord.postTestCompleted;
    if (alreadyDone) return;

    const answersArr = questions.map((_, idx) => quizAnswers[idx] ?? -1);
    if (answersArr.some((a) => a < 0)) {
      setErrorMsg('Please answer all questions before submitting.');
      return;
    }
    setErrorMsg('');
    setBusy(true);
    try {
      const patch = await submitQuizAttempt(activeRecord, selectedTopic, quizType, answersArr);
      setActiveRecord((prev) => (prev ? { ...prev, ...patch } : prev));
      setQuizAnswers({});
      setStatusMsg(
        quizType === 'pre'
          ? 'Pre-Test recorded! Proceed to Study Material and Reference Pictures.'
          : 'Post-Test complete! Your learning growth delta has been calculated.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to submit quiz.');
    } finally {
      setBusy(false);
    }
  };

  const handleCompleteStudy = async () => {
    if (!activeRecord || busy) return;
    if (activeRecord.studyCompleted) {
      setTopicStage('assignment');
      return;
    }
    setErrorMsg('');
    setBusy(true);
    try {
      await markStudyMaterialComplete(activeRecord.id);
      setActiveRecord((prev) => (prev ? { ...prev, studyCompleted: true } : prev));
      setTopicStage('assignment');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to mark study complete.');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignmentFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg('');
    try {
      const result = await readAssignmentFile(file);
      setAssignFileName(result.fileName);
      setAssignFileType(result.fileType);
      setAssignFileData(result.fileData);
      setAssignType('file');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not attach file.');
    }
  };

  const handleSubmitAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRecord || !selectedTopic || busy) return;
    if (activeRecord.assignmentStatus === 'graded') {
      setTopicStage('posttest');
      return;
    }
    setErrorMsg('');
    const mode =
      selectedTopic.assignmentMode === 'written'
        ? 'written'
        : selectedTopic.assignmentMode === 'file'
          ? 'file'
          : assignType;

    if (mode === 'written' && !assignText.trim()) {
      setErrorMsg('Please enter your written assignment response.');
      return;
    }
    if (mode === 'file' && !assignFileData) {
      setErrorMsg('Please attach a file or photo for your assignment.');
      return;
    }

    setBusy(true);
    try {
      const payload = {
        assignmentType: mode,
        assignmentText: mode === 'written' ? assignText : '',
        assignmentFileName: mode === 'file' ? assignFileName : '',
        assignmentFileType: mode === 'file' ? assignFileType : '',
        assignmentFileData: mode === 'file' ? assignFileData : '',
      };
      await submitStudentAssignment(activeRecord.id, payload);
      setActiveRecord((prev) =>
        prev
          ? {
              ...prev,
              assignmentStatus: 'submitted',
              ...payload,
            }
          : prev
      );
      setStatusMsg('Assignment submitted to your teacher. Proceed to the Post-Test!');
      setTopicStage('posttest');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to submit assignment.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    setStatusMsg('');
    setBusy(true);
    try {
      await updateSelfPhoto(profile, selfName, selfPhoto);
      setStatusMsg('Your student profile and photo have been updated.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update profile.');
    } finally {
      setBusy(false);
    }
  };

  const renderQuizSection = (quizType: 'pre' | 'post', questions: QuizQuestion[]) => {
    if (!activeRecord) return null;
    const isCompleted =
      quizType === 'pre' ? activeRecord.preTestCompleted : activeRecord.postTestCompleted;
    const savedAnswers =
      quizType === 'pre' ? activeRecord.preTestAnswers : activeRecord.postTestAnswers;
    const savedScore =
      quizType === 'pre' ? activeRecord.preTestScore : activeRecord.postTestScore;
    const savedPercent =
      quizType === 'pre' ? activeRecord.preTestPercent : activeRecord.postTestPercent;

    if (questions.length === 0) {
      return (
        <div className="p-6 border border-[#E7E5E0] rounded-xl bg-[#FAF9F6] text-sm text-[#64748B]">
          Your teacher has not added questions for this {quizType === 'pre' ? 'Pre-Test' : 'Post-Test'} yet.
        </div>
      );
    }

    return (
      <div className="space-y-5">
        {isCompleted && (
          <div className="p-5 rounded-2xl border border-[#A7F3D0] bg-[#ECFDF5] flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-[#059669]">
                {quizType === 'pre' ? 'Pre-Test Baseline Recorded' : 'Post-Test Mastery Recorded'}
              </p>
              <p className="text-xl font-bold text-[#0F172A] font-mono tabular-nums mt-0.5">
                {savedScore} / {questions.length} ({savedPercent}%)
              </p>
            </div>
            {quizType === 'post' && activeRecord.preTestCompleted && (
              <div className="text-right">
                <p className="text-xs text-[#475569]">Study Growth Delta</p>
                <p
                  className={`text-xl font-bold font-mono tabular-nums ${
                    activeRecord.growthDelta >= 0 ? 'text-[#059669]' : 'text-[#DC2626]'
                  }`}
                >
                  {activeRecord.growthDelta >= 0 ? '+' : ''}
                  {activeRecord.growthDelta}%
                </p>
              </div>
            )}
          </div>
        )}

        {questions.map((q, qIdx) => {
          const chosen = isCompleted ? savedAnswers[qIdx] : quizAnswers[qIdx];
          return (
            <div key={q.id} className="bg-white border border-[#E7E5E0] rounded-2xl p-5 space-y-3">
              <p className="text-sm font-semibold text-[#0F172A]">
                <span className="font-mono text-[#312E81] mr-2">Q{qIdx + 1}.</span>
                {q.question}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {q.options.map((opt, oIdx) => {
                  const isSelected = chosen === oIdx;
                  const isRight = q.correctIndex === oIdx;
                  let style = 'border-[#E7E5E0] bg-[#FAF9F6] text-[#334155]';
                  if (isCompleted) {
                    if (isRight) style = 'border-[#059669] bg-[#ECFDF5] text-[#065F46] font-semibold';
                    else if (isSelected) style = 'border-[#DC2626] bg-[#FEF2F2] text-[#991B1B]';
                  } else if (isSelected) {
                    style = 'border-[#312E81] bg-[#EEF2FF] text-[#312E81] font-semibold';
                  }

                  return (
                    <button
                      key={oIdx}
                      type="button"
                      disabled={isCompleted}
                      onClick={() => setQuizAnswers((prev) => ({ ...prev, [qIdx]: oIdx }))}
                      className={`text-left px-4 py-3 min-h-[44px] rounded-xl border text-xs transition-colors cursor-pointer disabled:cursor-default ${style}`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
              {isCompleted && q.explanation && (
                <p className="text-xs text-[#475569] pt-1">
                  <strong>Explanation:</strong> {q.explanation}
                </p>
              )}
            </div>
          );
        })}

        {!isCompleted && (
          <button
            type="button"
            disabled={busy}
            onClick={() => handleSubmitQuiz(quizType, questions)}
            className="px-6 py-3 min-h-[44px] rounded-xl bg-[#312E81] text-white text-sm font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
          >
            {busy
              ? 'Scoring...'
              : `Submit ${quizType === 'pre' ? 'Pre-Test' : 'Post-Test'}`}
          </button>
        )}
      </div>
    );
  };

  const navItems: { id: StudentTab; label: string; mobileLabel: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'My Growth', mobileLabel: 'Growth', icon: <TrendingUp className="w-4 h-4" /> },
    { id: 'learn', label: 'Subjects & Study', mobileLabel: 'Subjects', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'profile', label: 'My Profile', mobileLabel: 'Profile', icon: <User className="w-4 h-4" /> },
  ];

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
        {/* Sidebar */}
        <aside className="lg:col-span-3 space-y-5">
          <div className="bg-white border border-[#E7E5E0] rounded-2xl p-5 space-y-4">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-full bg-[#EEF2FF] border border-[#E7E5E0] overflow-hidden flex items-center justify-center shrink-0">
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
                <p className="text-xs font-mono font-semibold text-[#312E81]">
                  {studentRecord?.uniqueStudentId || profile.uniqueCode}
                </p>
              </div>
            </div>

            {institution && (
              <div className="pt-3 border-t border-[#E7E5E0] space-y-3">
                {institution.institutionPhoto && (
                  <img
                    src={institution.institutionPhoto}
                    alt={institution.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-28 rounded-xl object-contain bg-[#FAF9F6] p-1.5 border border-[#E7E5E0]"
                  />
                )}
                <div>
                  <p className="text-xs text-[#64748B]">Institution</p>
                  <p className="text-sm font-bold text-[#0F172A]">{institution.name}</p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-[#F4F2EC] overflow-hidden flex items-center justify-center shrink-0">
                    {institution.adminPhoto ? (
                      <img
                        src={institution.adminPhoto}
                        alt={institution.adminName}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-[11px] font-bold text-[#312E81]">
                        {institution.adminName.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-[#475569] truncate">{institution.adminName}</span>
                </div>
              </div>
            )}
          </div>

          <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4">
            <GrowthRing
              percent={avgStats.avgPost}
              label="Post-Test Mastery"
              sublabel={`${completedTopics.length} topics completed`}
            />
          </div>
        </aside>

        {/* Main Workspace */}
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

          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-bold text-[#0F172A]">
                    Welcome back, {profile.displayName}
                  </h1>
                  <p className="text-sm text-[#64748B] mt-0.5">
                    ID {studentRecord?.uniqueStudentId || profile.uniqueCode} · {subjects.length} Enrolled Subjects
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('learn')}
                  className="px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer"
                >
                  Continue Studying
                </button>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4">
                  <p className="text-xs text-[#64748B]">Enrolled Subjects</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-[#0F172A] tabular-nums">
                    {subjects.length}
                  </p>
                </div>
                <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4">
                  <p className="text-xs text-[#64748B]">Avg Pre-Test</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-[#0F172A] tabular-nums">
                    {avgStats.avgPre}%
                  </p>
                </div>
                <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4">
                  <p className="text-xs text-[#64748B]">Avg Post-Test</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-[#312E81] tabular-nums">
                    {avgStats.avgPost}%
                  </p>
                </div>
                <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4">
                  <p className="text-xs text-[#64748B]">Net Study Growth</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-[#059669] tabular-nums">
                    {avgStats.avgDelta >= 0 ? `+${avgStats.avgDelta}%` : `${avgStats.avgDelta}%`}
                  </p>
                </div>
              </div>

              <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
                <h2 className="text-base font-bold text-[#0F172A]">
                  Your Pre-Test vs Post-Test Growth Curve
                </h2>
                <PrePostComparisonChart items={chartItems} />
              </div>
            </div>
          )}

          {activeTab === 'learn' && (
            <div className="space-y-6">
              {selectedTopic && activeRecord ? (
                <div className="space-y-5">
                  <button
                    type="button"
                    onClick={() => setSelectedTopicId(null)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#312E81] hover:underline cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back to {activeSubject?.name} Topics
                  </button>

                  <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-5">
                    <div>
                      <p className="text-xs font-mono text-[#64748B]">
                        {activeSubject?.name} ({activeSubject?.code})
                      </p>
                      <h1 className="text-2xl font-bold text-[#0F172A] mt-1">
                        {selectedTopic.title}
                      </h1>
                      {selectedTopic.description && (
                        <p className="text-sm text-[#475569] mt-1">{selectedTopic.description}</p>
                      )}
                    </div>

                    {/* 4-Step Learning Rail */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-1.5 bg-[#F4F2EC] rounded-xl">
                      {[
                        {
                          id: 'pretest' as TopicStage,
                          label: '1. Pre-Test',
                          done: activeRecord.preTestCompleted,
                        },
                        {
                          id: 'study' as TopicStage,
                          label: '2. Study & Visuals',
                          done: activeRecord.studyCompleted,
                        },
                        {
                          id: 'assignment' as TopicStage,
                          label: '3. Assignment',
                          done: activeRecord.assignmentStatus !== 'pending',
                        },
                        {
                          id: 'posttest' as TopicStage,
                          label: '4. Post-Test',
                          done: activeRecord.postTestCompleted,
                        },
                      ].map((step) => (
                        <button
                          key={step.id}
                          type="button"
                          onClick={() => {
                            setTopicStage(step.id);
                            setQuizAnswers({});
                            setErrorMsg('');
                          }}
                          className={`py-2.5 px-3 min-h-[44px] rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                            topicStage === step.id
                              ? 'bg-white text-[#312E81] shadow-sm'
                              : 'text-[#475569] hover:text-[#0F172A]'
                          }`}
                        >
                          {step.done && <CheckCircle2 className="w-3.5 h-3.5 text-[#059669]" />}
                          <span className="truncate">{step.label}</span>
                        </button>
                      ))}
                    </div>

                    {topicStage === 'pretest' &&
                      renderQuizSection('pre', selectedTopic.preTestQuestions)}

                    {topicStage === 'study' && (
                      <div className="space-y-6">
                        {selectedTopic.referenceImages.length > 0 && (
                          <div className="space-y-3">
                            <h2 className="text-sm font-bold text-[#0F172A]">
                              Reference Pictures & Diagrams
                            </h2>
                            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                              {selectedTopic.referenceImages.map((img) => (
                                <button
                                  key={img.id}
                                  type="button"
                                  onClick={() => setZoomImage(img.dataUrl)}
                                  className="text-left border border-[#E7E5E0] rounded-xl p-2 bg-[#FAF9F6] hover:border-[#312E81] transition-colors cursor-pointer"
                                >
                                  <img
                                    src={img.dataUrl}
                                    alt={img.caption || 'Reference visual'}
                                    referrerPolicy="no-referrer"
                                    className="w-full h-36 object-contain bg-white rounded-lg"
                                  />
                                  {img.caption && (
                                    <p className="mt-1.5 text-xs font-medium text-[#334155] truncate">
                                      {img.caption}
                                    </p>
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="p-6 rounded-2xl border border-[#E7E5E0] bg-[#FAF9F6] space-y-3">
                          <h2 className="text-sm font-bold text-[#0F172A]">Study Material</h2>
                          <div className="text-[15px] text-[#1E293B] leading-[1.7] whitespace-pre-wrap">
                            {selectedTopic.studyContent ||
                              'Your teacher has not added written notes for this topic yet.'}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={busy}
                          onClick={handleCompleteStudy}
                          className="px-6 py-3 min-h-[44px] rounded-xl bg-[#059669] text-white text-sm font-semibold hover:bg-[#047857] cursor-pointer disabled:opacity-50"
                        >
                          {activeRecord.studyCompleted
                            ? 'Continue to Assignment →'
                            : 'Mark Study Material Complete →'}
                        </button>
                      </div>
                    )}

                    {topicStage === 'assignment' && (
                      <div className="space-y-5">
                        <div className="p-5 rounded-2xl border border-[#E7E5E0] bg-[#FAF9F6] space-y-2">
                          <div className="flex items-center gap-2 text-xs font-semibold text-[#312E81]">
                            <ClipboardList className="w-4 h-4" />
                            <span>Assignment Instructions</span>
                          </div>
                          <p className="text-sm text-[#0F172A] leading-relaxed whitespace-pre-wrap">
                            {selectedTopic.assignmentPrompt ||
                              'Complete and submit your topic work below.'}
                          </p>
                        </div>

                        {activeRecord.assignmentStatus === 'graded' && (
                          <div className="p-5 rounded-2xl border border-[#A7F3D0] bg-[#ECFDF5] space-y-1">
                            <div className="flex items-center gap-2 text-xs font-semibold text-[#059669]">
                              <Award className="w-4 h-4" />
                              <span>Graded by Teacher</span>
                            </div>
                            <p className="font-mono text-xl font-bold text-[#0F172A] tabular-nums">
                              Score: {activeRecord.assignmentScore ?? 0} / 100
                            </p>
                            {activeRecord.assignmentFeedback && (
                              <p className="text-sm text-[#334155]">
                                Feedback: {activeRecord.assignmentFeedback}
                              </p>
                            )}
                          </div>
                        )}

                        {activeRecord.assignmentStatus !== 'graded' && (
                          <form onSubmit={handleSubmitAssignment} className="space-y-4">
                            {selectedTopic.assignmentMode === 'both' && (
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => setAssignType('written')}
                                  className={`px-4 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${
                                    assignType === 'written'
                                      ? 'bg-[#312E81] text-white border-[#312E81]'
                                      : 'bg-white text-[#475569] border-[#E7E5E0]'
                                  }`}
                                >
                                  Written Response
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setAssignType('file')}
                                  className={`px-4 py-2 rounded-lg border text-xs font-semibold cursor-pointer ${
                                    assignType === 'file'
                                      ? 'bg-[#312E81] text-white border-[#312E81]'
                                      : 'bg-white text-[#475569] border-[#E7E5E0]'
                                  }`}
                                >
                                  Upload File / Photo
                                </button>
                              </div>
                            )}

                            {(selectedTopic.assignmentMode === 'written' ||
                              (selectedTopic.assignmentMode === 'both' &&
                                assignType === 'written')) && (
                              <textarea
                                rows={6}
                                maxLength={15000}
                                value={assignText}
                                onChange={(e) => setAssignText(e.target.value)}
                                placeholder="Write your assignment answer clearly..."
                                className="w-full px-4 py-3 rounded-xl border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                              />
                            )}

                            {(selectedTopic.assignmentMode === 'file' ||
                              (selectedTopic.assignmentMode === 'both' &&
                                assignType === 'file')) && (
                              <div className="p-5 rounded-xl border border-dashed border-[#CBD5E1] bg-[#FAF9F6] space-y-3">
                                <input
                                  ref={fileInputRef}
                                  type="file"
                                  accept="image/*,.pdf,.doc,.docx,.txt"
                                  onChange={handleAssignmentFilePick}
                                  className="hidden"
                                />
                                <button
                                  type="button"
                                  onClick={() => fileInputRef.current?.click()}
                                  className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-lg border border-[#E7E5E0] bg-white text-xs font-semibold text-[#0F172A] cursor-pointer"
                                >
                                  <FileUp className="w-4 h-4" />
                                  Choose Photo, PDF, or Document
                                </button>
                                {assignFileName && (
                                  <p className="text-xs font-medium text-[#059669]">
                                    Attached: {assignFileName}
                                  </p>
                                )}
                              </div>
                            )}

                            <button
                              type="submit"
                              disabled={busy}
                              className="px-6 py-3 min-h-[44px] rounded-xl bg-[#312E81] text-white text-sm font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                            >
                              {busy
                                ? 'Submitting...'
                                : activeRecord.assignmentStatus === 'submitted'
                                  ? 'Update Submitted Assignment'
                                  : 'Submit Assignment'}
                            </button>
                          </form>
                        )}
                      </div>
                    )}

                    {topicStage === 'posttest' &&
                      renderQuizSection('post', selectedTopic.postTestQuestions)}
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div>
                    <h1 className="text-2xl font-bold text-[#0F172A]">Your Enrolled Subjects</h1>
                    <p className="text-sm text-[#64748B]">
                      Select a subject to take Pre-Tests, study materials with reference pictures, submit assignments, and track Post-Test growth.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {subjects.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedSubjectId(s.id)}
                        className={`px-4 py-2.5 min-h-[44px] rounded-xl border text-xs font-semibold transition-colors cursor-pointer ${
                          activeSubject?.id === s.id
                            ? 'bg-[#312E81] text-white border-[#312E81]'
                            : 'bg-white text-[#334155] border-[#E7E5E0] hover:border-[#312E81]'
                        }`}
                      >
                        {s.name} ({s.code})
                      </button>
                    ))}
                  </div>

                  {activeSubject && (
                    <div className="space-y-4">
                      {/* Subject Teachers with Photos */}
                      <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4 flex flex-wrap items-center gap-4">
                        <span className="text-xs font-medium text-[#64748B]">Subject Teachers:</span>
                        {teacherProfiles
                          .filter((tp) => tp.subjectIds.includes(activeSubject.id))
                          .map((tp) => (
                            <div key={tp.id} className="flex items-center gap-2">
                              <div className="w-7 h-7 rounded-full bg-[#EEF2FF] overflow-hidden flex items-center justify-center">
                                {tp.photoUrl ? (
                                  <img
                                    src={tp.photoUrl}
                                    alt={tp.name}
                                    referrerPolicy="no-referrer"
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  <span className="text-[11px] font-bold text-[#312E81]">
                                    {tp.name.slice(0, 1).toUpperCase()}
                                  </span>
                                )}
                              </div>
                              <span className="text-xs font-semibold text-[#0F172A]">{tp.name}</span>
                            </div>
                          ))}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {publishedSubjectTopics.map((topic) => {
                          const rec = growthRecords.find((g) => g.topicId === topic.id);
                          return (
                            <div
                              key={topic.id}
                              className="bg-white border border-[#E7E5E0] rounded-2xl p-5 flex flex-col justify-between gap-4"
                            >
                              <div className="space-y-1.5">
                                <h3 className="text-base font-bold text-[#0F172A]">{topic.title}</h3>
                                {topic.description && (
                                  <p className="text-xs text-[#475569] line-clamp-2">
                                    {topic.description}
                                  </p>
                                )}
                                <p className="text-xs font-mono text-[#64748B] pt-1">
                                  Pre: {rec?.preTestCompleted ? `${rec.preTestPercent}%` : 'Pending'} · Post:{' '}
                                  {rec?.postTestCompleted ? `${rec.postTestPercent}%` : 'Pending'}
                                  {rec?.postTestCompleted && (
                                    <span className="ml-2 text-[#059669] font-semibold">
                                      ({rec.growthDelta >= 0 ? '+' : ''}
                                      {rec.growthDelta}%)
                                    </span>
                                  )}
                                </p>
                              </div>

                              <button
                                type="button"
                                onClick={() => handleOpenTopic(topic)}
                                className="w-full py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer"
                              >
                                {rec ? 'Open Learning Module' : 'Start with Pre-Test'}
                              </button>
                            </div>
                          );
                        })}

                        {publishedSubjectTopics.length === 0 && (
                          <div className="md:col-span-2 bg-white border border-[#E7E5E0] rounded-2xl p-8 text-center text-sm text-[#64748B]">
                            No published topics in {activeSubject.name} yet.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'profile' && (
            <div className="space-y-6">
              <form
                onSubmit={handleSaveProfile}
                className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-5"
              >
                <h2 className="text-lg font-bold text-[#0F172A]">Your Student Profile & Photo</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Full Name</label>
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
                      Unique Student ID
                    </label>
                    <input
                      type="text"
                      disabled
                      value={studentRecord?.uniqueStudentId || profile.uniqueCode || ''}
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#F4F2EC] font-mono text-sm text-[#312E81]"
                    />
                  </div>
                </div>
                <PhotoUploadField label="Your Student Photo" value={selfPhoto} onChange={setSelfPhoto} />
                <button
                  type="submit"
                  disabled={busy}
                  className="px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                >
                  {busy ? 'Saving...' : 'Save Student Photo & Name'}
                </button>
              </form>
              <WebOtpCard profile={profile} />
            </div>
          )}
        </main>
      </div>

      {/* Reference Image Lightbox */}
      {zoomImage && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          onClick={() => setZoomImage(null)}
        >
          <img
            src={zoomImage}
            alt="Zoomed reference diagram"
            className="max-w-full max-h-[85vh] rounded-2xl border border-white/20"
          />
        </div>
      )}

      {/* Mobile Bottom Nav */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-[#E7E5E0] pb-safe">
        <div className="grid grid-cols-3 h-16 items-center">
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
              <span className="mt-1 truncate max-w-[96px]">{item.mobileLabel}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
};
