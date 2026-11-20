import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db, handleFirestoreError, OperationType } from './firebase';
import {
  BLUEPRINT_LIMITS,
  calculateGrowthMetrics,
  generateSafeId,
  normalizePhoneE164,
  phoneLinkDocId,
  type GrowthRecord,
  type Institution,
  type PhoneLink,
  type PublicProfile,
  type QuizQuestion,
  type ReferenceImage,
  type StudentRecord,
  type Subject,
  type TeacherRecord,
  type Topic,
  type UserProfile,
} from '../types/sikshalite';

export function emailLinkDocId(email: string): string {
  const safe = email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 90);
  return `email_${safe}`;
}

export async function fetchUserProfile(uid: string): Promise<UserProfile | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? (snap.data() as UserProfile) : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

async function executeLinkClaim(user: User, linkId: string, verifiedPhone?: string): Promise<UserProfile | null> {
  const linkPath = `phoneLinks/${linkId}`;
  const linkRef = doc(db, 'phoneLinks', linkId);
  const linkSnap = await getDoc(linkRef);
  if (!linkSnap.exists()) return null;

  const link = linkSnap.data() as PhoneLink;
  if (link.claimedUid && link.claimedUid !== user.uid) return null;

  // Step 1: Claim phoneLink first so Firestore rules on teachers/students allow get/update
  // when claiming via verified mobile OTP + Google session.
  if (!link.claimedUid) {
    await updateDoc(linkRef, {
      claimedUid: user.uid,
      updatedAt: serverTimestamp(),
    });
  }

  const targetCollection = link.role === 'teacher' ? 'teachers' : 'students';
  const memberRef = doc(db, targetCollection, link.memberDocId);
  const memberSnap = await getDoc(memberRef);
  if (!memberSnap.exists()) return null;

  const memberData = memberSnap.data() as TeacherRecord | StudentRecord;
  const batch = writeBatch(db);
  const now = serverTimestamp();

  if (!memberData.claimedUid) {
    batch.update(memberRef, {
      claimedUid: user.uid,
      updatedAt: now,
    });
  }

  const profile: UserProfile = {
    uid: user.uid,
    role: link.role,
    institutionId: link.institutionId,
    memberId: link.memberDocId,
    displayName: memberData.name.slice(0, BLUEPRINT_LIMITS.nameMax),
    phoneE164: (verifiedPhone || user.phoneNumber || memberData.phoneE164 || '').slice(
      0,
      BLUEPRINT_LIMITS.phoneMax
    ),
    email: (user.email || memberData.fallbackEmail || '').slice(0, BLUEPRINT_LIMITS.emailMax),
    photoUrl: (memberData.photoUrl || '').slice(0, BLUEPRINT_LIMITS.photoMax),
    uniqueCode: (link.uniqueCode || '').slice(0, 40),
    createdAt: now,
    updatedAt: now,
  };

  batch.set(doc(db, 'users', user.uid), profile);
  await batch.commit();

  if (link.role === 'teacher') {
    await syncTeacherSubjectClaims(profile);
  }

  return (await fetchUserProfile(user.uid)) ?? profile;
}

export async function claimRoleByVerifiedPhone(
  user: User,
  verifiedPhoneE164: string
): Promise<UserProfile | null> {
  const existingProfile = await fetchUserProfile(user.uid);
  if (existingProfile) {
    if (existingProfile.role === 'teacher') {
      await syncTeacherSubjectClaims(existingProfile);
    }
    return existingProfile;
  }

  const normalized = normalizePhoneE164(verifiedPhoneE164);
  if (!normalized) return null;
  const linkId = phoneLinkDocId(normalized);
  try {
    return await executeLinkClaim(user, linkId, normalized);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
      return null;
    }
    handleFirestoreError(error, OperationType.WRITE, `phoneLinks/${linkId}`);
  }
}

export async function attemptAutoClaimRole(
  user: User,
  verifiedPhoneOverride?: string
): Promise<UserProfile | null> {
  const existingProfile = await fetchUserProfile(user.uid);
  if (existingProfile) {
    if (existingProfile.role === 'teacher') {
      await syncTeacherSubjectClaims(existingProfile);
    }
    return existingProfile;
  }

  const candidates: Array<{ linkId: string; phone?: string }> = [];
  if (verifiedPhoneOverride) {
    const norm = normalizePhoneE164(verifiedPhoneOverride);
    if (norm) candidates.push({ linkId: phoneLinkDocId(norm), phone: norm });
  }
  if (user.phoneNumber) {
    const norm = normalizePhoneE164(user.phoneNumber);
    if (norm) candidates.push({ linkId: phoneLinkDocId(norm), phone: norm });
  }
  if (user.email && user.emailVerified) {
    candidates.push({ linkId: emailLinkDocId(user.email) });
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.linkId)) continue;
    seen.add(candidate.linkId);
    const linkPath = `phoneLinks/${candidate.linkId}`;
    try {
      const claimed = await executeLinkClaim(user, candidate.linkId, candidate.phone);
      if (claimed) return claimed;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        continue;
      }
      handleFirestoreError(error, OperationType.WRITE, linkPath);
    }
  }

  return null;
}

export async function syncTeacherSubjectClaims(profile: UserProfile): Promise<void> {
  if (profile.role !== 'teacher') return;
  try {
    const tSnap = await getDoc(doc(db, 'teachers', profile.memberId));
    if (!tSnap.exists()) return;
    const teacher = tSnap.data() as TeacherRecord;
    for (const subjectId of teacher.assignedSubjectIds) {
      const sRef = doc(db, 'subjects', subjectId);
      const sSnap = await getDoc(sRef);
      if (!sSnap.exists()) continue;
      const subj = sSnap.data() as Subject;
      if (!subj.teacherUids.includes(profile.uid) && subj.teacherUids.length < 20) {
        await updateDoc(sRef, {
          teacherUids: [...subj.teacherUids, profile.uid],
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `teachers/${profile.memberId}`);
  }
}

export async function createInstitutionAccount(
  user: User,
  input: {
    institutionName: string;
    tagline?: string;
    adminName: string;
    institutionPhoto?: string;
    adminPhoto?: string;
  }
): Promise<UserProfile> {
  const institutionId = generateSafeId('inst');
  const joinCode = `SIK-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const now = serverTimestamp();

  const institution: Institution = {
    id: institutionId,
    name: input.institutionName.trim().slice(0, BLUEPRINT_LIMITS.institutionNameMax),
    tagline: (input.tagline ?? '').trim().slice(0, BLUEPRINT_LIMITS.taglineMax),
    adminUid: user.uid,
    adminName: input.adminName.trim().slice(0, BLUEPRINT_LIMITS.nameMax),
    institutionPhoto: (input.institutionPhoto ?? '').slice(0, BLUEPRINT_LIMITS.photoMax),
    adminPhoto: (input.adminPhoto ?? '').slice(0, BLUEPRINT_LIMITS.photoMax),
    joinCode,
    createdAt: now,
    updatedAt: now,
  };

  const userProfile: UserProfile = {
    uid: user.uid,
    role: 'admin',
    institutionId,
    memberId: institutionId,
    displayName: institution.adminName,
    phoneE164: (user.phoneNumber ?? '').slice(0, BLUEPRINT_LIMITS.phoneMax),
    email: (user.email ?? '').slice(0, BLUEPRINT_LIMITS.emailMax),
    photoUrl: institution.adminPhoto ?? '',
    uniqueCode: joinCode,
    createdAt: now,
    updatedAt: now,
  };

  const publicProfile: PublicProfile = {
    id: institutionId,
    institutionId,
    adminUid: user.uid,
    role: 'admin',
    name: institution.adminName,
    photoUrl: institution.adminPhoto ?? '',
    uniqueStudentId: '',
    subjectIds: [],
    updatedAt: now,
  };

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'institutions', institutionId), institution);
    batch.set(doc(db, 'users', user.uid), userProfile);
    batch.set(doc(db, 'publicProfiles', institutionId), publicProfile);
    await batch.commit();
    return (await fetchUserProfile(user.uid)) ?? userProfile;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `institutions/${institutionId}`);
  }
}

export async function updateInstitutionPhotosAndInfo(
  institutionId: string,
  updates: {
    name: string;
    tagline: string;
    adminName: string;
    institutionPhoto: string;
    adminPhoto: string;
  },
  adminUid: string
): Promise<void> {
  const path = `institutions/${institutionId}`;
  try {
    const now = serverTimestamp();
    const batch = writeBatch(db);
    batch.update(doc(db, 'institutions', institutionId), {
      name: updates.name.trim().slice(0, BLUEPRINT_LIMITS.institutionNameMax),
      tagline: updates.tagline.trim().slice(0, BLUEPRINT_LIMITS.taglineMax),
      adminName: updates.adminName.trim().slice(0, BLUEPRINT_LIMITS.nameMax),
      institutionPhoto: updates.institutionPhoto.slice(0, BLUEPRINT_LIMITS.photoMax),
      adminPhoto: updates.adminPhoto.slice(0, BLUEPRINT_LIMITS.photoMax),
      updatedAt: now,
    });
    batch.update(doc(db, 'users', adminUid), {
      displayName: updates.adminName.trim().slice(0, BLUEPRINT_LIMITS.nameMax),
      photoUrl: updates.adminPhoto.slice(0, BLUEPRINT_LIMITS.photoMax),
      updatedAt: now,
    });
    batch.update(doc(db, 'publicProfiles', institutionId), {
      name: updates.adminName.trim().slice(0, BLUEPRINT_LIMITS.nameMax),
      photoUrl: updates.adminPhoto.slice(0, BLUEPRINT_LIMITS.photoMax),
      updatedAt: now,
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateSelfPhoto(
  profile: UserProfile,
  displayName: string,
  photoUrl: string
): Promise<void> {
  const now = serverTimestamp();
  const safeName = displayName.trim().slice(0, BLUEPRINT_LIMITS.nameMax);
  const safePhoto = photoUrl.slice(0, BLUEPRINT_LIMITS.photoMax);

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', profile.uid), {
      displayName: safeName,
      photoUrl: safePhoto,
      updatedAt: now,
    });
    if (profile.role === 'teacher') {
      batch.update(doc(db, 'teachers', profile.memberId), {
        name: safeName,
        photoUrl: safePhoto,
        updatedAt: now,
      });
      batch.update(doc(db, 'publicProfiles', profile.memberId), {
        name: safeName,
        photoUrl: safePhoto,
        updatedAt: now,
      });
    } else if (profile.role === 'student') {
      batch.update(doc(db, 'students', profile.memberId), {
        name: safeName,
        photoUrl: safePhoto,
        updatedAt: now,
      });
      batch.update(doc(db, 'publicProfiles', profile.memberId), {
        name: safeName,
        photoUrl: safePhoto,
        updatedAt: now,
      });
    } else if (profile.role === 'admin') {
      batch.update(doc(db, 'institutions', profile.institutionId), {
        adminName: safeName,
        adminPhoto: safePhoto,
        updatedAt: now,
      });
      batch.update(doc(db, 'publicProfiles', profile.institutionId), {
        name: safeName,
        photoUrl: safePhoto,
        updatedAt: now,
      });
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${profile.uid}`);
  }
}

export async function updateVerifiedPhoneInProfile(
  uid: string,
  phoneE164: string
): Promise<void> {
  const safePhone = normalizePhoneE164(phoneE164).slice(0, 24);
  if (!safePhone) return;
  const path = `users/${uid}`;
  try {
    await updateDoc(doc(db, 'users', uid), {
      phoneE164: safePhone,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function createSubject(
  institution: Institution,
  input: { name: string; code: string; description?: string }
): Promise<string> {
  const subjectId = generateSafeId('subj');
  const now = serverTimestamp();
  const payload: Subject = {
    id: subjectId,
    institutionId: institution.id,
    adminUid: institution.adminUid,
    name: input.name.trim().slice(0, BLUEPRINT_LIMITS.nameMax),
    code: input.code.trim().toUpperCase().slice(0, 24),
    description: (input.description ?? '').trim().slice(0, BLUEPRINT_LIMITS.subjectDescMax),
    teacherUids: [],
    teacherIds: [],
    topicIds: [],
    createdAt: now,
    updatedAt: now,
  };

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'subjects', subjectId), payload);
    await batch.commit();
    return subjectId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `subjects/${subjectId}`);
  }
}

export async function addTeacherToInstitution(
  institution: Institution,
  input: {
    name: string;
    mobile: string;
    fallbackEmail?: string;
    photoUrl?: string;
    assignedSubjectIds: string[];
  },
  existingSubjects: Subject[]
): Promise<string> {
  const phoneE164 = normalizePhoneE164(input.mobile);
  if (!phoneE164 || phoneE164.length < 6) {
    throw new Error('Please enter a valid mobile number (e.g. +919876543210).');
  }

  const teacherId = generateSafeId('tch');
  const linkId = phoneLinkDocId(phoneE164);
  const safeEmail = (input.fallbackEmail ?? '').trim().toLowerCase().slice(0, BLUEPRINT_LIMITS.emailMax);
  const subjectIds = input.assignedSubjectIds.slice(0, BLUEPRINT_LIMITS.maxSubjectsPerMember);
  const now = serverTimestamp();

  const teacher: TeacherRecord = {
    id: teacherId,
    institutionId: institution.id,
    adminUid: institution.adminUid,
    name: input.name.trim().slice(0, BLUEPRINT_LIMITS.nameMax),
    phoneE164: phoneE164.slice(0, BLUEPRINT_LIMITS.phoneMax),
    fallbackEmail: safeEmail,
    photoUrl: (input.photoUrl ?? '').slice(0, BLUEPRINT_LIMITS.photoMax),
    assignedSubjectIds: subjectIds,
    claimedUid: '',
    createdAt: now,
    updatedAt: now,
  };

  const phoneLink: PhoneLink = {
    id: linkId,
    role: 'teacher',
    institutionId: institution.id,
    adminUid: institution.adminUid,
    memberDocId: teacherId,
    phoneE164: teacher.phoneE164,
    fallbackEmail: safeEmail,
    uniqueCode: institution.joinCode,
    claimedUid: '',
    createdByUid: institution.adminUid,
    createdAt: now,
    updatedAt: now,
  };

  const pubProfile: PublicProfile = {
    id: teacherId,
    institutionId: institution.id,
    adminUid: institution.adminUid,
    role: 'teacher',
    name: teacher.name,
    photoUrl: teacher.photoUrl,
    uniqueStudentId: '',
    subjectIds,
    updatedAt: now,
  };

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'teachers', teacherId), teacher);
    batch.set(doc(db, 'phoneLinks', linkId), phoneLink);
    if (safeEmail) {
      const eLinkId = emailLinkDocId(safeEmail);
      batch.set(doc(db, 'phoneLinks', eLinkId), { ...phoneLink, id: eLinkId });
    }
    batch.set(doc(db, 'publicProfiles', teacherId), pubProfile);

    for (const sid of subjectIds) {
      const subj = existingSubjects.find((s) => s.id === sid);
      if (subj && !subj.teacherIds.includes(teacherId) && subj.teacherIds.length < 20) {
        batch.update(doc(db, 'subjects', sid), {
          teacherIds: [...subj.teacherIds, teacherId],
          updatedAt: now,
        });
      }
    }

    await batch.commit();
    return teacherId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `teachers/${teacherId}`);
  }
}

export async function updateMemberPhotoAdmin(
  role: 'teacher' | 'student',
  memberId: string,
  photoUrl: string
): Promise<void> {
  const now = serverTimestamp();
  const safePhoto = photoUrl.slice(0, BLUEPRINT_LIMITS.photoMax);
  const col = role === 'teacher' ? 'teachers' : 'students';
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, col, memberId), { photoUrl: safePhoto, updatedAt: now });
    batch.update(doc(db, 'publicProfiles', memberId), { photoUrl: safePhoto, updatedAt: now });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `${col}/${memberId}`);
  }
}

export async function addStudentToInstitution(
  institution: Institution,
  creatorUid: string,
  input: {
    name: string;
    mobile: string;
    fallbackEmail?: string;
    photoUrl?: string;
    enrolledSubjectIds: string[];
    customStudentId?: string;
  },
  allSubjects: Subject[],
  currentStudentCount: number
): Promise<{ studentId: string; uniqueStudentId: string }> {
  const phoneE164 = normalizePhoneE164(input.mobile);
  if (!phoneE164 || phoneE164.length < 6) {
    throw new Error('Please enter a valid student mobile number (e.g. +919123456789).');
  }

  const studentId = generateSafeId('stu');
  const year = new Date().getFullYear();
  const seq = String(currentStudentCount + 1).padStart(3, '0');
  const randSuffix = Math.random().toString(36).slice(2, 4).toUpperCase();
  const uniqueStudentId = (
    input.customStudentId?.trim() || `SIK-${year}-${seq}${randSuffix}`
  ).slice(0, 32);

  const linkId = phoneLinkDocId(phoneE164);
  const safeEmail = (input.fallbackEmail ?? '').trim().toLowerCase().slice(0, BLUEPRINT_LIMITS.emailMax);
  const enrolledSubjectIds = input.enrolledSubjectIds.slice(0, BLUEPRINT_LIMITS.maxSubjectsPerMember);

  const teacherUidSet = new Set<string>();
  for (const sid of enrolledSubjectIds) {
    const subj = allSubjects.find((s) => s.id === sid);
    if (subj) {
      subj.teacherUids.forEach((uid) => teacherUidSet.add(uid));
    }
  }
  if (creatorUid !== institution.adminUid) {
    teacherUidSet.add(creatorUid);
  }
  const authorizedTeacherUids = Array.from(teacherUidSet).slice(0, 20);
  const now = serverTimestamp();

  const student: StudentRecord = {
    id: studentId,
    institutionId: institution.id,
    adminUid: institution.adminUid,
    uniqueStudentId,
    name: input.name.trim().slice(0, BLUEPRINT_LIMITS.nameMax),
    phoneE164: phoneE164.slice(0, BLUEPRINT_LIMITS.phoneMax),
    fallbackEmail: safeEmail,
    photoUrl: (input.photoUrl ?? '').slice(0, BLUEPRINT_LIMITS.photoMax),
    enrolledSubjectIds,
    authorizedTeacherUids,
    createdByUid: creatorUid,
    claimedUid: '',
    createdAt: now,
    updatedAt: now,
  };

  const phoneLink: PhoneLink = {
    id: linkId,
    role: 'student',
    institutionId: institution.id,
    adminUid: institution.adminUid,
    memberDocId: studentId,
    phoneE164: student.phoneE164,
    fallbackEmail: safeEmail,
    uniqueCode: uniqueStudentId,
    claimedUid: '',
    createdByUid: creatorUid,
    createdAt: now,
    updatedAt: now,
  };

  const pubProfile: PublicProfile = {
    id: studentId,
    institutionId: institution.id,
    adminUid: institution.adminUid,
    role: 'student',
    name: student.name,
    photoUrl: student.photoUrl,
    uniqueStudentId,
    subjectIds: enrolledSubjectIds,
    updatedAt: now,
  };

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'students', studentId), student);
    batch.set(doc(db, 'phoneLinks', linkId), phoneLink);
    if (safeEmail) {
      const eLinkId = emailLinkDocId(safeEmail);
      batch.set(doc(db, 'phoneLinks', eLinkId), { ...phoneLink, id: eLinkId });
    }
    batch.set(doc(db, 'publicProfiles', studentId), pubProfile);
    await batch.commit();
    return { studentId, uniqueStudentId };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `students/${studentId}`);
  }
}

export async function saveTopic(
  subject: Subject,
  creatorUid: string,
  input: {
    id?: string;
    title: string;
    description: string;
    studyContent: string;
    referenceImages: ReferenceImage[];
    preTestQuestions: QuizQuestion[];
    postTestQuestions: QuizQuestion[];
    assignmentPrompt: string;
    assignmentMode: 'written' | 'file' | 'both';
    isPublished: boolean;
  }
): Promise<string> {
  const isNew = !input.id;
  const topicId = input.id || generateSafeId('top');
  const now = serverTimestamp();
  const teacherUids = Array.from(new Set([...subject.teacherUids, creatorUid])).slice(0, 20);

  const topicData: Topic = {
    id: topicId,
    institutionId: subject.institutionId,
    adminUid: subject.adminUid,
    subjectId: subject.id,
    teacherUid: creatorUid,
    teacherUids,
    title: input.title.trim().slice(0, BLUEPRINT_LIMITS.topicTitleMax),
    description: input.description.trim().slice(0, BLUEPRINT_LIMITS.topicDescMax),
    studyContent: input.studyContent.slice(0, BLUEPRINT_LIMITS.studyContentMax),
    referenceImages: input.referenceImages.slice(0, BLUEPRINT_LIMITS.maxRefImagesPerTopic),
    preTestQuestions: input.preTestQuestions.slice(0, BLUEPRINT_LIMITS.maxQuestionsPerQuiz),
    postTestQuestions: input.postTestQuestions.slice(0, BLUEPRINT_LIMITS.maxQuestionsPerQuiz),
    assignmentPrompt: input.assignmentPrompt.slice(0, BLUEPRINT_LIMITS.assignmentPromptMax),
    assignmentMode: input.assignmentMode,
    isPublished: input.isPublished,
    updatedAt: now,
  };

  try {
    const batch = writeBatch(db);
    if (isNew) {
      topicData.createdAt = now;
      batch.set(doc(db, 'topics', topicId), topicData);
      if (!subject.topicIds.includes(topicId) && subject.topicIds.length < BLUEPRINT_LIMITS.maxTopicsPerSubject) {
        batch.update(doc(db, 'subjects', subject.id), {
          topicIds: [...subject.topicIds, topicId],
          updatedAt: now,
        });
      }
    } else {
      batch.update(doc(db, 'topics', topicId), {
        title: topicData.title,
        description: topicData.description,
        studyContent: topicData.studyContent,
        referenceImages: topicData.referenceImages,
        preTestQuestions: topicData.preTestQuestions,
        postTestQuestions: topicData.postTestQuestions,
        assignmentPrompt: topicData.assignmentPrompt,
        assignmentMode: topicData.assignmentMode,
        isPublished: topicData.isPublished,
        teacherUids,
        updatedAt: now,
      });
    }
    await batch.commit();
    return topicId;
  } catch (error) {
    handleFirestoreError(error, isNew ? OperationType.CREATE : OperationType.UPDATE, `topics/${topicId}`);
  }
}

export async function removeTopic(subject: Subject, topicId: string): Promise<void> {
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'topics', topicId));
    batch.update(doc(db, 'subjects', subject.id), {
      topicIds: subject.topicIds.filter((id) => id !== topicId),
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `topics/${topicId}`);
  }
}

export async function ensureGrowthRecord(
  topic: Topic,
  student: StudentRecord,
  studentUid: string
): Promise<GrowthRecord> {
  const recordId = `${student.id}_${topic.id}`;
  const path = `growthRecords/${recordId}`;
  try {
    const ref = doc(db, 'growthRecords', recordId);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const existingData = snap.data() as GrowthRecord;
      if (existingData.studentUid !== studentUid) {
        await updateDoc(ref, {
          studentUid,
          updatedAt: serverTimestamp(),
        });
        return { ...existingData, studentUid };
      }
      return existingData;
    }

    const now = serverTimestamp();
    const initial: GrowthRecord = {
      id: recordId,
      institutionId: topic.institutionId,
      adminUid: topic.adminUid,
      subjectId: topic.subjectId,
      topicId: topic.id,
      studentDocId: student.id,
      studentUid,
      studentName: student.name,
      uniqueStudentId: student.uniqueStudentId,
      teacherUids: topic.teacherUids,
      preTestScore: 0,
      preTestTotal: topic.preTestQuestions.length,
      preTestPercent: 0,
      preTestAnswers: [],
      preTestCompleted: false,
      studyCompleted: false,
      assignmentStatus: 'pending',
      assignmentType: 'none',
      assignmentText: '',
      assignmentFileName: '',
      assignmentFileType: '',
      assignmentFileData: '',
      assignmentFeedback: '',
      postTestScore: 0,
      postTestTotal: topic.postTestQuestions.length,
      postTestPercent: 0,
      postTestAnswers: [],
      postTestCompleted: false,
      growthDelta: 0,
      normalizedGain: 0,
      createdAt: now,
      updatedAt: now,
    };

    const batch = writeBatch(db);
    batch.set(ref, initial);
    await batch.commit();
    const created = await getDoc(ref);
    return created.data() as GrowthRecord;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function submitQuizAttempt(
  record: GrowthRecord,
  topic: Topic,
  quizType: 'pre' | 'post',
  answers: number[]
): Promise<Partial<GrowthRecord>> {
  const questions = (quizType === 'pre' ? topic.preTestQuestions : topic.postTestQuestions).slice(0, 15);
  const total = questions.length;
  const score = questions.reduce((acc, q, idx) => (answers[idx] === q.correctIndex ? acc + 1 : acc), 0);
  const percent = total > 0 ? Math.round((score / total) * 100) : 0;
  const cleanAnswers = answers.slice(0, 15);
  const path = `growthRecords/${record.id}`;
  const ref = doc(db, 'growthRecords', record.id);

  try {
    const latestSnap = await getDoc(ref);
    const latest = latestSnap.exists() ? (latestSnap.data() as GrowthRecord) : record;

    if (quizType === 'pre') {
      if (latest.preTestCompleted) {
        return {
          preTestScore: latest.preTestScore,
          preTestTotal: latest.preTestTotal,
          preTestPercent: latest.preTestPercent,
          preTestAnswers: latest.preTestAnswers,
          preTestCompleted: true,
        };
      }
      const patch = {
        preTestScore: score,
        preTestTotal: total,
        preTestPercent: percent,
        preTestAnswers: cleanAnswers,
        preTestCompleted: true,
      };
      await updateDoc(ref, {
        ...patch,
        updatedAt: serverTimestamp(),
      });
      return patch;
    } else {
      if (latest.postTestCompleted) {
        return {
          postTestScore: latest.postTestScore,
          postTestTotal: latest.postTestTotal,
          postTestPercent: latest.postTestPercent,
          postTestAnswers: latest.postTestAnswers,
          postTestCompleted: true,
          growthDelta: latest.growthDelta,
          normalizedGain: latest.normalizedGain,
        };
      }
      const { growthDelta, normalizedGain } = calculateGrowthMetrics(latest.preTestPercent, percent);
      const patch = {
        postTestScore: score,
        postTestTotal: total,
        postTestPercent: percent,
        postTestAnswers: cleanAnswers,
        postTestCompleted: true,
        growthDelta,
        normalizedGain,
      };
      await updateDoc(ref, {
        ...patch,
        updatedAt: serverTimestamp(),
      });
      return patch;
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function markStudyMaterialComplete(recordId: string): Promise<void> {
  const path = `growthRecords/${recordId}`;
  const ref = doc(db, 'growthRecords', recordId);
  try {
    const latestSnap = await getDoc(ref);
    if (latestSnap.exists() && (latestSnap.data() as GrowthRecord).studyCompleted) {
      return;
    }
    await updateDoc(ref, {
      studyCompleted: true,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function submitStudentAssignment(
  recordId: string,
  payload: {
    assignmentType: 'written' | 'file';
    assignmentText: string;
    assignmentFileName: string;
    assignmentFileType: string;
    assignmentFileData: string;
  }
): Promise<void> {
  const path = `growthRecords/${recordId}`;
  const ref = doc(db, 'growthRecords', recordId);
  try {
    const latestSnap = await getDoc(ref);
    if (latestSnap.exists() && (latestSnap.data() as GrowthRecord).assignmentStatus === 'graded') {
      throw new Error('This assignment has already been graded by your teacher.');
    }
    await updateDoc(ref, {
      assignmentStatus: 'submitted',
      assignmentType: payload.assignmentType,
      assignmentText: payload.assignmentText.slice(0, BLUEPRINT_LIMITS.assignmentTextMax),
      assignmentFileName: payload.assignmentFileName.slice(0, 200),
      assignmentFileType: payload.assignmentFileType.slice(0, 100),
      assignmentFileData: payload.assignmentFileData.slice(0, BLUEPRINT_LIMITS.assignmentFileDataMax),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('already been graded')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function gradeStudentAssignment(
  recordId: string,
  score: number,
  feedback: string
): Promise<void> {
  const path = `growthRecords/${recordId}`;
  try {
    await updateDoc(doc(db, 'growthRecords', recordId), {
      assignmentStatus: 'graded',
      assignmentScore: Math.max(0, Math.min(100, Math.round(score))),
      assignmentFeedback: feedback.trim().slice(0, BLUEPRINT_LIMITS.assignmentFeedbackMax),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export function subscribeInstitution(institutionId: string, cb: (inst: Institution | null) => void): Unsubscribe {
  const path = `institutions/${institutionId}`;
  return onSnapshot(
    doc(db, 'institutions', institutionId),
    (snap) => cb(snap.exists() ? (snap.data() as Institution) : null),
    (error) => handleFirestoreError(error, OperationType.GET, path)
  );
}

export function subscribeAdminSubjects(adminUid: string, cb: (items: Subject[]) => void): Unsubscribe {
  const q = query(collection(db, 'subjects'), where('adminUid', '==', adminUid));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as Subject)),
    (error) => handleFirestoreError(error, OperationType.LIST, 'subjects')
  );
}

export function subscribeTeacherSubjects(teacherUid: string, cb: (items: Subject[]) => void): Unsubscribe {
  const q = query(collection(db, 'subjects'), where('teacherUids', 'array-contains', teacherUid));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as Subject)),
    (error) => handleFirestoreError(error, OperationType.LIST, 'subjects')
  );
}

export function subscribeAdminTeachers(adminUid: string, cb: (items: TeacherRecord[]) => void): Unsubscribe {
  const q = query(collection(db, 'teachers'), where('adminUid', '==', adminUid));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as TeacherRecord)),
    (error) => handleFirestoreError(error, OperationType.LIST, 'teachers')
  );
}

export function subscribeStudentsForAdmin(adminUid: string, cb: (items: StudentRecord[]) => void): Unsubscribe {
  const q = query(collection(db, 'students'), where('adminUid', '==', adminUid));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as StudentRecord)),
    (error) => handleFirestoreError(error, OperationType.LIST, 'students')
  );
}

export function subscribeStudentsForTeacher(teacherUid: string, cb: (items: StudentRecord[]) => void): Unsubscribe {
  const q = query(collection(db, 'students'), where('authorizedTeacherUids', 'array-contains', teacherUid));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as StudentRecord)),
    (error) => handleFirestoreError(error, OperationType.LIST, 'students')
  );
}

export function subscribeAdminTopics(adminUid: string, cb: (items: Topic[]) => void): Unsubscribe {
  const q = query(collection(db, 'topics'), where('adminUid', '==', adminUid));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as Topic)),
    (error) => handleFirestoreError(error, OperationType.LIST, 'topics')
  );
}

export function subscribeTeacherTopics(teacherUid: string, cb: (items: Topic[]) => void): Unsubscribe {
  const q = query(collection(db, 'topics'), where('teacherUids', 'array-contains', teacherUid));
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as Topic)),
    (error) => handleFirestoreError(error, OperationType.LIST, 'topics')
  );
}

export function subscribeGrowthRecordsByRole(
  role: 'admin' | 'teacher' | 'student',
  uid: string,
  cb: (items: GrowthRecord[]) => void
): Unsubscribe {
  const q =
    role === 'admin'
      ? query(collection(db, 'growthRecords'), where('adminUid', '==', uid))
      : role === 'teacher'
        ? query(collection(db, 'growthRecords'), where('teacherUids', 'array-contains', uid))
        : query(collection(db, 'growthRecords'), where('studentUid', '==', uid));

  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as GrowthRecord)),
    (error) => handleFirestoreError(error, OperationType.LIST, 'growthRecords')
  );
}

export async function fetchSubjectsByIds(subjectIds: string[]): Promise<Subject[]> {
  const results: Subject[] = [];
  for (const id of subjectIds) {
    try {
      const snap = await getDoc(doc(db, 'subjects', id));
      if (snap.exists()) results.push(snap.data() as Subject);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `subjects/${id}`);
    }
  }
  return results;
}

export async function fetchTopicsByIds(topicIds: string[]): Promise<Topic[]> {
  const results: Topic[] = [];
  for (const id of topicIds) {
    try {
      const snap = await getDoc(doc(db, 'topics', id));
      if (snap.exists()) results.push(snap.data() as Topic);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `topics/${id}`);
    }
  }
  return results;
}

export async function fetchPublicProfilesByIds(ids: string[]): Promise<PublicProfile[]> {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  const results: PublicProfile[] = [];
  for (const id of unique) {
    try {
      const snap = await getDoc(doc(db, 'publicProfiles', id));
      if (snap.exists()) results.push(snap.data() as PublicProfile);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `publicProfiles/${id}`);
    }
  }
  return results;
}

type BatchOp = (batch: ReturnType<typeof writeBatch>) => void;

async function commitOpsInBatches(ops: BatchOp[]): Promise<void> {
  const CHUNK_SIZE = 380;
  for (let i = 0; i < ops.length; i += CHUNK_SIZE) {
    const chunk = ops.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const op of chunk) {
      op(batch);
    }
    await batch.commit();
  }
}

async function safeDeleteUserProfile(uid: string): Promise<void> {
  if (!uid) return;
  try {
    await deleteDoc(doc(db, 'users', uid));
  } catch {
    // Ignore if user doc was already removed or never created
  }
}

async function safeCheckPhoneLinkExists(linkId: string): Promise<boolean> {
  try {
    const snap = await getDoc(doc(db, 'phoneLinks', linkId));
    return snap.exists();
  } catch {
    return false;
  }
}

export async function deleteTeacherRecord(teacher: TeacherRecord, subjects: Subject[]): Promise<void> {
  try {
    const ops: BatchOp[] = [];
    const now = serverTimestamp();

    ops.push((b) => b.delete(doc(db, 'teachers', teacher.id)));
    ops.push((b) => b.delete(doc(db, 'publicProfiles', teacher.id)));

    const pLinkId = phoneLinkDocId(teacher.phoneE164);
    if (await safeCheckPhoneLinkExists(pLinkId)) {
      ops.push((b) => b.delete(doc(db, 'phoneLinks', pLinkId)));
    }
    if (teacher.fallbackEmail) {
      const eLinkId = emailLinkDocId(teacher.fallbackEmail);
      if (await safeCheckPhoneLinkExists(eLinkId)) {
        ops.push((b) => b.delete(doc(db, 'phoneLinks', eLinkId)));
      }
    }

    for (const sid of teacher.assignedSubjectIds) {
      const s = subjects.find((item) => item.id === sid);
      if (s) {
        ops.push((b) =>
          b.update(doc(db, 'subjects', sid), {
            teacherIds: s.teacherIds.filter((id) => id !== teacher.id),
            teacherUids: teacher.claimedUid
              ? s.teacherUids.filter((u) => u !== teacher.claimedUid)
              : s.teacherUids,
            updatedAt: now,
          })
        );
      }
    }

    await commitOpsInBatches(ops);
    if (teacher.claimedUid) {
      await safeDeleteUserProfile(teacher.claimedUid);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `teachers/${teacher.id}`);
  }
}

export async function resetTeacherRegistration(
  teacher: TeacherRecord,
  subjects: Subject[]
): Promise<void> {
  try {
    const prevUid = teacher.claimedUid;
    const now = serverTimestamp();
    const ops: BatchOp[] = [];

    ops.push((b) =>
      b.update(doc(db, 'teachers', teacher.id), {
        claimedUid: '',
        updatedAt: now,
      })
    );

    const pLinkId = phoneLinkDocId(teacher.phoneE164);
    if (await safeCheckPhoneLinkExists(pLinkId)) {
      ops.push((b) =>
        b.update(doc(db, 'phoneLinks', pLinkId), {
          claimedUid: '',
          updatedAt: now,
        })
      );
    }
    if (teacher.fallbackEmail) {
      const eLinkId = emailLinkDocId(teacher.fallbackEmail);
      if (await safeCheckPhoneLinkExists(eLinkId)) {
        ops.push((b) =>
          b.update(doc(db, 'phoneLinks', eLinkId), {
            claimedUid: '',
            updatedAt: now,
          })
        );
      }
    }

    if (prevUid) {
      for (const s of subjects) {
        if (s.teacherUids.includes(prevUid)) {
          ops.push((b) =>
            b.update(doc(db, 'subjects', s.id), {
              teacherUids: s.teacherUids.filter((u) => u !== prevUid),
              updatedAt: now,
            })
          );
        }
      }
    }

    await commitOpsInBatches(ops);
    if (prevUid) {
      await safeDeleteUserProfile(prevUid);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `teachers/${teacher.id}`);
  }
}

export async function fetchStudentRecord(studentId: string): Promise<StudentRecord | null> {
  try {
    const snap = await getDoc(doc(db, 'students', studentId));
    return snap.exists() ? (snap.data() as StudentRecord) : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `students/${studentId}`);
  }
}

export async function deleteStudentRecord(
  student: StudentRecord,
  growthRecords: GrowthRecord[] = []
): Promise<void> {
  try {
    const ops: BatchOp[] = [];
    ops.push((b) => b.delete(doc(db, 'students', student.id)));
    ops.push((b) => b.delete(doc(db, 'publicProfiles', student.id)));

    const pLinkId = phoneLinkDocId(student.phoneE164);
    if (await safeCheckPhoneLinkExists(pLinkId)) {
      ops.push((b) => b.delete(doc(db, 'phoneLinks', pLinkId)));
    }
    if (student.fallbackEmail) {
      const eLinkId = emailLinkDocId(student.fallbackEmail);
      if (await safeCheckPhoneLinkExists(eLinkId)) {
        ops.push((b) => b.delete(doc(db, 'phoneLinks', eLinkId)));
      }
    }

    for (const rec of growthRecords) {
      if (rec.studentDocId === student.id) {
        ops.push((b) => b.delete(doc(db, 'growthRecords', rec.id)));
      }
    }

    await commitOpsInBatches(ops);
    if (student.claimedUid) {
      await safeDeleteUserProfile(student.claimedUid);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `students/${student.id}`);
  }
}

export async function resetStudentRegistration(student: StudentRecord): Promise<void> {
  try {
    const prevUid = student.claimedUid;
    const now = serverTimestamp();
    const ops: BatchOp[] = [];

    ops.push((b) =>
      b.update(doc(db, 'students', student.id), {
        claimedUid: '',
        updatedAt: now,
      })
    );

    const pLinkId = phoneLinkDocId(student.phoneE164);
    if (await safeCheckPhoneLinkExists(pLinkId)) {
      ops.push((b) =>
        b.update(doc(db, 'phoneLinks', pLinkId), {
          claimedUid: '',
          updatedAt: now,
        })
      );
    }
    if (student.fallbackEmail) {
      const eLinkId = emailLinkDocId(student.fallbackEmail);
      if (await safeCheckPhoneLinkExists(eLinkId)) {
        ops.push((b) =>
          b.update(doc(db, 'phoneLinks', eLinkId), {
            claimedUid: '',
            updatedAt: now,
          })
        );
      }
    }

    await commitOpsInBatches(ops);
    if (prevUid) {
      await safeDeleteUserProfile(prevUid);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `students/${student.id}`);
  }
}

export async function deleteSubjectCascade(
  subject: Subject,
  topics: Topic[],
  teachers: TeacherRecord[],
  students: StudentRecord[],
  growthRecords: GrowthRecord[]
): Promise<void> {
  try {
    const now = serverTimestamp();
    const ops: BatchOp[] = [];

    for (const rec of growthRecords) {
      if (rec.subjectId === subject.id) {
        ops.push((b) => b.delete(doc(db, 'growthRecords', rec.id)));
      }
    }

    for (const top of topics) {
      if (top.subjectId === subject.id) {
        ops.push((b) => b.delete(doc(db, 'topics', top.id)));
      }
    }

    for (const t of teachers) {
      if (t.assignedSubjectIds.includes(subject.id)) {
        const nextSubjects = t.assignedSubjectIds.filter((id) => id !== subject.id);
        ops.push((b) =>
          b.update(doc(db, 'teachers', t.id), {
            assignedSubjectIds: nextSubjects,
            updatedAt: now,
          })
        );
        ops.push((b) =>
          b.update(doc(db, 'publicProfiles', t.id), {
            subjectIds: nextSubjects,
            updatedAt: now,
          })
        );
      }
    }

    for (const stu of students) {
      if (stu.enrolledSubjectIds.includes(subject.id)) {
        const nextEnrolled = stu.enrolledSubjectIds.filter((id) => id !== subject.id);
        ops.push((b) =>
          b.update(doc(db, 'students', stu.id), {
            enrolledSubjectIds: nextEnrolled,
            updatedAt: now,
          })
        );
        ops.push((b) =>
          b.update(doc(db, 'publicProfiles', stu.id), {
            subjectIds: nextEnrolled,
            updatedAt: now,
          })
        );
      }
    }

    ops.push((b) => b.delete(doc(db, 'subjects', subject.id)));

    await commitOpsInBatches(ops);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `subjects/${subject.id}`);
  }
}

export async function deleteTopicAdmin(
  subject: Subject | undefined,
  topicId: string,
  growthRecords: GrowthRecord[]
): Promise<void> {
  try {
    const ops: BatchOp[] = [];
    for (const rec of growthRecords) {
      if (rec.topicId === topicId) {
        ops.push((b) => b.delete(doc(db, 'growthRecords', rec.id)));
      }
    }
    ops.push((b) => b.delete(doc(db, 'topics', topicId)));
    if (subject && subject.topicIds.includes(topicId)) {
      ops.push((b) =>
        b.update(doc(db, 'subjects', subject.id), {
          topicIds: subject.topicIds.filter((id) => id !== topicId),
          updatedAt: serverTimestamp(),
        })
      );
    }
    await commitOpsInBatches(ops);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `topics/${topicId}`);
  }
}

export async function resetTopicStudyMaterialAdmin(
  topic: Topic,
  growthRecords: GrowthRecord[],
  options: {
    clearStudy?: boolean;
    clearImages?: boolean;
    clearPreTest?: boolean;
    clearPostTest?: boolean;
    clearAssignment?: boolean;
    resetAttempts?: boolean;
  }
): Promise<void> {
  try {
    const now = serverTimestamp();
    const ops: BatchOp[] = [];
    const topicPatch: Record<string, unknown> = { updatedAt: now };

    if (options.clearStudy) {
      topicPatch.studyContent = '';
    }
    if (options.clearImages) {
      topicPatch.referenceImages = [];
    }
    if (options.clearPreTest) {
      topicPatch.preTestQuestions = [];
    }
    if (options.clearPostTest) {
      topicPatch.postTestQuestions = [];
    }
    if (options.clearAssignment) {
      topicPatch.assignmentPrompt = '';
    }

    if (Object.keys(topicPatch).length > 1) {
      ops.push((b) => b.update(doc(db, 'topics', topic.id), topicPatch));
    }

    if (options.resetAttempts) {
      for (const rec of growthRecords) {
        if (rec.topicId === topic.id) {
          ops.push((b) => b.delete(doc(db, 'growthRecords', rec.id)));
        }
      }
    }

    await commitOpsInBatches(ops);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `topics/${topic.id}`);
  }
}

export async function deleteGrowthRecordAdmin(recordId: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'growthRecords', recordId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `growthRecords/${recordId}`);
  }
}

export async function resetStudentGrowthRecordAdmin(
  record: GrowthRecord,
  topic?: Topic
): Promise<void> {
  const path = `growthRecords/${record.id}`;
  try {
    await updateDoc(doc(db, 'growthRecords', record.id), {
      preTestScore: 0,
      preTestTotal: topic ? topic.preTestQuestions.length : record.preTestTotal,
      preTestPercent: 0,
      preTestAnswers: [],
      preTestCompleted: false,
      studyCompleted: false,
      assignmentStatus: 'pending',
      assignmentType: 'none',
      assignmentText: '',
      assignmentFileName: '',
      assignmentFileType: '',
      assignmentFileData: '',
      assignmentScore: 0,
      assignmentFeedback: '',
      postTestScore: 0,
      postTestTotal: topic ? topic.postTestQuestions.length : record.postTestTotal,
      postTestPercent: 0,
      postTestAnswers: [],
      postTestCompleted: false,
      growthDelta: 0,
      normalizedGain: 0,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function resetStudentAllProgressAdmin(
  student: StudentRecord,
  growthRecords: GrowthRecord[]
): Promise<void> {
  try {
    const ops: BatchOp[] = growthRecords
      .filter((g) => g.studentDocId === student.id)
      .map((g) => (b) => b.delete(doc(db, 'growthRecords', g.id)));
    if (ops.length > 0) {
      await commitOpsInBatches(ops);
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `students/${student.id}`);
  }
}

export async function resetInstitutionWorkspace(
  institution: Institution,
  subjects: Subject[],
  teachers: TeacherRecord[],
  students: StudentRecord[],
  topics: Topic[],
  growthRecords: GrowthRecord[],
  mode: 'content_only' | 'full_registration'
): Promise<void> {
  try {
    const now = serverTimestamp();
    const ops: BatchOp[] = [];

    for (const rec of growthRecords) {
      ops.push((b) => b.delete(doc(db, 'growthRecords', rec.id)));
    }
    for (const top of topics) {
      ops.push((b) => b.delete(doc(db, 'topics', top.id)));
    }

    if (mode === 'content_only') {
      for (const subj of subjects) {
        if (subj.topicIds.length > 0) {
          ops.push((b) =>
            b.update(doc(db, 'subjects', subj.id), {
              topicIds: [],
              updatedAt: now,
            })
          );
        }
      }
      await commitOpsInBatches(ops);
      return;
    }

    // Full registration reset: remove subjects, teachers, students, links, profiles, member users, then institution + admin user
    for (const subj of subjects) {
      ops.push((b) => b.delete(doc(db, 'subjects', subj.id)));
    }

    const memberUids = new Set<string>();
    for (const t of teachers) {
      if (t.claimedUid) memberUids.add(t.claimedUid);
      ops.push((b) => b.delete(doc(db, 'teachers', t.id)));
      ops.push((b) => b.delete(doc(db, 'publicProfiles', t.id)));
      const pLinkId = phoneLinkDocId(t.phoneE164);
      if (await safeCheckPhoneLinkExists(pLinkId)) {
        ops.push((b) => b.delete(doc(db, 'phoneLinks', pLinkId)));
      }
      if (t.fallbackEmail) {
        const eLinkId = emailLinkDocId(t.fallbackEmail);
        if (await safeCheckPhoneLinkExists(eLinkId)) {
          ops.push((b) => b.delete(doc(db, 'phoneLinks', eLinkId)));
        }
      }
    }

    for (const s of students) {
      if (s.claimedUid) memberUids.add(s.claimedUid);
      ops.push((b) => b.delete(doc(db, 'students', s.id)));
      ops.push((b) => b.delete(doc(db, 'publicProfiles', s.id)));
      const pLinkId = phoneLinkDocId(s.phoneE164);
      if (await safeCheckPhoneLinkExists(pLinkId)) {
        ops.push((b) => b.delete(doc(db, 'phoneLinks', pLinkId)));
      }
      if (s.fallbackEmail) {
        const eLinkId = emailLinkDocId(s.fallbackEmail);
        if (await safeCheckPhoneLinkExists(eLinkId)) {
          ops.push((b) => b.delete(doc(db, 'phoneLinks', eLinkId)));
        }
      }
    }

    ops.push((b) => b.delete(doc(db, 'publicProfiles', institution.id)));

    await commitOpsInBatches(ops);

    // Delete member users/* while institution still exists for isInstitutionAdmin check
    for (const uid of memberUids) {
      if (uid !== institution.adminUid) {
        await safeDeleteUserProfile(uid);
      }
    }

    // Finally delete the institution and the admin's own user profile
    const finalBatch = writeBatch(db);
    finalBatch.delete(doc(db, 'institutions', institution.id));
    finalBatch.delete(doc(db, 'users', institution.adminUid));
    await finalBatch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `institutions/${institution.id}`);
  }
}

export { deleteDoc, doc };
