import React, { useMemo, useState } from 'react';
import { signOut } from 'firebase/auth';
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  Building2,
  Camera,
  Eraser,
  GraduationCap,
  LogOut,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { auth, formatReadableFirestoreError } from '../lib/firebase';
import {
  addStudentToInstitution,
  addTeacherToInstitution,
  createSubject,
  deleteGrowthRecordAdmin,
  deleteStudentRecord,
  deleteSubjectCascade,
  deleteTeacherRecord,
  deleteTopicAdmin,
  resetInstitutionWorkspace,
  resetStudentAllProgressAdmin,
  resetStudentGrowthRecordAdmin,
  resetStudentRegistration,
  resetTeacherRegistration,
  resetTopicStudyMaterialAdmin,
  updateInstitutionPhotosAndInfo,
  updateMemberPhotoAdmin,
} from '../lib/sikshaliteService';
import type {
  GrowthRecord,
  Institution,
  StudentRecord,
  Subject,
  TeacherRecord,
  Topic,
  UserProfile,
} from '../types/sikshalite';
import { PrePostComparisonChart } from './GrowthCharts';
import { PhotoUploadField } from './PhotoUploadField';
import { PWAInstallButton } from './PWAInstallButton';
import { WebOtpCard } from './WebOtpCard';

type AdminTab = 'overview' | 'subjects' | 'teachers' | 'students' | 'photos' | 'study_reset';

interface ConfirmActionState {
  title: string;
  description: string;
  confirmLabel: string;
  successMessage: string;
  danger?: boolean;
  requirePhrase?: string;
  run: () => Promise<void>;
}

interface AdminDashboardProps {
  profile: UserProfile;
  institution: Institution | null;
  subjects: Subject[];
  teachers: TeacherRecord[];
  students: StudentRecord[];
  topics: Topic[];
  growthRecords: GrowthRecord[];
  onInstitutionReset?: () => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  profile,
  institution,
  subjects,
  teachers,
  students,
  topics,
  growthRecords,
  onInstitutionReset,
}) => {
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmActionState | null>(null);
  const [confirmPhraseInput, setConfirmPhraseInput] = useState('');

  // Subject form
  const [subjName, setSubjName] = useState('');
  const [subjCode, setSubjCode] = useState('');
  const [subjDesc, setSubjDesc] = useState('');

  // Teacher form
  const [tName, setTName] = useState('');
  const [tMobile, setTMobile] = useState('');
  const [tEmail, setTEmail] = useState('');
  const [tPhoto, setTPhoto] = useState('');
  const [tSubjects, setTSubjects] = useState<string[]>([]);

  // Student form
  const [sName, setSName] = useState('');
  const [sMobile, setSMobile] = useState('');
  const [sEmail, setSEmail] = useState('');
  const [sPhoto, setSPhoto] = useState('');
  const [sCustomId, setSCustomId] = useState('');
  const [sSubjects, setSSubjects] = useState<string[]>([]);
  const [studentSearch, setStudentSearch] = useState('');

  // Institution & Admin photo editor
  const [editInstName, setEditInstName] = useState(institution?.name || '');
  const [editTagline, setEditTagline] = useState(institution?.tagline || '');
  const [editAdminName, setEditAdminName] = useState(institution?.adminName || profile.displayName);
  const [editInstPhoto, setEditInstPhoto] = useState(institution?.institutionPhoto || '');
  const [editAdminPhoto, setEditAdminPhoto] = useState(institution?.adminPhoto || profile.photoUrl || '');

  const syncPhotoEditor = () => {
    if (!institution) return;
    setEditInstName(institution.name);
    setEditTagline(institution.tagline || '');
    setEditAdminName(institution.adminName);
    setEditInstPhoto(institution.institutionPhoto || '');
    setEditAdminPhoto(institution.adminPhoto || '');
  };

  const completedGrowth = useMemo(
    () => growthRecords.filter((g) => g.preTestCompleted && g.postTestCompleted),
    [growthRecords]
  );

  const avgGrowthDelta = useMemo(() => {
    if (completedGrowth.length === 0) return 0;
    const sum = completedGrowth.reduce((acc, g) => acc + g.growthDelta, 0);
    return Math.round((sum / completedGrowth.length) * 10) / 10;
  }, [completedGrowth]);

  const subjectChartItems = useMemo(() => {
    return subjects
      .map((subj) => {
        const recs = completedGrowth.filter((g) => g.subjectId === subj.id);
        if (recs.length === 0) return null;
        const pre = Math.round(recs.reduce((a, b) => a + b.preTestPercent, 0) / recs.length);
        const post = Math.round(recs.reduce((a, b) => a + b.postTestPercent, 0) / recs.length);
        return {
          label: `${subj.name} (${recs.length} attempts)`,
          prePercent: pre,
          postPercent: post,
          delta: Math.round((post - pre) * 10) / 10,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [subjects, completedGrowth]);

  const filteredStudents = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    if (!q) return students;
    return students.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.uniqueStudentId.toLowerCase().includes(q) ||
        s.phoneE164.includes(q)
    );
  }, [students, studentSearch]);

  const handleCreateSubject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!institution) return;
    setErrorMsg('');
    setStatusMsg('');
    setBusy(true);
    try {
      await createSubject(institution, { name: subjName, code: subjCode, description: subjDesc });
      setSubjName('');
      setSubjCode('');
      setSubjDesc('');
      setStatusMsg('Subject created. You can now assign teachers and enroll students in it.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to create subject.');
    } finally {
      setBusy(false);
    }
  };

  const handleAddTeacher = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!institution) return;
    setErrorMsg('');
    setStatusMsg('');
    if (tSubjects.length === 0) {
      setErrorMsg('Assign at least one subject to the teacher.');
      return;
    }
    setBusy(true);
    try {
      await addTeacherToInstitution(
        institution,
        {
          name: tName,
          mobile: tMobile,
          fallbackEmail: tEmail,
          photoUrl: tPhoto,
          assignedSubjectIds: tSubjects,
        },
        subjects
      );
      setTName('');
      setTMobile('');
      setTEmail('');
      setTPhoto('');
      setTSubjects([]);
      setStatusMsg('Teacher added and mobile number linked for SMS OTP login.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to add teacher.');
    } finally {
      setBusy(false);
    }
  };

  const handleAddStudent = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!institution) return;
    setErrorMsg('');
    setStatusMsg('');
    if (sSubjects.length === 0) {
      setErrorMsg('Select at least one enrolled subject for the student.');
      return;
    }
    setBusy(true);
    try {
      const { uniqueStudentId } = await addStudentToInstitution(
        institution,
        profile.uid,
        {
          name: sName,
          mobile: sMobile,
          fallbackEmail: sEmail,
          photoUrl: sPhoto,
          enrolledSubjectIds: sSubjects,
          customStudentId: sCustomId,
        },
        subjects,
        students.length
      );
      setSName('');
      setSMobile('');
      setSEmail('');
      setSPhoto('');
      setSCustomId('');
      setSSubjects([]);
      setStatusMsg(`Student enrolled with Unique ID ${uniqueStudentId} and mobile OTP access.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to enroll student.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveInstitutionPhotos = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!institution) return;
    setErrorMsg('');
    setStatusMsg('');
    setBusy(true);
    try {
      await updateInstitutionPhotosAndInfo(
        institution.id,
        {
          name: editInstName,
          tagline: editTagline,
          adminName: editAdminName,
          institutionPhoto: editInstPhoto,
          adminPhoto: editAdminPhoto,
        },
        profile.uid
      );
      setStatusMsg('Institution branding and admin photo updated for all teachers and students.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update institution profile.');
    } finally {
      setBusy(false);
    }
  };

  const handleMemberPhotoUpdate = async (
    role: 'teacher' | 'student',
    memberId: string,
    memberName: string,
    url: string
  ) => {
    setErrorMsg('');
    setStatusMsg('');
    try {
      await updateMemberPhotoAdmin(role, memberId, url);
      setStatusMsg(`Updated photo for ${memberName}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update member photo.');
    }
  };

  const requestConfirm = (action: ConfirmActionState) => {
    setErrorMsg('');
    setConfirmPhraseInput('');
    setConfirmAction(action);
  };

  const executeConfirmAction = async () => {
    if (!confirmAction) return;
    if (confirmAction.requirePhrase && confirmPhraseInput.trim() !== confirmAction.requirePhrase) {
      return;
    }
    setBusy(true);
    setErrorMsg('');
    setStatusMsg('');
    try {
      await confirmAction.run();
      setStatusMsg(confirmAction.successMessage);
      setConfirmAction(null);
      setConfirmPhraseInput('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Action failed.');
      setConfirmAction(null);
    } finally {
      setBusy(false);
    }
  };

  const navItems: { id: AdminTab; label: string; shortLabel: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', shortLabel: 'Overview', icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'subjects', label: 'Subjects', shortLabel: 'Subjects', icon: <BookOpen className="w-4 h-4" /> },
    { id: 'teachers', label: 'Teachers', shortLabel: 'Teachers', icon: <Users className="w-4 h-4" /> },
    { id: 'students', label: 'Students', shortLabel: 'Students', icon: <GraduationCap className="w-4 h-4" /> },
    { id: 'photos', label: 'Photos & Profile', shortLabel: 'Photos', icon: <Camera className="w-4 h-4" /> },
    { id: 'study_reset', label: 'Study & Reset', shortLabel: 'Reset', icon: <RotateCcw className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-[#FAF9F6] flex flex-col pb-20 md:pb-0">
      {/* Top Bar */}
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
                onClick={() => {
                  if (item.id === 'photos') syncPhotoEditor();
                  setActiveTab(item.id);
                }}
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
        {/* Desktop Sidebar */}
        <aside className="hidden lg:block lg:col-span-3 space-y-5">
          <div className="bg-white border border-[#E7E5E0] rounded-2xl p-5 space-y-4">
            <div className="w-full h-28 rounded-xl bg-[#FAF9F6] p-1.5 border border-[#E7E5E0] overflow-hidden flex items-center justify-center">
              {institution?.institutionPhoto ? (
                <img
                  src={institution.institutionPhoto}
                  alt={institution.name}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain"
                />
              ) : (
                <Building2 className="w-8 h-8 text-[#94A3B8]" />
              )}
            </div>
            <div>
              <h2 className="text-base font-bold text-[#0F172A] leading-snug">
                {institution?.name || 'Institution'}
              </h2>
              <p className="text-xs text-[#64748B] mt-1">
                Join Code: <span className="font-mono font-semibold text-[#312E81]">{institution?.joinCode}</span>
              </p>
            </div>
            <div className="pt-3 border-t border-[#E7E5E0] flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#EEF2FF] border border-[#E7E5E0] overflow-hidden flex items-center justify-center shrink-0">
                {institution?.adminPhoto ? (
                  <img
                    src={institution.adminPhoto}
                    alt={institution.adminName}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-xs font-bold text-[#312E81]">
                    {(institution?.adminName || 'A').slice(0, 1).toUpperCase()}
                  </span>
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[#0F172A] truncate">
                  {institution?.adminName || profile.displayName}
                </p>
                <p className="text-xs text-[#64748B]">Institution Admin</p>
              </div>
            </div>
          </div>

          <div className="bg-white border border-[#E7E5E0] rounded-2xl p-2 space-y-1">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.id === 'photos') syncPhotoEditor();
                  setActiveTab(item.id);
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
                  activeTab === item.id
                    ? 'bg-[#312E81] text-white'
                    : 'text-[#475569] hover:bg-[#FAF9F6] hover:text-[#0F172A]'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* Main Content Viewport */}
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
                  <h1 className="text-2xl font-bold text-[#0F172A]">Institution Admin Dashboard</h1>
                  <p className="text-sm text-[#64748B] mt-0.5">
                    {institution?.name} · {subjects.length} Subjects · {teachers.length} Teachers · {students.length} Students
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('teachers')}
                  className="inline-flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <UserPlus className="w-4 h-4" />
                  Assign Teacher
                </button>
              </div>

              {/* 4 KPI Strip */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4">
                  <p className="text-xs text-[#64748B]">Subjects</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-[#0F172A] tabular-nums">
                    {subjects.length}
                  </p>
                </div>
                <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4">
                  <p className="text-xs text-[#64748B]">Assigned Teachers</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-[#0F172A] tabular-nums">
                    {teachers.length}
                  </p>
                </div>
                <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4">
                  <p className="text-xs text-[#64748B]">Enrolled Students</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-[#0F172A] tabular-nums">
                    {students.length}
                  </p>
                </div>
                <div className="bg-white border border-[#E7E5E0] rounded-2xl p-4">
                  <p className="text-xs text-[#64748B]">Avg Study Growth</p>
                  <p className="mt-1 font-mono text-2xl font-bold text-[#059669] tabular-nums">
                    {avgGrowthDelta >= 0 ? `+${avgGrowthDelta}%` : `${avgGrowthDelta}%`}
                  </p>
                </div>
              </div>

              {/* Subject Growth Chart */}
              <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-bold text-[#0F172A]">
                    Subject-Wise Pre-Test vs Post-Test Growth
                  </h2>
                  <span className="text-xs text-[#64748B] font-mono tabular-nums">
                    {topics.length} Published/Draft Topics
                  </span>
                </div>
                <PrePostComparisonChart items={subjectChartItems} />
              </div>

              {/* Recent Student Growth Records Table */}
              <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
                <h2 className="text-base font-bold text-[#0F172A]">Recent Student Growth Activity</h2>
                {growthRecords.length === 0 ? (
                  <p className="text-sm text-[#64748B] py-4">
                    No student assessment attempts yet. Once students take Pre-Tests and Post-Tests, growth records appear here.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-[#E7E5E0] text-xs text-[#64748B]">
                          <th className="py-2.5 pr-4 font-medium">Student ID</th>
                          <th className="py-2.5 pr-4 font-medium">Student</th>
                          <th className="py-2.5 pr-4 font-medium">Subject</th>
                          <th className="py-2.5 pr-4 font-medium text-right">Pre-Test</th>
                          <th className="py-2.5 pr-4 font-medium text-right">Post-Test</th>
                          <th className="py-2.5 font-medium text-right">Growth</th>
                        </tr>
                      </thead>
                      <tbody>
                        {growthRecords.slice(0, 12).map((rec) => {
                          const subj = subjects.find((s) => s.id === rec.subjectId);
                          return (
                            <tr key={rec.id} className="border-b border-[#F1F0EA] last:border-b-0">
                              <td className="py-3 pr-4 font-mono text-xs text-[#312E81]">
                                {rec.uniqueStudentId}
                              </td>
                              <td className="py-3 pr-4 font-medium text-[#0F172A]">{rec.studentName}</td>
                              <td className="py-3 pr-4 text-[#475569]">{subj?.name || 'Subject'}</td>
                              <td className="py-3 pr-4 text-right font-mono tabular-nums">
                                {rec.preTestCompleted ? `${rec.preTestPercent}%` : '—'}
                              </td>
                              <td className="py-3 pr-4 text-right font-mono tabular-nums">
                                {rec.postTestCompleted ? `${rec.postTestPercent}%` : '—'}
                              </td>
                              <td
                                className={`py-3 text-right font-mono font-semibold tabular-nums ${
                                  rec.postTestCompleted
                                    ? rec.growthDelta >= 0
                                      ? 'text-[#059669]'
                                      : 'text-[#DC2626]'
                                    : 'text-[#64748B]'
                                }`}
                              >
                                {rec.postTestCompleted
                                  ? `${rec.growthDelta >= 0 ? '+' : ''}${rec.growthDelta}%`
                                  : 'In Progress'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'subjects' && (
            <div className="space-y-6">
              <form
                onSubmit={handleCreateSubject}
                className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4"
              >
                <h2 className="text-base font-bold text-[#0F172A]">Add New Subject</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                      Subject Name *
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={100}
                      value={subjName}
                      onChange={(e) => setSubjName(e.target.value)}
                      placeholder="e.g. Organic Chemistry"
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                      Subject Code *
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={24}
                      value={subjCode}
                      onChange={(e) => setSubjCode(e.target.value)}
                      placeholder="e.g. CHEM-101"
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    Curriculum Overview
                  </label>
                  <input
                    type="text"
                    maxLength={400}
                    value={subjDesc}
                    onChange={(e) => setSubjDesc(e.target.value)}
                    placeholder="Brief description of syllabus scope..."
                    className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                  Create Subject
                </button>
              </form>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {subjects.map((subj) => {
                  const assignedTeachers = teachers.filter((t) =>
                    t.assignedSubjectIds.includes(subj.id)
                  );
                  const subjTopicsCount = topics.filter((t) => t.subjectId === subj.id).length;
                  return (
                    <div
                      key={subj.id}
                      className="bg-white border border-[#E7E5E0] rounded-2xl p-5 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-base font-bold text-[#0F172A] truncate">{subj.name}</h3>
                          <p className="text-xs text-[#64748B] font-mono mt-0.5">
                            {subj.code} · {subjTopicsCount} Topics · {assignedTeachers.length} Teachers
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            requestConfirm({
                              title: `Delete Subject "${subj.name}"?`,
                              description: `This permanently deletes "${subj.name}", its ${subjTopicsCount} topic(s), and related student growth records, and unassigns it from teachers and students.`,
                              confirmLabel: 'Delete Subject',
                              successMessage: `Subject "${subj.name}" and its study material were deleted.`,
                              danger: true,
                              run: () =>
                                deleteSubjectCascade(
                                  subj,
                                  topics,
                                  teachers,
                                  students,
                                  growthRecords
                                ),
                            })
                          }
                          className="p-2 min-h-[40px] min-w-[40px] rounded-lg text-[#64748B] hover:text-[#DC2626] flex items-center justify-center cursor-pointer shrink-0"
                          aria-label={`Delete ${subj.name}`}
                          title="Delete subject & cascade topics"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      {subj.description && (
                        <p className="text-sm text-[#475569]">{subj.description}</p>
                      )}
                      <div className="pt-2 border-t border-[#F1F0EA] text-xs text-[#64748B]">
                        Teachers:{' '}
                        {assignedTeachers.length > 0
                          ? assignedTeachers.map((t) => t.name).join(', ')
                          : 'Unassigned'}
                      </div>
                    </div>
                  );
                })}
                {subjects.length === 0 && (
                  <p className="text-sm text-[#64748B] md:col-span-2">
                    Create your first subject above before assigning teachers.
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === 'teachers' && (
            <div className="space-y-6">
              <form
                onSubmit={handleAddTeacher}
                className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-5"
              >
                <h2 className="text-base font-bold text-[#0F172A]">Assign Subject Teacher</h2>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                      Teacher Name *
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={100}
                      value={tName}
                      onChange={(e) => setTName(e.target.value)}
                      placeholder="e.g. Prof. Rajesh Verma"
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                      Mobile Number (SMS OTP) *
                    </label>
                    <input
                      type="tel"
                      required
                      maxLength={24}
                      value={tMobile}
                      onChange={(e) => setTMobile(e.target.value)}
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
                      value={tEmail}
                      onChange={(e) => setTEmail(e.target.value)}
                      placeholder="teacher@institute.edu"
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                    />
                  </div>
                </div>

                <div>
                  <span className="block text-xs font-medium text-[#475569] mb-2">
                    Assigned Subjects (Teacher can only access selected subjects) *
                  </span>
                  {subjects.length === 0 ? (
                    <p className="text-xs text-[#D97706]">
                      Add subjects in the Subjects tab first.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {subjects.map((s) => {
                        const checked = tSubjects.includes(s.id);
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() =>
                              setTSubjects((prev) =>
                                checked ? prev.filter((id) => id !== s.id) : [...prev, s.id]
                              )
                            }
                            className={`px-3.5 py-2 min-h-[40px] rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                              checked
                                ? 'bg-[#312E81] text-white border-[#312E81]'
                                : 'bg-[#FAF9F6] text-[#334155] border-[#E7E5E0] hover:border-[#312E81]'
                            }`}
                          >
                            {s.name} ({s.code})
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <PhotoUploadField label="Teacher Photo" value={tPhoto} onChange={setTPhoto} />

                <button
                  type="submit"
                  disabled={busy || subjects.length === 0}
                  className="inline-flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                >
                  <UserPlus className="w-4 h-4" />
                  {busy ? 'Assigning...' : 'Add Teacher & Link Mobile'}
                </button>
              </form>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {teachers.map((teacher) => {
                  const subjNames = subjects
                    .filter((s) => teacher.assignedSubjectIds.includes(s.id))
                    .map((s) => s.name);
                  return (
                    <div
                      key={teacher.id}
                      className="bg-white border border-[#E7E5E0] rounded-2xl p-5 flex items-start justify-between gap-4"
                    >
                      <div className="flex items-start gap-3.5 min-w-0">
                        <div className="w-12 h-12 rounded-full bg-[#EEF2FF] border border-[#E7E5E0] overflow-hidden flex items-center justify-center shrink-0">
                          {teacher.photoUrl ? (
                            <img
                              src={teacher.photoUrl}
                              alt={teacher.name}
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <span className="text-sm font-bold text-[#312E81]">
                              {teacher.name.slice(0, 1).toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-sm font-bold text-[#0F172A] truncate">{teacher.name}</h3>
                          <p className="text-xs font-mono text-[#64748B] mt-0.5">
                            {teacher.phoneE164} · {teacher.claimedUid ? 'OTP Active' : 'Pending Login'}
                          </p>
                          <p className="text-xs text-[#475569] mt-1.5">
                            Subjects: {subjNames.join(', ') || 'None'}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {teacher.claimedUid && (
                          <button
                            type="button"
                            onClick={() =>
                              requestConfirm({
                                title: `Reset OTP Registration for ${teacher.name}?`,
                                description:
                                  'This unlinks their current login session so the teacher can verify their mobile OTP again from any device. Their assigned subjects remain intact.',
                                confirmLabel: 'Reset Registration',
                                successMessage: `OTP registration reset for ${teacher.name}. They can re-verify using ${teacher.phoneE164}.`,
                                run: () => resetTeacherRegistration(teacher, subjects),
                              })
                            }
                            className="p-2 min-h-[40px] min-w-[40px] rounded-lg text-[#64748B] hover:text-[#312E81] flex items-center justify-center cursor-pointer"
                            aria-label={`Reset registration for ${teacher.name}`}
                            title="Reset OTP Registration"
                          >
                            <RotateCcw className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() =>
                            requestConfirm({
                              title: `Delete Teacher "${teacher.name}"?`,
                              description:
                                'Permanently removes this teacher registration, phone OTP link, and subject assignment.',
                              confirmLabel: 'Delete Teacher',
                              successMessage: `Teacher "${teacher.name}" removed.`,
                              danger: true,
                              run: () => deleteTeacherRecord(teacher, subjects),
                            })
                          }
                          className="p-2 min-h-[40px] min-w-[40px] rounded-lg text-[#64748B] hover:text-[#DC2626] flex items-center justify-center cursor-pointer"
                          aria-label={`Remove ${teacher.name}`}
                          title="Delete Teacher"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'students' && (
            <div className="space-y-6">
              <form
                onSubmit={handleAddStudent}
                className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-5"
              >
                <h2 className="text-base font-bold text-[#0F172A]">
                  Enroll Student (Generates Unique ID & Mobile OTP Link)
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
                      value={sName}
                      onChange={(e) => setSName(e.target.value)}
                      placeholder="e.g. Aarav Sharma"
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                      Mobile Number (SMS OTP) *
                    </label>
                    <input
                      type="tel"
                      required
                      maxLength={24}
                      value={sMobile}
                      onChange={(e) => setSMobile(e.target.value)}
                      placeholder="+919123456789"
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
                      value={sEmail}
                      onChange={(e) => setSEmail(e.target.value)}
                      placeholder="student@example.com"
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                      Unique Student ID (Auto-generated if blank)
                    </label>
                    <input
                      type="text"
                      maxLength={32}
                      value={sCustomId}
                      onChange={(e) => setSCustomId(e.target.value)}
                      placeholder="e.g. SIK-2026-001"
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm"
                    />
                  </div>
                </div>

                <div>
                  <span className="block text-xs font-medium text-[#475569] mb-2">
                    Enrolled Subjects *
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {subjects.map((s) => {
                      const checked = sSubjects.includes(s.id);
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() =>
                            setSSubjects((prev) =>
                              checked ? prev.filter((id) => id !== s.id) : [...prev, s.id]
                            )
                          }
                          className={`px-3.5 py-2 min-h-[40px] rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                            checked
                              ? 'bg-[#312E81] text-white border-[#312E81]'
                              : 'bg-[#FAF9F6] text-[#334155] border-[#E7E5E0] hover:border-[#312E81]'
                          }`}
                        >
                          {s.name} ({s.code})
                        </button>
                      );
                    })}
                  </div>
                </div>

                <PhotoUploadField label="Student Photo" value={sPhoto} onChange={setSPhoto} />

                <button
                  type="submit"
                  disabled={busy || subjects.length === 0}
                  className="inline-flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                >
                  <GraduationCap className="w-4 h-4" />
                  {busy ? 'Enrolling...' : 'Enroll Student & Issue Unique ID'}
                </button>
              </form>

              <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-base font-bold text-[#0F172A]">
                    Student Directory ({students.length})
                  </h2>
                  <div className="relative w-full sm:w-64">
                    <Search className="w-4 h-4 text-[#94A3B8] absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={studentSearch}
                      onChange={(e) => setStudentSearch(e.target.value)}
                      placeholder="Search name, ID, or mobile..."
                      className="w-full pl-9 pr-3 py-2 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-xs"
                    />
                  </div>
                </div>

                <div className="divide-y divide-[#F1F0EA]">
                  {filteredStudents.map((stu) => {
                    const stuRecs = growthRecords.filter(
                      (g) => g.studentDocId === stu.id && g.postTestCompleted
                    );
                    const avgStuDelta =
                      stuRecs.length > 0
                        ? Math.round(
                            (stuRecs.reduce((a, b) => a + b.growthDelta, 0) / stuRecs.length) * 10
                          ) / 10
                        : null;

                    return (
                      <div
                        key={stu.id}
                        className="py-3.5 flex items-center justify-between gap-4"
                      >
                        <div className="flex items-center gap-3.5 min-w-0">
                          <div className="w-11 h-11 rounded-full bg-[#EEF2FF] border border-[#E7E5E0] overflow-hidden flex items-center justify-center shrink-0">
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
                            <p className="text-xs text-[#64748B] font-mono truncate">
                              {stu.uniqueStudentId} · {stu.phoneE164} ·{' '}
                              {stu.claimedUid ? 'Linked' : 'Pending OTP'}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          {avgStuDelta !== null && (
                            <span
                              className={`font-mono text-xs font-semibold tabular-nums mr-1.5 ${
                                avgStuDelta >= 0 ? 'text-[#059669]' : 'text-[#DC2626]'
                              }`}
                            >
                              {avgStuDelta >= 0 ? `+${avgStuDelta}%` : `${avgStuDelta}%`} Growth
                            </span>
                          )}
                          {stu.claimedUid && (
                            <button
                              type="button"
                              onClick={() =>
                                requestConfirm({
                                  title: `Reset OTP Registration for ${stu.name}?`,
                                  description: `Unlinks ${stu.name} (${stu.uniqueStudentId}) from their current login session so they can re-verify using ${stu.phoneE164}.`,
                                  confirmLabel: 'Reset Registration',
                                  successMessage: `OTP registration reset for ${stu.name}.`,
                                  run: () => resetStudentRegistration(stu),
                                })
                              }
                              className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-[#E7E5E0] text-xs font-medium text-[#475569] hover:border-[#312E81] hover:text-[#312E81] flex items-center gap-1 cursor-pointer"
                              title="Reset Student OTP Registration"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              Reset OTP
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              requestConfirm({
                                title: `Reset Study Progress for ${stu.name}?`,
                                description:
                                  'Clears all Pre-Tests, Study completion, Assignments, and Post-Tests for this student so they can restart topics fresh.',
                                confirmLabel: 'Reset Progress',
                                successMessage: `Cleared study progress for ${stu.name}.`,
                                run: () => resetStudentAllProgressAdmin(stu, growthRecords),
                              })
                            }
                            className="px-2.5 py-1.5 min-h-[36px] rounded-lg border border-[#E7E5E0] text-xs font-medium text-[#475569] hover:border-[#D97706] hover:text-[#D97706] flex items-center gap-1 cursor-pointer"
                            title="Reset All Study Progress"
                          >
                            <Eraser className="w-3.5 h-3.5" />
                            Reset Study
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              requestConfirm({
                                title: `Delete Student "${stu.name}"?`,
                                description: `Permanently deletes ${stu.name} (${stu.uniqueStudentId}), their OTP link, and all growth records.`,
                                confirmLabel: 'Delete Student',
                                successMessage: `Student "${stu.name}" deleted.`,
                                danger: true,
                                run: () => deleteStudentRecord(stu, growthRecords),
                              })
                            }
                            className="p-2 min-h-[36px] min-w-[36px] rounded-lg text-[#64748B] hover:text-[#DC2626] flex items-center justify-center cursor-pointer"
                            aria-label={`Remove ${stu.name}`}
                            title="Delete Student"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {filteredStudents.length === 0 && (
                    <p className="py-6 text-sm text-[#64748B] text-center">
                      No matching students found.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'photos' && (
            <div className="space-y-6">
              <form
                onSubmit={handleSaveInstitutionPhotos}
                className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-5"
              >
                <div>
                  <h2 className="text-base font-bold text-[#0F172A]">
                    Institution & Admin Photos
                  </h2>
                  <p className="text-xs text-[#64748B] mt-0.5">
                    Displayed to all assigned teachers and enrolled students across Sikshalite.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                      Institution Name
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={120}
                      value={editInstName}
                      onChange={(e) => setEditInstName(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                      Admin Display Name
                    </label>
                    <input
                      type="text"
                      required
                      maxLength={100}
                      value={editAdminName}
                      onChange={(e) => setEditAdminName(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    Institution Tagline
                  </label>
                  <input
                    type="text"
                    maxLength={200}
                    value={editTagline}
                    onChange={(e) => setEditTagline(e.target.value)}
                    className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-sm"
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <PhotoUploadField
                    label="Institution Photo"
                    value={editInstPhoto}
                    onChange={setEditInstPhoto}
                    shape="banner"
                  />
                  <PhotoUploadField
                    label="Your Admin Photo"
                    value={editAdminPhoto}
                    onChange={setEditAdminPhoto}
                    shape="circle"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-5 py-2.5 min-h-[44px] rounded-xl bg-[#312E81] text-white text-xs font-semibold hover:bg-[#4338CA] cursor-pointer disabled:opacity-50"
                >
                  {busy ? 'Saving...' : 'Save Institution & Admin Photos'}
                </button>
              </form>

              <WebOtpCard profile={profile} />

              {/* Manage Member Photos */}
              <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-5">
                <h2 className="text-base font-bold text-[#0F172A]">
                  Manage Teacher & Student Photos
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {teachers.map((t) => (
                    <div key={t.id} className="p-4 border border-[#E7E5E0] rounded-xl space-y-3">
                      <p className="text-xs font-semibold text-[#0F172A]">
                        Teacher: {t.name}
                      </p>
                      <PhotoUploadField
                        label="Teacher Avatar"
                        value={t.photoUrl || ''}
                        onChange={(url) => handleMemberPhotoUpdate('teacher', t.id, t.name, url)}
                      />
                    </div>
                  ))}
                  {students.map((s) => (
                    <div key={s.id} className="p-4 border border-[#E7E5E0] rounded-xl space-y-3">
                      <p className="text-xs font-semibold text-[#0F172A]">
                        Student: {s.name} ({s.uniqueStudentId})
                      </p>
                      <PhotoUploadField
                        label="Student Avatar"
                        value={s.photoUrl || ''}
                        onChange={(url) => handleMemberPhotoUpdate('student', s.id, s.name, url)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          {activeTab === 'study_reset' && (
            <div className="space-y-6">
              <div>
                <h1 className="text-xl font-bold text-[#0F172A]">
                  Study Material, Progress & Registration Reset
                </h1>
                <p className="text-sm text-[#64748B] mt-0.5">
                  Delete or reset any topic, study material, quiz, student attempt, or institution registration.
                </p>
              </div>

              {/* Topic Study Materials & Quizzes */}
              <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-base font-bold text-[#0F172A]">
                    Topics & Study Materials ({topics.length})
                  </h2>
                </div>

                {topics.length === 0 ? (
                  <p className="text-sm text-[#64748B]">
                    No topics or study materials created yet.
                  </p>
                ) : (
                  <div className="divide-y divide-[#F1F0EA]">
                    {topics.map((top) => {
                      const subj = subjects.find((s) => s.id === top.subjectId);
                      const attemptCount = growthRecords.filter((g) => g.topicId === top.id).length;
                      return (
                        <div key={top.id} className="py-4 space-y-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-[#0F172A]">
                                {top.title}
                              </p>
                              <p className="text-xs text-[#64748B] font-mono mt-0.5">
                                {subj?.name || 'Subject'} · Pre: {top.preTestQuestions.length}Q · Post:{' '}
                                {top.postTestQuestions.length}Q · {top.referenceImages.length} Pics ·{' '}
                                {attemptCount} Student Attempt(s)
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                requestConfirm({
                                  title: `Delete Topic "${top.title}"?`,
                                  description: `Removes the entire topic, its quizzes, study content, reference pictures, and ${attemptCount} student growth record(s).`,
                                  confirmLabel: 'Delete Topic',
                                  successMessage: `Topic "${top.title}" deleted.`,
                                  danger: true,
                                  run: () => deleteTopicAdmin(subj, top.id, growthRecords),
                                })
                              }
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg border border-[#FECACA] bg-[#FEF2F2] text-xs font-semibold text-[#DC2626] hover:bg-[#FEE2E2] cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Delete Topic
                            </button>
                          </div>

                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                requestConfirm({
                                  title: `Clear Study Notes & Reference Images for "${top.title}"?`,
                                  description:
                                    'Removes the study guide text and uploaded reference pictures so the teacher can author fresh material.',
                                  confirmLabel: 'Clear Study Material',
                                  successMessage: `Cleared study notes and reference pictures for "${top.title}".`,
                                  run: () =>
                                    resetTopicStudyMaterialAdmin(top, growthRecords, {
                                      clearStudy: true,
                                      clearImages: true,
                                    }),
                                })
                              }
                              className="px-3 py-1.5 min-h-[36px] rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-xs font-medium text-[#334155] hover:border-[#312E81] cursor-pointer"
                            >
                              Clear Study & Pics
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                requestConfirm({
                                  title: `Clear Pre-Test & Post-Test Quizzes for "${top.title}"?`,
                                  description:
                                    'Removes all Pre-Test and Post-Test questions from this topic.',
                                  confirmLabel: 'Clear Quizzes',
                                  successMessage: `Cleared Pre/Post quizzes for "${top.title}".`,
                                  run: () =>
                                    resetTopicStudyMaterialAdmin(top, growthRecords, {
                                      clearPreTest: true,
                                      clearPostTest: true,
                                    }),
                                })
                              }
                              className="px-3 py-1.5 min-h-[36px] rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-xs font-medium text-[#334155] hover:border-[#312E81] cursor-pointer"
                            >
                              Clear Quizzes
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                requestConfirm({
                                  title: `Reset All Student Attempts for "${top.title}"?`,
                                  description: `Deletes ${attemptCount} student growth/assignment attempt(s) for this topic so students can retake Pre-Test, Assignment, and Post-Test.`,
                                  confirmLabel: 'Reset Attempts',
                                  successMessage: `Reset all student attempts for "${top.title}".`,
                                  run: () =>
                                    resetTopicStudyMaterialAdmin(top, growthRecords, {
                                      resetAttempts: true,
                                    }),
                                })
                              }
                              className="px-3 py-1.5 min-h-[36px] rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-xs font-medium text-[#334155] hover:border-[#D97706] cursor-pointer"
                            >
                              Reset Student Attempts
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                requestConfirm({
                                  title: `Full Reset of Topic "${top.title}"?`,
                                  description:
                                    'Clears study notes, reference images, assignment prompt, Pre/Post quizzes, and all student attempts while keeping the topic slot.',
                                  confirmLabel: 'Reset Everything in Topic',
                                  successMessage: `Topic "${top.title}" reset to blank state.`,
                                  danger: true,
                                  run: () =>
                                    resetTopicStudyMaterialAdmin(top, growthRecords, {
                                      clearStudy: true,
                                      clearImages: true,
                                      clearPreTest: true,
                                      clearPostTest: true,
                                      clearAssignment: true,
                                      resetAttempts: true,
                                    }),
                                })
                              }
                              className="px-3 py-1.5 min-h-[36px] rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] text-xs font-medium text-[#DC2626] hover:border-[#DC2626] cursor-pointer"
                            >
                              Reset All Topic Content
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Student Growth Records & Submissions */}
              <div className="bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4">
                <h2 className="text-base font-bold text-[#0F172A]">
                  Student Attempts & Submissions ({growthRecords.length})
                </h2>
                {growthRecords.length === 0 ? (
                  <p className="text-sm text-[#64748B]">
                    No student quiz or assignment records found.
                  </p>
                ) : (
                  <div className="divide-y divide-[#F1F0EA]">
                    {growthRecords.map((rec) => {
                      const top = topics.find((t) => t.id === rec.topicId);
                      return (
                        <div
                          key={rec.id}
                          className="py-3.5 flex flex-wrap items-center justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-[#0F172A]">
                              {rec.studentName}{' '}
                              <span className="font-mono text-xs text-[#312E81]">
                                ({rec.uniqueStudentId})
                              </span>
                            </p>
                            <p className="text-xs text-[#64748B] font-mono mt-0.5">
                              {top?.title || 'Topic'} · Pre:{' '}
                              {rec.preTestCompleted ? `${rec.preTestPercent}%` : 'Pending'} · Assign:{' '}
                              {rec.assignmentStatus} · Post:{' '}
                              {rec.postTestCompleted ? `${rec.postTestPercent}%` : 'Pending'}
                            </p>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() =>
                                requestConfirm({
                                  title: `Reset Attempt for ${rec.studentName}?`,
                                  description: `Resets Pre-Test, Study completion, Assignment submission/grade, and Post-Test for "${top?.title || 'this topic'}" back to 0%.`,
                                  confirmLabel: 'Reset Attempt',
                                  successMessage: `Reset attempt for ${rec.studentName}.`,
                                  run: () => resetStudentGrowthRecordAdmin(rec, top),
                                })
                              }
                              className="px-3 py-1.5 min-h-[36px] rounded-lg border border-[#E7E5E0] text-xs font-medium text-[#334155] hover:border-[#312E81] cursor-pointer"
                            >
                              Reset Attempt
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                requestConfirm({
                                  title: `Delete Record for ${rec.studentName}?`,
                                  description:
                                    'Deletes this growth record completely. A fresh record will start when the student opens the topic again.',
                                  confirmLabel: 'Delete Record',
                                  successMessage: `Deleted record for ${rec.studentName}.`,
                                  danger: true,
                                  run: () => deleteGrowthRecordAdmin(rec.id),
                                })
                              }
                              className="p-2 min-h-[36px] min-w-[36px] rounded-lg text-[#64748B] hover:text-[#DC2626] flex items-center justify-center cursor-pointer"
                              aria-label={`Delete record for ${rec.studentName}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Institution-Wide Reset Controls */}
              <div className="bg-white border border-[#FECACA] rounded-2xl p-6 space-y-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-[#DC2626] shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-base font-bold text-[#0F172A]">
                      Institution-Wide Reset Controls
                    </h2>
                    <p className="text-xs text-[#64748B] mt-0.5">
                      Use these controls to wipe all study content for a new term or reset your entire institution registration.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                  <div className="p-4 rounded-xl border border-[#E7E5E0] bg-[#FAF9F6] space-y-3">
                    <div>
                      <h3 className="text-sm font-bold text-[#0F172A]">
                        Reset All Study Material & Growth Data
                      </h3>
                      <p className="text-xs text-[#64748B] mt-1 leading-relaxed">
                        Deletes all topics, quizzes, study notes, reference images, assignments, and student growth records. Keeps Institution, Subjects, Teachers, and Students registered.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!institution || busy}
                      onClick={() =>
                        institution &&
                        requestConfirm({
                          title: 'Clear All Study Material & Student Progress?',
                          description: `Deletes ${topics.length} topic(s) and ${growthRecords.length} growth record(s) across all subjects. Your Institution, Teachers, and Students remain enrolled.`,
                          confirmLabel: 'Clear Study Data',
                          successMessage: 'All study material and student growth records were cleared.',
                          danger: true,
                          requirePhrase: 'RESET',
                          run: () =>
                            resetInstitutionWorkspace(
                              institution,
                              subjects,
                              teachers,
                              students,
                              topics,
                              growthRecords,
                              'content_only'
                            ),
                        })
                      }
                      className="px-4 py-2.5 min-h-[40px] rounded-xl border border-[#F59E0B] bg-white text-xs font-semibold text-[#B45309] hover:bg-[#FFFBEB] cursor-pointer disabled:opacity-50"
                    >
                      Clear All Study Material
                    </button>
                  </div>

                  <div className="p-4 rounded-xl border border-[#FECACA] bg-[#FEF2F2] space-y-3">
                    <div>
                      <h3 className="text-sm font-bold text-[#991B1B]">
                        Full Institution Registration Reset
                      </h3>
                      <p className="text-xs text-[#7F1D1D] mt-1 leading-relaxed">
                        Deletes everything—subjects, teachers, students, OTP links, study materials, growth records, and this Institution registration—so you can register from scratch.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={!institution || busy}
                      onClick={() =>
                        institution &&
                        requestConfirm({
                          title: `Reset Entire Institution "${institution.name}"?`,
                          description:
                            'This permanently wipes all registrations (Admin, Teachers, Students), Subjects, Topics, Study Material, and Growth Records.',
                          confirmLabel: 'Reset Everything',
                          successMessage: 'Institution registration completely reset.',
                          danger: true,
                          requirePhrase: 'RESET',
                          run: async () => {
                            await resetInstitutionWorkspace(
                              institution,
                              subjects,
                              teachers,
                              students,
                              topics,
                              growthRecords,
                              'full_registration'
                            );
                            onInstitutionReset?.();
                          },
                        })
                      }
                      className="px-4 py-2.5 min-h-[40px] rounded-xl bg-[#DC2626] text-white text-xs font-semibold hover:bg-[#B91C1C] cursor-pointer disabled:opacity-50"
                    >
                      Reset Entire Registration
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* In-App Confirmation Modal */}
      {confirmAction && (
        <div
          className="fixed inset-0 z-50 bg-[#0F172A]/50 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md bg-white border border-[#E7E5E0] rounded-2xl p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                    confirmAction.danger ? 'bg-[#FEF2F2] text-[#DC2626]' : 'bg-[#EEF2FF] text-[#312E81]'
                  }`}
                >
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-[#0F172A]">{confirmAction.title}</h3>
                  <p className="text-xs text-[#475569] mt-1 leading-relaxed">
                    {confirmAction.description}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="p-1.5 rounded-lg text-[#64748B] hover:text-[#0F172A] cursor-pointer"
                aria-label="Close confirmation"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {confirmAction.requirePhrase && (
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1.5">
                  Type <span className="font-mono font-bold text-[#0F172A]">{confirmAction.requirePhrase}</span> to confirm:
                </label>
                <input
                  type="text"
                  value={confirmPhraseInput}
                  onChange={(e) => setConfirmPhraseInput(e.target.value)}
                  placeholder={confirmAction.requirePhrase}
                  className="w-full px-3.5 py-2.5 rounded-lg border border-[#E7E5E0] bg-[#FAF9F6] font-mono text-sm text-[#0F172A] focus:outline-none focus:border-[#DC2626]"
                />
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2.5 min-h-[40px] rounded-xl border border-[#E7E5E0] text-xs font-semibold text-[#475569] hover:text-[#0F172A] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  (Boolean(confirmAction.requirePhrase) &&
                    confirmPhraseInput.trim() !== confirmAction.requirePhrase)
                }
                onClick={executeConfirmAction}
                className={`px-4 py-2.5 min-h-[40px] rounded-xl text-xs font-semibold text-white cursor-pointer disabled:opacity-50 ${
                  confirmAction.danger
                    ? 'bg-[#DC2626] hover:bg-[#B91C1C]'
                    : 'bg-[#312E81] hover:bg-[#4338CA]'
                }`}
              >
                {busy ? 'Processing...' : confirmAction.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Thumb-Zone Nav Bar */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-[#E7E5E0] pb-safe">
        <div className="grid grid-cols-6 h-16 items-center">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === 'photos') syncPhotoEditor();
                setActiveTab(item.id);
              }}
              className={`flex flex-col items-center justify-center min-h-[44px] text-[10px] font-medium ${
                activeTab === item.id ? 'text-[#312E81] font-semibold' : 'text-[#64748B]'
              }`}
            >
              {item.icon}
              <span className="mt-1 truncate max-w-[56px]">{item.shortLabel}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
};
