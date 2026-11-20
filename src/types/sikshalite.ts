export type UserRole = 'admin' | 'teacher' | 'student';

export const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export const BLUEPRINT_LIMITS = {
  idMax: 128,
  nameMax: 100,
  institutionNameMax: 120,
  taglineMax: 200,
  phoneMax: 24,
  emailMax: 160,
  photoMax: 250000,
  subjectDescMax: 400,
  topicTitleMax: 140,
  topicDescMax: 600,
  studyContentMax: 30000,
  assignmentPromptMax: 4000,
  assignmentTextMax: 15000,
  assignmentFileDataMax: 350000,
  assignmentFeedbackMax: 2000,
  maxSubjectsPerMember: 20,
  maxTopicsPerSubject: 50,
  maxRefImagesPerTopic: 6,
  maxQuestionsPerQuiz: 15,
} as const;

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface ReferenceImage {
  id: string;
  caption: string;
  dataUrl: string;
}

export interface UserProfile {
  uid: string;
  role: UserRole;
  institutionId: string;
  memberId: string;
  displayName: string;
  phoneE164?: string;
  email?: string;
  photoUrl?: string;
  uniqueCode?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Institution {
  id: string;
  name: string;
  tagline?: string;
  adminUid: string;
  adminName: string;
  institutionPhoto?: string;
  adminPhoto?: string;
  joinCode: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Subject {
  id: string;
  institutionId: string;
  adminUid: string;
  name: string;
  code: string;
  description?: string;
  teacherUids: string[];
  teacherIds: string[];
  topicIds: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TeacherRecord {
  id: string;
  institutionId: string;
  adminUid: string;
  name: string;
  phoneE164: string;
  fallbackEmail?: string;
  photoUrl?: string;
  assignedSubjectIds: string[];
  claimedUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface StudentRecord {
  id: string;
  institutionId: string;
  adminUid: string;
  uniqueStudentId: string;
  name: string;
  phoneE164: string;
  fallbackEmail?: string;
  photoUrl?: string;
  enrolledSubjectIds: string[];
  authorizedTeacherUids: string[];
  createdByUid: string;
  claimedUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PublicProfile {
  id: string;
  institutionId: string;
  adminUid: string;
  role: UserRole;
  name: string;
  photoUrl?: string;
  uniqueStudentId?: string;
  subjectIds: string[];
  updatedAt?: unknown;
}

export interface PhoneLink {
  id: string;
  role: 'teacher' | 'student';
  institutionId: string;
  adminUid: string;
  memberDocId: string;
  phoneE164: string;
  fallbackEmail?: string;
  uniqueCode?: string;
  claimedUid: string;
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Topic {
  id: string;
  institutionId: string;
  adminUid: string;
  subjectId: string;
  teacherUid: string;
  teacherUids: string[];
  title: string;
  description?: string;
  studyContent: string;
  referenceImages: ReferenceImage[];
  preTestQuestions: QuizQuestion[];
  postTestQuestions: QuizQuestion[];
  assignmentPrompt: string;
  assignmentMode: 'written' | 'file' | 'both';
  isPublished: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface GrowthRecord {
  id: string;
  institutionId: string;
  adminUid: string;
  subjectId: string;
  topicId: string;
  studentDocId: string;
  studentUid: string;
  studentName: string;
  uniqueStudentId: string;
  teacherUids: string[];
  preTestScore: number;
  preTestTotal: number;
  preTestPercent: number;
  preTestAnswers: number[];
  preTestCompleted: boolean;
  studyCompleted: boolean;
  assignmentStatus: 'pending' | 'submitted' | 'graded';
  assignmentType: 'none' | 'written' | 'file';
  assignmentText?: string;
  assignmentFileName?: string;
  assignmentFileType?: string;
  assignmentFileData?: string;
  assignmentScore?: number;
  assignmentFeedback?: string;
  postTestScore: number;
  postTestTotal: number;
  postTestPercent: number;
  postTestAnswers: number[];
  postTestCompleted: boolean;
  growthDelta: number;
  normalizedGain: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export function calculateGrowthMetrics(prePercent: number, postPercent: number): {
  growthDelta: number;
  normalizedGain: number;
} {
  const growthDelta = Math.round((postPercent - prePercent) * 10) / 10;
  let normalizedGain = 0;
  if (prePercent < 100) {
    const rawGain = ((postPercent - prePercent) / (100 - prePercent)) * 100;
    normalizedGain = Math.max(-100, Math.min(100, Math.round(rawGain * 10) / 10));
  } else {
    normalizedGain = postPercent === 100 ? 100 : Math.max(-100, postPercent - prePercent);
  }
  return { growthDelta, normalizedGain };
}

export function normalizePhoneE164(raw: string, defaultCountryCode = '+91'): string {
  const cleaned = raw.trim().replace(/[\s()-]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) {
    return '+' + cleaned.slice(1).replace(/\D/g, '');
  }
  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) {
    return `${defaultCountryCode}${digits}`;
  }
  return `+${digits}`;
}

export function phoneLinkDocId(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, '');
  return `phone_${digits}`;
}

export function generateSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now()}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
}
